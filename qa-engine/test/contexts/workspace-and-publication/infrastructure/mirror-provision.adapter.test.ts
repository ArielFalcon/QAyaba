/* test/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.test.ts
   repo-mirror.test.ts's ensureMirror/ensureMirrorAtBranch tests. Credential/auth-header decoration
   (authHeaderArgs' -c insteadOf rewrite) is NOT exercised here — that decoration now lives in the
   injector (src/integrations/repo-mirror.ts's thin wrapper, pinned by its OWN unchanged tests); this
   adapter's own argv is bare by construction, so these fakes never see a credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UntrustedGitTreeError } from "../../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import { MirrorProvisionAdapter, type MirrorProvisionDeps } from "@contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts";

/* exists: a boolean covers both the mirror dir and the stale-lock probe; a function lets a test
   answer differently per path (e.g. "dir exists but no index.lock").
 */
function recorder(exists: boolean | ((path: string) => boolean)): MirrorProvisionDeps & { calls: string[][]; removed: string[] } {
  const calls: string[][] = [];
  const removed: string[] = [];
  return {
    calls,
    removed,
    root: "/tmp/mirrors",
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    exists: typeof exists === "function" ? exists : () => exists,
    removeFile: (path) => {
      removed.push(path);
    },
    git: async (args) => {
      calls.push(args);
      return "ok";
    },
  };
}

test("clones, force-checks out and cleans when the working copy does not exist", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.equal(dir, "/tmp/mirrors/org__app");
  assert.deepEqual(d.calls[0], ["clone", "https://github.com/org/app.git", "/tmp/mirrors/org__app"]);
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("existing mirror: resets origin URL, fetches, force-checks out and cleans", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.calls[0], ["remote", "set-url", "origin", "https://github.com/org/app.git"]);
  assert.deepEqual(d.calls[1], ["fetch", "--no-recurse-submodules", "origin"]);
  assert.deepEqual(d.calls[2], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[3], ["clean", "-fd", "-e", "node_modules"]);
});

/* ── Stale git lock self-heal ──────────────────────────────────────────────────
   The queue is strictly sequential and only the orchestrator performs git writes, so an index.lock
   present at the start of a run is stale by definition.
 */

test("removes a stale .git/index.lock before any git command", async () => {
  const d = recorder(true); /* mirror dir AND lock exist */
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("ensureMirrorAtBranch also removes a stale index.lock", async () => {
  const d = recorder(true);
  await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main");
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("does not touch index.lock when absent", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, []);
});

test("does not probe for a lock on the clone path (no mirror, no lock)", async () => {
  const d = recorder(false);
  await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");
  assert.deepEqual(d.removed, []);
});

test("rejects a non-hex sha before spawning git (injection defense)", async () => {
  const d = recorder(true);
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "--output=/etc/passwd"), /invalid commit sha/);
  assert.equal(d.calls.length, 0); /* never reached git */
});

test("ensureMirror flattens a nested repo path (replaceAll, not just first slash)", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirror("org/sub/app", "abc1234");
  assert.equal(dir, "/tmp/mirrors/org__sub__app");
});

test("ensureMirrorAtBranch clones when missing and checks out origin/<branch>", async () => {
  const d = recorder(false);
  const dir = await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/shop-front", "main");
  assert.equal(dir, "/tmp/mirrors/org__shop-front");
  assert.equal(d.calls[0]?.[0], "clone");
  assert.ok(d.calls.some((c) => c[0] === "checkout" && c.includes("origin/main")));
  assert.ok(d.calls.some((c) => c[0] === "clean"));
});

test("ensureMirrorAtBranch fetches when the mirror exists", async () => {
  const d = recorder(true);
  await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/shop-front", "main");
  assert.ok(d.calls.some((c) => c.includes("fetch")));
  assert.ok(!d.calls.some((c) => c[0] === "clone"));
});

test("ensureMirrorAtBranch rejects a branch name that could be parsed as a git option", async () => {
  const d = recorder(true);
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/x", "--upload-pack=evil"));
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/x", "a..b"));
});

test("ensureMirror propagates git clone failure (network timeout / auth failure)", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => false,
    removeFile: () => {},
    git: async () => {
      throw new Error("git clone failed: connection timeout");
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git clone failed/);
});

test("ensureMirror propagates git checkout failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed: unknown revision");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git checkout failed/);
});

test("ensureMirror propagates git fetch failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args.includes("fetch")) throw new Error("git fetch failed: 401 Unauthorized");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /git fetch failed/);
});

test("ensureMirrorAtBranch propagates git clone failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => false,
    removeFile: () => {},
    git: async () => {
      throw new Error("git clone failed");
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main"), /git clone failed/);
});

test("ensureMirrorAtBranch propagates git checkout failure", async () => {
  const d: MirrorProvisionDeps = {
    root: "/tmp/mirrors",
    remoteUrl: (r) => `https://github.com/${r}.git`,
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed");
      return "ok";
    },
  };
  await assert.rejects(() => new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main"), /git checkout failed/);
});

/* The sandbox owns the mirror's directory, so it can replace the root-owned `.git` there with a link into a place it
   controls; the lock removal must not follow that link. */
test("a stale lock is never removed through a git dir the sandbox replaced with a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-provision-swapped-git-"));
  try {
    const mirror = join(root, "org__app");
    const elsewhere = join(root, "sandbox-controlled-git");
    mkdirSync(mirror);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "index.lock"), "");
    symlinkSync(elsewhere, join(mirror, ".git"));
    const d = recorder(existsSync);
    d.root = root;
    d.removeFile = (path) => rmSync(path, { force: true });

    await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), UntrustedGitTreeError);

    assert.equal(existsSync(join(elsewhere, "index.lock")), true, "the file behind the link was not deleted");
    assert.deepEqual(d.calls, [], "no git command ran against the swapped git dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── A mirror the git hardening refuses is deleted and cloned afresh ──────────────────────────────────
   A mirror is a regenerable cache. The sandbox that owns its directory can leave it in a state the hardening
   refuses for good; git is never run inside such a tree to repair it. */

function refusingMirror(options: { refusals: number; removeTree?: boolean }): MirrorProvisionDeps & { calls: string[][]; removedTrees: string[]; present: { value: boolean } } {
  const calls: string[][] = [];
  const removedTrees: string[] = [];
  const present = { value: true };
  let refusalsLeft = options.refusals;
  return {
    calls,
    removedTrees,
    present,
    root: "/tmp/mirrors",
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    exists: (path) => (path.endsWith("index.lock") ? false : present.value),
    removeFile: () => {},
    ...(options.removeTree === false
      ? {}
      : {
          removeTree: (path: string) => {
            removedTrees.push(path);
            present.value = false;
          },
        }),
    git: async (args) => {
      calls.push(args);
      if (args[0] === "clone") {
        present.value = true;
        return "ok";
      }
      if (refusalsLeft > 0 && (args[0] === "remote" || args[0] === "clean")) {
        refusalsLeft -= 1;
        throw new UntrustedGitTreeError("refusing to run git on /tmp/mirrors/org__app: refused");
      }
      return "ok";
    },
  };
}

function captureErrors(): { logs: string[]; restore(): void } {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  return { logs, restore: () => void (console.error = original) };
}

test("a mirror the hardening refuses is deleted and cloned afresh, and what was found is logged", async () => {
  const d = refusingMirror({ refusals: 1 });
  const errors = captureErrors();
  try {
    const dir = await new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234");

    assert.equal(dir, "/tmp/mirrors/org__app");
    assert.deepEqual(d.removedTrees, ["/tmp/mirrors/org__app"]);
    assert.deepEqual(d.calls.map((c) => c[0]), ["remote", "clone", "checkout", "clean"], "the refused sync is followed by a fresh clone and the normal checkout");
    assert.ok(errors.logs.some((line) => line.includes("/tmp/mirrors/org__app") && line.includes("refused")), "the heal is never silent");
  } finally {
    errors.restore();
  }
});

test("a mirror is healed for a branch checkout too", async () => {
  const d = refusingMirror({ refusals: 1 });
  const errors = captureErrors();
  try {
    await new MirrorProvisionAdapter(d).ensureMirrorAtBranch("org/app", "main");
    assert.deepEqual(d.removedTrees, ["/tmp/mirrors/org__app"]);
    assert.ok(d.calls.some((c) => c[0] === "checkout" && c.includes("origin/main")));
  } finally {
    errors.restore();
  }
});

test("a refusal that survives the fresh clone propagates: the mirror is deleted once, never in a loop", async () => {
  const d = refusingMirror({ refusals: 2 });
  const errors = captureErrors();
  try {
    await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), UntrustedGitTreeError);
    assert.equal(d.removedTrees.length, 1);
  } finally {
    errors.restore();
  }
});

test("a refusal on a mirror that did not exist before the call is not healed by deleting what was just cloned", async () => {
  const d = refusingMirror({ refusals: 1 });
  d.present.value = false;
  d.git = async (args) => {
    d.calls.push(args);
    if (args[0] === "clone") d.present.value = true;
    if (args[0] === "checkout") throw new UntrustedGitTreeError("refusing to run git on /tmp/mirrors/org__app: refused");
    return "ok";
  };
  await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), UntrustedGitTreeError);
  assert.deepEqual(d.removedTrees, []);
});

test("a git failure that is not a refusal is not healed by deleting the mirror", async () => {
  const d = refusingMirror({ refusals: 0 });
  d.git = async (args) => {
    if (args[0] === "fetch") throw new Error("git fetch failed: 401 Unauthorized");
    return "ok";
  };
  await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), /401/);
  assert.deepEqual(d.removedTrees, []);
});

test("with no way to delete a directory wired, a refused mirror propagates as before", async () => {
  const d = refusingMirror({ refusals: 1, removeTree: false });
  await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror("org/app", "abc1234"), UntrustedGitTreeError);
  assert.deepEqual(d.calls.map((c) => c[0]), ["remote"], "nothing else ran against the refused tree");
});

test("a repo name that resolves to the mirrors root or above it is never deleted", async () => {
  for (const repo of ["..", "."]) {
    const d = refusingMirror({ refusals: 1 });
    await assert.rejects(new MirrorProvisionAdapter(d).ensureMirror(repo, "abc1234"), UntrustedGitTreeError, repo);
    assert.deepEqual(d.removedTrees, [], `${repo} would have deleted a directory that is not a mirror`);
  }
});

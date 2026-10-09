/* The staging of a service's context reads the files of another repository's mirror and writes them into the front's working copy, which is the agent's own: both are directories the agent can write into. A repository's tree can hold committed links, and the agent can plant a link, a named pipe or a file of any size anywhere in a mirror, so a read that follows a link would copy a file from outside the mirror into the context the agent is given, one that opens a named pipe would hold the whole single-threaded orchestrator for ever, and a write through a link the agent planted in the working copy would put the service's files wherever the link points. The service's files are listed by the one walk of the files of a repository and read through the strict, capped read; the staging directory is emptied and written through the strict calls rooted at the working copy. What cannot be used is omitted, with a reason of the module's own, and the rest is staged. Every case runs the real staging against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. Git is the one injected boundary and is faked: the commit reports the files the fixture holds, which is all the staging takes from it, so no case spawns a git process. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageServiceContext, serviceContextDir, defaultStageDeps, type ServiceContextManifest, type StageDeps } from "./service-context";
import { ConfinedPathError } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";
import { withoutWaitingOnNamedPipe } from "../../qa-engine/test/support/named-pipe-watch";

const SECRET = "SECRET-OUTSIDE-THE-MIRROR-0451";

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-stage-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";

/* <tmp>/front is the front's working copy (its e2e/ directory is where the context goes), <tmp>/svc the service's mirror and <tmp>/outside what no read or write may reach. `committed` is what the commit reports as changed. */
interface Fixture {
  tmp: string;
  front: string;
  svc: string;
  outside: string;
  committed: string[];
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/* The service's mirror with `files` in it (a value starting with "->" is a link to what follows), all of them reported by the commit, and `after` done to its working tree once they are. */
async function withFixture(files: Record<string, string>, run: (f: Fixture, sha: string) => Promise<void>, after?: (f: Fixture) => void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-stage-"));
  const f: Fixture = { tmp, front: join(tmp, "front"), svc: join(tmp, "svc"), outside: join(tmp, "outside"), committed: Object.keys(files).sort() };
  try {
    mkdirSync(join(f.front, "e2e"), { recursive: true });
    mkdirSync(f.svc);
    mkdirSync(f.outside);
    writeFileSync(join(f.outside, "secret.txt"), `${SECRET}\n`);
    for (const [name, content] of Object.entries(files)) {
      if (content.startsWith("->")) {
        mkdirSync(dirname(join(f.svc, name)), { recursive: true });
        symlinkSync(content.slice(2).replace("<outside>", f.outside), join(f.svc, name));
      } else {
        put(f.svc, name, content);
      }
    }
    after?.(f);
    await run(f, SHA);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* The real strict calls over a git that reports the fixture's commit. */
const depsOf = (f: Fixture, overrides: Partial<StageDeps> = {}): StageDeps => ({
  ...defaultStageDeps,
  git: async (args: string[]) => (args.includes("--name-only") ? `${f.committed.join("\n")}\n` : "a patch\n"),
  ...overrides,
});

const stage = (f: Fixture, sha?: string, deps: StageDeps = depsOf(f)) => stageServiceContext({ workingCopyDir: f.front, service: { repo: "org/svc", mirrorDir: f.svc }, ...(sha ? { sha } : {}) }, deps);
const manifestOf = (path: string): ServiceContextManifest => JSON.parse(readFileSync(path, "utf8")) as ServiceContextManifest;
const stagedDir = (f: Fixture): string => serviceContextDir(f.front, "org/svc");

/* Every file below a directory, as a path below it. */
function filesBelow(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
  } catch {
    return [];
  }
}

const everythingStaged = (f: Fixture): string => filesBelow(stagedDir(f)).map((rel) => readFileSync(join(stagedDir(f), rel), "utf8")).join("\n");

test("a service's contracts, the files its commit changed, the diff and a manifest are staged, and nothing is omitted from an ordinary service", async () => {
  await withFixture({ "openapi.yaml": "openapi: 3.0.3\n", "src/a.txt": "an ordinary file\n" }, async (f, sha) => {
    const staged = await stage(f, sha);

    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest.contracts, ["openapi.yaml"]);
    assert.deepEqual([...manifest.changed].sort(), ["openapi.yaml", "src/a.txt"]);
    assert.deepEqual(manifest.omitted, []);
    assert.deepEqual(filesBelow(stagedDir(f)), ["CHANGE.patch", "changed/openapi.yaml", "changed/src/a.txt", "contracts/openapi.yaml", "manifest.json"]);
    assert.equal(readFileSync(join(stagedDir(f), "changed", "src", "a.txt"), "utf8"), "an ordinary file\n");
  });
});

test("a symbolic link a commit adds is omitted with a reason of its own, and the file it points at is not in the context", async () => {
  await withFixture({ "readme.txt": "ordinary\n", "link.txt": "-><outside>/secret.txt", "docs/link-in-dir.txt": "-><outside>/secret.txt" }, async (f, sha) => {
    const staged = await stage(f, sha);

    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest.changed, ["readme.txt"], "the ordinary file is staged");
    assert.deepEqual(manifest.omitted.map((o) => o.path).sort(), ["docs/link-in-dir.txt", "link.txt"]);
    for (const omitted of manifest.omitted) assert.match(omitted.reason, /^refused: \S/, `${omitted.path} is told as refused, with the module's reason, and not as a file that could not be read`);
    assert.ok(!everythingStaged(f).includes(SECRET), "nothing of the file outside the mirror was copied");
  });
});

test("a changed file that is a directory link, or has one on the way, is omitted and nothing behind the link is staged", async () => {
  await withFixture(
    { "dir/file.txt": "committed under dir\n", "keep.txt": "kept\n" },
    async (f, sha) => {
      const staged = await stage(f, sha);

      const manifest = manifestOf(staged.manifestPath);
      assert.deepEqual(manifest.changed, ["keep.txt"]);
      assert.deepEqual(manifest.omitted.map((o) => o.path), ["dir/file.txt"]);
      assert.ok(!everythingStaged(f).includes(SECRET));
    },
    (f) => {
      writeFileSync(join(f.outside, "file.txt"), `${SECRET}\n`);
      rmSync(join(f.svc, "dir"), { recursive: true });
      symlinkSync(f.outside, join(f.svc, "dir"));
    },
  );
});

test("a changed file that is a named pipe in the working tree is not waited on: it is omitted, and the others are staged", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  await withFixture(
    { "ctx.txt": "committed as a file\n", "keep.txt": "kept\n" },
    async (f, sha) => {
      const staged = await withoutWaitingOnNamedPipe(join(f.svc, "ctx.txt"), () => stage(f, sha));

      const manifest = manifestOf(staged.manifestPath);
      assert.deepEqual(manifest.changed, ["keep.txt"]);
      assert.deepEqual(manifest.omitted.map((o) => o.path), ["ctx.txt"]);
    },
    (f) => {
      rmSync(join(f.svc, "ctx.txt"));
      execFileSync("mkfifo", [join(f.svc, "ctx.txt")]);
    },
  );
});

test("a contract that is a link or a named pipe is not listed as a contract, and a contract beside them still is", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  await withFixture({ "openapi.yaml": "openapi: 3.0.3\n" }, async (f) => {
    put(f.svc, "swagger.yaml", "swagger: '2.0'\n");
    rmSync(join(f.svc, "swagger.yaml"));
    execFileSync("mkfifo", [join(f.svc, "swagger.yaml")]);
    symlinkSync(join(f.outside, "secret.txt"), join(f.svc, "api-definition.json"));

    const staged = await withoutWaitingOnNamedPipe(join(f.svc, "swagger.yaml"), () => stage(f));

    assert.deepEqual(manifestOf(staged.manifestPath).contracts, ["openapi.yaml"]);
    assert.ok(!everythingStaged(f).includes(SECRET));
  });
});

test("the service's installed packages and its git directory are not walked for contracts", async () => {
  await withFixture({ "openapi.yaml": "openapi: 3.0.3\n", "node_modules/pkg/openapi.json": "{}\n" }, async (f) => {
    const staged = await stage(f);

    assert.deepEqual(manifestOf(staged.manifestPath).contracts, ["openapi.yaml"]);
  });
});

test("a path the commit reports that climbs out of the service, or is absolute, is omitted and not staged anywhere", async () => {
  await withFixture({ "ok.txt": "ordinary\n" }, async (f, sha) => {
    writeFileSync(join(f.tmp, "climbed.txt"), `${SECRET}\n`);
    const deps = depsOf(f, { git: async (args: string[]) => (args.includes("--name-only") ? "../climbed.txt\n/etc/hosts\nok.txt\n" : "patch") });

    const staged = await stage(f, sha, deps);

    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest.changed, ["ok.txt"]);
    assert.deepEqual(manifest.omitted.map((o) => o.path).sort(), ["../climbed.txt", "/etc/hosts"]);
    assert.ok(!everythingStaged(f).includes(SECRET));
    assert.deepEqual(filesBelow(join(f.front, "e2e", ".qa")).filter((p) => p.includes("climbed")), [], "and nothing was written outside the staging directory");
  });
});

test("a file of exactly the size cap is staged and one byte more is omitted with a reason", async () => {
  const cap = 512 * 1024;
  await withFixture({ "exact.txt": "x".repeat(cap), "over.txt": "x".repeat(cap + 1) }, async (f, sha) => {
    const staged = await stage(f, sha);

    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest.changed, ["exact.txt"]);
    assert.ok(manifest.omitted.some((o) => o.path === "over.txt" && /^refused: \S/.test(o.reason)), `the file past the cap is refused by the read, before it is held in memory: ${JSON.stringify(manifest.omitted)}`);
    assert.equal(readFileSync(join(stagedDir(f), "changed", "exact.txt"), "utf8").length, cap);
  });
});

test("a file the listing named that is gone by the time it is read is omitted with a reason, not staged and not fatal", async () => {
  await withFixture({ "ctx.txt": "listed\n", "keep.txt": "kept\n" }, async (f, sha) => {
    const staged = await stage(f, sha, depsOf(f, { exists: () => true }));

    const manifest = manifestOf(staged.manifestPath);
    assert.deepEqual(manifest.changed, ["keep.txt"]);
    assert.deepEqual(manifest.omitted.map((o) => o.path), ["ctx.txt"]);
    assert.match(manifest.omitted[0]!.reason, /^refused: \S/, "a refusal always says why");
  }, (f) => rmSync(join(f.svc, "ctx.txt")));
});

test("the default removal has rm -rf semantics: a path that is not there is nothing to remove, and an ordinary directory goes with what is in it", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f) => {
    const gone = join(f.front, "e2e", "never-made");
    const full = join(f.front, "e2e", "full");
    put(full, "a/b.txt", "inside");

    assert.doesNotThrow(() => defaultStageDeps.rm(gone, f.front));
    defaultStageDeps.rm(full, f.front);

    assert.deepEqual(filesBelow(join(f.front, "e2e")), []);
  });
});

test("the staging directory is emptied before a run, so what a previous run staged is gone", async () => {
  await withFixture({ "ctx.txt": "first\n" }, async (f, sha) => {
    await stage(f, sha);
    put(stagedDir(f), "stale/old.txt", "from an earlier run");

    await stage(f, sha);

    assert.ok(!filesBelow(stagedDir(f)).includes("stale/old.txt"));
  });
});

/* ── the staging directory is in the working copy, which the agent writes into ─────────────────── */

test("a .qa that is a link out of the working copy refuses the staging, loudly, and nothing is written where it points", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    mkdirSync(join(f.outside, "qa-target"));
    symlinkSync(join(f.outside, "qa-target"), join(f.front, "e2e", ".qa"));

    await assert.rejects(() => stage(f, sha), (err: unknown) => err instanceof ConfinedPathError);

    assert.deepEqual(readdirSync(join(f.outside, "qa-target")), [], "nothing was made or written through the link, not even a directory");
  });
});

test("an e2e that is a link out of the working copy refuses the staging as well", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    rmSync(join(f.front, "e2e"), { recursive: true });
    mkdirSync(join(f.outside, "e2e-target"));
    symlinkSync(join(f.outside, "e2e-target"), join(f.front, "e2e"));

    await assert.rejects(() => stage(f, sha), (err: unknown) => err instanceof ConfinedPathError);

    assert.deepEqual(readdirSync(join(f.outside, "e2e-target")), []);
  });
});

test("a link above the staging directory is not removed through: what is at the end of it is as it was, though the staging directory is there", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    const precious = join(f.outside, "qa-target", "service-context", "org__svc", "precious.txt");
    mkdirSync(dirname(precious), { recursive: true });
    writeFileSync(precious, "PRECIOUS\n");
    symlinkSync(join(f.outside, "qa-target"), join(f.front, "e2e", ".qa"));

    await assert.rejects(() => stage(f, sha), (err: unknown) => err instanceof ConfinedPathError);

    assert.equal(readFileSync(precious, "utf8"), "PRECIOUS\n", "the directory the link leads to was not emptied");
  });
});

test("a staging directory that is itself a link is replaced by a directory of the working copy, and what it pointed at is not touched", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    mkdirSync(join(f.outside, "target"));
    writeFileSync(join(f.outside, "target", "precious.txt"), "PRECIOUS\n");
    mkdirSync(dirname(stagedDir(f)), { recursive: true });
    symlinkSync(join(f.outside, "target"), stagedDir(f));

    await stage(f, sha);

    assert.deepEqual(filesBelow(join(f.outside, "target")), ["precious.txt"], "the directory it pointed at is as it was");
    assert.equal(readFileSync(join(f.outside, "target", "precious.txt"), "utf8"), "PRECIOUS\n");
    assert.ok(filesBelow(stagedDir(f)).includes("manifest.json"), "and the context is where it belongs");
  });
});

test("a link to nothing at the staging directory is replaced like any other, so a plant cannot fail every later staging for good", async () => {
  await withFixture({ "ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    mkdirSync(dirname(stagedDir(f)), { recursive: true });
    symlinkSync(join(f.outside, "no-such-target"), stagedDir(f));

    await stage(f, sha);

    assert.ok(filesBelow(stagedDir(f)).includes("manifest.json"), "the context is where it belongs");
    assert.deepEqual(readdirSync(f.outside), ["secret.txt"], "and nothing was made where the link pointed");
  });
});

test("a link planted at a file the staging writes is never written through: the staging refuses it and the file behind the link is as it was", async () => {
  for (const name of ["CHANGE.patch", "manifest.json", "contracts/openapi.yaml"]) {
    await withFixture({ "openapi.yaml": "openapi: 3.0.3\n" }, async (f, sha) => {
      writeFileSync(join(f.outside, "victim.txt"), "PRECIOUS\n");
      let planted = false;
      const plantedDeps = depsOf(f, {
        /* The agent's link appears after the staging directory is made and before the files are written. */
        mkdir: (path: string, root: string) => {
          defaultStageDeps.mkdir(path, root);
          if (!planted && path === stagedDir(f)) {
            planted = true;
            mkdirSync(dirname(join(path, name)), { recursive: true });
            symlinkSync(join(f.outside, "victim.txt"), join(path, name));
          }
        },
      });

      await assert.rejects(() => stage(f, sha, plantedDeps), (err: unknown) => err instanceof ConfinedPathError, name);

      assert.equal(readFileSync(join(f.outside, "victim.txt"), "utf8"), "PRECIOUS\n", `${name}: the file behind the link was not written`);
    });
  }
});

test("a link planted inside the staging directory is never written through: a directory of it that is a link refuses the write", async () => {
  await withFixture({ "dir/ctx.txt": "an ordinary file\n" }, async (f, sha) => {
    let done = false;
    const planted = depsOf(f, {
      /* The agent's link appears after the directory is made and before the files are written. */
      mkdir: (path: string, root: string) => {
        defaultStageDeps.mkdir(path, root);
        if (!done && path === stagedDir(f)) {
          done = true;
          mkdirSync(join(f.outside, "changed-target"), { recursive: true });
          symlinkSync(join(f.outside, "changed-target"), join(path, "changed"));
        }
      },
    });

    await assert.rejects(() => stage(f, sha, planted), (err: unknown) => err instanceof ConfinedPathError);

    assert.deepEqual(filesBelow(join(f.outside, "changed-target")), [], "nothing was written through the link");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalExportPublicationAdapter,
  addedLinesOfPatch,
  nodeLocalExportFs,
  parsePorcelainZ,
  type LocalExportDeps,
  type LocalExportFs,
} from "@contexts/workspace-and-publication/infrastructure/local-export-publication.adapter.ts";

function memFs(): LocalExportFs & { files: Map<string, string>; copies: Array<[string, string]> } {
  const files = new Map<string, string>();
  const copies: Array<[string, string]> = [];
  return {
    files,
    copies,
    mkdir: () => {},
    write: (path, content) => void files.set(path, content),
    copy: (src, dest) => void copies.push([src, dest]),
    exists: (path) => files.has(path),
    isRegularFile: () => true,
    realpath: (path) => path,
    read: (path) => mirrorFiles.get(path) ?? "",
  };
}

/* What the in-memory mirror holds, keyed by absolute path. A path not listed reads as an empty file. */
const mirrorFiles = new Map<string, string>();

function harness(
  statusOut: string,
  opts: { diffThrows?: boolean; containsSecret?: (text: string) => boolean; diff?: (args: string[]) => string } = {},
) {
  mirrorFiles.clear();
  const calls: string[][] = [];
  const excludesWritten: Array<[string, readonly string[]]> = [];
  const fs = memFs();
  const deps: LocalExportDeps = {
    exportDir: "/exports/app/ns-1",
    mirrorDir: "/mirrors/org__app",
    baseBranch: "main",
    addPaths: ["e2e"],
    excludes: ["node_modules/", "e2e/.qa/coverage/"],
    git: async (args) => {
      calls.push(args);
      if (args[0] === "status") return statusOut;
      if (args[0] === "diff") {
        if (opts.diffThrows) throw new Error("diff exploded");
        return opts.diff?.(args) ?? "diff --git a/e2e/flows/a.spec.ts b/e2e/flows/a.spec.ts\n";
      }
      return "";
    },
    writeExcludes: (dir, patterns) => void excludesWritten.push([dir, patterns]),
    containsSecret: opts.containsSecret ?? (() => false),
    fs,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
    log: () => {},
  };
  return { adapter: new LocalExportPublicationAdapter(deps), calls, fs, excludesWritten };
}

test("parsePorcelainZ: untracked, modified, deleted and a rename (source token skipped)", () => {
  const out = ["?? e2e/flows/new.spec.ts", " M e2e/fixtures.ts", " D e2e/flows/old.spec.ts", "R  e2e/flows/b.spec.ts", "e2e/flows/a.spec.ts", ""].join("\0");
  assert.deepEqual(parsePorcelainZ(out), [
    { path: "e2e/flows/new.spec.ts", deleted: false, untracked: true },
    { path: "e2e/fixtures.ts", deleted: false, untracked: false },
    { path: "e2e/flows/old.spec.ts", deleted: true, untracked: false },
    { path: "e2e/flows/b.spec.ts", deleted: false, untracked: false },
  ]);
});

test("publish exports copies, the patch and a manifest, and reports changed", async () => {
  const { adapter, calls, fs, excludesWritten } = harness(["?? e2e/flows/a.spec.ts", " M e2e/.qa/manifest.json", ""].join("\0"));
  const res = await adapter.publish({ mirrorDir: "/mirrors/org__app", branch: "qa/e2e-abc", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.deepEqual(excludesWritten, [["/mirrors/org__app", ["node_modules/", "e2e/.qa/coverage/"]]]);
  assert.deepEqual(calls[0], ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--", "e2e"]);
  assert.deepEqual(fs.copies, [
    ["/mirrors/org__app/e2e/flows/a.spec.ts", "/exports/app/ns-1/files/e2e/flows/a.spec.ts"],
    ["/mirrors/org__app/e2e/.qa/manifest.json", "/exports/app/ns-1/files/e2e/.qa/manifest.json"],
  ]);
  assert.match(fs.files.get("/exports/app/ns-1/changes.patch") ?? "", /^diff --git/);
  const manifest = JSON.parse(fs.files.get("/exports/app/ns-1/export.json") ?? "{}");
  assert.equal(manifest.sha, "abc1234");
  assert.equal(manifest.baseBranch, "main");
  assert.deepEqual(manifest.files, ["e2e/flows/a.spec.ts", "e2e/.qa/manifest.json"]);
});

test("publish stages untracked files only as intent-to-add and resets them afterwards", async () => {
  const { adapter, calls } = harness(["?? e2e/flows/a.spec.ts", ""].join("\0"));
  await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });
  const verbs = calls.map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(verbs, ["status --porcelain", "add --intent-to-add", "diff --binary", "reset -q"]);
});

test("the intent-to-add reset still runs when the diff throws, and the error surfaces", async () => {
  const { adapter, calls } = harness(["?? e2e/flows/a.spec.ts", ""].join("\0"), { diffThrows: true });
  await assert.rejects(adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" }), /diff exploded/);
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ["reset", "-q"]);
});

test("publish with no changes reports changed:false and writes nothing (the agent's no-op stays a no-op)", async () => {
  const { adapter, fs } = harness("");
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });
  assert.equal(res.changed, false);
  assert.equal(fs.files.size, 0);
  assert.equal(fs.copies.length, 0);
});

test("openWithAutoMerge writes MR.md with the body, target branch and apply steps", async () => {
  const { adapter, fs } = harness(["?? e2e/flows/a.spec.ts", ""].join("\0"));
  await adapter.publish({ mirrorDir: "/m", branch: "qa/e2e-abc", sha: "abc1234" });
  const pr = await adapter.openWithAutoMerge("group/sub/app", "qa/e2e-abc", "qa-bot: pass run", "BODY-TEXT");
  assert.equal(pr.url, "/exports/app/ns-1/MR.md");
  const md = fs.files.get("/exports/app/ns-1/MR.md") ?? "";
  assert.match(md, /^# qa-bot: pass run/);
  assert.match(md, /`group\/sub\/app`/);
  assert.match(md, /Target branch \| `main`/);
  assert.match(md, /git apply --index changes\.patch/);
  assert.match(md, /BODY-TEXT/);
  assert.doesNotMatch(md, /Shadow preview/);
});

test("open writes ISSUE.md", async () => {
  const { adapter, fs } = harness("");
  const issue = await adapter.open("group/app", "qa-bot: fail run", "FAILURE-DETAILS");
  assert.equal(issue.url, "/exports/app/ns-1/ISSUE.md");
  assert.match(fs.files.get("/exports/app/ns-1/ISSUE.md") ?? "", /FAILURE-DETAILS/);
});

test("shadow openPr exports from the primary mirror and flags the request as a preview", async () => {
  const { adapter, fs, calls } = harness(["?? e2e/flows/a.spec.ts", ""].join("\0"));
  await adapter.openPr("group/app", "qa/e2e-abc", "qa-bot: pass run", "BODY");
  assert.equal(calls[0]?.[0], "status");
  assert.deepEqual(fs.copies[0], ["/mirrors/org__app/e2e/flows/a.spec.ts", "/exports/app/ns-1/files/e2e/flows/a.spec.ts"]);
  assert.match(fs.files.get("/exports/app/ns-1/MR.md") ?? "", /Shadow preview/);
});

test("shadow openIssue flags the issue as a preview", async () => {
  const { adapter, fs } = harness("");
  await adapter.openIssue("group/app", "t", "b");
  assert.match(fs.files.get("/exports/app/ns-1/ISSUE.md") ?? "", /Shadow preview/);
});

test("the change scan and the patch never let git enter a submodule", async () => {
  const { adapter, calls } = harness("?? e2e/flows/a.spec.ts\0");
  await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });
  const status = calls.find((c) => c[0] === "status");
  const diff = calls.find((c) => c[0] === "diff");
  assert.ok(status?.includes("--ignore-submodules=dirty"));
  assert.ok(diff?.includes("--ignore-submodules=dirty"));
});

test("a path the code-target denylist covers is neither copied nor patched, and is named in the export metadata", async () => {
  const status = ["?? e2e/flows/a.spec.ts", "?? .github/workflows/ci.yml", " M Dockerfile", " D e2e/.env", ""].join("\0");
  const { adapter, calls, fs } = harness(status);
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.deepEqual(
    fs.copies.map(([src]) => src),
    ["/m/e2e/flows/a.spec.ts"],
  );
  const diffPaths = calls.find((c) => c[0] === "diff")?.slice(calls.find((c) => c[0] === "diff")!.indexOf("--") + 1);
  assert.deepEqual(diffPaths, ["e2e/flows/a.spec.ts"]);
  const manifest = JSON.parse(fs.files.get("/exports/app/ns-1/export.json") ?? "{}");
  assert.deepEqual(manifest.files, ["e2e/flows/a.spec.ts"]);
  assert.deepEqual(manifest.deleted, []);
  assert.deepEqual([...manifest.skipped].sort(), [".github/workflows/ci.yml", "Dockerfile", "e2e/.env"]);
});

test("when every change is skipped nothing is diffed (an empty pathspec would diff the whole tree) and nothing is reported as changed", async () => {
  const { adapter, calls, fs } = harness("?? .github/workflows/ci.yml\0");
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, false);
  assert.deepEqual(res.leftOut?.map((l) => l.path), [".github/workflows/ci.yml"]);
  assert.equal(calls.some((c) => c[0] === "diff" || c[0] === "add"), false);
  assert.equal(fs.files.has("/exports/app/ns-1/changes.patch"), false);
  const manifest = JSON.parse(fs.files.get("/exports/app/ns-1/export.json") ?? "{}");
  assert.deepEqual(manifest.skipped, [".github/workflows/ci.yml"]);
});

function allFileContents(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFileContents(path));
    else out.push(readFileSync(path, "utf8"));
  }
  return out;
}

function realFsHarness(root: string, status: string) {
  const calls: string[][] = [];
  const mirror = join(root, "mirror");
  const exportDir = join(root, "export");
  mkdirSync(join(mirror, "e2e"), { recursive: true });
  const adapter = new LocalExportPublicationAdapter({
    exportDir,
    mirrorDir: mirror,
    baseBranch: "main",
    addPaths: ["e2e"],
    excludes: [],
    git: async (args) => {
      calls.push(args);
      return args[0] === "status" ? status : "";
    },
    writeExcludes: () => {},
    containsSecret: () => false,
    fs: nodeLocalExportFs,
    log: () => {},
  });
  return { adapter, calls, mirror, exportDir };
}

const SECRET = "SECRET-TOKEN-VALUE";

test("a symlink the sandbox planted in e2e/ never exports the file it points at", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-export-link-"));
  try {
    writeFileSync(join(root, "secret.txt"), SECRET);
    const { adapter, calls, mirror, exportDir } = realFsHarness(root, "?? e2e/leak\0?? e2e/ok.spec.ts\0");
    writeFileSync(join(mirror, "e2e", "ok.spec.ts"), "test('ok')");
    symlinkSync(join(root, "secret.txt"), join(mirror, "e2e", "leak"));

    const res = await adapter.publish({ mirrorDir: mirror, branch: "b", sha: "abc1234" });

    assert.equal(res.changed, true);
    assert.equal(readFileSync(join(exportDir, "files", "e2e", "ok.spec.ts"), "utf8"), "test('ok')");
    assert.equal(existsSync(join(exportDir, "files", "e2e", "leak")), false);
    assert.equal(allFileContents(exportDir).some((c) => c.includes(SECRET)), false);
    const manifest = JSON.parse(readFileSync(join(exportDir, "export.json"), "utf8"));
    assert.deepEqual(manifest.files, ["e2e/ok.spec.ts"]);
    assert.deepEqual(manifest.skipped, ["e2e/leak"]);
    const diff = calls.find((c) => c[0] === "diff") ?? [];
    assert.equal(diff.includes("e2e/leak"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a regular file reached through a symlinked directory is not exported either", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-export-dirlink-"));
  try {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "secret.txt"), SECRET);
    const { adapter, mirror, exportDir } = realFsHarness(root, "?? e2e/linked/secret.txt\0");
    symlinkSync(join(root, "outside"), join(mirror, "e2e", "linked"));

    const res = await adapter.publish({ mirrorDir: mirror, branch: "b", sha: "abc1234" });

    assert.equal(res.changed, false);
    assert.deepEqual(res.leftOut?.map((l) => l.path), ["e2e/linked/secret.txt"]);
    assert.equal(allFileContents(exportDir).some((c) => c.includes(SECRET)), false);
    const manifest = JSON.parse(readFileSync(join(exportDir, "export.json"), "utf8"));
    assert.deepEqual(manifest.skipped, ["e2e/linked/secret.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial export names what it left out so the caller can tell it from a complete one", async () => {
  const { adapter } = harness(["?? e2e/flows/a.spec.ts", "?? Dockerfile", ""].join("\0"));
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.deepEqual(res.leftOut?.map((l) => l.path), ["Dockerfile"]);
});

test("a complete export carries no left-out list", async () => {
  const { adapter } = harness("?? e2e/flows/a.spec.ts\0");
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.leftOut, undefined);
});

test("MR.md has a Left out section with each name and its reason, and never the content", async () => {
  const { adapter, fs } = harness(["?? e2e/flows/a.spec.ts", "?? .github/workflows/ci.yml", "?? e2e/flows/leaky.spec.ts", ""].join("\0"), {
    containsSecret: (text) => text.includes("LEAK-MARKER"),
  });
  mirrorFiles.set("/m/e2e/flows/leaky.spec.ts", "const k = 'LEAK-MARKER'");
  await adapter.publish({ mirrorDir: "/m", branch: "qa/e2e-abc", sha: "abc1234" });
  await adapter.openWithAutoMerge("group/app", "qa/e2e-abc", "qa-bot: pass run", "BODY");

  const md = fs.files.get("/exports/app/ns-1/MR.md") ?? "";
  const section = md.slice(md.indexOf("## Left out"));
  assert.ok(md.includes("## Left out"));
  assert.ok(section.includes(".github/workflows/ci.yml"));
  assert.ok(section.includes("e2e/flows/leaky.spec.ts"));
  assert.match(section, /contains a secret/);
  assert.equal(md.includes("LEAK-MARKER"), false);
});

test("MR.md has no Left out section when nothing was left out", async () => {
  const { adapter, fs } = harness("?? e2e/flows/a.spec.ts\0");
  await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });
  await adapter.openWithAutoMerge("group/app", "b", "t", "BODY");

  assert.equal((fs.files.get("/exports/app/ns-1/MR.md") ?? "").includes("## Left out"), false);
});

test("a file whose content carries a secret is neither copied nor patched, and is left out as such", async () => {
  const { adapter, calls, fs } = harness(["?? e2e/flows/a.spec.ts", "?? e2e/flows/leaky.spec.ts", ""].join("\0"), {
    containsSecret: (text) => text.includes("LEAK-MARKER"),
  });
  mirrorFiles.set("/m/e2e/flows/leaky.spec.ts", "const k = 'LEAK-MARKER'");
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.deepEqual(fs.copies.map(([src]) => src), ["/m/e2e/flows/a.spec.ts"]);
  assert.deepEqual(res.leftOut, [{ path: "e2e/flows/leaky.spec.ts", reason: "contains a secret" }]);
  const diff = calls.find((c) => c[0] === "diff") ?? [];
  assert.equal(diff.includes("e2e/flows/leaky.spec.ts"), false);
  assert.equal([...fs.files.values()].some((c) => c.includes("LEAK-MARKER")), false);
});

test("when every file carries a secret nothing is exported and the result says so", async () => {
  const { adapter, fs } = harness("?? e2e/flows/leaky.spec.ts\0", { containsSecret: (text) => text.includes("LEAK-MARKER") });
  mirrorFiles.set("/m/e2e/flows/leaky.spec.ts", "LEAK-MARKER");
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, false);
  assert.equal(res.leftOut?.length, 1);
  assert.equal(fs.files.has("/exports/app/ns-1/changes.patch"), false);
});

test("a secret that only the patch carries (an added line of a tracked file) takes that file out of the patch, not the others", async () => {
  const diff = (args: string[]): string => {
    const paths = args.slice(args.indexOf("--") + 1);
    return paths.map((p) => (p === "e2e/flows/old.spec.ts" ? patchOf(p, ["+const k = 'LEAK-MARKER'"]) : patchOf(p, ["+ok"]))).join("");
  };
  const { adapter, fs } = harness([" M e2e/flows/a.spec.ts", " M e2e/flows/old.spec.ts", ""].join("\0"), {
    containsSecret: (text) => text.includes("LEAK-MARKER"),
    diff,
  });
  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.deepEqual(res.leftOut, [{ path: "e2e/flows/old.spec.ts", reason: "contains a secret" }]);
  const patch = fs.files.get("/exports/app/ns-1/changes.patch") ?? "";
  assert.ok(patch.includes("e2e/flows/a.spec.ts"));
  assert.equal(patch.includes("LEAK-MARKER"), false);
  const manifest = JSON.parse(fs.files.get("/exports/app/ns-1/export.json") ?? "{}");
  assert.deepEqual(manifest.files, ["e2e/flows/a.spec.ts"]);
  assert.deepEqual(manifest.skipped, ["e2e/flows/old.spec.ts"]);
});

/* A unified diff of one text file, as `git diff --binary HEAD` prints it: `body` holds the hunk lines, the header counts follow from them. */
function patchOf(path: string, body: readonly string[]): string {
  const old = body.filter((l) => !l.startsWith("+")).length;
  const added = body.filter((l) => !l.startsWith("-")).length;
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${old} +1,${added} @@\n${body.join("\n")}\n`;
}

const LEAKS = (text: string): boolean => text.includes("LEAK-MARKER");

test("only the lines a change adds are screened: a literal already in the file, or removed from it, does not hold the export back", async () => {
  const seen: string[] = [];
  const diff = () => patchOf("e2e/fixtures.ts", [" const PRE_EXISTING = 'LEAK-MARKER';", "-const REMOVED = 'LEAK-MARKER';", "+const ADDED = 'fine';"]);
  const { adapter } = harness(" M e2e/fixtures.ts\0", { containsSecret: (text) => (seen.push(text), LEAKS(text)), diff });
  mirrorFiles.set("/m/e2e/fixtures.ts", "const PRE_EXISTING = 'LEAK-MARKER';\nconst ADDED = 'fine';\n");

  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.equal(res.leftOut, undefined);
  assert.ok(seen.length > 0 && seen.every((text) => !LEAKS(text)), "nothing but the added line reached the screen");
});

test("a secret on an added line of a tracked file is caught", async () => {
  const diff = () => patchOf("e2e/fixtures.ts", [" const keep = 1;", "+const k = 'LEAK-MARKER';"]);
  const { adapter } = harness(" M e2e/fixtures.ts\0", { containsSecret: LEAKS, diff });

  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, false);
  assert.deepEqual(res.leftOut, [{ path: "e2e/fixtures.ts", reason: "contains a secret" }]);
});

test("a new file is screened whole: all of its lines are added", async () => {
  const { adapter } = harness("?? e2e/flows/leaky.spec.ts\0", { containsSecret: LEAKS });
  mirrorFiles.set("/m/e2e/flows/leaky.spec.ts", "const k = 'LEAK-MARKER'");

  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.deepEqual(res.leftOut, [{ path: "e2e/flows/leaky.spec.ts", reason: "contains a secret" }]);
});

test("a binary patch body is never screened", async () => {
  const seen: string[] = [];
  const diff = () => "diff --git a/e2e/assets/logo.png b/e2e/assets/logo.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 12\nzcmZQzLEAK-MARKERzzzz\n\nliteral 0\nHcmV?d00001\n\n";
  const { adapter } = harness("?? e2e/assets/logo.png\0", { containsSecret: (text) => (seen.push(text), false), diff });
  mirrorFiles.set("/m/e2e/assets/logo.png", "binary");

  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.ok(seen.every((text) => !LEAKS(text) && !text.includes("zcmZQz")), "the base85 body stays out of the screen");
});

test("deleting a file that held a secret exports the deletion: removed lines leave nothing new", async () => {
  const diff = () => patchOf("e2e/flows/old.spec.ts", ["-const k = 'LEAK-MARKER';"]);
  const { adapter } = harness(" D e2e/flows/old.spec.ts\0", { containsSecret: LEAKS, diff });

  const res = await adapter.publish({ mirrorDir: "/m", branch: "b", sha: "abc1234" });

  assert.equal(res.changed, true);
  assert.equal(res.leftOut, undefined);
});

const NEW_FILE_HEADER = "diff --git a/e2e/n.ts b/e2e/n.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/e2e/n.ts\n";

test("addedLinesOfPatch returns every line of a new file", () => {
  assert.equal(addedLinesOfPatch(`${NEW_FILE_HEADER}@@ -0,0 +1,2 @@\n+one\n+two\n`), "one\ntwo");
});

test("addedLinesOfPatch leaves context and removed lines out, across hunks and files", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " ctx-a", "-old-a", "+new-a", " ctx-a2",
    "@@ -10,1 +10,3 @@", " ctx-b", "+new-b", "+new-b2",
    "diff --git a/c.ts b/c.ts", "--- a/c.ts", "+++ b/c.ts", "@@ -1 +1 @@", "-old-c", "+new-c", "",
  ].join("\n");

  assert.equal(addedLinesOfPatch(patch), "new-a\nnew-b\nnew-b2\nnew-c");
});

test("addedLinesOfPatch keeps an added line that looks like a file header, a hunk header or a diff header", () => {
  const body = ["+++ b/evil", "+@@ -1 +1 @@", "+diff --git a/x b/x", "+--- a/x"];

  assert.equal(addedLinesOfPatch(`${NEW_FILE_HEADER}@@ -0,0 +1,4 @@\n${body.join("\n")}\n`), ["++ b/evil", "@@ -1 +1 @@", "diff --git a/x b/x", "--- a/x"].join("\n"));
});

test("addedLinesOfPatch skips binary patch bodies and the 'no newline' marker", () => {
  const patch = `${NEW_FILE_HEADER}@@ -0,0 +1 @@\n+text\n\\ No newline at end of file\ndiff --git a/b.bin b/b.bin\nindex 1..2 100644\nGIT binary patch\nliteral 5\nzcmZQz\n\nliteral 0\nHcmV?d00001\n\n`;

  assert.equal(addedLinesOfPatch(patch), "text");
});

test("addedLinesOfPatch reads a hunk it cannot follow whole, so nothing is skipped by accident", () => {
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n-old\n+new\nnot a hunk line\n";

  const text = addedLinesOfPatch(patch);

  assert.ok(text.includes("old") && text.includes("new") && text.includes("not a hunk line"));
});

test("addedLinesOfPatch of an empty patch is empty", () => {
  assert.equal(addedLinesOfPatch(""), "");
});

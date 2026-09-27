import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalExportPublicationAdapter,
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
  };
}

function harness(statusOut: string, opts: { diffThrows?: boolean } = {}) {
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
        return "diff --git a/e2e/flows/a.spec.ts b/e2e/flows/a.spec.ts\n";
      }
      return "";
    },
    writeExcludes: (dir, patterns) => void excludesWritten.push([dir, patterns]),
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
  assert.deepEqual(calls[0], ["status", "--porcelain", "-z", "--untracked-files=all", "--", "e2e"]);
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

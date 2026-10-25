/* Co-change is a history question: which files changed in the same commits as the changed ones, before the run's commit.
   Bulk commits couple everything with everything and are ignored; weak or one-off couplings are not reported. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BULK_COMMIT_FILES, GitCoChangeAdapter, couplingOf, parseHistory } from "../../../src/shared-infrastructure/code-graph/git-co-change.adapter.ts";
import { SandboxedBinaryRunnerAdapter } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { BlastRadius } from "../../../src/shared-kernel/blast-radius.ts";
import { Sha } from "../../../src/shared-kernel/sha.ts";
import { closeGitDir, git } from "../process-sandbox/git-fixtures.ts";

const commit = (date: string, ...files: string[]) => ({ date, files });

test("a file is coupled when it changed with a changed file at least twice and in enough of its commits; the strongest changed file decides", () => {
  const history = [
    commit("2026-10-05", "a.ts", "b.ts"),
    commit("2026-10-04", "a.ts", "b.ts", "c.ts"),
    commit("2026-10-03", "a.ts", "c.ts"),
    commit("2026-10-02", "a.ts"),
    commit("2026-10-01", "d.ts", "b.ts"),
  ];

  assert.deepEqual(couplingOf(history, ["a.ts"]), [
    { file: "b.ts", couplingScore: 0.5, coChanges: 2, lastCoChange: "2026-10-05" },
    { file: "c.ts", couplingScore: 0.5, coChanges: 2, lastCoChange: "2026-10-04" },
  ]);
  assert.deepEqual(couplingOf(history, ["d.ts"]), [], "one co-change is no coupling");
});

test("the changed files themselves are never reported, and bulk commits are ignored", () => {
  const bulk = commit("2026-10-09", "a.ts", "z.ts", ...Array.from({ length: BULK_COMMIT_FILES }, (_, i) => `gen/${i}.ts`));
  const history = [bulk, bulk, commit("2026-10-02", "a.ts", "b.ts"), commit("2026-10-01", "a.ts", "b.ts")];

  const coupled = couplingOf(history, ["a.ts", "b.ts"]);

  assert.deepEqual(coupled, []);
});

test("parseHistory reads one commit per record with its date and de-duplicated files", () => {
  const out = "\u001e2026-10-02T10:00:00+00:00\n\na.ts\nb.ts\na.ts\n\u001e2026-10-01T10:00:00+00:00\n\nc.ts\n";
  assert.deepEqual(parseHistory(out), [
    { date: "2026-10-02T10:00:00+00:00", files: ["a.ts", "b.ts"] },
    { date: "2026-10-01T10:00:00+00:00", files: ["c.ts"] },
  ]);
});

test("the adapter reads the run's commit's ancestors through git, the commit itself excluded", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-cochange-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const touch = (msg: string, ...files: string[]) => {
      for (const f of files) writeFileSync(join(repo, f), `${msg}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", msg);
    };
    touch("one", "a.ts", "b.ts");
    touch("two", "a.ts", "b.ts");
    touch("three", "a.ts", "c.ts");
    touch("head", "a.ts", "c.ts");
    closeGitDir(repo);
    const head = git(repo, "rev-parse", "HEAD");

    const result = await new GitCoChangeAdapter(new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() })).coChangeCoupling(repo, BlastRadius.of(Sha.of(head), ["a.ts"]));

    assert.ok(result.ok, result.ok ? "" : result.error.reason);
    assert.deepEqual(result.value.map((c) => [c.file, c.coChanges]), [["b.ts", 2]], "c.ts co-changed once before the run's commit; the run's commit does not count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty change asks git nothing, and a git failure is unavailable, never an empty list", async () => {
  let asked = 0;
  const failing = { run: async () => { asked++; return { exitCode: 128, stdout: "", stderr: "fatal: bad object", timedOut: false }; } };
  const adapter = new GitCoChangeAdapter(failing);

  assert.deepEqual(await adapter.coChangeCoupling("/repo", BlastRadius.of(Sha.of("abc1234"), [])), { ok: true, value: [] });
  assert.equal(asked, 0);

  const root = mkdtempSync(join(tmpdir(), "cg-cochange-fail-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    closeGitDir(repo);
    const failed = await adapter.coChangeCoupling(repo, BlastRadius.of(Sha.of("abc1234"), ["a.ts"]));
    assert.equal(asked, 1);
    assert.deepEqual(failed, { ok: false, error: { reason: "git log exited 128: fatal: bad object" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("when the run's commit is a merge, only the merge itself is left out: every real commit of both parents still counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-cochange-merge-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    /* a.ts is changed on both sides of the merge, on lines far apart, so the merge is clean. */
    const base = Array.from({ length: 40 }, (_, n) => `line ${n}`);
    const touch = (msg: string, line: number, ...others: string[]) => {
      const next = [...base];
      next[line] = msg;
      writeFileSync(join(repo, "a.ts"), `${next.join("\n")}\n`);
      for (const f of others) writeFileSync(join(repo, f), `${msg}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", msg);
    };
    touch("one", 1, "b.ts");
    touch("two", 2, "b.ts");
    const main = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    git(repo, "checkout", "-qb", "feature");
    touch("f1", 35, "d.ts");
    touch("f2", 36, "d.ts");
    git(repo, "checkout", "-q", main);
    touch("m1", 3, "e.ts");
    touch("m2", 4, "e.ts");
    git(repo, "merge", "-q", "--no-ff", "feature", "-m", "merge feature");
    closeGitDir(repo);
    const head = git(repo, "rev-parse", "HEAD");

    const result = await new GitCoChangeAdapter(new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() })).coChangeCoupling(repo, BlastRadius.of(Sha.of(head), ["a.ts"]));

    assert.ok(result.ok, result.ok ? "" : result.error.reason);
    assert.deepEqual(result.value.map((c) => [c.file, c.coChanges]).sort(), [["b.ts", 2], ["d.ts", 2], ["e.ts", 2]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run on the repository's first commit has no history, never the checked-out branch's", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-cochange-root-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.ts"), "1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    const first = git(repo, "rev-parse", "HEAD");
    for (const n of ["2", "3"]) { writeFileSync(join(repo, "a.ts"), `${n}\n`); git(repo, "commit", "-qam", n); }
    closeGitDir(repo);

    const result = await new GitCoChangeAdapter(new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() })).coChangeCoupling(repo, BlastRadius.of(Sha.of(first), ["a.ts"]));

    assert.ok(result.ok, result.ok ? "" : result.error.reason);
    assert.deepEqual(result.value, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* assembleChangeCoverage() turns CoverageCollectorPort's raw CoverageReport + the run's diff into
   the ChangeCoverage read-model DecideCoverageService.decide() consumes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffHunks,
  computeChangeCoverage,
  assembleChangeCoverage,
} from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageReport } from "@contexts/objective-signal/domain/coverage-collector.ts";

function lines(m: Map<string, Set<number>>): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort((a, b) => a - b);
  return o;
}

/* ── parseDiffHunks parity ────────────────────────────────────────────────────────────────────── */

test("parseDiffHunks: added lines numbered on the new side, context advances, deletions don't", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -10,3 +10,4 @@ ctx",
    " keep10",
    "-removed",
    "+added11",
    "+added12",
    " keep13",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "src/foo.ts": [11, 12] });
});

test("parseDiffHunks: multiple files and hunks, ignores /dev/null (deleted file)", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,2 @@",
    "+x",
    "+y",
    "diff --git a/gone.ts b/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-old1",
    "-old2",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [1, 2] });
});

/* With -U0 a pure-deletion hunk declares zero new-side lines, so its removed lines arrive while the
   parser waits for the next header: they must not rename the file the next hunk belongs to. */
test("parseDiffHunks: in a -U0 diff, a pure-deletion hunk's removed lines do not rename the file of the next hunk", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -3 +2,0 @@",
    "-const removed = true;",
    "@@ -10,0 +10 @@",
    "+const added = true;",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "src/app.ts": [10] });
});

test("parseDiffHunks: a NEW file (all-added hunk) numbers lines starting at 1", () => {
  const diff = [
    "diff --git a/new.ts b/new.ts",
    "+++ b/new.ts",
    "@@ -0,0 +1,3 @@",
    "+line1",
    "+line2",
    "+line3",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "new.ts": [1, 2, 3] });
});

test("parseDiffHunks: a hunk CONTENT line starting with '+++ ' is NOT misread as a header", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,3 @@",
    " title",
    "+```diff",
    "++++ b/other.ts",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "README.md": [2, 3] });
});

test("parseDiffHunks: a plain unified diff (no git header, unprefixed paths, timestamped file headers) maps added lines to the file", () => {
  const diff = [
    "--- src/lib/cart.ts\t2026-01-01 10:00:00.000000000 +0000",
    "+++ src/lib/cart.ts\t2026-01-02 11:30:00.000000000 +0000",
    "@@ -1,2 +1,3 @@",
    " keep1",
    "+added2",
    " keep3",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "src/lib/cart.ts": [2] });
});

test("parseDiffHunks: each file of a multi-file plain unified diff keeps its own added lines", () => {
  const diff = [
    "--- src/a.ts\t2026-01-01 10:00:00.000000000 +0000",
    "+++ src/a.ts\t2026-01-02 11:30:00.000000000 +0000",
    "@@ -1,3 +1,3 @@",
    " keep1",
    "+added2",
    " keep3",
    "-removed",
    "--- src/b.ts\t2026-01-01 10:00:00.000000000 +0000",
    "+++ src/b.ts\t2026-01-02 11:30:00.000000000 +0000",
    "@@ -4 +4,2 @@",
    " keep4",
    "+added5",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "src/a.ts": [2], "src/b.ts": [5] });
});

test("parseDiffHunks: a hunk whose counts are omitted holds one line per side, then the next file header opens", () => {
  const diff = ["--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-old", "+new", "--- b.ts", "+++ b.ts", "@@ -1,1 +1,2 @@", " keep", "+added"].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [1], "b.ts": [2] });
});

test("parseDiffHunks: a deleted file in a plain unified diff does not swallow the next file's added lines", () => {
  const diff = ["--- gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x", "-y", "--- b.ts", "+++ b.ts", "@@ -0,0 +1 @@", "+added"].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "b.ts": [1] });
});

test("parseDiffHunks: a 'diff --git' line starts the next file even after a hunk cut short of its declared count", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "+++ b/a.ts",
    "@@ -1,5 +1,6 @@",
    " keep1",
    "+added2",
    "diff --git a/b.ts b/b.ts",
    "+++ b/b.ts",
    "@@ -0,0 +1 @@",
    "+added1",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [2], "b.ts": [1] });
});

test("parseDiffHunks: inside a hunk, a removed '-- ' line and an added '++ ' line are content, not a file header", () => {
  const diff = ["--- q.sql", "+++ q.sql", "@@ -1,2 +1,2 @@", " select 1;", "--- old note", "+++ new note"].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "q.sql": [2] });
});

test("parseDiffHunks: a CRLF-terminated diff names the file without the carriage return", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " keep", "+added"].join("\r\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [2] });
});

test("parseDiffHunks: hunk headers with an omitted count (single-line ranges) still open a hunk", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -3 +3 @@", "-old", "+new", "@@ -9,2 +9 @@", "-gone", " kept"].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [3] });
});

test("parseDiffHunks: hunk headers with multi-digit counts open a hunk", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -100,12 +120,13 @@", " ctx", "+added"].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [121] });
});

test("parseDiffHunks: an added line whose text looks like a hunk header is counted as content", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,3 @@",
    " ctx",
    "+const marker = \"@@ -1,1 +40,1 @@\";",
    "+after",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [2, 3] });
});

test("parseDiffHunks: a 'No newline at end of file' marker does not advance the new-side line number", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1,2 @@",
    "-last",
    "\\ No newline at end of file",
    "+last",
    "+added",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [1, 2] });
});

/* ── computeChangeCoverage intersection math parity ──────────────────────────────────────────── */

test("computeChangeCoverage: intersects, reports uncovered, computes ratio", () => {
  const changed = new Map([["a.ts", new Set([1, 2, 3, 4])]]);
  const covered = new Map([["a.ts", new Set([1, 2, 9])]]);
  const cc = computeChangeCoverage(changed, covered);
  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 4);
  assert.equal(cc.overall.coveredChanged, 2);
  assert.equal(cc.overall.ratio, 0.5);
  assert.deepEqual(cc.uncovered, [{ file: "a.ts", lines: [3, 4] }]);
  assert.equal(cc.branches, null); /* the port carries no branch-coverage signal (yet) */
});

test("computeChangeCoverage: a changed file with NO coverage data → measured stays false", () => {
  const cc = computeChangeCoverage(new Map([["a.ts", new Set([1, 2])]]), new Map());
  assert.equal(cc.measured, false);
  assert.equal(cc.overall.ratio, 0);
});

test("computeChangeCoverage: perFile ratios and multi-file intersection", () => {
  const changed = new Map([
    ["a.ts", new Set([1, 2, 3, 4])],
    ["b.ts", new Set([10, 11])],
  ]);
  const covered = new Map([
    ["a.ts", new Set([1, 2, 3])],
    ["b.ts", new Set([10, 11])],
  ]);
  const cc = computeChangeCoverage(changed, covered);
  const perFile = [...cc.perFile].sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(perFile, [
    { file: "a.ts", changed: 4, covered: 3, ratio: 0.75 },
    { file: "b.ts", changed: 2, covered: 2, ratio: 1 },
  ]);
});

test("computeChangeCoverage: a fully covered file is not listed as uncovered", () => {
  const changed = new Map([
    ["a.ts", new Set([1, 2])],
    ["b.ts", new Set([10, 11])],
  ]);
  const covered = new Map([
    ["a.ts", new Set([1])],
    ["b.ts", new Set([10, 11])],
  ]);
  const cc = computeChangeCoverage(changed, covered);
  assert.deepEqual(cc.uncovered.map((u) => u.file), ["a.ts"]);
});

test("computeChangeCoverage: uncovered lines are reported in ascending order whatever order they were collected in", () => {
  const cc = computeChangeCoverage(new Map([["a.ts", new Set([30, 4, 12, 5])]]), new Map([["a.ts", new Set<number>()]]));
  assert.deepEqual(cc.uncovered, [{ file: "a.ts", lines: [4, 5, 12, 30] }]);
});

/* ── report-shape conversion (CoverageReport [{file,lines}] -> Map<string, Set<number>>) ───────── */

test("assembleChangeCoverage: converts CoverageReport's array-of-objects shape and intersects with the diff", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,3 @@",
    "+line1",
    "+line2",
    "+line3",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1, 2] }] };

  const cc = assembleChangeCoverage(diff, report);

  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 3);
  assert.equal(cc.overall.coveredChanged, 2);
  assert.deepEqual(cc.uncovered, [{ file: "src/checkout.ts", lines: [3] }]);
});

test("assembleChangeCoverage: a file in the report that the diff never touched contributes nothing", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +1,1 @@",
    "+x",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/unrelated.ts", lines: [1, 2, 3] }] };

  const cc = assembleChangeCoverage(diff, report);

  assert.equal(cc.measured, false); /* a.ts (the only changed file) has no matching report entry */
  assert.equal(cc.overall.changedLines, 1);
  assert.equal(cc.overall.coveredChanged, 0);
});

/* ── zero-changed-lines semantics (decide() -> "unknown") ───────────────────────── */

test("assembleChangeCoverage: a diff with no added lines (pure deletion) → measured but decide() reads unknown", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +0,0 @@", "-x", "-y"].join("\n");
  const report: CoverageReport = { covered: [] };

  const cc = assembleChangeCoverage(diff, report);
  assert.equal(cc.overall.changedLines, 0);

  const svc = new DecideCoverageService();
  const status = svc.decide(cc, { mode: "enforce", minRatio: 0.7 });
  assert.equal(status, "unknown", "zero changed lines must decide to unknown");
  assert.equal(svc.blocks(status, { mode: "enforce", minRatio: 0.7 }), false, "unknown must never block, even in enforce mode");
});

/* ── MUTATION-PROOF: the keystone actually gates on real ratios ────────────────────────────────── */

test("KEYSTONE: uncovered diff lines under a real assembler → decide() returns fail under enforce, and blocks publish", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,4 @@",
    "+a",
    "+b",
    "+c",
    "+d",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1] }] };

  const cc = assembleChangeCoverage(diff, report);
  const svc = new DecideCoverageService();
  const policy = { mode: "enforce" as const, minRatio: 0.7 };
  const status = svc.decide(cc, policy);

  assert.equal(status, "fail");
  assert.equal(svc.blocks(status, policy), true, "enforce mode must block publish on a real coverage gap");
});

test("KEYSTONE: the SAME uncovered gap under signal mode never blocks (records only)", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,4 @@",
    "+a",
    "+b",
    "+c",
    "+d",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1] }] };

  const cc = assembleChangeCoverage(diff, report);
  const svc = new DecideCoverageService();
  const policy = { mode: "signal" as const, minRatio: 0.7 };
  const status = svc.decide(cc, policy);

  assert.equal(status, "fail"); /* the STATUS is still fail (an honest signal)... */
  assert.equal(svc.blocks(status, policy), false, "...but signal mode must never block publish on it");
});

test("KEYSTONE: no assembler / no diff still decides unknown and NEVER blocks (unchanged safe default)", () => {
  const svc = new DecideCoverageService();
  for (const mode of ["off", "signal", "enforce"] as const) {
    const policy = { mode, minRatio: 0.7 };
    const status = svc.decide(null, policy);
    assert.equal(status, "unknown");
    assert.equal(svc.blocks(status, policy), false);
  }
});

/* ── branches: the decisions on the changed lines ─────────────────────────────────────────────── */

const BRANCH_DIFF = [
  "diff --git a/src/store.ts b/src/store.ts",
  "+++ b/src/store.ts",
  "@@ -10,0 +10,3 @@",
  "+if (status === 404) state = 'missing';",
  "+else state = 'failed';",
  "+const retry = failed && canRetry;",
].join("\n");

test("branches count the arms of the decisions on changed lines, and name the arms that never ran; a decision on an unchanged line is not the change's", () => {
  const report: CoverageReport = {
    covered: [{ file: "src/store.ts", lines: [10, 11, 12] }],
    branches: [
      { file: "src/store.ts", line: 10, column: 4, kind: "if", arms: [{ label: "then", taken: true }, { label: "else", taken: false }] },
      { file: "src/store.ts", line: 12, column: 14, kind: "logical", arms: [{ label: "right of && evaluated", taken: true }, { label: "&& short-circuited", taken: true }] },
      { file: "src/store.ts", line: 30, column: 2, kind: "if", arms: [{ label: "then", taken: false }, { label: "else", taken: false }] },
    ],
  };

  const cc = assembleChangeCoverage(BRANCH_DIFF, report);

  assert.deepEqual(cc.branches, { changedBranches: 4, takenBranches: 3, ratio: 0.75 });
  assert.deepEqual(cc.untakenArms, [{ file: "src/store.ts", line: 10, kind: "if", arm: "else" }]);
  assert.equal(cc.overall.ratio, 1, "every changed line ran: the line ratio cannot tell the else that never did");
});

test("branches are null when the report saw no decisions, or none on a changed line; they never decide the status", () => {
  const noBranches = assembleChangeCoverage(BRANCH_DIFF, { covered: [{ file: "src/store.ts", lines: [10, 11, 12] }] });
  assert.equal(noBranches.branches, null);
  assert.deepEqual(noBranches.untakenArms ?? [], []);

  const elsewhere = assembleChangeCoverage(BRANCH_DIFF, {
    covered: [{ file: "src/store.ts", lines: [10, 11, 12] }],
    branches: [{ file: "src/store.ts", line: 40, column: 0, kind: "if", arms: [{ label: "then", taken: false }, { label: "else", taken: false }] }],
  });
  assert.equal(elsewhere.branches, null);

  const allUntaken = assembleChangeCoverage(BRANCH_DIFF, {
    covered: [{ file: "src/store.ts", lines: [10, 11, 12] }],
    branches: [{ file: "src/store.ts", line: 10, column: 4, kind: "if", arms: [{ label: "then", taken: false }, { label: "else", taken: false }] }],
  });
  assert.equal(new DecideCoverageService().decide(allUntaken, { mode: "enforce", minRatio: 0.7 }), "pass", "the line ratio alone decides");
});

/* ── executable changed lines ─────────────────────────────────────────────────────────────────── */

/* src/a.ts gains an import, a blank line, two code lines and a comment; src/lazy.ts (a chunk no page loaded) gains a code line and a blank one. */
const EXECUTABLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,5 @@",
  "+import { x } from './x';",
  "+",
  "+const y = x();",
  "+run(y);",
  "+// done",
  "diff --git a/src/lazy.ts b/src/lazy.ts",
  "--- a/src/lazy.ts",
  "+++ b/src/lazy.ts",
  "@@ -0,0 +1,2 @@",
  "+go();",
  "+",
].join("\n");

test("a browser collection counts only the changed lines its scripts hold code for, and a changed file no loaded script maps counts its non-blank lines as uncovered", () => {
  const report: CoverageReport = { covered: [{ file: "src/a.ts", lines: [3] }], executable: [{ file: "src/a.ts", lines: [3, 4] }] };

  const cc = assembleChangeCoverage(EXECUTABLE_DIFF, report);

  assert.deepEqual(cc.overall, { changedLines: 3, coveredChanged: 1, ratio: 1 / 3 }, "a.ts lines 3 and 4, and lazy.ts line 1");
  assert.deepEqual(cc.uncovered, [{ file: "src/a.ts", lines: [4] }, { file: "src/lazy.ts", lines: [1] }]);
  assert.deepEqual(cc.notExecutable, [{ file: "src/a.ts", lines: [1, 2, 5] }], "the import, the blank line and the comment are not code");
  assert.deepEqual(cc.notLoaded, [{ file: "src/lazy.ts", lines: [1] }]);
});

test("a covered changed line is counted even when no segment maps code to it", () => {
  const cc = assembleChangeCoverage(EXECUTABLE_DIFF, { covered: [{ file: "src/a.ts", lines: [1] }], executable: [{ file: "src/a.ts", lines: [3] }] });

  assert.deepEqual(cc.perFile.find((f) => f.file === "src/a.ts"), { file: "src/a.ts", changed: 2, covered: 1, ratio: 0.5 });
});

test("a collection that cannot tell code from the rest counts every added line, as before", () => {
  const cc = assembleChangeCoverage(EXECUTABLE_DIFF, { covered: [{ file: "src/a.ts", lines: [3] }] });

  assert.equal(cc.overall.changedLines, 7);
  assert.equal(cc.notExecutable, undefined);
  assert.equal(cc.notLoaded, undefined);
});

test("a changed file no script can hold (a document, a style sheet) is not counted, while an unloaded file of a kind the scripts map stays uncovered", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -0,0 +1,2 @@",
    "+# Menus",
    "+Daily menus near you.",
    "diff --git a/src/card.scss b/src/card.scss",
    "--- a/src/card.scss",
    "+++ b/src/card.scss",
    "@@ -0,0 +1 @@",
    "+.card { color: red; }",
    "diff --git a/src/detail.html b/src/detail.html",
    "--- a/src/detail.html",
    "+++ b/src/detail.html",
    "@@ -0,0 +1 @@",
    "+<p>{{ day }}</p>",
    "diff --git a/src/list.html b/src/list.html",
    "--- a/src/list.html",
    "+++ b/src/list.html",
    "@@ -0,0 +1 @@",
    "+<ul></ul>",
    "diff --git a/src/lazy.ts b/src/lazy.ts",
    "--- a/src/lazy.ts",
    "+++ b/src/lazy.ts",
    "@@ -0,0 +1 @@",
    "+go();",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/list.html", lines: [1] }], executable: [{ file: "src/list.html", lines: [1] }] };

  const cc = assembleChangeCoverage(diff, report);

  assert.deepEqual(cc.overall, { changedLines: 3, coveredChanged: 1, ratio: 1 / 3 }, "list.html line 1, detail.html line 1 and lazy.ts line 1");
  assert.deepEqual(cc.notLoaded, [{ file: "src/detail.html", lines: [1] }, { file: "src/lazy.ts", lines: [1] }]);
});

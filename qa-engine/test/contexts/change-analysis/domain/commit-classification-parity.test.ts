/* Expected values are the established behavior, built by hand — change them only with a deliberate behavior change, never to silence a failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, classifyRange } from "@contexts/change-analysis/domain/commit-classification.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

test("each Conventional Commits type maps to its action, and a skip-typed commit that adds logic escalates to generate", () => {
  const cases: Array<[message: string, diff: string, expected: { type: string; hasLogicChange: boolean; contradiction: boolean; action: string }]> = [
    ["feat: x", srcDiff(["if (a) return;"]), { type: "feat", hasLogicChange: true, contradiction: false, action: "generate" }],
    ["refactor: move", srcDiff(["const moved = 1;"]), { type: "refactor", hasLogicChange: false, contradiction: false, action: "regression" }],
    ["style: format", srcDiff(["const s = \"   spaced   \";"]), { type: "style", hasLogicChange: false, contradiction: false, action: "skip" }],
    ["docs: readme", "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,1 +1,2 @@\n a\n+b", { type: "docs", hasLogicChange: false, contradiction: false, action: "skip" }],
    ["perf: faster loop", srcDiff(["for (let i=0;i<n;i++) work();"]), { type: "perf", hasLogicChange: true, contradiction: true, action: "generate" }],
  ];
  for (const [message, diff, expected] of cases) {
    const { type, hasLogicChange, contradiction, action } = classifyCommit(message, diff);
    assert.deepEqual({ type, hasLogicChange, contradiction, action }, expected, message);
  }
});

test("a logic line that moved (removed and re-added) is not net-new logic and does not escalate a refactor", () => {
  const relocatedDiff = [
    "diff --git a/src/svc.ts b/src/svc.ts",
    "--- a/src/svc.ts",
    "+++ b/src/svc.ts",
    "@@ -1,4 +1,4 @@",
    " export class S {",
    "-  if (x) return 1;",
    "+  if (x) return 1;",
    " }",
  ].join("\n");
  const { hasLogicChange, contradiction, action } = classifyCommit("refactor: move guard", relocatedDiff);
  assert.equal(hasLogicChange, false);
  assert.equal(contradiction, false);
  assert.equal(action, "regression");
});

test("a .html template diff with added logic escalates a chore commit to generate", () => {
  const d = ["diff --git a/src/index.html b/src/index.html", "--- a/src/index.html", "+++ b/src/index.html", "@@ -1,1 +1,2 @@", " <html>", "+<script>if (loggedIn) redirect();</script>"].join("\n");
  const { type, changedFiles, hasLogicChange, contradiction, action } = classifyCommit("chore: tweak markup", d);
  assert.deepEqual({ type, changedFiles, hasLogicChange, contradiction, action }, { type: "chore", changedFiles: ["src/index.html"], hasLogicChange: true, contradiction: true, action: "generate" });
});

test("an .astro template diff with added logic escalates a style commit to generate", () => {
  const d = ["diff --git a/src/pages/index.astro b/src/pages/index.astro", "--- a/src/pages/index.astro", "+++ b/src/pages/index.astro", "@@ -1,1 +1,2 @@", " ---", "+if (isAdmin) { return Astro.redirect('/admin'); }"].join("\n");
  const { type, hasLogicChange, contradiction, action } = classifyCommit("style: format", d);
  assert.deepEqual({ type, hasLogicChange, contradiction, action }, { type: "style", hasLogicChange: true, contradiction: true, action: "generate" });
});

test("a skip-typed commit that only removes logic escalates to regression and names how many lines it removed", () => {
  const d = ["diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts", "@@ -1,2 +1,1 @@", " export class S {", "-if (legacyFlag) doOldThing();", " }"].join("\n");
  const { hasLogicChange, contradiction, action, reason } = classifyCommit("chore: cleanup dead code", d);
  assert.deepEqual({ hasLogicChange, contradiction, action }, { hasLogicChange: false, contradiction: true, action: "regression" });
  assert.match(reason, /\b1 line/);
});

test("a Flyway migration escalates a chore commit to regression", () => {
  const d = [
    "diff --git a/db/migration/V2__add_column.sql b/db/migration/V2__add_column.sql",
    "--- /dev/null", "+++ b/db/migration/V2__add_column.sql",
    "@@ -0,0 +1,1 @@", "+ALTER TABLE owners ADD COLUMN loyalty_points INT;",
  ].join("\n");
  const { changedFiles, contradiction, action } = classifyCommit("chore: db update", d);
  assert.deepEqual({ changedFiles, contradiction, action }, { changedFiles: ["db/migration/V2__add_column.sql"], contradiction: true, action: "regression" });
});

test("a .sql file outside a migration path does not escalate a chore commit", () => {
  const d = ["diff --git a/scripts/adhoc-report.sql b/scripts/adhoc-report.sql", "--- a/scripts/adhoc-report.sql", "+++ b/scripts/adhoc-report.sql", "@@ -1,1 +1,2 @@", " SELECT 1;", "+SELECT 2;"].join("\n");
  const { contradiction, action } = classifyCommit("chore: report tweak", d);
  assert.deepEqual({ contradiction, action }, { contradiction: false, action: "skip" });
});

test("classifyRange with no range classifies exactly like classifyCommit", () => {
  const d = srcDiff(["if (a) return;"]);
  assert.deepEqual(classifyRange("feat: x", [], d), classifyCommit("feat: x", d));
  assert.equal(classifyRange("feat: x", [], d).action, "generate");
});

test("a feat buried under a chore head escalates the range to generate while keeping the head's intent", () => {
  const { type, message, action, reason } = classifyRange("chore: bump deps", ["feat: x"], srcDiff(["if (a) return;"]));
  assert.equal(action, "generate");
  assert.equal(type, "chore");
  assert.equal(message, "chore: bump deps");
  assert.match(reason, /\b2 commit/, "the reason names the range size");
});

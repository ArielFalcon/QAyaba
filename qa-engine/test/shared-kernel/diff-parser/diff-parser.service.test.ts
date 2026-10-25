import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

const svc = new DiffParserService();

function diff(file: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
}

test("changedLines: added lines are numbered on the new side", () => {
  const d = diff("src/a.ts", ["@@ -1,2 +1,3 @@", " ctx", "+added one", "+added two"]);
  const map = svc.changedLines(d);
  assert.deepEqual([...(map.get("src/a.ts") ?? new Set())].sort((x, y) => x - y), [2, 3]);
});

test("changedLines: pure deletion contributes no new lines (file absent)", () => {
  const d = diff("src/b.ts", ["@@ -1,2 +1,1 @@", " ctx", "-gone"]);
  const map = svc.changedLines(d);
  assert.equal(map.has("src/b.ts"), false);
});

test("changedLines: a '+++ '/'--- ' INSIDE hunk content is not mistaken for a header", () => {
  const d = diff("docs/x.md", ["@@ -1,1 +1,3 @@", " intro", "+--- a/fake", "+++ b/fake"]);
  const map = svc.changedLines(d);
  /* both added lines belong to docs/x.md, not a phantom "fake" file */
  assert.deepEqual([...(map.get("docs/x.md") ?? new Set())].sort((x, y) => x - y), [2, 3]);
  assert.equal(map.has("fake"), false);
});

test("changedFiles: every changed path (added, modified, deleted) from the diff --git headers", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(svc.changedFiles(d).sort(), ["src/added.ts", "src/mod.ts"]);
});

test("modifiedFiles: only files present on BOTH sides (a pure add is excluded)", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  /* added.ts has --- /dev/null (not --- a/...), so it is NOT a modification */
  assert.deepEqual(svc.modifiedFiles(d), ["src/mod.ts"]);
});

function htmlDiff(lines: string[], file = "src/home.component.html"): string {
  return [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    `@@ -1,3 +1,${lines.length + 2} @@`, ` <div>`, ...lines, ` </div>`,
  ].join("\n");
}

test("changedElements: data-cy → testId", () => {
  const els = svc.changedElements(htmlDiff([`+<button data-cy="submit-order">Place Order</button>`]));
  assert.ok(els.find((e) => e.testId === "submit-order"));
});

test("changedElements: routerLink literal resolves to href, not the attr name", () => {
  const els = svc.changedElements(htmlDiff([`+<a routerLink="/products">Products</a>`]));
  assert.ok(els.find((e) => e.href === "/products"));
  assert.ok(!els.some((e) => "routerLink" in (e as unknown as Record<string, unknown>)));
});

test("changedElements: bare relative routerLink (no leading / or #) is skipped", () => {
  const els = svc.changedElements(htmlDiff([`+<a routerLink="products">Products</a>`]));
  assert.equal(els.filter((e) => e.href !== undefined).length, 0);
});

test("changedElements: interpolated {{...}} text is skipped", () => {
  const els = svc.changedElements(htmlDiff([`+<button>{{ submitLabel }}</button>`]));
  assert.ok(!els.some((e) => e.text?.includes("{{")));
});

test("changedElements: pure TS diff → []", () => {
  const els = svc.changedElements(diff("src/svc.ts", ["@@ -1,2 +1,3 @@", " class X {", "+  private n = 0;", " }"]));
  assert.deepEqual(els, []);
});

test("changedElements: capped at 200 entries", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `+<button data-cy="b-${i}">x</button>`);
  const d = [`diff --git a/h.html b/h.html`, `--- a/h.html`, `+++ b/h.html`, `@@ -1,5 +1,255 @@`, ...lines].join("\n");
  assert.ok(svc.changedElements(d).length <= 200);
});

test("changedElementsFromGuidance: QA stopwords are filtered, distinctive nouns kept", () => {
  const els = svc.changedElementsFromGuidance("test the contact form");
  const texts = els.map((e) => e.text?.toLowerCase());
  assert.ok(!texts.includes("test"));
  assert.ok(!texts.includes("form"));
  assert.ok(texts.includes("contact"));
});

test("changedElementsFromGuidance: empty string → []", () => {
  assert.deepEqual(svc.changedElementsFromGuidance(""), []);
});

/* Parity tests that import from src/ live in diff-parser-parity.test.ts, which is
   excluded from qa-engine typecheck.
 */

test("touchedLines marks every added line, and a deletion at the new-side line that follows it", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,3 @@",
    " context",
    "-removed one",
    "-removed two",
    " kept",
    "+added",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-x",
    "-y",
  ].join("\n");
  const touched = new DiffParserService().touchedLines(diff);
  assert.deepEqual([...touched.keys()], ["src/a.ts"], "a deleted file touches nothing on the new side");
  assert.deepEqual([...touched.get("src/a.ts")!].sort((a, b) => a - b), [11, 12]);
});

/* git writes a path with a control character, a quote, a backslash or (core.quotepath on) a non-ASCII byte as a C-quoted string with octal escapes. */
test("a path with spaces is a changed file, and its lines are numbered under it", () => {
  const d = diff("src/my dir/a b.ts", ["@@ -1,1 +1,2 @@", " ctx", "+added"]);
  assert.deepEqual(svc.changedFiles(d), ["src/my dir/a b.ts"]);
  assert.deepEqual(svc.modifiedFiles(d), ["src/my dir/a b.ts"]);
  assert.deepEqual([...(svc.changedLines(d).get("src/my dir/a b.ts") ?? [])], [2]);
});

test("git's quoted path, octal escapes included, is the file's real name", () => {
  const d = [
    'diff --git "a/src/caf\\303\\251/\\"x\\".ts" "b/src/caf\\303\\251/\\"x\\".ts"',
    '--- "a/src/caf\\303\\251/\\"x\\".ts"',
    '+++ "b/src/caf\\303\\251/\\"x\\".ts"',
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+added",
  ].join("\n");
  const name = 'src/café/"x".ts';
  assert.deepEqual(svc.changedFiles(d), [name]);
  assert.deepEqual(svc.modifiedFiles(d), [name]);
  assert.deepEqual([...(svc.changedLines(d).get(name) ?? [])], [2]);
});

test("an added, a deleted and a renamed file with spaces are all changed files; the head path wins", () => {
  const d = [
    "diff --git a/old dir/f.ts b/new dir/f.ts", "similarity index 90%", "rename from old dir/f.ts", "rename to new dir/f.ts",
    "diff --git a/gone one.ts b/gone one.ts", "deleted file mode 100644", "--- a/gone one.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
  ].join("\n");
  assert.deepEqual(svc.changedFiles(d), ["new dir/f.ts", "gone one.ts"]);
});

test("unquoted paths without spaces parse as before", () => {
  const d = [diff("src/a.ts", ["@@ -1,1 +1,2 @@", " c", "+x"]), diff("b/b.ts", ["@@ -1,1 +1,2 @@", " c", "+y"])].join("\n");
  assert.deepEqual(svc.changedFiles(d), ["src/a.ts", "b/b.ts"]);
  assert.deepEqual(svc.modifiedFiles(d), ["src/a.ts", "b/b.ts"]);
});

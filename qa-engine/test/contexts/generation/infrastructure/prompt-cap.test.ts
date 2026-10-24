/* capDiff is a DIFF-AWARE, relevance-ordered, per-file-section capper (distinct from capText's
   flat prose truncation). See the module header in prompt-cap.ts for the full rationale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capDiff, capText, extractDiffFilePath } from "@contexts/generation/infrastructure/prompt-cap.ts";

test("capDiff returns the diff unchanged when it is within the budget", () => {
  const diff = "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(capDiff(diff, 10_000), diff);
});

/* `diff.split(/^(?=diff --git )/m)` must treat rawSections[0] as a REAL file section whenever it
   starts with `diff --git ` — not as an unconditional "preamble". Otherwise: (1) a multi-file diff
   whose first file is oversized vanishes with ZERO trace while a smaller second file survives "for
   free"; (2) a genuinely single-file diff over budget produces JUST the truncation marker with ZERO
   real content, falsely claiming "0 file(s) omitted". A TRUE preamble (content before any file
   header, e.g. a `git log -p` prefix) is the only case still unconditionally kept.
 */
test("capDiff FIX (2nd known bug): the first file section is now REAL — an oversized first file sheds and is correctly NAMED in the omitted list, not silently kept", () => {
  const fileA = "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA\n";
  const fileB = "diff --git a/src/b.ts b/src/b.ts\n@@ -1,1 +1,1 @@\n-oldB\n+newB\n";
  const diff = fileA + fileB;
  /* Budget fits fileA exactly; fileA is now subject to the SAME budget check as any other file —
     fileB no longer survives "for free" once fileA has consumed the whole budget.
   */
  const out = capDiff(diff, fileA.length);
  assert.ok(out.startsWith(fileA), "fileA's whole section is still kept first (relevance-ordered, fits within budget)");
  assert.ok(!out.includes("newB"), "FIXED: fileB no longer survives for free — the budget now genuinely applies to fileA");
  assert.ok(out.includes("1 file(s) omitted"), "FIXED: the marker correctly reports the one real omission");
  assert.ok(out.includes("src/b.ts"), "FIXED: fileB is correctly NAMED in the omitted list");
});

test("capDiff FIX (2nd known bug): an oversized FIRST file is now correctly named as omitted — no more silent, untraceable loss", () => {
  const huge1 = "diff --git a/src/huge1.ts b/src/huge1.ts\n" + "+line\n".repeat(2000);
  const small2 = "diff --git a/src/small2.ts b/src/small2.ts\n+x\n";
  const out = capDiff(huge1 + small2, 50);
  assert.ok(!out.includes("+line\n+line"), "huge1's content is still gone (correctly — it does not fit the budget)");
  assert.ok(out.includes("huge1"), "FIXED: huge1 IS now named as omitted — no more silent, untraceable loss");
  assert.ok(out.includes("small2.ts"), "small2 (the second file) still survives — it fits within the remaining budget");
});

test("capDiff FIX (2nd known bug): a genuinely single-file diff over budget now hard-truncates via the degenerate fallback instead of dropping ALL content", () => {
  const oneHugeFile = "diff --git a/src/huge.ts b/src/huge.ts\n@@ -1,1 +1,1 @@\n" + "+line\n".repeat(5000);
  const out = capDiff(oneHugeFile, 100);
  /* FIXED: a single-file diff now correctly populates `fileSections` with its one real section
     (rawSections[0] is no longer misclassified as an empty-preamble-only case), so the degenerate
     "hard-truncate the lone oversized file" fallback fires as originally intended.
   */
  assert.ok(out.includes("+line"), "FIXED: the degenerate fallback now hard-truncates real content instead of dropping everything");
  assert.ok(out.startsWith("diff --git a/src/huge.ts"), "the hard-truncated content starts with the real file's own header");
  assert.ok(out.length >= 100, "the output now carries real (truncated) diff content, not just the marker text");
});

/* The degenerate-fallback re-add computes `name = extractDiffFilePath(firstFile)` and does
   `omitted.splice(omitted.indexOf(name), 1)` with NO bounds check. When the oversized first file's
   header is malformed enough that extractDiffFilePath can't find its "b/" path (it returns ""),
   `indexOf("")` is -1 (an empty string is never a real omitted filename) and `splice(-1, 1)` deletes
   the LAST entry of `omitted` instead of doing nothing — silently un-reporting a genuinely omitted
   file that has nothing to do with the malformed one.
 */
test("capDiff FIX (splice guard): a malformed-header oversized first file must not delete an unrelated LAST omitted file", () => {
  /* No " b/..." on this header line — extractDiffFilePath fails (""); the main loop's fallback
     regex (a/-path only) still finds a name for it, so it lands in `omitted` as "bigfile.ts". */
  const bigfile = "diff --git a/bigfile.ts\n" + "+line\n".repeat(20);
  const second = "diff --git a/src/second.ts b/src/second.ts\n+x\n";
  const third = "diff --git a/src/third.ts b/src/third.ts\n+y\n";
  const out = capDiff(bigfile + second + third, 50);

  assert.ok(
    out.includes("src/third.ts"),
    "FIXED: third.ts is a genuinely separate omission and must stay reported — the unrelated malformed name lookup must not delete it",
  );
  assert.ok(out.includes("src/second.ts"), "second.ts must also still be reported as omitted");
});

/* relocated cappedDiffText can pick a per-file-section sanitize mode by extension. Same parsing
   capDiff already uses internally — no new logic.
 */
test("extractDiffFilePath extracts the post-rename (b/) path from a diff --git header", () => {
  const section = "diff --git a/src/old-name.ts b/src/new-name.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(extractDiffFilePath(section), "src/new-name.ts");
});

test("extractDiffFilePath returns an empty string when the section has no diff --git header", () => {
  assert.equal(extractDiffFilePath("no header here\n+just content\n"), "");
});

test("capText returns text unchanged when within the budget", () => {
  const text = "a short commit body";
  assert.equal(capText(text, 4000), text);
});

test("capText hard-slices and appends a truncation marker when over budget", () => {
  const text = "x".repeat(5000);
  const out = capText(text, 100);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.ok(out.includes("truncated"));
  assert.ok(out.length < text.length + 200); /* marker adds bytes but stays far under the original */
});

test("capDiff and capText are DISTINCT functions — capDiff preserves diff structure, capText does not", () => {
  assert.notEqual(capDiff, capText);
  const diffLike = "diff --git a/src/a.ts b/src/a.ts\n" + "+line\n".repeat(2000);
  const viaCapDiff = capDiff(diffLike, 200);
  const viaCapText = capText(diffLike, 200);
  /* capText slices AT the byte boundary regardless of diff structure; capDiff keeps whole sections
     or falls back to a structured omission marker — their outputs differ for the same oversized input.
   */
  assert.notEqual(viaCapDiff, viaCapText);
});

const section = (path: string, added: number, removed = 0, mode = "") =>
  `diff --git a/${path} b/${path}\n${mode}@@ -1,${removed} +1,${added} @@\n${"-gone\n".repeat(removed)}${"+line of code\n".repeat(added)}`;

test("a file the budget leaves out is still listed with its added and removed lines, and whether it is new or deleted", () => {
  const kept = section("src/a.ts", 2);
  const out = capDiff(kept + section("src/big.ts", 400, 3) + section("src/fresh.html", 300, 0, "new file mode 100644\n") + section("src/old.ts", 0, 200, "deleted file mode 100644\n"), kept.length + 10);
  assert.ok(out.includes("3 file(s) omitted"));
  assert.match(out, /src\/big\.ts \(\+400 -3\)/);
  assert.match(out, /src\/fresh\.html \(\+300 -0, new file\)/);
  assert.match(out, /src\/old\.ts \(\+0 -200, deleted\)/);
});

test("a section that does not fit does not keep out the smaller ones after it", () => {
  const small = section("src/a.ts", 2);
  const later = section("src/z.ts", 2);
  const out = capDiff(small + section("src/m.ts", 500) + later, small.length + later.length + 5);
  assert.ok(out.includes("+line of code") && out.includes("diff --git a/src/z.ts"), "the later small file is kept");
  assert.match(out, /1 file\(s\) omitted/);
  assert.match(out, /src\/m\.ts \(\+500 -0\)/);
});

test("style sheets give way to the code that defines the behaviour", () => {
  const style = section("src/a.component.scss", 20);
  const code = section("src/z.component.ts", 20);
  const out = capDiff(style + code, code.length + 5);
  assert.ok(out.includes("diff --git a/src/z.component.ts"), "the code is kept");
  assert.match(out, /src\/a\.component\.scss \(\+20 -0\)/, "the style sheet is the one listed");
});

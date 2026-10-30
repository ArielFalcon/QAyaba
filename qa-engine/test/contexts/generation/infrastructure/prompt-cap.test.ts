/* The safety bounds on free-form text (boundedEvidenceText) and the diff-section path reader. The commit diff has no cap: its window fit is
   covered by prompts.window-fit.diff.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMIT_BODY_SAFETY_BOUND, boundedEvidenceText, extractDiffFilePath } from "@contexts/generation/infrastructure/prompt-cap.ts";

test("extractDiffFilePath extracts the post-rename (b/) path from a diff --git header", () => {
  const section = "diff --git a/src/old-name.ts b/src/new-name.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(extractDiffFilePath(section), "src/new-name.ts");
});

test("extractDiffFilePath returns an empty string when the section has no diff --git header", () => {
  assert.equal(extractDiffFilePath("no header here\n+just content\n"), "");
});

test("boundedEvidenceText returns text unchanged when within the bound", () => {
  const text = "a short commit body";
  assert.equal(boundedEvidenceText(text, { maxChars: COMMIT_BODY_SAFETY_BOUND, what: "the commit body" }), text);
});

test("boundedEvidenceText cuts text past the bound and says what it was and how long it was", () => {
  const text = "a longer commit body ".repeat(250);
  const out = boundedEvidenceText(text, { maxChars: 100, what: "the commit body" });
  assert.ok(out.startsWith(text.slice(0, 100)));
  assert.match(out, new RegExp(`${text.length - 100} more chars of ${text.length}, past the safety bound on the commit body`));
});

test("extractDiffFilePath names a file whose path holds spaces or that git quotes by its real path", () => {
  assert.equal(extractDiffFilePath("diff --git a/src/my page.ts b/src/my page.ts\n--- a/src/my page.ts\n"), "src/my page.ts");
  assert.equal(extractDiffFilePath('diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n'), "src/café.ts");
  assert.equal(extractDiffFilePath("diff --git a/src/a.ts b/src/a.ts\n"), "src/a.ts");
});

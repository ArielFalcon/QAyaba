/* The safety bounds on free-form prose (capText) and the diff-section path reader. The commit diff has no cap: its window fit is
   covered by prompts.window-fit.diff.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, extractDiffFilePath } from "@contexts/generation/infrastructure/prompt-cap.ts";

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

test("extractDiffFilePath names a file whose path holds spaces or that git quotes by its real path", () => {
  assert.equal(extractDiffFilePath("diff --git a/src/my page.ts b/src/my page.ts\n--- a/src/my page.ts\n"), "src/my page.ts");
  assert.equal(extractDiffFilePath('diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n'), "src/café.ts");
  assert.equal(extractDiffFilePath("diff --git a/src/a.ts b/src/a.ts\n"), "src/a.ts");
});

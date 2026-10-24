import { test } from "node:test";
import assert from "node:assert/strict";
import { diffWithoutTestFiles } from "@contexts/generation/domain/diff-without-test-files.ts";

const section = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

test("the app's own test files leave the diff and are named instead, in the diff's order", () => {
  const diff = section("src/store.ts", "+export const x = 1;") + section("src/store.spec.ts", "+it('x', () => {});") + section("svc/src/test/java/a/ATest.java", "+@Test void a() {}");
  const out = diffWithoutTestFiles(diff);
  assert.equal(out.diff, section("src/store.ts", "+export const x = 1;"));
  assert.deepEqual(out.testFiles, ["src/store.spec.ts", "svc/src/test/java/a/ATest.java"]);
});

test("a diff with no test file, or with no file headers, is returned as it is", () => {
  const diff = section("src/store.ts", "+x");
  assert.deepEqual(diffWithoutTestFiles(diff), { diff, testFiles: [] });
  assert.deepEqual(diffWithoutTestFiles("not a diff"), { diff: "not a diff", testFiles: [] });
});

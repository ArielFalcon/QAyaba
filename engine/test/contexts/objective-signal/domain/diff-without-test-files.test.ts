import { test } from "node:test";
import assert from "node:assert/strict";
import { diffWithoutTestFiles } from "@contexts/objective-signal/domain/diff-without-test-files.ts";

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

test("a test file whose path git quotes or holds spaces is still recognised and named by its real path", () => {
  const spaced = "diff --git a/src/my store.spec.ts b/src/my store.spec.ts\n--- a/src/my store.spec.ts\n+++ b/src/my store.spec.ts\n@@ -1 +1 @@\n+it('x', () => {});\n";
  const quoted = 'diff --git "a/src/caf\\303\\251.spec.ts" "b/src/caf\\303\\251.spec.ts"\n--- "a/src/caf\\303\\251.spec.ts"\n+++ "b/src/caf\\303\\251.spec.ts"\n@@ -1 +1 @@\n+it(\'y\', () => {});\n';
  const out = diffWithoutTestFiles(section("src/store.ts", "+x") + spaced + quoted);
  assert.equal(out.diff, section("src/store.ts", "+x"));
  assert.deepEqual(out.testFiles, ["src/my store.spec.ts", "src/café.spec.ts"]);
});

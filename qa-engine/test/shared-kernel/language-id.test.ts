import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageRegistry, type LanguageId } from "@kernel/language-id.ts";

test("the supported set is the single source of truth", () => {
  assert.deepEqual([...LanguageRegistry.supported].sort(), ["java", "javascript", "typescript"]);
});

test("languageForFile maps extensions to languages, null for unsupported", () => {
  assert.equal(LanguageRegistry.languageForFile("a/b.tsx"), "typescript");
  assert.equal(LanguageRegistry.languageForFile("a/b.mjs"), "javascript");
  assert.equal(LanguageRegistry.languageForFile("a/B.java"), "java");
  assert.equal(LanguageRegistry.languageForFile("a/b.rb"), null);
  assert.equal(LanguageRegistry.languageForFile("noext"), null);
});

test("groupByLanguage buckets files and drops unsupported", () => {
  const g = LanguageRegistry.groupByLanguage(["a.ts", "b.js", "c.py", "d.java"]);
  assert.deepEqual(g.get("typescript"), ["a.ts"]);
  assert.deepEqual(g.get("javascript"), ["b.js"]);
  assert.deepEqual(g.get("java"), ["d.java"]);
  assert.equal(g.has("python" as LanguageId), false);
});

test("DRIFT KILLED: hasAstGrepRules derives from the ONE record — true for every ast-grep-capable lang", () => {
  /* All three currently-supported languages have ast-grep rules. The one-record design
     means adding a non-astGrep language (e.g. "go") would return false without touching a
     separate set.
   */
  assert.equal(LanguageRegistry.hasAstGrepRules("javascript"), true);
  assert.equal(LanguageRegistry.hasAstGrepRules("typescript"), true);
  assert.equal(LanguageRegistry.hasAstGrepRules("java"), true);
  /* A language NOT in the registry returns false (no second set to diverge from). */
  assert.equal(LanguageRegistry.hasAstGrepRules("ruby" as LanguageId), false);
});

test("a file is a test file by its own language's conventions, and only then", () => {
  for (const file of ["src/app/store.spec.ts", "src/app/store.test.tsx", "lib/__tests__/util.js", "web/a.test.mjs", "svc/src/test/java/com/x/OrderServiceTest.java", "svc/src/main/java/com/x/OrderIT.java", "svc/src/main/java/com/x/OrderTests.java"]) {
    assert.equal(LanguageRegistry.isTestFile(file), true, file);
  }
  for (const file of ["src/app/store.ts", "src/app/testimonials.component.ts", "svc/src/main/java/com/x/Contest.java", "README.test.md", "config/spec.yaml", "Makefile"]) {
    assert.equal(LanguageRegistry.isTestFile(file), false, file);
  }
});

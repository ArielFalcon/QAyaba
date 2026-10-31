/* The relevance classes of a changed path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPath, FILE_CLASS_ORDER } from "@kernel/file-classes.ts";

test("a path is code, other, style, generated or low-relevance", () => {
  assert.equal(classifyPath("src/a.ts"), "code");
  assert.equal(classifyPath("src/Main.java"), "code");
  assert.equal(classifyPath("src/a.html"), "other");
  assert.equal(classifyPath("src/a.scss"), "style");
  assert.equal(classifyPath("package-lock.json"), "generated");
  assert.equal(classifyPath("dist/app.js.map"), "generated");
  assert.equal(classifyPath("CHANGELOG.md"), "low-relevance");
  assert.equal(classifyPath("img/logo.png"), "low-relevance");
});

test("the class order puts code before other kinds before styles", () => {
  assert.deepEqual([...FILE_CLASS_ORDER], ["code", "other", "style", "generated", "low-relevance"]);
});

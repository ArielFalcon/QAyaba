import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleCallLines } from "./no-console.scan";

test("a console call in code is found on its line, whatever the method", () => {
  assert.deepEqual(consoleCallLines("const a = 1;\nconsole.error(a);\n\nconsole.log(a);"), [2, 4]);
  assert.deepEqual(consoleCallLines("x(() => console.warn('w'));"), [1]);
});

test("a console mention in a comment, a string, a regular expression or template text is not a call", () => {
  const source = [
    "// console.log(a)",
    "/* console.warn(a)",
    "   console.error(a) */",
    'const s = "console.log(a)";',
    "const t = 'console.info(a)';",
    "const r = /console\\.log\\(/.test(s);",
    "const page = `(() => { console.warn('blocked'); })()`;",
    "const nested = `a ${`console.log(x)`} b`;",
  ].join("\n");
  assert.deepEqual(consoleCallLines(source), []);
});

test("a console call inside a template expression is code and is found", () => {
  assert.deepEqual(consoleCallLines("const t = `a ${console.log(1)} b`;"), [1]);
  assert.deepEqual(consoleCallLines("const t = `a ${ {b: 1}.b } ${console.warn(1)}`;"), [1]);
});

test("a multi-line template keeps the line count right for the calls after it", () => {
  assert.deepEqual(consoleCallLines("const t = `one\ntwo\nthree`;\nconsole.error(t);"), [4]);
});

test("a method that is not a log method, and a property named console, are not calls", () => {
  assert.deepEqual(consoleCallLines("console.table(x); other.console.log(x);"), []);
});

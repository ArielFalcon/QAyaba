/* Which lines of a source hold no executable code, by the statement syntax its language declares: an import, a re-export, a
   type-only declaration, a comment and a blank line are none; anything else is code; a language with no syntax tells nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { linesWithoutCode } from "@contexts/objective-signal/infrastructure/statement-code-lines.ts";

const sorted = (lines: ReadonlySet<number> | undefined): number[] | undefined => (lines === undefined ? undefined : [...lines].sort((a, b) => a - b));

test("imports, re-exports, export lists, type-only declarations, comments and blank lines are no code", () => {
  const source = [
    "import { A } from './a';",
    "export * from './b';",
    "export {",
    "  C,",
    "  D,",
    "} from './c';",
    "",
    "// a comment",
    "export type { E } from './e';",
    "export interface F { x: number }",
    "type G = string;",
    "declare const H: number;",
    "export { A };",
  ].join("\n");

  assert.deepEqual(sorted(linesWithoutCode("src/shared/index.ts", source)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("a statement that runs is code on every line it spans, and a line it shares with a re-export stays code", () => {
  const source = [
    "export * from './b';",
    "export const total = (xs: number[]) =>",
    "  xs.reduce((a, b) => a + b, 0);",
    "export class Store {}",
    "export enum Kind { A, B }",
    "export * from './c'; boot();",
  ].join("\n");

  assert.deepEqual(sorted(linesWithoutCode("src/store.ts", source)), [1]);
});

test("a JavaScript source is read with the same syntax", () => {
  assert.deepEqual(sorted(linesWithoutCode("src/index.mjs", "export { a } from './a.mjs';\nrun();")), [1]);
});

test("a language that declares no statement syntax, or a source that does not parse, tells nothing", () => {
  assert.equal(linesWithoutCode("src/Main.java", "import a.B;\n"), undefined);
  assert.equal(linesWithoutCode("src/broken.ts", "export { from;\n"), undefined);
});

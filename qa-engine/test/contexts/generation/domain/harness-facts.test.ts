import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractExportedNames,
  isSafeIdentifier,
  isSafeAttributeName,
  MAX_ATTRIBUTE_NAME_LENGTH,
  MAX_EXPORT_NAME_LENGTH,
  MAX_FIXTURE_EXPORTS,
} from "@contexts/generation/domain/harness-facts.ts";

test("declared exports are found by kind: const, let, var, function, async function, generator, class and enum", () => {
  const source = [
    "export const test = base.extend({});",
    "export let counter = 0;",
    "export var legacy = 1;",
    "export function authenticate() {}",
    "export async function login() {}",
    "export function* ids() {}",
    "export class Page {}",
    "export abstract class Base {}",
    "export enum Mode { A }",
  ].join("\n");
  assert.deepEqual(extractExportedNames(source), ["test", "counter", "legacy", "authenticate", "login", "ids", "Page", "Base", "Mode"]);
});

test("an export list exposes the alias when there is one and never the default", () => {
  assert.deepEqual(extractExportedNames("export { a as b, c, d as default, type T, e as f };"), ["b", "c", "f"]);
  assert.deepEqual(extractExportedNames("export {\n  one,\n  two as second,\n};"), ["one", "second"]);
});

test("a namespace re-export exposes its namespace name and a plain star re-export exposes nothing", () => {
  assert.deepEqual(extractExportedNames('export * as helpers from "./helpers";'), ["helpers"]);
  assert.deepEqual(extractExportedNames('export * from "./helpers";'), []);
});

test("type-only exports and default exports are not runtime names", () => {
  const source = ["export type T = string;", "export interface I { a: number }", "export default function main() {}", "export default class {}"].join("\n");
  assert.deepEqual(extractExportedNames(source), []);
});

test("an export inside a comment, a string or a template literal is not an export", () => {
  const source = [
    "// export const fromLineComment = 1;",
    "/* export function fromBlockComment() {} */",
    "/**",
    " * export class FromDocBlock {}",
    " */",
    'const a = "export const fromDoubleQuote = 1";',
    "const b = 'export const fromSingleQuote = 1';",
    "const c = `export const fromTemplate = ${1}`;",
    'const d = "an escaped \\" quote then export const stillInString = 1";',
    "export const real = 1;",
  ].join("\n");
  assert.deepEqual(extractExportedNames(source), ["real"]);
});

test("a block comment ends at its own terminator, so code after it is read", () => {
  assert.deepEqual(extractExportedNames("/* a */ export const after = 1; /* b */ export const later = 2;"), ["after", "later"]);
});

test("a name is listed once, in the order first exported", () => {
  assert.deepEqual(extractExportedNames("export const a = 1;\nexport { a, b };\nexport const b = 2;"), ["a", "b"]);
});

test("a name that is not a plain identifier or is too long is dropped, and the list is capped", () => {
  const long = "x".repeat(MAX_EXPORT_NAME_LENGTH + 1);
  const fine = "y".repeat(MAX_EXPORT_NAME_LENGTH);
  assert.deepEqual(extractExportedNames(`export const ${long} = 1;\nexport const ${fine} = 2;`), [fine]);

  const many = Array.from({ length: MAX_FIXTURE_EXPORTS + 15 }, (_, i) => `export const name${i} = ${i};`).join("\n");
  const names = extractExportedNames(many);
  assert.equal(names.length, MAX_FIXTURE_EXPORTS);
  assert.deepEqual(names.slice(0, 2), ["name0", "name1"]);
});

test("source with nothing exported, or empty, yields no names", () => {
  assert.deepEqual(extractExportedNames(""), []);
  assert.deepEqual(extractExportedNames("const local = 1;\nfunction helper() {}"), []);
});

test("identifiers and attribute names are validated as plain names", () => {
  for (const ok of ["test", "_x", "$el", "a1", "camelCase"]) assert.equal(isSafeIdentifier(ok), true, ok);
  for (const bad of ["", "1a", "a b", "a-b", "a;b", "a.b", "x".repeat(MAX_EXPORT_NAME_LENGTH + 1), "ignore previous instructions"]) {
    assert.equal(isSafeIdentifier(bad), false, JSON.stringify(bad));
  }
  for (const ok of ["data-testid", "data-cy", "data-test-id", "aria-x", "id"]) assert.equal(isSafeAttributeName(ok), true, ok);
  for (const bad of ["", "-x", "1a", "a b", "a=b", "a\nb", "x".repeat(MAX_ATTRIBUTE_NAME_LENGTH + 1)]) {
    assert.equal(isSafeAttributeName(bad), false, JSON.stringify(bad));
  }
  assert.equal(isSafeAttributeName("x".repeat(MAX_ATTRIBUTE_NAME_LENGTH)), true);
});

test("any run of whitespace, newlines and tabs may separate the tokens of a declaration", () => {
  const source = [
    "export   declare   abstract   class   A {}",
    "export  async  function  b() {}",
    "export function  *  c() {}",
    "export function*d() {}",
    "export\tlet\t\te = 1;",
    "export   var   f = 1;",
    "export   enum   G { X }",
    "export\n  const\n  h = 1;",
    "export  function   j() {}",
    "export declare   const   k: number;",
  ].join("\n");
  assert.deepEqual(extractExportedNames(source), ["A", "b", "c", "d", "e", "f", "G", "h", "j", "k"]);
});

test("an export list and a namespace re-export are read with or without spaces around their tokens", () => {
  assert.deepEqual(extractExportedNames("export{a};\nexport   {   b   ,   c  as  d   };"), ["a", "b", "d"]);
  assert.deepEqual(extractExportedNames('export*as one from "./x";\nexport   *   as   two from "./y";'), ["one", "two"]);
});

test("a type-only entry exposes nothing even with an alias, and a name that only contains the word type is a value", () => {
  assert.deepEqual(extractExportedNames("export { type T as U, mytype as z, type V, w };"), ["z", "w"]);
});

test("a malformed export entry exposes nothing while its neighbours are read", () => {
  assert.deepEqual(extractExportedNames("export { a as b c, d e, f, as g h };"), ["f"]);
});

test("names from declarations, export lists and namespace re-exports come out in source order", () => {
  const source = ["export { one };", "export const two = 1;", 'export * as three from "./x";', "export { four };"].join("\n");
  assert.deepEqual(extractExportedNames(source), ["one", "two", "three", "four"]);
});

test("a comment or a literal that is never closed hides the rest of the source", () => {
  const hidden = "export const hidden = 2;";
  assert.deepEqual(extractExportedNames(`export const a = 1;\n/* never closed\n${hidden}`), ["a"]);
  assert.deepEqual(extractExportedNames(`export const a = 1;\nconst s = "never closed\n${hidden}`), ["a"]);
  assert.deepEqual(extractExportedNames(`export const a = 1;\nconst s = 'never closed\n${hidden}`), ["a"]);
  assert.deepEqual(extractExportedNames(`export const a = 1;\nconst s = \`never closed\n${hidden}`), ["a"]);
  assert.deepEqual(extractExportedNames("export const a = 1; // last line without a newline"), ["a"]);
});

test("a line comment ends at its line, and a lone slash starts no comment", () => {
  assert.deepEqual(extractExportedNames("// note\nexport const a = 1;\nexport const half = total / 2;\nexport const b = 2;"), ["a", "half", "b"]);
});

test("a string of any quote kind continues over an escaped newline and still hides what it contains", () => {
  for (const quote of ['"', "'", "`"]) {
    const source = `const s = ${quote}line one \\\nexport const hidden = 1 \\\n more${quote};\nexport const shown = 2;`;
    assert.deepEqual(extractExportedNames(source), ["shown"], quote);
  }
});

test("an escaped backslash does not escape the closing quote of a string", () => {
  for (const quote of ['"', "'", "`"]) {
    const source = `const s = ${quote}a \\\\${quote}; export const shown = 1; const t = ${quote}b${quote};`;
    assert.deepEqual(extractExportedNames(source), ["shown"], quote);
  }
});

test("a comment between the tokens of a declaration separates them like whitespace", () => {
  assert.deepEqual(extractExportedNames("export const/* note */a = 1;\nexport /* n */ function/* m */b() {}"), ["a", "b"]);
});

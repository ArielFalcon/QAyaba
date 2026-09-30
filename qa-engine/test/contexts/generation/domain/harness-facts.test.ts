import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractExportedNames,
  isSafeIdentifier,
  isSafeAttributeName,
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
  for (const bad of ["", "-x", "1a", "a b", "a=b", "a\nb", "x".repeat(65)]) assert.equal(isSafeAttributeName(bad), false, JSON.stringify(bad));
});

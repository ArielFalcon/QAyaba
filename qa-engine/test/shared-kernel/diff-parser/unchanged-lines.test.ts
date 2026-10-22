import { test } from "node:test";
import assert from "node:assert/strict";
import { countUnchangedLinesHolding } from "@kernel/diff-parser/unchanged-lines.ts";

const source = ['<app-a label="Cambiar filtros" />', "<p>x</p>", '<app-b label="Cambiar filtros" />', '<app-c endActionLabel="Cambiar filtros" />'].join("\n");

test("a line the change touched is not counted, whatever it holds", () => {
  assert.equal(countUnchangedLinesHolding(source, new Set([4]), "Cambiar filtros"), 2);
});

test("every line is unchanged when the change touched none of them", () => {
  assert.equal(countUnchangedLinesHolding(source, new Set(), "Cambiar filtros"), 3);
  assert.equal(countUnchangedLinesHolding(source, undefined, "Cambiar filtros"), 3);
});

test("a line is counted once however often it holds the value", () => {
  assert.equal(countUnchangedLinesHolding("a Foo Foo\nb", new Set(), "Foo"), 1);
});

test("a value that is only a part of a longer word or phrase is not held by the line that has the longer one", () => {
  assert.equal(countUnchangedLinesHolding(source, new Set(), "Cambiar filtro"), 0);
  assert.equal(countUnchangedLinesHolding("<b>Guardar</b> y Guardarlo", new Set(), "Guardar"), 1);
});

test("a value no line holds counts none", () => {
  assert.equal(countUnchangedLinesHolding(source, new Set(), "Otro texto"), 0);
});

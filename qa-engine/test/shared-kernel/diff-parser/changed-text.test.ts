/* A commit changes the text a page shows not only inside an element's tag: a component input or prop carries it (`endActionLabel="…"`, `label="…"`), and a multi-line element has it on a line of its own. Those lines are changed elements too, carrying the new text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

const parser = new DiffParserService();

function changedTexts(file: string, added: string[]): Array<string | undefined> {
  const diff = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n");
  return parser.changedElements(diff).map((e) => e.text);
}

test("a text-bearing input of a component carries the text it shows", () => {
  assert.deepEqual(changedTexts("src/list.page.html", ['      endActionLabel="Cambiar filtros"']), ["Cambiar filtros"]);
  assert.deepEqual(changedTexts("src/form.html", ['  label="Guardar cambios"', '  placeholder="Buscar restaurante"', '  aria-label="Cerrar"']), ["Guardar cambios", "Buscar restaurante", "Cerrar"]);
  assert.deepEqual(changedTexts("src/Footer.tsx", ['      emptyText="Sin resultados"']), ["Sin resultados"]);
});

test("an attribute that styles, types, routes or binds an element carries no shown text", () => {
  assert.deepEqual(changedTexts("src/list.page.html", ['  class="btn btn-primary"', '  styleClass="p-button-sm"', '  icon="pi pi-search"', '  type="button"', '  [label]="labelFor(item)"', '  label="{{ title }}"']), []);
});

test("a line that is only text, inside a multi-line element, is the text it shows", () => {
  assert.deepEqual(changedTexts("src/list.page.html", ["      Cambiar filtros"]), ["Cambiar filtros"]);
});

test("a line of code or a comment is not shown text", () => {
  assert.deepEqual(changedTexts("src/list.page.ts", ["  const total = items.length;", "  // keeps the filters", "   * the end action", "  return x;"]), []);
});

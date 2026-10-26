import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { decodeLiteralText } from "@kernel/diff-parser/changed-literal.ts";
import { countUnchangedLinesHolding } from "@contexts/generation/domain/unchanged-lines.ts";

const svc = new DiffParserService();

const addedValues = (...lines: string[]): string[] => {
  const diff = ["diff --git a/web/a.html b/web/a.html", "--- a/web/a.html", "+++ b/web/a.html", "@@ -1,1 +1,2 @@", " ctx", ...lines.map((l) => `+${l}`)].join("\n");
  return svc.changedLiterals(diff).filter((l) => l.side === "added").map((l) => l.value);
};

test("a literal that holds a placeholder is no label: braces, printf conversions and :name tokens", () => {
  assert.deepEqual(addedValues('const a = "Hola {name}";', 'const b = "Hello {0}";', 'const c = "Total: %s";', 'const d = "%d items found";', 'const e = "Edit :userId profile";', 'const f = "Item %1$s of %2$d";'), []);
});

test("a colon in a phrase is not a placeholder", () => {
  assert.deepEqual(addedValues('const a = "Nota: guardar cambios";', 'const b = "Hora 10:30 abierto";'), ["Nota: guardar cambios", "Hora 10:30 abierto"]);
});

test("an escaped quote is decoded before the value is kept", () => {
  assert.deepEqual(addedValues("const a = 'It\\'s done';", 'const b = "Say \\"hi\\" now";'), ["It's done", 'Say "hi" now']);
});

test("a named or numeric HTML entity is decoded before the value is kept", () => {
  assert.deepEqual(addedValues('<h1 title="Men&uacute; principal">', '<h2 title="Save &amp; exit">', '<h3 title="Adi&#243;s amigo">', '<h4 title="Adi&#xF3;s amigos">'), [
    "Menú principal",
    "Save & exit",
    "Adiós amigo",
    "Adiós amigos",
  ]);
});

test("a placeholder written as an entity is still a placeholder", () => {
  assert.deepEqual(addedValues('<h1 title="Hola &#123;name&#125;">'), []);
});

test("an entity or escape the decoder does not know is left as written", () => {
  assert.equal(decodeLiteralText("Fish &chips; and \\q"), "Fish &chips; and \\q");
});

test("a single token of an uncased script is a label; a single lower-case Latin token is still not", () => {
  assert.deepEqual(addedValues('<b label="保存">', '<b label="حفظ">', '<b label="guardar">'), ["保存", "حفظ"]);
});

test("the unchanged lines holding a decoded value are found in the source as it is written, entities and escapes included", () => {
  const source = ["<b>Men&uacute; principal</b>", "x = 'It\\'s done'", "<i>Menú principal</i>", "<p>otra cosa</p>"].join("\n");
  assert.equal(countUnchangedLinesHolding(source, undefined, "Menú principal"), 2);
  assert.equal(countUnchangedLinesHolding(source, undefined, "It's done"), 1);
});

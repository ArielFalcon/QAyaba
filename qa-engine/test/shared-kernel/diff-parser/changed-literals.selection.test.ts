import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { MAX_ADDED_LITERALS, MAX_ADDED_LITERALS_IN_ALL, MAX_REMOVED_LITERALS_IN_ALL } from "@kernel/diff-parser/changed-literal.ts";

const svc = new DiffParserService();

const fileDiff = (file: string, added: string[], removed: string[] = []): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1,1 +1,1 @@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");

const labels = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `x = "${prefix} label ${String.fromCharCode(65 + i)}";`);

test("a list of CSS classes is no label, and a phrase of ordinary lower-case words is", () => {
  const d = fileDiff("web/a.html", ['<div class="flex items-center gap-2">', '<div class="md:flex hidden">', '<div class="text-sm font-bold">', '<input placeholder="buscar por nombre">', '<b label="ver más">']);
  assert.deepEqual(svc.changedLiterals(d).map((l) => l.value), ["buscar por nombre", "ver más"]);
});

test("the cap applies to each file, so a file with many labels does not hide the labels of the next", () => {
  const d = [fileDiff("web/big.ts", labels("Big", 20)), fileDiff("web/small.ts", labels("Small", 2))].join("\n");
  const values = svc.changedLiterals(d).map((l) => l.value);
  assert.equal(values.filter((v) => v.startsWith("Big")).length, MAX_ADDED_LITERALS);
  assert.deepEqual(values.filter((v) => v.startsWith("Small")), ["Small label A", "Small label B"]);
});

test("the files of a diff are taken in turn up to the ceiling of the whole diff, so the first files cannot crowd out the rest", () => {
  const files = ["a", "b", "c", "d", "e"].map((f) => fileDiff(`web/${f}.ts`, labels(f.toUpperCase(), 8)));
  const values = svc.changedLiterals(files.join("\n")).map((l) => l.value);
  assert.equal(values.length, MAX_ADDED_LITERALS_IN_ALL);
  for (const f of ["A", "B", "C", "D", "E"]) assert.ok(values.filter((v) => v.startsWith(`${f} label`)).length >= 4, `file ${f} keeps a share`);
});

test("the removed labels of a whole diff are bounded too", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((f) => fileDiff(`web/${f}.ts`, [], labels(`Old${f}`, 4)));
  assert.equal(svc.changedLiterals(files.join("\n")).filter((l) => l.side === "removed").length, MAX_REMOVED_LITERALS_IN_ALL);
});

test("with files a map links to pages, only their labels are kept when any has one", () => {
  const d = [fileDiff("src/app/list.page.html", ['<b label="Cambiar filtros">']), fileDiff("src/util/messages.ts", ['x = "Mensaje interno";'])].join("\n");
  const linked = new Set(["src/app/list.page.html"]);
  assert.deepEqual(svc.changedLiterals(d, { preferFiles: linked }).map((l) => l.value), ["Cambiar filtros"]);
});

test("files outside the linked ones are used when no linked file has a label", () => {
  const d = [fileDiff("src/app/list.page.html", ["<b>sin etiqueta</b>"]), fileDiff("src/util/messages.ts", ['x = "Mensaje interno";'])].join("\n");
  const linked = new Set(["src/app/list.page.html"]);
  assert.deepEqual(svc.changedLiterals(d, { preferFiles: linked }).map((l) => l.value), ["Mensaje interno"]);
});

test("without a preference every file counts, and an empty preference is no preference", () => {
  const d = [fileDiff("a/one.ts", ['x = "Primer texto";']), fileDiff("b/two.ts", ['x = "Segundo texto";'])].join("\n");
  assert.equal(svc.changedLiterals(d).length, 2);
  assert.equal(svc.changedLiterals(d, { preferFiles: new Set() }).length, 2);
});

test("changedElements takes its quoted labels per file as well, with no extension named anywhere", () => {
  const d = [fileDiff("web/big.weird", labels("Big", 20)), fileDiff("web/small.other", labels("Small", 2))].join("\n");
  const texts = svc.changedElements(d).map((e) => e.text ?? "");
  assert.equal(texts.filter((t) => t.startsWith("Big")).length, MAX_ADDED_LITERALS);
  assert.equal(texts.filter((t) => t.startsWith("Small")).length, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { MAX_ADDED_LITERALS, MAX_REMOVED_LITERALS } from "@kernel/diff-parser/changed-literal.ts";

const svc = new DiffParserService();

function diff(file: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
}

const valuesOf = (d: string, side: "added" | "removed"): string[] =>
  svc.changedLiterals(d).filter((l) => l.side === side).map((l) => l.value);

test("a quoted label changed on one line is an added and a removed literal of its file", () => {
  const d = diff("src/app/list.page.html", [
    "@@ -10,3 +10,3 @@",
    " <app-list",
    '-  endActionLabel="Cambiar filtro"',
    '+  endActionLabel="Cambiar filtros"',
    " />",
  ]);
  const literals = svc.changedLiterals(d);
  assert.deepEqual(
    literals.map(({ file, value, side }) => ({ file, value, side })),
    [
      { file: "src/app/list.page.html", value: "Cambiar filtros", side: "added" },
      { file: "src/app/list.page.html", value: "Cambiar filtro", side: "removed" },
    ],
  );
  assert.equal(literals.find((l) => l.side === "added")?.line, 11, "an added literal is numbered on the new side");
});

test("string literals are read the same way in a TypeScript, a Java and a template line", () => {
  const d = [
    diff("web/a.ts", ["@@ -1,1 +1,2 @@", " ctx", "+const title = 'Save changes';"]),
    diff("svc/B.java", ["@@ -1,1 +1,2 @@", " ctx", '+    String label = "Save order";']),
    diff("web/c.html", ["@@ -1,1 +1,2 @@", " ctx", '+<h1 title="Order summary">']),
  ].join("\n");
  assert.deepEqual(valuesOf(d, "added"), ["Save changes", "Save order", "Order summary"]);
});

test("a template literal with a substitution and an interpolated text are not literals", () => {
  const d = diff("web/a.ts", ["@@ -1,1 +1,4 @@", " ctx", "+const a = `Hello ${name}`;", '+const b = "Total {{ amount }}";', "+const c = `Plain text`;"]);
  assert.deepEqual(valuesOf(d, "added"), ["Plain text"]);
});

test("a literal that only moves between the removed and the added lines of a file is no change", () => {
  const d = diff("web/a.html", ["@@ -1,1 +1,1 @@", '-<button  label="Guardar cambios" class="a">', '+<button label="Guardar cambios" class="b">']);
  assert.deepEqual(svc.changedLiterals(d), []);
});

test("values that are not a label a page could show are left out: paths, imports, identifiers, comments, constants, single lower-case tokens", () => {
  const d = diff("web/a.ts", [
    "@@ -1,1 +1,9 @@",
    " ctx",
    "+import { x } from './some/module';",
    "+const p = '/api/orders/list';",
    "+const k = 'MAX_RETRY_COUNT';",
    "+const c = 'UserService';",
    "+// it's a 'quoted thing' in a comment",
    "+const t = 'submit';",
    "+const u = 'https://example.org/a b';",
    "+const n = 'ab.cd.ef';",
  ]);
  assert.deepEqual(valuesOf(d, "added"), []);
});

test("a single capitalised word is a label", () => {
  const d = diff("web/a.html", ["@@ -1,1 +1,2 @@", " ctx", '+<button label="Guardar">']);
  assert.deepEqual(valuesOf(d, "added"), ["Guardar"]);
});

test("the literals are bounded per side and each value is listed once", () => {
  const added = Array.from({ length: MAX_ADDED_LITERALS + 5 }, (_, i) => `+x = "Label number ${String.fromCharCode(65 + i)}";`);
  const removed = Array.from({ length: MAX_REMOVED_LITERALS + 5 }, (_, i) => `-y = "Old label ${String.fromCharCode(65 + i)}";`);
  const d = diff("web/a.ts", ["@@ -1,1 +1,1 @@", ...removed, ...added, '+z = "Label number A";']);
  assert.equal(valuesOf(d, "added").length, MAX_ADDED_LITERALS);
  assert.equal(valuesOf(d, "removed").length, MAX_REMOVED_LITERALS);
  assert.equal(new Set(valuesOf(d, "added")).size, MAX_ADDED_LITERALS);
});

test("a deleted file lists only removed literals and an added file only added ones", () => {
  const deleted = ["diff --git a/old.ts b/old.ts", "--- a/old.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", '-const a = "Old caption";'].join("\n");
  const created = ["diff --git a/new.ts b/new.ts", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,1 @@", '+const a = "New caption";'].join("\n");
  assert.deepEqual(svc.changedLiterals(deleted).map((l) => [l.value, l.side]), [["Old caption", "removed"]]);
  assert.deepEqual(svc.changedLiterals(created).map((l) => [l.value, l.side]), [["New caption", "added"]]);
});

test("changedElements: a line that holds only a quoted label yields a text-only element, and a removed label yields none", () => {
  const d = diff("src/app/list.page.html", [
    "@@ -10,3 +10,3 @@",
    " <app-list",
    '-  endActionLabel="Cambiar filtro"',
    '+  endActionLabel="Cambiar filtros"',
    " />",
  ]);
  const elements = svc.changedElements(d);
  assert.deepEqual(
    elements.map(({ file, line, text, testId, id, name, href }) => ({ file, line, text, testId, id, name, href })),
    [{ file: "src/app/list.page.html", line: 11, text: "Cambiar filtros", testId: undefined, id: undefined, name: undefined, href: undefined }],
  );
});

test("changedElements: a line that already yields an element keeps it and adds no second text element", () => {
  const d = diff("src/a.html", ["@@ -1,1 +1,2 @@", " ctx", '+<button data-cy="save">Guardar cambios</button>']);
  const elements = svc.changedElements(d);
  assert.equal(elements.length, 1);
  assert.equal(elements[0]?.testId, "save");
});

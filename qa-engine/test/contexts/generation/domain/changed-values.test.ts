import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChangedValues, nodeShowsText, CONCLUSION, MAX_ROUTES_NAMED_PER_VALUE } from "@contexts/generation/domain/changed-values.ts";
import { countDirectives, hasTrustLanguage, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ChangedLiteral } from "@kernel/diff-parser/changed-literal.ts";

const FILE = "src/app/restaurant-list.page.html";
const added = (value: string, unchangedLines?: number): ChangedLiteral => ({ file: FILE, line: 164, value, side: "added", ...(unchangedLines === undefined ? {} : { unchangedLines }) });
const removed = (value: string, unchangedLines?: number): ChangedLiteral => ({ file: FILE, line: 164, value, side: "removed", ...(unchangedLines === undefined ? {} : { unchangedLines }) });
const page = (route: string, nodes: string[]) => ({ route, nodes });

test("a changed label shown by as many nodes as unchanged lines already hold it is reported as not observed", () => {
  /* DEV had no restaurants: the end-of-list button could not render, and the two nodes shown come from the two unchanged lines that hold the same label. */
  const out = renderChangedValues([added("Cambiar filtros", 2)], [page("/restaurantes", ["heading: Restaurantes", "button: Cambiar filtros", "button: Cambiar filtros"])]);
  assert.match(out, /changed value "Cambiar filtros"/);
  assert.match(out, /2 node\(s\) on \/restaurantes/);
  assert.match(out, new RegExp(`2 unchanged line\\(s\\) of ${FILE.replace(/\./g, "\\.")} already contain it`));
  assert.ok(out.includes(CONCLUSION.notObserved));
  assert.ok(!out.includes(`→ ${CONCLUSION.observed}`));
});

test("a changed label shown by more nodes than unchanged lines hold it is reported as observed", () => {
  const out = renderChangedValues([added("Cambiar filtros", 2)], [page("/restaurantes", ["button: Cambiar filtros", "button: Cambiar filtros", "button: Cambiar filtros"])]);
  assert.match(out, /3 node\(s\) on \/restaurantes/);
  assert.ok(out.includes(`→ ${CONCLUSION.observed}`));
  assert.ok(!out.includes(CONCLUSION.notObserved));
});

test("a new label no unchanged line holds and one node shows is observed", () => {
  const out = renderChangedValues([added("Nuevo texto", 0)], [page("/a", ["button: Nuevo texto"])]);
  assert.match(out, /0 unchanged line\(s\)/);
  assert.ok(out.includes(`→ ${CONCLUSION.observed}`));
});

test("a changed label no node shows is not observed, whatever the file holds", () => {
  for (const unchangedLines of [0, 3, undefined]) {
    const out = renderChangedValues([added("Nuevo texto", unchangedLines)], [page("/a", ["button: Otra cosa"])]);
    assert.match(out, /0 node\(s\)/, `unchanged lines ${unchangedLines}`);
    assert.ok(out.includes(CONCLUSION.notObserved), `unchanged lines ${unchangedLines}`);
  }
});

test("when the file was not read, the nodes are counted and no conclusion is drawn from them", () => {
  const out = renderChangedValues([added("Nuevo texto")], [page("/a", ["button: Nuevo texto"])]);
  assert.match(out, /1 node\(s\) on \/a/);
  assert.doesNotMatch(out, /→/);
});

test("an old value still shown by more nodes than unchanged lines hold it is reported as still visible", () => {
  const out = renderChangedValues([removed("Cambiar filtro", 0)], [page("/a", ["button: Cambiar filtro"])]);
  assert.match(out, /old value "Cambiar filtro"/);
  assert.match(out, /1 node\(s\) on \/a/);
  assert.ok(out.includes(CONCLUSION.oldValueVisible));
});

test("an old value no node shows, or that unchanged lines explain, is not reported", () => {
  assert.equal(renderChangedValues([removed("Gone", 0)], [page("/a", ["button: Other"])]), "");
  assert.equal(renderChangedValues([removed("Kept", 1)], [page("/a", ["button: Kept"])]), "");
  assert.equal(renderChangedValues([removed("Unread")], [page("/a", ["button: Unread"])]), "");
});

test("nothing is reported without a captured page or without a changed literal", () => {
  assert.equal(renderChangedValues([added("Cambiar filtros", 0)], []), "");
  assert.equal(renderChangedValues([], [page("/a", ["button: Cambiar filtros"])]), "");
});

test("the routes that show the value are named, and only up to the bound", () => {
  const pages = Array.from({ length: MAX_ROUTES_NAMED_PER_VALUE + 2 }, (_, i) => page(`/r${i}`, ["button: Nuevo texto"]));
  const out = renderChangedValues([added("Nuevo texto", 0)], [page("/empty", ["button: Otra cosa"]), ...pages]);
  assert.doesNotMatch(out, /\/empty/);
  assert.match(out, new RegExp(`${MAX_ROUTES_NAMED_PER_VALUE + 2} node\\(s\\) on /r0`));
  const named = out.match(/\/r\d+/g) ?? [];
  assert.equal(named.length, MAX_ROUTES_NAMED_PER_VALUE);
});

test("the section states facts only: no directive wording and no trust vocabulary, so the lint accepts it as a facts-only section", () => {
  const out = renderChangedValues(
    [added("Cambiar filtros", 2), added("Nuevo texto", 0), removed("Viejo texto", 0)],
    [page("/a", ["button: Cambiar filtros", "button: Cambiar filtros", "button: Viejo texto"])],
  );
  assert.ok(out.length > 0);
  assert.equal(countDirectives(out), 0);
  assert.equal(hasTrustLanguage(out), false);
  const findings = lintCell({ name: "changed-values", regen: false, sections: [{ id: "changed-values", layer: "assembled", text: out, claims: [], factsOnly: true }] });
  assert.deepEqual(findings, []);
});

test("a value holding a quote or a line break cannot end its own quotation", () => {
  const out = renderChangedValues([added('Di "hola"\nadiós', 0)], [page("/a", ["button: x"])]);
  const line = out.split("\n").find((l) => l.startsWith("- changed value")) ?? "";
  assert.equal((line.match(/"/g) ?? []).length, 2);
  assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 1);
});

test("a node shows a text when its name equals it or has it as a whole word, whatever the case", () => {
  assert.equal(nodeShowsText("button: Cambiar filtros", "cambiar FILTROS"), true);
  assert.equal(nodeShowsText("button: Guardar [disabled]", "Guardar"), true);
  assert.equal(nodeShowsText("button: Contact form submit", "form"), true);
  assert.equal(nodeShowsText("button: test-submission", "form"), false);
  assert.equal(nodeShowsText("button: Cambiar filtros ahora", "Cambiar filtros"), false);
});

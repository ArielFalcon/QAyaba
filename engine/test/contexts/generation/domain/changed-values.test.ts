import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChangedValues, valuesWithMoreNodesThanLines, nodeShowsText, WORDING, MAX_ROUTES_NAMED_PER_VALUE } from "@contexts/generation/domain/changed-values.ts";
import { countDirectives, hasTrustLanguage, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ChangedLiteral } from "@kernel/diff-parser/changed-literal.ts";

const FILE = "src/app/restaurant-list.page.html";
const added = (value: string, unchangedLines?: number): ChangedLiteral => ({ file: FILE, line: 164, value, side: "added", ...(unchangedLines === undefined ? {} : { unchangedLines }) });
const removed = (value: string, unchangedLines?: number): ChangedLiteral => ({ file: FILE, line: 164, value, side: "removed", ...(unchangedLines === undefined ? {} : { unchangedLines }) });
const page = (route: string, nodes: string[]) => ({ route, nodes });
const valueLine = (out: string): string => out.split("\n").find((l) => l.startsWith("- ")) ?? "";

test("nodes that unchanged lines of the file could account for are stated neutrally: none can be attributed to the change", () => {
  /* DEV had no restaurants: the end-of-list button could not render, and the two nodes shown come from the two unchanged lines that hold the same label. */
  const out = renderChangedValues([added("Cambiar filtros", 2)], [page("/restaurantes", ["heading: Restaurantes", "button: Cambiar filtros", "button: Cambiar filtros"])]);
  const line = valueLine(out);
  assert.match(line, /changed value "Cambiar filtros"/);
  assert.match(line, /2 node\(s\) on \/restaurantes show it/);
  assert.match(line, new RegExp(`2 unchanged line\\(s\\) of ${FILE.replace(/\./g, "\\.")} already hold it`));
  assert.ok(line.includes(WORDING.ambiguous));
  assert.doesNotMatch(line, /not observed|observed/i, "no wording that echoes the no-op reason or claims an observation");
});

test("more nodes on a route than unchanged lines hold the value is stated with its limit: other files are not checked", () => {
  const out = renderChangedValues([added("Cambiar filtros", 2)], [page("/restaurantes", ["button: Cambiar filtros", "button: Cambiar filtros", "button: Cambiar filtros"])]);
  const line = valueLine(out);
  assert.match(line, /3 node\(s\) on \/restaurantes show it/);
  assert.ok(line.includes(WORDING.moreNodes(FILE)), line);
  assert.ok(line.includes("(other files not checked)"));
  assert.doesNotMatch(line, /observed/i);
});

test("nodes are counted per route and never summed across pages", () => {
  /* Two pages that each show the label once, with two unchanged lines holding it: the sum (2) equals the lines, but also shared chrome would make it grow with the pages; each route is judged alone. */
  const pages = [page("/a", ["button: Guardar"]), page("/b", ["button: Guardar"]), page("/c", ["button: Guardar"])];
  const out = renderChangedValues([added("Guardar", 2)], pages);
  const line = valueLine(out);
  assert.match(line, /1 node\(s\) on \/a/);
  assert.match(line, /1 node\(s\) on \/b/);
  assert.ok(line.includes(WORDING.ambiguous), "three pages of one node each do not exceed two lines on any route");
  assert.equal(valuesWithMoreNodesThanLines([added("Guardar", 2)], pages).length, 0);
});

test("a route that exceeds the lines is the only one the limit statement names", () => {
  const pages = [page("/a", ["button: Guardar"]), page("/b", ["button: Guardar", "button: Guardar", "button: Guardar"])];
  const line = valueLine(renderChangedValues([added("Guardar", 2)], pages));
  assert.ok(line.includes(`${WORDING.moreNodes(FILE)} on /b`) || line.includes(WORDING.moreNodes(FILE)));
  assert.deepEqual(valuesWithMoreNodesThanLines([added("Guardar", 2)], pages), ["Guardar"]);
});

test("a new label no unchanged line holds that one node shows has more nodes than unchanged lines", () => {
  const line = valueLine(renderChangedValues([added("Nuevo texto", 0)], [page("/a", ["button: Nuevo texto"])]));
  assert.match(line, /0 unchanged line\(s\)/);
  assert.ok(line.includes(WORDING.moreNodes(FILE)));
});

test("a changed label no node shows is stated as a count of zero, with the lines that hold it when known, and draws no conclusion", () => {
  for (const unchangedLines of [0, 3, undefined]) {
    const line = valueLine(renderChangedValues([added("Nuevo texto", unchangedLines)], [page("/a", ["button: Otra cosa"])]));
    assert.match(line, /no captured node shows it/, `unchanged lines ${unchangedLines}`);
    assert.doesNotMatch(line, /observed|→/, `unchanged lines ${unchangedLines}`);
    assert.equal(line.includes("unchanged line(s)"), unchangedLines !== undefined);
  }
});

test("when the file was not read, the nodes are counted per route and no conclusion is drawn from them", () => {
  const line = valueLine(renderChangedValues([added("Nuevo texto")], [page("/a", ["button: Nuevo texto"])]));
  assert.match(line, /1 node\(s\) on \/a show it/);
  assert.match(line, /not read/);
  assert.doesNotMatch(line, /→|observed/);
});

test("an old value shown on a route by more nodes than unchanged lines hold it is stated with the same limit", () => {
  const line = valueLine(renderChangedValues([removed("Cambiar filtro", 0)], [page("/a", ["button: Cambiar filtro"])]));
  assert.match(line, /old value "Cambiar filtro"/);
  assert.match(line, /1 node\(s\) on \/a show it/);
  assert.ok(line.includes(WORDING.moreNodes(FILE)));
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
  const out = renderChangedValues([added("Nuevo texto", 5)], [page("/empty", ["button: Otra cosa"]), ...pages]);
  assert.doesNotMatch(out, /\/empty/);
  const named = valueLine(out).match(/on \/r\d+/g) ?? [];
  assert.equal(named.length, MAX_ROUTES_NAMED_PER_VALUE);
  assert.match(out, /\(\+2 more\)/);
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
  const line = valueLine(out);
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

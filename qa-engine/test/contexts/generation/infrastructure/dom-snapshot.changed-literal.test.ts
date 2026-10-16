import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangedMarker, formatDomSnapshot, type RouteSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { ChangedElement } from "@kernel/diff-parser/changed-element.ts";

const textOnly = (text: string, unchangedLines?: number): ChangedElement => ({
  file: "src/app/list.page.html",
  line: 164,
  text,
  raw: `endActionLabel="${text}"`,
  ...(unchangedLines === undefined ? {} : { unchangedLines }),
});

test("a text-only change marks the node with that text when no unchanged line of its file holds the text", () => {
  assert.match(buildChangedMarker("button: Cambiar filtros", undefined, [textOnly("Cambiar filtros", 0)]), /\[CHANGED: added text "Cambiar filtros"\]/);
});

test("a text-only change whose file was not read still marks the node: nothing shows the text pre-exists", () => {
  assert.match(buildChangedMarker("button: Cambiar filtros", undefined, [textOnly("Cambiar filtros")]), /\[CHANGED:/);
});

test("a text-only change marks no node when an unchanged line of its file already holds the text", () => {
  assert.equal(buildChangedMarker("button: Cambiar filtros", undefined, [textOnly("Cambiar filtros", 2)]), "");
});

test("a change that names a test-id keeps its mark even when its text is held by unchanged lines", () => {
  const changed: ChangedElement = { file: "f.html", line: 1, testId: "save", text: "Guardar", raw: "r", unchangedLines: 3 };
  assert.match(buildChangedMarker("button: Guardar", { key: "button: Guardar", testId: "save" }, [changed], "data-cy"), /added data-cy=save/);
});

test("the two pre-existing nodes of a label changed on a third line carry no CHANGED mark in the rendered tree", () => {
  const snaps: RouteSnapshot[] = [{ route: "/restaurantes", nodes: ["heading: Restaurantes", "button: Cambiar filtros", "button: Cambiar filtros"] }];
  const out = formatDomSnapshot(snaps, [textOnly("Cambiar filtros", 2)]);
  assert.doesNotMatch(out, /CHANGED/);
  assert.equal(formatDomSnapshot(snaps, [textOnly("Cambiar filtros", 0)]).match(/CHANGED/g)?.length, 2);
});

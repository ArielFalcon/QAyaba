/* The changed-values section of the pack: what the captured pages say about the labels the change added and removed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, deriveClaimsFromPackText, PACK_HEADINGS, type ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import { captureDomForRoutes, type CapturedPage, type CaptureDomDeps, type RouteSnapshot } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { WORDING } from "@contexts/generation/domain/changed-values.ts";
import { countDirectives, lintCell } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { ChangedLiteral } from "@kernel/diff-parser/changed-literal.ts";
import { countUnchangedLinesHolding } from "@contexts/generation/domain/unchanged-lines.ts";

const FILE = "src/app/restaurant-list.page.html";
const PACK_INPUT = { baseUrl: "http://localhost:3000", e2eDir: "/fake/e2e", routes: ["/restaurantes"] };

/* DEV had no restaurants: the page shows the two nodes the applied-filters button and the empty-state call to action render, and the end-of-list button the change edited cannot render. */
const NODES_WITHOUT_RESTAURANTS = ["heading: Restaurantes", "button: Cambiar filtros", "button: Cambiar filtros"];

const label = (unchangedLines: number | undefined, side: ChangedLiteral["side"] = "added", value = "Cambiar filtros"): ChangedLiteral => ({
  file: FILE,
  line: 164,
  value,
  side,
  ...(unchangedLines === undefined ? {} : { unchangedLines }),
});

/* A capture that renders `pages`, telling the pack what it holds the way the real one does. */
function siteShowing(pages: ReadonlyArray<{ route: string; nodes: string[]; grounded?: boolean }>): ContextPackDeps {
  return {
    captureDomForRoutes: async (routes, input) => {
      input.onPages?.([...routes, ...(input.linkSeeds ?? [])].map((route) => {
        const page = pages.find((candidate) => candidate.route === route);
        return { route, grounded: page?.grounded ?? true, links: [], nodes: page?.nodes ?? [] };
      }));
      return routes.map((route) => `route ${route}:\n${(pages.find((p) => p.route === route)?.nodes ?? []).map((n) => `  ${n}`).join("\n")}`).join("\n");
    },
    domDeps: { render: async () => [] },
    log: () => {},
  };
}

const sectionText = (text: string | undefined): string => (text ?? "").split(/^### /m).slice(1).find((part) => part.startsWith(PACK_HEADINGS.changedValues)) ?? "";

test("a label changed on a line while two unchanged lines of the file already hold it and the page shows two such nodes: the pack says none can be attributed to the change", async () => {
  const result = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(2)] },
    siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]),
  );
  const section = sectionText(result.text);
  assert.match(section, /changed value "Cambiar filtros": 2 node\(s\) on \/restaurantes show it and 2 unchanged line\(s\) of src\/app\/restaurant-list\.page\.html already hold it/);
  assert.ok(section.includes(WORDING.ambiguous), "the pack states that none of the nodes can be attributed to the change");
  assert.ok(deriveClaimsFromPackText(result.text ?? "").some((c) => c.kind === "provides" && c.fact === "changed-values"), "the section is a fact the pack provides");
});

test("a pack that carries the section lints clean as the pack section of a prompt: no second provider, no duplicate line, no directive wording, no trust vocabulary", async () => {
  const result = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(2), label(0, "removed", "Cambiar filtro")] },
    siteShowing([{ route: "/restaurantes", nodes: [...NODES_WITHOUT_RESTAURANTS, "button: Cambiar filtro"] }]),
  );
  assert.ok(sectionText(result.text) !== "");
  const claims = deriveClaimsFromPackText(result.text ?? "");
  const findings = lintCell({ name: "pack", regen: false, sections: [{ id: "context-pack", layer: "assembled", text: result.text ?? "", claims, verbatim: false }] });
  assert.deepEqual(findings, []);
  assert.equal(countDirectives(sectionText(result.text)), 0);
});

test("the same label with no unchanged line holding it is stated with the limit of the comparison once a node shows it", async () => {
  const result = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(0)] },
    siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]),
  );
  assert.ok(sectionText(result.text).includes(WORDING.moreNodes(FILE)));
  assert.ok(sectionText(result.text).includes(WORDING.limit));
});

test("an old value the page still shows beyond the unchanged lines that hold it is stated", async () => {
  const result = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(0, "removed", "Cambiar filtro"), label(0, "removed", "Cambiar filtros")] },
    siteShowing([{ route: "/restaurantes", nodes: ["button: Cambiar filtro"] }]),
  );
  const section = sectionText(result.text);
  assert.ok(section.includes(WORDING.moreNodes(FILE)));
  assert.equal(section.match(/^- old value/gm)?.length, 1, "only the old value the page shows is stated");
});

test("a page that was not grounded says nothing about a value, and a page that only served to find links is not counted", async () => {
  const ungrounded = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(0)] },
    siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS, grounded: false }]),
  );
  assert.equal(sectionText(ungrounded.text), "");
  /* The app root is rendered only for its links when no route asked for it: its nodes are no part of the report. */
  const seedOnly = await buildContextPack(
    { baseUrl: PACK_INPUT.baseUrl, e2eDir: PACK_INPUT.e2eDir, routes: ["/restaurantes", "/shops/:province"], changedLiterals: [label(0)] },
    siteShowing([{ route: "/restaurantes", nodes: ["heading: Restaurantes"] }, { route: "/", nodes: ["button: Cambiar filtros"] }]),
  );
  const section = sectionText(seedOnly.text);
  assert.match(section, /no captured node shows it/);
});

test("the pack reports the added values a route shows by more nodes than unchanged lines hold them, and no other", async () => {
  const stated = await buildContextPack(
    { ...PACK_INPUT, changedLiterals: [label(0), label(2, "added", "Otro texto")] },
    siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]),
  );
  assert.deepEqual(stated.changedValuesWithMoreNodes, ["Cambiar filtros"]);
  const unattributable = await buildContextPack({ ...PACK_INPUT, changedLiterals: [label(2)] }, siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]));
  assert.equal("changedValuesWithMoreNodes" in unattributable, false);
  const none = await buildContextPack(PACK_INPUT, siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]));
  assert.equal("changedValuesWithMoreNodes" in none, false);
});

test("a pack without changed literals has no changed-values section", async () => {
  const result = await buildContextPack(PACK_INPUT, siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]));
  assert.equal(sectionText(result.text), "");
  assert.ok(result.text !== undefined);
});

test("a capture reports the nodes of each page it renders, so the pack can count them", async () => {
  const snaps: RouteSnapshot[] = [{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }];
  const deps: CaptureDomDeps = { render: async () => snaps };
  const reported: CapturedPage[] = [];
  await captureDomForRoutes(["/restaurantes"], { e2eDir: "/e2e", baseUrl: "http://localhost:3000", onPages: (pages) => reported.push(...pages) }, deps);
  assert.deepEqual(reported[0]?.nodes, NODES_WITHOUT_RESTAURANTS);
});

test("end to end from a diff: the one-line label change of the live run reads as unattributable against the two nodes DEV rendered", async () => {
  const diff = [
    `diff --git a/${FILE} b/${FILE}`,
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    "@@ -162,5 +162,5 @@",
    "   <app-end-of-list",
    '-    endActionLabel="Cambiar filtro"',
    '+    endActionLabel="Cambiar filtros"',
    "   />",
  ].join("\n");
  /* The file after the change holds the label on the changed line and on two unchanged ones. */
  const lines = Array.from({ length: 170 }, () => "<x/>");
  lines[66] = '<app-button label="Cambiar filtros" />';
  lines[144] = '<app-empty-state cta="Cambiar filtros" />';
  lines[162] = '    endActionLabel="Cambiar filtros"';
  const parser = new DiffParserService();
  const unchangedLines = countUnchangedLinesHolding(lines.join("\n"), parser.changedLines(diff).get(FILE), "Cambiar filtros");
  assert.equal(unchangedLines, 2, "setup: the two pre-existing lines of the live run");
  const changedLiterals = parser.changedLiterals(diff).map((literal) => ({ ...literal, unchangedLines }));
  const result = await buildContextPack({ ...PACK_INPUT, changedLiterals }, siteShowing([{ route: "/restaurantes", nodes: NODES_WITHOUT_RESTAURANTS }]));
  const section = sectionText(result.text);
  assert.ok(section.includes(WORDING.ambiguous));
  assert.equal(section.includes(WORDING.moreNodes(FILE)), false);
});

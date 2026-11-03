import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPreExecGrounding,
  type RouteTree,
} from "@contexts/generation/domain/pre-exec-grounding.service.ts";

/* checkPreExecGrounding composes unscopedMultipleContradictions with the catalog gate
   (confidentWindowEnd / extractTestIdSelectorsWithIndex):
   - PER-SPEC ROUTE PAIRING — a spec is checked only against trees of routes IT targets.
   - SAFE DIRECTION: only catalog corrections feed the one-shot repair; an ambiguity is ADVISORY
   telemetry (the regex check has false positives that real execution does not), never a correction,
   an origin or a block; degraded/unsettled routes are advisory.
   Input shape: RouteTree[] (route + nodes[] + optional catalog fields) — a domain-local, minimal
   mirror of generation/infrastructure's RouteSnapshot/RouteCatalog SHAPE (not imported — domain
   never imports another context; the use-case adapts the real capture into this shape).
 */

test("checkPreExecGrounding: no routes captured -> zero corrections, zero counters", () => {
  const result = checkPreExecGrounding({ specSources: [`await page.goto("/owners");`], routes: [] });
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.ambiguities, []);
  assert.equal(result.preExecAmbiguityCatches, 0);
  assert.equal(result.catalogGateInWindow, 0);
  assert.equal(result.catalogGateAdvisory, 0);
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.absentSelectorFailClosed, 0);
  assert.equal(result.absentSelectorUnsettled, 0);
});

test("checkPreExecGrounding: a page-rooted MULTIPLE ambiguity on the spec's OWN route is counted and told, as an advisory and not as a correction", () => {
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners"] },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.match(result.ambiguities[0]!, /MULTIPLE/);
  assert.deepEqual(result.corrections, []);
});

/* Per-spec route pairing.
 */
test("leak 6b fix: spec A's ambiguity does NOT leak into spec B's route (per-spec pairing)", () => {
  /* Spec A targets /list (5 "Edit" buttons -> real ambiguity). Spec B targets /detail (1 "Edit"
     button -> no ambiguity). Cross-producting ALL specs x ALL trees (the pre-fix behavior) would
     wrongly check spec B's selector against /list's tree too, since /list's tree also happens to
     multiply-match "Edit" — but spec B never navigates there, so that tree is NOT its own ground
     truth. Per-spec pairing must yield ZERO contradictions for spec B.
   */
  const specA = `await page.goto("/list"); await page.getByRole("button", { name: "Edit" }).click();`;
  const specB = `await page.goto("/detail"); await page.getByRole("button", { name: "Edit" }).click();`;
  const routes: RouteTree[] = [
    { route: "/list", nodes: Array(5).fill("button: Edit") },
    { route: "/detail", nodes: ["button: Edit"] },
  ];
  const result = checkPreExecGrounding({ specSources: [specA, specB], routes });
  /* Only spec A's ambiguity should surface; spec B's own route (/detail) has a unique "Edit". */
  assert.equal(result.preExecAmbiguityCatches, 1);
});

test("leak 6b fix: a spec with no first-goto route is checked against ALL captured routes (advisory fallback unaffected)", () => {
  /* A spec with no literal .goto(...) (e.g. it reuses fixtures/navigation helpers) cannot be paired
     to a specific route — the pairing degrades to the full route set rather than silently excluding
     it from grounding entirely (never a false negative that hides a real ambiguity).
   */
  const specSources = [`await page.getByRole("heading", { name: "Owners" }).click();`];
  const routes: RouteTree[] = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
});

/* ── Catalog gate composition ───────────────────────────────────────────────── */
test("catalog gate: a fabricated test-id inside the confident window on a captured&&settled route yields a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["real-id", 1]]) },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.catalogGateInWindow, 1);
  assert.equal(result.catalogGateAdvisory, 0);
  assert.equal(result.corrections.length, 1);
  assert.match(result.corrections[0]!, /ghost-id/);
  assert.match(result.corrections[0]!, /NOT in the captured DOM/);
});

test("catalog gate: a test-id present in the catalog is NOT a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("real-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["real-id", 1]]) },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateInWindow, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: a DEGRADED route is advisory only — never a fail-closed correction (safe direction)", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "degraded", settled: false, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: an UNSETTLED route is advisory only — never a fail-closed correction (safe direction)", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: false, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
  assert.equal(result.corrections.length, 0);
});

test("catalog gate: a selector AFTER the confident window closes (post-click) is advisory only", () => {
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("button", { name: "Add" }).click(); await page.getByTestId("late-id").click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["button: Add"], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 0);
  assert.equal(result.catalogGateAdvisory, 1);
});

test("catalog gate corrections NEVER escalate preExecAmbiguityCatches — the two channels stay independent", () => {
  const specSources = [`await page.goto("/owners"); await page.getByTestId("ghost-id").click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.preExecAmbiguityCatches, 0); /* catalog corrections are NOT ambiguity catches */
});

test("SAFE DIRECTION: an ambiguity and a catalog correction on the SAME spec stay on their own channels", () => {
  /* The ambiguous role selector sits before the first click and the fabricated test-id after it: the ambiguity is told as an advisory, and the test-id (outside the confident window) stays an advisory of the catalog gate. Neither is a correction. */
  const specSources = [
    `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click(); await page.getByTestId("ghost-id").fill("x"); await page.getByRole("button", { name: "Save" }).click();`,
  ];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners", "button: Save"], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources, routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.catalogGateFailClosed, 0, "the ghost-id selector sits AFTER the first click — outside the confident window, so it stays advisory (not a correction)");
  assert.equal(result.catalogGateAdvisory, 1);
  assert.deepEqual(result.corrections, []);
});

/* ── Which spec raised each correction ─────────────────────────────────────── */
const OWNERS_PAGE = `await page.goto("/owners");`;
const PAGE_ROOTED = `${OWNERS_PAGE} await page.getByRole("heading", { name: "Owners" }).click();`;
const DISAMBIGUATED = `${OWNERS_PAGE} await page.getByRole("heading", { name: "Owners" }).first().click();`;
const SCOPED = `${OWNERS_PAGE} await page.locator("main").getByRole("heading", { name: "Owners" }).click();`;
const UNRELATED = `${OWNERS_PAGE} await page.getByRole("link", { name: "Home" }).click();`;
const GHOST = `${OWNERS_PAGE} await page.getByTestId("ghost-id").click();`;
const TWO_OWNERS: RouteTree[] = [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners", "link: Home"] }];
const OWNERS_WITHOUT_GHOST: RouteTree[] = [{ route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() }];

test("an ambiguity is told once, however many specs raise it, and it has no origin: nothing is regenerated for it", () => {
  const result = checkPreExecGrounding({ specSources: [PAGE_ROOTED, UNRELATED, PAGE_ROOTED], routes: TWO_OWNERS });
  assert.equal(result.ambiguities.length, 1, "told once");
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.origins, []);
});

test("a spec that holds the same selector disambiguated or scoped raised no ambiguity", () => {
  assert.deepEqual(checkPreExecGrounding({ specSources: [DISAMBIGUATED, SCOPED, UNRELATED], routes: TWO_OWNERS }).ambiguities, []);
});

test("a spec is blamed only for the routes it targets: the same selector on a route that is fine raised nothing", () => {
  const listSpec = `await page.goto("/list"); await page.getByRole("button", { name: "Edit" }).click();`;
  const detailSpec = `await page.goto("/detail"); await page.getByRole("button", { name: "Edit" }).click();`;
  const routes: RouteTree[] = [
    { route: "/list", nodes: Array(5).fill("button: Edit") },
    { route: "/detail", nodes: ["button: Edit"] },
  ];
  assert.deepEqual(checkPreExecGrounding({ specSources: [detailSpec], routes }).ambiguities, []);
  assert.equal(checkPreExecGrounding({ specSources: [detailSpec, listSpec], routes }).ambiguities.length, 1);
});

test("a test-id the page of one spec does not have is blamed on the spec whose page lacks it", () => {
  const onPets = `await page.goto("/pets"); await page.getByTestId("owner-list").click();`;
  const onOwners = `await page.goto("/owners"); await page.getByTestId("owner-list").click();`;
  const routes: RouteTree[] = [
    { route: "/pets", nodes: [], status: "captured", settled: true, testIds: new Map() },
    { route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map([["owner-list", 1]]) },
  ];
  const result = checkPreExecGrounding({ specSources: [onOwners, onPets], routes });
  assert.equal(result.corrections.length, 1);
  assert.deepEqual(result.origins, [{ contradiction: result.corrections[0], specIndex: 1 }]);
});

test("a test-id correction that two specs raise is two corrections and two origins", () => {
  const result = checkPreExecGrounding({ specSources: [GHOST, UNRELATED, GHOST], routes: OWNERS_WITHOUT_GHOST });
  assert.equal(result.corrections.length, 2);
  assert.equal(result.catalogGateFailClosed, 2);
  assert.deepEqual(result.origins.map((origin) => origin.specIndex), [0, 2]);
});

test("the origins are the corrections: every correction has one, and every origin names a correction", () => {
  const result = checkPreExecGrounding({ specSources: [GHOST, UNRELATED, GHOST], routes: OWNERS_WITHOUT_GHOST });
  assert.deepEqual(result.origins.map((origin) => origin.contradiction), result.corrections);
});

test("nothing captured, or nothing wrong, gives no origin", () => {
  assert.deepEqual(checkPreExecGrounding({ specSources: [GHOST], routes: [] }).origins, []);
  assert.deepEqual(checkPreExecGrounding({ specSources: [UNRELATED], routes: TWO_OWNERS }).origins, []);
});

test("SAFE DIRECTION: an ambiguity on one spec and a catalog correction on another are told on their own channels", () => {
  const fabricatedIdSpec = `await page.goto("/pets"); await page.getByTestId("ghost-id").click();`;
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "heading: Owners"], status: "captured", settled: true, testIds: new Map() },
    { route: "/pets", nodes: [], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specSources: [PAGE_ROOTED, fabricatedIdSpec], routes });
  assert.equal(result.preExecAmbiguityCatches, 1);
  assert.equal(result.catalogGateFailClosed, 1);
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.corrections.length, 1);
  assert.match(result.corrections[0]!, /ghost-id/);
  assert.deepEqual(result.origins.map((origin) => origin.specIndex), [1]);
});

/* ── The DOM-assertion gate: a verifiable-absent role/text/label selector is a correction ──
   The engine already knows how to prove a selector absent from a captured a11y tree; the gate
   turns a PROVABLE absence into the same one-shot correction family the catalog gate feeds, so
   the reviewer no longer has to compare selectors to the DOM by hand.
   Fail-closed in every other direction: no evidence, no finding. */

const OWNERS_SPEC = "flows/owners.spec.ts";
const CAPTURED_OWNERS: RouteTree[] = [
  { route: "/owners", nodes: ["heading: Owners", "button: Add Owner"], status: "captured", settled: true, testIds: new Map() },
];
const ABSENT_ON_OWNERS = `await page.goto("/owners"); await page.getByRole("button", { name: "Delete owner" }).click();`;

test("a role selector the captured tree proves absent is one correction naming the spec and the selector", () => {
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources: [ABSENT_ON_OWNERS], routes: CAPTURED_OWNERS });
  assert.equal(result.absentSelectorFailClosed, 1);
  assert.equal(result.corrections.length, 1);
  assert.match(result.corrections[0]!, /flows\/owners\.spec\.ts/);
  assert.match(result.corrections[0]!, /button: "Delete owner"/);
  assert.match(result.corrections[0]!, /NOT in the captured/);
  assert.deepEqual(result.origins.map((origin) => origin.specIndex), [0]);
});

test("a role selector the captured tree shows is not a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByRole("button", { name: "Add Owner" }).click();`];
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources, routes: CAPTURED_OWNERS });
  assert.equal(result.absentSelectorFailClosed, 0);
  assert.deepEqual(result.corrections, []);
});

test("a role seen only as the (present) marker is unverifiable and is never a correction", () => {
  const specSources = [`await page.goto("/owners"); await page.getByRole("row", { name: "Invoice 7" }).click();`];
  const routes: RouteTree[] = [{ route: "/owners", nodes: ["row: (present)"], status: "captured", settled: true, testIds: new Map() }];
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources, routes });
  assert.equal(result.absentSelectorFailClosed, 0);
  assert.deepEqual(result.corrections, []);
});

test("no settled tree settles nothing: a degraded route, an unsettled one and an empty node list are counted and never corrected", () => {
  const specSources = [ABSENT_ON_OWNERS];
  const cases: RouteTree[][] = [
    [{ route: "/owners", nodes: ["heading: Owners"], status: "degraded", settled: false, testIds: new Map() }],
    [{ route: "/owners", nodes: ["heading: Owners"], status: "captured", settled: false, testIds: new Map() }],
    [{ route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() }],
  ];
  for (const routes of cases) {
    const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources, routes });
    assert.equal(result.absentSelectorFailClosed, 0);
    assert.equal(result.absentSelectorUnsettled, 1);
    assert.deepEqual(result.corrections, []);
  }
});

test("one degraded route of a spec's own set leaves the whole spec uncorrected, never a half-read page", () => {
  const specSources = [`await page.goto("/owners"); await page.goto("/owners/new"); await page.getByRole("button", { name: "Delete owner" }).click();`];
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners"], status: "captured", settled: true, testIds: new Map() },
    { route: "/owners/new", nodes: [], status: "degraded", settled: false, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources, routes });
  assert.equal(result.absentSelectorFailClosed, 0);
  assert.equal(result.absentSelectorUnsettled, 1);
});

test("an absent selector is attributed to the spec whose own route lacks it, and to no other", () => {
  const onOwners = `await page.goto("/owners"); await page.getByRole("button", { name: "Delete owner" }).click();`;
  const onPets = `await page.goto("/pets"); await page.getByRole("button", { name: "Delete owner" }).click();`;
  const routes: RouteTree[] = [
    { route: "/owners", nodes: ["heading: Owners", "button: Add Owner"], status: "captured", settled: true, testIds: new Map() },
    { route: "/pets", nodes: ["heading: Pets", "button: Delete owner"], status: "captured", settled: true, testIds: new Map() },
  ];
  const result = checkPreExecGrounding({ specFiles: ["flows/owners.spec.ts", "flows/pets.spec.ts"], specSources: [onOwners, onPets], routes });
  assert.equal(result.corrections.length, 1);
  assert.deepEqual(result.origins.map((origin) => origin.specIndex), [0]);
  assert.match(result.corrections[0]!, /flows\/owners\.spec\.ts/);
  assert.doesNotMatch(result.corrections[0]!, /flows\/pets\.spec\.ts/);
});

test("a selector after the page has changed (past the confident window) is never corrected", () => {
  /* The capture is the page as loaded: what an earlier click may reveal, or another page may hold, the tree cannot settle. The role is there under another name, so absence would be conclusive without the window. */
  const specSources = [`await page.goto("/owners"); await page.getByRole("button", { name: "Add Owner" }).click(); await page.getByRole("button", { name: "Confirm deletion" }).click();`];
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources, routes: CAPTURED_OWNERS });
  assert.equal(result.absentSelectorFailClosed, 0);
  assert.deepEqual(result.corrections, []);
});

test("a spec that uses only a CSS locator raises no correction: the locator family is advisory, never a fact", () => {
  const result = checkPreExecGrounding({ specFiles: [OWNERS_SPEC], specSources: [`await page.goto("/owners"); await page.locator(".btn-primary").click();`], routes: CAPTURED_OWNERS });
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.origins, []);
});

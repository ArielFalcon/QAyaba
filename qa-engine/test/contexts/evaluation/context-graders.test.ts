/* The R4 fixture and the context graders over it: gross/focused utilization, completeness, freshness, no-op consistency. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import { evidence } from "./evidence-fixtures.ts";
import type { ContextEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";

const route = (path: string): string => `route:${path}`;
const dom = (path: string, testId: string): string => `dom:${path}#${testId}`;

/* The change-relevant routes of R4: the three RestaurantListPage routes, one component. */
const RELEVANT_ROUTES = ["/restaurantes", "/restaurantes/:province", "/restaurantes/:province/:city"];

/* 41 delivered routes, 263 delivered DOM ids; the spec navigates one template and reads three cards. */
function r4Context(): ContextEvidence {
  const routes = [
    route("/home"),
    route("/login"),
    route("/login/callback"),
    ...RELEVANT_ROUTES.map(route),
    ...Array.from({ length: 35 }, (_, i) => route(`/misc/${i}`)),
  ];
  const domIds = [
    ...Array.from({ length: 94 }, (_, i) => dom("/home", `h${i}`)),
    ...Array.from({ length: 14 }, (_, i) => dom("/restaurantes/:province/:city", `restaurant-card-${i}`)),
    ...Array.from({ length: 155 }, (_, i) => dom("/misc/0", `m${i}`)),
  ];
  const spec = [
    "test('restaurants', async ({ page }) => {",
    "  await page.goto('/restaurantes/madrid/madrid');",
    "  await page.getByTestId('restaurant-card-0').first().isVisible();",
    "  await page.getByTestId('restaurant-card-1').first().isVisible();",
    "  await page.getByTestId('restaurant-card-2').first().isVisible();",
    "});",
  ].join("\n");
  return {
    delivered: [
      { source: "context-map", ids: routes, bytes: 27_546, omitted: 0, omissions: [] },
      { source: "context-pack", ids: domIds, bytes: 5_713, omitted: 34, omissions: [{ class: "truncation", reason: "node-cap", count: 34, route: "/home" }] },
    ],
    relevantIds: RELEVANT_ROUTES.map(route),
    relevantGroups: ["RestaurantListPage", "RestaurantListPage", "RestaurantListPage"],
    changedTestIds: [],
    changedElement: "unknown",
    snapshots: [{ path: "flows/restaurants.spec.ts", text: spec }],
    toolSequence: [],
    fileReads: undefined,
    freshness: { stale: [{ source: "context-map", reason: "sha-mismatch" }], domChanged: true },
  };
}

const score = (e: ReturnType<typeof evidence>, name: string) => gradeEvidence(e).find((s) => s.name === name);

test("R4 gross utilization is the micro-average over all delivered extractable items", () => {
  const e = evidence({ context: r4Context() });
  assert.equal(score(e, "context_utilization.route")?.value, 1 / 41);
  assert.equal(score(e, "context_utilization.dom")?.value, 3 / 263);
  assert.equal(score(e, "context_utilization.op"), undefined, "no delivered operations → n/a, never 0");
  assert.equal(score(e, "context_utilization")?.value, 4 / 304, "overall gross is the union micro-average");
});

test("R4 focused utilization groups the relevant routes by component and omits DOM when no element is identifiable", () => {
  const e = evidence({ context: r4Context() });
  assert.equal(score(e, "context_utilization_focused.route")?.value, 1, "one RestaurantListPage group, used");
  assert.equal(score(e, "context_utilization_focused.dom"), undefined, "label-only change has no changed element → n/a");
  assert.equal(score(e, "context_utilization_focused.op"), undefined);
});

test("R4 is complete: the node-cap truncation is on /home, which is not change-relevant", () => {
  assert.equal(score(evidence({ context: r4Context() }), "context_complete")?.value, true);
});

test("a truncation on a change-relevant page is incomplete, with source:reason:count", () => {
  const e = evidence({
    context: {
      ...r4Context(),
      delivered: [
        { source: "context-map", ids: [], bytes: 0, omitted: 0, omissions: [] },
        { source: "context-pack", ids: [], bytes: 0, omitted: 40, omissions: [{ class: "truncation", reason: "node-cap", count: 40, route: "/restaurantes/:province/:city" }] },
      ],
    },
  });
  const s = score(e, "context_complete");
  assert.equal(s?.value, false);
  assert.match(s?.comment ?? "", /context-pack:node-cap:40/);
});

test("context_complete is omitted when nothing was delivered", () => {
  assert.equal(score(evidence(), "context_complete"), undefined);
  assert.equal(score(evidence({ context: { ...r4Context(), delivered: [] } }), "context_complete"), undefined);
});

test("R4 is stale: the map sha mismatched and the change-relevant DOM changed between captures", () => {
  const e = evidence({ context: r4Context() });
  assert.equal(score(e, "context_fresh")?.value, false);
});

test("context_fresh is omitted when no provenance was recorded", () => {
  assert.equal(score(evidence({ context: { ...r4Context(), freshness: undefined } }), "context_fresh"), undefined);
});

test("noop_consistent is omitted when the changed element is unknown (label-only R4)", () => {
  assert.equal(score(evidence({ context: r4Context() }), "noop_consistent"), undefined);
});

test("noop_consistent judges a no-op against the changed element's observability", () => {
  const absent = evidence({ context: { ...r4Context(), changedElement: "absent" }, specs: { generated: 0, valid: 0, passed: 0 } });
  assert.equal(score(absent, "noop_consistent")?.value, true, "no-op + absent element is consistent");
  const presentButNoop = evidence({ context: { ...r4Context(), changedElement: "present", changedTestIds: ["save-btn"] }, specs: { generated: 0, valid: 0, passed: 0 } });
  assert.equal(score(presentButNoop, "noop_consistent")?.value, false, "no-op + present element is inconsistent");
  const presentWithSpec = evidence({ context: { ...r4Context(), changedElement: "present", changedTestIds: ["save-btn"] }, specs: { generated: 1, valid: 1, passed: 1 } });
  assert.equal(score(presentWithSpec, "noop_consistent")?.value, true, "spec + present element is consistent");
});

test("context scores are absent for a run with no grounding", () => {
  const scores = gradeEvidence(evidence());
  for (const n of ["context_utilization", "context_utilization_focused", "context_complete", "context_fresh", "noop_consistent"]) {
    assert.equal(scores.some((s) => s.name === n || s.name.startsWith(`${n}.`)), false, n);
  }
});

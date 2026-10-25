/* The plan graders: how much of the change's pages the lead's plan reached, how much of it a passing spec reached, and how many flows delivered a passing spec. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { ContextEvidence, PlanEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { evidence } from "./evidence-fixtures.ts";

const NAMES = ["plan_route_coverage", "delivered_route_coverage", "plan_graph_route_coverage", "delivered_graph_route_coverage", "flow_delivery_rate"];

function plan(over: Partial<PlanEvidence> = {}): PlanEvidence {
  return {
    kind: "fanout",
    changeRoutes: ["/cart", "/shops/:city", "/orders"],
    flows: [
      { id: "cart", visits: ["/cart"], passed: true },
      { id: "shops", visits: ["/shops/:city"], passed: false },
    ],
    ...over,
  };
}

const scores = (p: PlanEvidence | undefined, over = {}) => new Map(gradeEvidence(evidence({ plan: p, ...over }), NAMES).map((s) => [s.name, s]));

test("the plan's reach, the passing specs' reach and the flows that delivered are graded over the change's pages", () => {
  const s = scores(plan());
  assert.equal(s.get("plan_route_coverage")?.value, 2 / 3);
  assert.match(String(s.get("plan_route_coverage")?.comment), /\/orders/);
  assert.equal(s.get("delivered_route_coverage")?.value, 1 / 3);
  assert.match(String(s.get("delivered_route_coverage")?.comment), /\/shops\/:city/);
  assert.equal(s.get("flow_delivery_rate")?.value, 1 / 2);
});

test("a page two flows visit is reached once, and reached by a passing spec when either passed", () => {
  const s = scores(plan({ changeRoutes: ["/cart"], flows: [{ id: "a", visits: ["/cart"], passed: false }, { id: "b", visits: ["/cart"], passed: true }] }));
  assert.equal(s.get("plan_route_coverage")?.value, 1);
  assert.equal(s.get("delivered_route_coverage")?.value, 1);
});

test("nothing is graded without a plan of flows, and no reach without change pages", () => {
  assert.equal(scores(undefined).size, 0);
  assert.equal(scores(plan({ kind: "lead", flows: [] })).size, 0);
  assert.equal(scores(plan({ kind: "noop", flows: [] })).size, 0);
  const noPages = scores(plan({ changeRoutes: [] }));
  assert.deepEqual([...noPages.keys()], ["flow_delivery_rate"]);
});

test("a flow whose result cannot be told leaves what depends on it ungraded", () => {
  const s = scores(plan({ flows: [{ id: "cart", visits: ["/cart"], passed: undefined }, { id: "shops", visits: ["/shops/:city"], passed: true }] }));
  assert.equal(s.get("plan_route_coverage")?.value, 2 / 3);
  assert.equal(s.has("delivered_route_coverage"), false);
  assert.equal(s.has("flow_delivery_rate"), false);
});

test("a run that has not finished is not graded", () => {
  assert.equal(scores(plan(), { finished: false, verdict: null }).size, 0);
});

/* The route-ranking record of a run: each change page's id and why it is one. */
function ranked(basis: Record<string, string>): ContextEvidence {
  return {
    delivered: [],
    relevantIds: Object.keys(basis).map((route) => `route:${route}`),
    relevantGroups: [],
    relevantBasis: Object.values(basis),
    changedTestIds: [],
    changedElement: undefined,
    snapshots: [],
    toolSequence: [],
    fileReads: undefined,
    freshness: undefined,
  };
}

test("the pages the call graph proved are also scored apart, so graph pages can be told from the map's", () => {
  const s = scores(plan(), { context: ranked({ "/cart": "implementation", "/shops/:city": "graph", "/orders": "graph" }) });
  assert.equal(s.get("plan_route_coverage")?.value, 2 / 3, "the whole set of change pages is still graded");
  assert.equal(s.get("plan_graph_route_coverage")?.value, 1 / 2);
  assert.match(String(s.get("plan_graph_route_coverage")?.comment), /\/orders/);
  assert.equal(s.get("delivered_graph_route_coverage")?.value, 0);
});

test("without a graph page, or without a recorded basis, nothing is scored apart", () => {
  const mapOnly = scores(plan(), { context: ranked({ "/cart": "implementation", "/shops/:city": "spec", "/orders": "source" }) });
  assert.equal(mapOnly.has("plan_graph_route_coverage"), false);
  assert.equal(mapOnly.has("delivered_graph_route_coverage"), false);
  assert.equal(scores(plan()).has("plan_graph_route_coverage"), false);
});

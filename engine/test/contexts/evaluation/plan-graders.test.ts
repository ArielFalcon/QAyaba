/* The plan graders: how much of the change's pages the lead's plan reached, how much of it a passing spec reached, and how many flows delivered a passing spec. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { ContextEvidence, PlanEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { evidence } from "./evidence-fixtures.ts";

const NAMES = ["plan_graph_route_coverage", "delivered_graph_route_coverage", "flow_delivery_rate", "plan_candidate_coverage", "delivered_candidate_coverage"];

function plan(over: Partial<PlanEvidence> = {}): PlanEvidence {
  return {
    kind: "fanout",
    changeRoutes: ["/cart", "/shops/:city", "/orders"],
    candidates: [],
    flows: [
      { id: "cart", visits: ["/cart"], candidates: [], passed: true },
      { id: "shops", visits: ["/shops/:city"], candidates: [], passed: false },
    ],
    ...over,
  };
}

const scores = (p: PlanEvidence | undefined, over = {}) => new Map(gradeEvidence(evidence({ plan: p, ...over }), NAMES).map((s) => [s.name, s]));

test("the plan's reach, the passing specs' reach and the flows that delivered are graded over the change's pages", () => {
  const s = scores(plan());
  assert.equal(s.get("plan_candidate_coverage")?.value, 2 / 3);
  assert.match(String(s.get("plan_candidate_coverage")?.comment), /\/orders/);
  assert.equal(s.get("delivered_candidate_coverage")?.value, 1 / 3);
  assert.match(String(s.get("delivered_candidate_coverage")?.comment), /\/shops\/:city/);
  assert.equal(s.get("flow_delivery_rate")?.value, 1 / 2);
});

test("a page two flows visit is reached once, and reached by a passing spec when either passed", () => {
  const s = scores(plan({ changeRoutes: ["/cart"], flows: [{ id: "a", visits: ["/cart"], candidates: [], passed: false }, { id: "b", visits: ["/cart"], candidates: [], passed: true }] }));
  assert.equal(s.get("plan_candidate_coverage")?.value, 1);
  assert.equal(s.get("delivered_candidate_coverage")?.value, 1);
});

test("nothing is graded without a plan of flows, and no reach without change pages", () => {
  assert.equal(scores(undefined).size, 0);
  assert.equal(scores(plan({ kind: "lead", flows: [] })).size, 0);
  assert.equal(scores(plan({ kind: "noop", flows: [] })).size, 0);
  const noPages = scores(plan({ changeRoutes: [] }));
  assert.deepEqual([...noPages.keys()], ["flow_delivery_rate"]);
});

test("a flow whose result cannot be told leaves what depends on it ungraded", () => {
  const s = scores(plan({ flows: [{ id: "cart", visits: ["/cart"], candidates: [], passed: undefined }, { id: "shops", visits: ["/shops/:city"], candidates: [], passed: true }] }));
  assert.equal(s.get("plan_candidate_coverage")?.value, 2 / 3);
  assert.equal(s.has("delivered_candidate_coverage"), false);
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
  assert.equal(s.get("plan_candidate_coverage")?.value, 2 / 3, "the whole set of change pages is still graded");
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


const CANDIDATES: PlanEvidence["candidates"] = [
  { id: "uc-a", state: "planned" },
  { id: "uc-b", state: "planned" },
  { id: "uc-c", state: "planned" },
  { id: "uc-d", state: "unplanned" },
];

const withCandidates = (over: Partial<PlanEvidence> = {}): PlanEvidence =>
  plan({
    candidates: CANDIDATES,
    flows: [
      { id: "cart", visits: [], candidates: [{ id: "uc-a", claimed: "covered" }, { id: "uc-b", claimed: "covered" }], passed: true },
      { id: "shops", visits: [], candidates: [{ id: "uc-c", claimed: "covered" }], passed: false },
    ],
    ...over,
  });

test("the plan's reach and the passing specs' reach are graded per candidate, and the comment names each by id and state", () => {
  const s = scores(withCandidates());
  assert.equal(s.get("plan_candidate_coverage")?.value, 3 / 4);
  assert.equal(s.get("delivered_candidate_coverage")?.value, 2 / 4);
  const comment = String(s.get("delivered_candidate_coverage")?.comment);
  assert.match(comment, /uc-a: delivered/);
  assert.match(comment, /uc-c: planned/);
  assert.match(comment, /uc-d: unplanned/);
  assert.match(String(s.get("plan_candidate_coverage")?.comment), /uc-d: unplanned/);
});

test("a dropped candidate is named with its reason and does not count as planned", () => {
  const s = scores(withCandidates({ candidates: [{ id: "uc-a", state: "planned" }, { id: "uc-b", state: "dropped", reason: "only a log line changed" }], flows: [{ id: "cart", visits: [], candidates: [{ id: "uc-a" }], passed: true }] }));
  assert.equal(s.get("plan_candidate_coverage")?.value, 1 / 2);
  assert.match(String(s.get("plan_candidate_coverage")?.comment), /uc-b: dropped: only a log line changed/);
});

test("a sidekick's claim never scores: a candidate claimed covered by a flow whose spec failed is undelivered", () => {
  const s = scores(withCandidates({ candidates: [{ id: "uc-a", state: "planned" }], flows: [{ id: "cart", visits: [], candidates: [{ id: "uc-a", claimed: "covered" }], passed: false }] }));
  assert.equal(s.get("plan_candidate_coverage")?.value, 1);
  assert.equal(s.get("delivered_candidate_coverage")?.value, 0);
});

test("a plan with neither candidates nor change pages, or a flow whose result cannot be told, leaves the coverage scores ungraded", () => {
  assert.equal(scores(plan({ changeRoutes: [] })).has("plan_candidate_coverage"), false);
  const unknown = scores(withCandidates({ flows: [{ id: "cart", visits: [], candidates: [{ id: "uc-a" }], passed: undefined }] }));
  assert.equal(unknown.get("plan_candidate_coverage")?.value, 3 / 4);
  assert.equal(unknown.has("delivered_candidate_coverage"), false);
});

test("the merged coverage pair keeps the value of the route pair and of the candidate pair it replaces", () => {
  /* One candidate per change page, answered by the flow that visits the page: the two former graders gave the same numbers. */
  const oneToOne = plan({
    candidates: [{ id: "uc-cart", state: "planned" }, { id: "uc-shops", state: "planned" }, { id: "uc-orders", state: "unplanned" }],
    flows: [
      { id: "cart", visits: ["/cart"], candidates: [{ id: "uc-cart" }], passed: true },
      { id: "shops", visits: ["/shops/:city"], candidates: [{ id: "uc-shops" }], passed: false },
    ],
  });
  const byUseCase = scores(oneToOne);
  const byPage = scores(plan());
  assert.equal(byUseCase.get("plan_candidate_coverage")?.value, 2 / 3);
  assert.equal(byUseCase.get("delivered_candidate_coverage")?.value, 1 / 3);
  assert.equal(byPage.get("plan_candidate_coverage")?.value, byUseCase.get("plan_candidate_coverage")?.value, "the former plan_route_coverage");
  assert.equal(byPage.get("delivered_candidate_coverage")?.value, byUseCase.get("delivered_candidate_coverage")?.value, "the former delivered_route_coverage");
  assert.match(String(byPage.get("plan_candidate_coverage")?.comment), /by change page/);
});

test("the removed route pair is no longer emitted", () => {
  const names = gradeEvidence(evidence({ plan: plan() })).map((x) => x.name);
  assert.equal(names.includes("plan_route_coverage"), false);
  assert.equal(names.includes("delivered_route_coverage"), false);
});

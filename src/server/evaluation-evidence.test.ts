/* The evidence of a run that failed after validation: what it delivered is read from the run's delivered snapshots, since the run record's own spec list is written only by the normal exit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GradeRunUseCase } from "@contexts/evaluation/application/index";
import type { ScoreStorePort } from "@contexts/evaluation/application/index.ts";
import { gradeEvidence } from "@contexts/evaluation/application/index";
import type { RunRecord } from "../types";
import type { SpecSnapshotRow } from "./persistence/repositories/run.repository";
import { HistoryEvidenceAdapter, type EvidenceDeps } from "./evaluation-evidence";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    app: "demo",
    sha: "abcdef1",
    target: "e2e",
    mode: "diff",
    status: "done",
    verdict: "infra-error",
    at: "2026-10-19T00:00:00.000Z",
    cases: [],
    ...over,
  } as RunRecord;
}

function snapshot(path: string, delivered = 1): SpecSnapshotRow {
  return { runId: "run-1", path, sha256: "x", text: "t", bytes: 1, capturedAt: 1, delivered };
}

function deps(over: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    getRecord: () => record(),
    getRunPhases: () => ({ furthestPhase: "execute", phaseTimings: null }),
    getRunFacts: () => undefined,
    getRunOutcome: () => undefined,
    getAgentTurns: () => [],
    runSpans: () => [],
    listSpecSnapshots: () => [snapshot("flows/restaurant-list-change-filters.spec.ts")],
    getRunPlan: () => undefined,
    ...over,
  };
}

test("a run that failed in execute still reports the spec it delivered and validated, from its snapshots", async () => {
  const evidence = (await new HistoryEvidenceAdapter(deps()).load("run-1"))!;

  assert.equal(evidence.specs.generated, 1);
  assert.equal(evidence.specs.valid, 1);
  assert.equal(evidence.specs.passed, undefined, "the run never executed its specs, so none can be said to pass");
  const scores = gradeEvidence(evidence);
  assert.equal(scores.find((s) => s.name === "spec_validity_rate")?.value, 1);
  assert.equal(scores.some((s) => s.name === "spec_pass_rate"), false);
});

test("the record's own spec list wins whole, and a spec is counted once however many snapshots of it the run kept", async () => {
  const counted = new HistoryEvidenceAdapter(
    deps({ listSpecSnapshots: () => [snapshot("flows/one.spec.ts"), snapshot("flows/one.spec.ts"), snapshot("flows/superseded.spec.ts", 0)] }),
  );
  assert.deepEqual((await counted.load("run-1"))!.specs, { generated: 1, valid: 1, passed: undefined });

  const recorded = new HistoryEvidenceAdapter(deps({ getRecord: () => record({ specs: [{ name: "e2e/flows/from-record.spec.ts" }] }) }));
  assert.equal((await recorded.load("run-1"))!.specs.generated, 1, "the snapshots are not added on top of the record's list");
});

test("grading that run stores a validity rate and no pass rate, since it never executed", async () => {
  const graded: Array<{ name: string; value: unknown }> = [];
  const store: ScoreStorePort = {
    replace: (_runId, scores) => void graded.push(...scores),
    list: () => [],
    setStatus: () => undefined,
    status: () => "pending",
  };
  const grade = new GradeRunUseCase({ evidence: new HistoryEvidenceAdapter(deps()), store, now: () => "2026-10-19T00:00:00.000Z" });

  assert.equal((await grade.execute("run-1")).status, "complete");
  assert.equal(graded.find((s) => s.name === "spec_validity_rate")?.value, 1);
  assert.equal(graded.some((s) => s.name === "spec_pass_rate"), false);
});

const deliveredSpan = (source: string, ids: string[], omitted = 0) => ({
  name: `qayaba.delivered.${source}`,
  spanId: `span-${source}`,
  parentSpanId: null,
  attrs: JSON.stringify({
    "qayaba.context.source": source,
    "qayaba.context.stage": "delivered",
    "qayaba.context.item_ids": ids,
    "qayaba.context.bytes": 100,
    ...(omitted > 0 ? { "qayaba.context.omitted": omitted } : {}),
  }),
});

test("the evidence exposes the delivered sources, the changed element and the snapshots", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({
      runSpans: () => [deliveredSpan("context-pack", ["fact:/restaurantes#save-btn:present", "dom:/restaurantes#save-btn"], 0)],
      listSpecSnapshots: () => [snapshot("flows/restaurants.spec.ts")],
    }),
  ).load("run-1"))!;

  assert.equal(evidence.context?.delivered[0]?.source, "context-pack");
  assert.deepEqual(evidence.context?.delivered[0]?.ids, ["fact:/restaurantes#save-btn:present", "dom:/restaurantes#save-btn"]);
  assert.equal(evidence.context?.changedElement, "present");
  assert.deepEqual(evidence.context?.changedTestIds, ["save-btn"]);
  assert.deepEqual(evidence.context?.snapshots.map((s) => s.path), ["flows/restaurants.spec.ts"]);
});

test("the evidence surfaces the run's parentRunId (lineage visible, never graded)", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({ getRecord: () => record({ parentRunId: "parent-run-1" }) }),
  ).load("run-1"))!;

  assert.equal(evidence.parentRunId, "parent-run-1");
});

const domChangedSpan = {
  name: "qayaba.context.dom-capture",
  spanId: "dom-1",
  parentSpanId: null,
  attrs: JSON.stringify({ "qayaba.context.dom_changed": true }),
};

test("context_fresh/domChanged grade only the pipeline run's own spans — a child heal's spans never leak in", async () => {
  const pipeline = (await new HistoryEvidenceAdapter(
    deps({ runSpans: () => [domChangedSpan] }),
  ).load("run-1"))!;
  assert.equal(pipeline.context?.freshness?.domChanged, true, "the pipeline's own spans grade its freshness");

  /* The child heal is a separate run id; assembling it reads only its own (empty) span ledger, never the parent's. */
  const child = (await new HistoryEvidenceAdapter(
    deps({ getRecord: () => record({ id: "run-heal", parentRunId: "run-1" }), runSpans: () => [] }),
  ).load("run-heal"))!;
  assert.equal(child.parentRunId, "run-1");
  assert.equal(child.context?.freshness, undefined, "a child's freshness never consumes the parent's spans");
});

test("the delivered span's per-reason omissions are read back with their page", async () => {
  const span = {
    name: "qayaba.delivered.context-pack",
    spanId: "pack",
    parentSpanId: null,
    attrs: JSON.stringify({
      "qayaba.context.source": "context-pack",
      "qayaba.context.stage": "delivered",
      "qayaba.context.item_ids": ["dom:/restaurantes#card"],
      "qayaba.context.bytes": 100,
      "qayaba.context.omitted": 34,
      "qayaba.context.omissions": ["truncation:node-cap:34:/home"],
    }),
  };
  const evidence = (await new HistoryEvidenceAdapter(deps({ runSpans: () => [span] })).load("run-1"))!;
  assert.deepEqual(evidence.context?.delivered[0]?.omissions, [{ class: "truncation", reason: "node-cap", count: 34, route: "/home" }]);
});

test("a label-only change with no fact ids reads as an unknown changed element", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({ runSpans: () => [deliveredSpan("context-pack", ["dom:/restaurantes#card"], 0)] }),
  ).load("run-1"))!;
  assert.equal(evidence.context?.changedElement, "unknown");
  assert.deepEqual(evidence.context?.changedTestIds, []);
});

test("why each relevant route is one is read back when it is recorded for every route, and left absent otherwise", async () => {
  const ranking = (attrs: Record<string, unknown>) => ({ name: "qayaba.context.route-ranking", spanId: "rank", parentSpanId: null, attrs: JSON.stringify(attrs) });
  const recorded = (await new HistoryEvidenceAdapter(
    deps({ runSpans: () => [ranking({ "qayaba.context.relevant_ids": ["route:/a", "route:/b"], "qayaba.context.relevant_basis": ["implementation", "graph"] }), deliveredSpan("context-map", ["route:/a"])] }),
  ).load("run-1"))!;
  assert.deepEqual(recorded.context?.relevantBasis, ["implementation", "graph"]);

  const partial = (await new HistoryEvidenceAdapter(
    deps({ runSpans: () => [ranking({ "qayaba.context.relevant_ids": ["route:/a", "route:/b"], "qayaba.context.relevant_basis": ["graph"] }), deliveredSpan("context-map", ["route:/a"])] }),
  ).load("run-1"))!;
  assert.equal(partial.context?.relevantBasis, undefined);
});

test("the relevant routes and file reads are read back from the spans and the turns", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({
      runSpans: () => [
        { name: "qayaba.context.route-ranking", spanId: "rank", parentSpanId: null, attrs: JSON.stringify({ "qayaba.context.relevant_ids": ["route:/restaurantes/:province/:city"], "qayaba.context.relevant_groups": ["RestaurantListPage"] }) },
        deliveredSpan("context-map", ["route:/restaurantes/:province/:city"]),
      ],
      getAgentTurns: () => [{ promptProvidedReadCount: 2, pathProvidedReadCount: 1, toolSequence: [{ tool: "read", target: "a.ts" }] } as never],
    }),
  ).load("run-1"))!;

  assert.deepEqual(evidence.context?.relevantIds, ["route:/restaurantes/:province/:city"]);
  assert.deepEqual(evidence.context?.relevantGroups, ["RestaurantListPage"]);
  assert.equal(evidence.context?.fileReads, 3);
  assert.deepEqual(evidence.context?.toolSequence, [{ tool: "read", target: "a.ts" }]);
});

test("two captures of the same route that disagree mark the context stale", async () => {
  const capture = (spanId: string, ids: string[]) => ({
    name: "qayaba.context.dom-capture",
    spanId,
    parentSpanId: null,
    attrs: JSON.stringify({ "qayaba.context.source": "dom-capture", "qayaba.context.item_ids": ids }),
  });
  const evidence = (await new HistoryEvidenceAdapter(
    deps({ runSpans: () => [capture("pack", ["dom:/restaurantes#a"]), capture("review", ["dom:/restaurantes#a", "dom:/restaurantes#b"])] }),
  ).load("run-1"))!;
  assert.equal(evidence.context?.freshness?.domChanged, true);
});

test("a run with no delivered sources and no snapshots has no context evidence", async () => {
  const evidence = (await new HistoryEvidenceAdapter(deps({ runSpans: () => [], listSpecSnapshots: () => [] })).load("run-1"))!;
  assert.equal(evidence.context, undefined);
});

test("the plan the run kept carries each flow's result in the final execution, tied to its cases by the flow's spec file", async () => {
  const plan = {
    runId: "run-1", kind: "fanout", changeRoutes: ["/cart", "/orders"], unvisited: [], recordedAt: 1,
    flows: [
      { id: "cart", objective: "o", acceptance: [], routes: ["/cart"], specFile: "flows/cart.spec.ts", visits: ["/cart"], outcome: { kind: "delivered", specs: ["flows/cart.spec.ts"] } },
      { id: "orders", objective: "o", acceptance: [], routes: ["/orders"], specFile: "flows/orders.spec.ts", visits: ["/orders"], outcome: { kind: "delivered", specs: ["flows/orders.spec.ts"] } },
      { id: "login", objective: "o", acceptance: [], routes: [], specFile: "flows/login.spec.ts", visits: [], outcome: { kind: "failed", reason: "x" } },
      { id: "quiet", objective: "o", acceptance: [], routes: [], specFile: "flows/quiet.spec.ts", visits: [], outcome: { kind: "delivered" } },
    ],
  };
  const cases: RunRecord["cases"] = [
    { name: "cart a", status: "pass", file: "flows/cart.spec.ts" },
    { name: "cart b", status: "pass", file: "flows/cart.spec.ts" },
    { name: "orders a", status: "fail", file: "flows/orders.spec.ts" },
  ];
  const executed = (await new HistoryEvidenceAdapter(deps({ getRecord: () => record({ verdict: "fail", cases }), getRunPlan: () => JSON.stringify(plan) })).load("run-1"))!;
  assert.deepEqual(executed.plan, {
    kind: "fanout",
    changeRoutes: ["/cart", "/orders"],
    candidates: [],
    flows: [
      { id: "cart", visits: ["/cart"], candidates: [], passed: true },
      { id: "orders", visits: ["/orders"], candidates: [], passed: false },
      { id: "login", visits: [], candidates: [], passed: false },
      { id: "quiet", visits: [], candidates: [], passed: undefined },
    ],
  });
  const unexecuted = (await new HistoryEvidenceAdapter(deps({ getRecord: () => record({ verdict: "invalid", cases }), getRunPlan: () => JSON.stringify(plan) })).load("run-1"))!;
  assert.deepEqual(unexecuted.plan?.flows.map((f) => f.passed), [undefined, undefined, false, undefined]);
  const unreadable = (await new HistoryEvidenceAdapter(deps({ getRunPlan: () => "{not json" })).load("run-1"))!;
  assert.equal(unreadable.plan, undefined);
});

test("the plan's candidates and each flow's claims are read back, and an entry of another shape is left out", async () => {
  const plan = {
    kind: "fanout", changeRoutes: [],
    candidates: [{ id: "uc-a", state: "planned" }, { id: "uc-b", state: "dropped", reason: "r" }, { id: "uc-c", state: "bogus" }, "x"],
    flows: [{ id: "cart", visits: [], specFile: "flows/cart.spec.ts", candidates: [{ id: "uc-a", claimed: "covered" }, { id: 4 }], outcome: { kind: "delivered" } }],
  };
  const cases: RunRecord["cases"] = [{ name: "cart a", status: "pass", file: "flows/cart.spec.ts" }];
  const evidence = (await new HistoryEvidenceAdapter(deps({ getRecord: () => record({ verdict: "pass", cases }), getRunPlan: () => JSON.stringify(plan) })).load("run-1"))!;
  assert.deepEqual(evidence.plan?.candidates, [{ id: "uc-a", state: "planned" }, { id: "uc-b", state: "dropped", reason: "r" }]);
  assert.deepEqual(evidence.plan?.flows[0], { id: "cart", visits: [], candidates: [{ id: "uc-a", claimed: "covered" }], passed: true });
});

const span = (name: string, attrs: Record<string, unknown>, id = name) => ({ name, spanId: id, parentSpanId: null, attrs: JSON.stringify(attrs) });

test("the run_spec calls are read back in order with their bytes, outcome and refusal code", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({
      runSpans: () => [
        span("qayaba.tool.run_spec", { "qayaba.spec.path": "flows/cart.spec.ts", "qayaba.spec.sha256": "aaa", "qayaba.tool.outcome": "failed" }, "a"),
        span("qayaba.tool.run_spec", { "qayaba.spec.path": ".qa-probe/x.spec.ts", "qayaba.tool.outcome": "refused", "qayaba.tool.refusal": "invalid-request" }, "b"),
        span("qayaba.tool.run_spec", { "qayaba.tool.outcome": "refused" }, "c"),
      ],
    }),
  ).load("run-1"))!;
  assert.deepEqual(evidence.runSpecCalls, [
    { path: "flows/cart.spec.ts", sha256: "aaa", outcome: "failed", refusal: undefined },
    { path: ".qa-probe/x.spec.ts", sha256: undefined, outcome: "refused", refusal: "invalid-request" },
  ]);
});

test("each delivered spec carries its newest delivered bytes and whether its cases passed the final execution", async () => {
  const row = (path: string, sha256: string, capturedAt: number, delivered = 1): SpecSnapshotRow => ({ runId: "run-1", path, sha256, text: "t", bytes: 1, capturedAt, delivered });
  const evidence = (await new HistoryEvidenceAdapter(
    deps({
      getRecord: () =>
        record({
          verdict: "fail",
          specs: [{ name: "e2e/flows/cart.spec.ts" }, { name: "e2e/flows/menu.spec.ts" }, { name: "e2e/flows/untied.spec.ts" }] as RunRecord["specs"],
          cases: [
            { name: "cart › a", status: "pass", file: "flows/cart.spec.ts" },
            { name: "menu › a", status: "pass", file: "flows/menu.spec.ts" },
            { name: "menu › b", status: "fail", file: "flows/menu.spec.ts" },
          ] as RunRecord["cases"],
        }),
      listSpecSnapshots: () => [row("flows/cart.spec.ts", "old", 1), row("flows/cart.spec.ts", "new", 2), row("flows/cart.spec.ts", "draft", 3, 0), row("flows/menu.spec.ts", "m", 1)],
    }),
  ).load("run-1"))!;
  assert.deepEqual(evidence.deliveredSpecs, [
    { path: "e2e/flows/cart.spec.ts", sha256: "new", passed: true },
    { path: "e2e/flows/menu.spec.ts", sha256: "m", passed: false },
    { path: "e2e/flows/untied.spec.ts", sha256: undefined, passed: undefined },
  ]);
  const unexecuted = (await new HistoryEvidenceAdapter(deps({ getRecord: () => record({ verdict: "invalid", cases: [{ name: "x", status: "fail", file: "flows/restaurant-list-change-filters.spec.ts" }] as RunRecord["cases"] }) })).load("run-1"))!;
  assert.equal(unexecuted.deliveredSpecs[0]!.passed, undefined, "a run that did not execute has no final result");
});

test("a delegation event that recorded the sidekick's status is read back with its flow's last run_spec outcome", async () => {
  const evidence = (await new HistoryEvidenceAdapter(
    deps({
      runSpans: () => [
        span("qayaba.coordination.event", { "qayaba.coordination.kind": "delegation", "qayaba.delegation.id": "run-1-flow-cart", "qayaba.coordination.attempt": 1, "qayaba.delegation.status": "failed", "qayaba.delegation.last_run_spec": "passed" }, "a"),
        span("qayaba.coordination.event", { "qayaba.coordination.kind": "delegation", "qayaba.delegation.id": "run-1-flow-menu", "qayaba.delegation.status": "completed" }, "b"),
        span("qayaba.coordination.event", { "qayaba.coordination.kind": "delegation", "qayaba.delegation.id": "run-1-flow-old" }, "c"),
        span("qayaba.coordination.event", { "qayaba.coordination.kind": "lead-decision", "qayaba.delegation.status": "failed" }, "d"),
      ],
    }),
  ).load("run-1"))!;
  assert.deepEqual(evidence.sidekickReports, [
    { delegationId: "run-1-flow-cart", attempt: 1, status: "failed", lastRunSpec: "passed" },
    { delegationId: "run-1-flow-menu", attempt: undefined, status: "completed", lastRunSpec: undefined },
  ]);
});

test("a delivered source counts the ids its span could not list past the cap", async () => {
  const capped = span("qayaba.delivered.context-pack", { "qayaba.context.source": "context-pack", "qayaba.context.item_ids": ["dom:/a#x"], "qayaba.context.bytes": 1, "qayaba.context.item_ids.overflow": 4 });
  const evidence = (await new HistoryEvidenceAdapter(deps({ runSpans: () => [capped] })).load("run-1"))!;
  assert.equal(evidence.context?.delivered[0]?.idsOverflow, 4);
  const uncapped = (await new HistoryEvidenceAdapter(deps({ runSpans: () => [deliveredSpan("context-pack", ["dom:/a#x"])] })).load("run-1"))!;
  assert.equal(uncapped.context?.delivered[0]?.idsOverflow, undefined);
});

test("a reference use case is named when a candidate's page names one of its routes, a renamed parameter included, and a candidate no use case matches is counted", async () => {
  const plan = JSON.stringify({
    kind: "fanout",
    changeRoutes: [],
    flows: [],
    candidates: [
      { id: "uc-1", tier: "direct", reachability: "page", state: "planned", pages: ["/r/:province/:city/:slug"] },
      { id: "uc-2", tier: "direct", reachability: "via-page", state: "planned", pages: ["/cart"] },
      { id: "uc-3", tier: "direct", reachability: "backend-only", state: "unplanned", pages: [] },
    ],
  });
  const references = [{
    app: "demo",
    changes: [{
      sha: "abcdef1",
      summary: "s",
      useCases: [
        { id: "ref-renamed", description: "d", reachability: "dev" as const, routes: ["/r/:province/:city/:restaurantSlug"] },
        { id: "ref-missed", description: "d", reachability: "dev" as const, routes: ["/orders"] },
        { id: "ref-error", description: "d", reachability: "fault-injection" as const, routes: ["/cart"] },
      ],
    }],
  }];
  const evidence = (await new HistoryEvidenceAdapter(deps({ getRunPlan: () => plan }), () => references).load("run-1"))!;
  assert.deepEqual(evidence.reference, { useCases: [{ id: "ref-renamed", named: true }, { id: "ref-missed", named: false }], unlabelledCandidates: 1 });
});

test("no reference evidence without a reference for the change or when the plan did not keep its candidates' pages", async () => {
  const kept = JSON.stringify({ kind: "fanout", changeRoutes: [], flows: [], candidates: [{ id: "uc-1", tier: "direct", reachability: "page", state: "planned" }] });
  const references = [{ app: "demo", changes: [{ sha: "abcdef1", summary: "s", useCases: [{ id: "r", description: "d", reachability: "dev" as const, routes: ["/cart"] }] }] }];
  assert.equal((await new HistoryEvidenceAdapter(deps({ getRunPlan: () => kept }), () => references).load("run-1"))!.reference, undefined);
  assert.equal((await new HistoryEvidenceAdapter(deps({ getRunPlan: () => kept }), () => []).load("run-1"))!.reference, undefined);
});

const outcomeOf = (gateSignals: Record<string, unknown>) => ({ runId: "run-1", app: "demo", sha: "abcdef1", mode: "diff", target: "e2e", verdict: "fail", errorClass: null, gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...gateSignals }, rulesRetrieved: [], at: "2026-10-19T00:00:00.000Z" }) as unknown as NonNullable<ReturnType<EvidenceDeps["getRunOutcome"]>>;

test("the outcome's coverage, mutation, review, triage and causal signals reach the evidence, and the survivors come from the newest coverage measurement", async () => {
  const measure = (routed: number, unrouted: number) => ({ name: "qayaba.coverage.measure", spanId: `m${routed}`, parentSpanId: null, attrs: JSON.stringify({ "qayaba.mutation.survivors_routed": routed, "qayaba.mutation.survivors_without_spec": unrouted }) });
  const outcome = outcomeOf({
    coverageRatio: 0.5,
    branchCoverage: { changed: 4, taken: 2 },
    bundleMutation: { applied: 3, killed: 1, survived: [] },
    flakyTriage: { cases: 2, dataInstability: 1, timing: 1, outcome: "accepted" },
    reviewer: { rounds: 2, modelRounds: 1, approved: true, corrections: 0, blocking: 0, durationMs: 1, promptBytes: 1, outputTokens: null, costUsd: null, steps: null, preCheckRejects: 0, skippedRounds: 0 },
    causal: { reach: "in-reach", basis: "page", via: [], reason: "", cases: [{ name: "a", reach: "in-reach", basis: "page" }, { name: "b", reach: "out-of-reach", basis: "none" }, { name: "c", reach: "in-reach", basis: "flow" }] },
  });
  const e = (await new HistoryEvidenceAdapter(deps({ getRunOutcome: () => outcome, runSpans: () => [measure(0, 1), measure(1, 2)] })).load("run-1"))!;
  assert.deepEqual(e.signals?.survivors, { routed: 1, total: 3 }, "the newest measurement stands");
  assert.deepEqual(e.signals?.causal, { inReach: 2, outOfReach: 1, unknown: 0 });
  assert.deepEqual(e.signals?.bundleMutation, { applied: 3, killed: 1 });
  assert.deepEqual(e.signals?.reviewer, { approved: true, rounds: 2, modelRounds: 1 });
  assert.equal(e.signals?.coverageRatio, 0.5);
  assert.deepEqual(e.signals?.branchCoverage, { changed: 4, taken: 2 });
  assert.equal(e.signals?.flakyTriage?.dataInstability, 1);
});

test("a run that recorded none of those signals leaves them undefined", async () => {
  const e = (await new HistoryEvidenceAdapter(deps({ getRunOutcome: () => outcomeOf({}) })).load("run-1"))!;
  assert.equal(e.signals?.survivors, undefined);
  assert.equal(e.signals?.causal, undefined);
  assert.equal(e.signals?.bundleMutation, undefined);
  assert.equal(e.signals?.reviewer, undefined);
  assert.equal(e.signals?.coverageRatio, undefined);
});

test("freshness names the pages whose captures differed and the pages a stale source delivered", async () => {
  const capture = (id: string, ids: string[]) => ({ name: "qayaba.context.dom-capture", spanId: id, parentSpanId: null, attrs: JSON.stringify({ "qayaba.context.item_ids": ids, ...(id === "c2" ? { "qayaba.context.stale": true, "qayaba.context.source": "dom-capture", "qayaba.context.stale_reason": "data-state-unconfirmed" } : {}) }) });
  const ranking = { name: "qayaba.context.route-ranking", spanId: "r", parentSpanId: null, attrs: JSON.stringify({ "qayaba.context.relevant_ids": ["route:/a", "route:/b"] }) };
  const e = (await new HistoryEvidenceAdapter(deps({ runSpans: () => [ranking, capture("c1", ["dom:/a#x", "dom:/b#y"]), capture("c2", ["dom:/a#x2", "dom:/b#y", "dom:/other#z"])] })).load("run-1"))!;
  assert.deepEqual(e.context?.freshness?.domChangedRoutes, ["/a"]);
  assert.equal(e.context?.freshness?.domChanged, true);
  assert.deepEqual(e.context?.freshness?.stale[0]?.routes?.sort(), ["/a", "/b", "/other"]);
});

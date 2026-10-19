/* The evidence of a run that failed after validation: what it delivered is read from the run's delivered snapshots, since the run record's own spec list is written only by the normal exit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GradeRunUseCase } from "@contexts/evaluation/application/grade-run.use-case";
import type { ScoreStorePort } from "@contexts/evaluation/application/ports/index";
import { gradeEvidence } from "@contexts/evaluation/domain/graders";
import type { RunRecord } from "../types";
import type { SpecSnapshotRow } from "./history";
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

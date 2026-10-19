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

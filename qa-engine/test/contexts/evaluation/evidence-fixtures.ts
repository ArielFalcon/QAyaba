import type { RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";

/* A finished, accepted, healthy run; tests override what they exercise. */
export function evidence(over: Partial<RunEvaluationEvidence> = {}): RunEvaluationEvidence {
  return {
    runId: "run-1",
    app: "app",
    mode: "diff",
    finished: true,
    verdict: "pass",
    errorClass: null,
    decision: "pr",
    furthestPhase: "learn",
    specs: { generated: 2, valid: 2, passed: 2 },
    reviewerTurns: 1,
    reviewRequired: undefined,
    signals: { static: true, coverageRatio: 0.9, coverageMinRatio: 0.7, coverageMode: "signal", mutantCount: undefined, killedCount: undefined, catalogGateFailClosed: undefined },
    limit: undefined,
    stepIntents: undefined,
    finishedAt: "2026-10-17T10:00:00.000Z",
    ...over,
  };
}

export function signals(over: Partial<NonNullable<RunEvaluationEvidence["signals"]>> = {}): NonNullable<RunEvaluationEvidence["signals"]> {
  return { ...evidence().signals!, ...over };
}

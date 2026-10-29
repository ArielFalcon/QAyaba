import type { FixLoopIntegrity } from "@contexts/run-orchestration/domain/fix-loop.aggregate.ts";

/* The evidence a run grants the fix loop when no spec has a green proof and no triage execution is left to spend. */
export const UNPROVEN_INTEGRITY: FixLoopIntegrity = {
  hasGreenProof: async () => false,
  spendExecution: () => false,
  remainingMs: () => undefined,
};

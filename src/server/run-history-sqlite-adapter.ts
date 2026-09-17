
import { saveRunOutcome } from "./history";
import type { RunHistoryPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../types";

/*
 * Dependency injection is the testing strategy (CLAUDE.md): a test supplies a fake saveOutcome so
 * the mapping is verifiable without touching the real (lazily-initialized, module-singleton)
 * SQLite database history.ts owns.
 */
export interface RunHistorySqliteAdapterDeps {
  saveOutcome: (outcome: LegacyRunOutcome) => void;
}

export const defaultRunHistorySqliteAdapterDeps: RunHistorySqliteAdapterDeps = {
  saveOutcome: saveRunOutcome,
};

/*
 * Maps the kernel RunOutcome onto the shell history store's shape. Optional/unknown
 * fields (errorClass, reflection, usage) are produced by the same taxonomy as history.ts.
 */
export function toLegacyRunOutcome(outcome: KernelRunOutcome): LegacyRunOutcome {
  return {
    runId: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    target: outcome.target,
    verdict: outcome.verdict,
    errorClass: outcome.errorClass as LegacyRunOutcome["errorClass"],
    gateSignals: {
      static: outcome.gateSignals.static,
      coverageRatio: outcome.gateSignals.coverageRatio,
      valueScore: outcome.gateSignals.valueScore,
      reviewerCorrections: outcome.gateSignals.reviewerCorrections,
      ...(outcome.gateSignals.reviewerRationale !== undefined ? { reviewerRationale: outcome.gateSignals.reviewerRationale } : {}),
      ...(outcome.gateSignals.reviewerApproved !== undefined ? { reviewerApproved: outcome.gateSignals.reviewerApproved } : {}),
      flaky: outcome.gateSignals.flaky,
      retries: outcome.gateSignals.retries,
      ...(outcome.gateSignals.confinement !== undefined ? { confinement: outcome.gateSignals.confinement } : {}),
      ...(outcome.gateSignals.usage !== undefined ? { usage: outcome.gateSignals.usage as LegacyRunOutcome["gateSignals"]["usage"] } : {}),
      ...(outcome.gateSignals.phaseTimings !== undefined ? { phaseTimings: outcome.gateSignals.phaseTimings } : {}),
      ...(outcome.gateSignals.preExecAmbiguityCatches !== undefined ? { preExecAmbiguityCatches: outcome.gateSignals.preExecAmbiguityCatches } : {}),
      ...(outcome.gateSignals.deterministicSelectorBlocks !== undefined ? { deterministicSelectorBlocks: outcome.gateSignals.deterministicSelectorBlocks } : {}),
      ...(outcome.gateSignals.catalogGateInWindow !== undefined ? { catalogGateInWindow: outcome.gateSignals.catalogGateInWindow } : {}),
      ...(outcome.gateSignals.catalogGateAdvisory !== undefined ? { catalogGateAdvisory: outcome.gateSignals.catalogGateAdvisory } : {}),
      ...(outcome.gateSignals.catalogGateFailClosed !== undefined ? { catalogGateFailClosed: outcome.gateSignals.catalogGateFailClosed } : {}),
      
      ...(outcome.gateSignals.structuralSignalBytes !== undefined ? { structuralSignalBytes: outcome.gateSignals.structuralSignalBytes } : {}),
      ...(outcome.gateSignals.serviceLinksCount !== undefined ? { serviceLinksCount: outcome.gateSignals.serviceLinksCount } : {}),
      ...(outcome.gateSignals.contractDriftCount !== undefined ? { contractDriftCount: outcome.gateSignals.contractDriftCount } : {}),
      
      ...(outcome.gateSignals.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: outcome.gateSignals.crossRepoImpactedCount } : {}),
    },
    rulesRetrieved: outcome.rulesRetrieved,
    ...(outcome.reflection !== undefined ? { reflection: outcome.reflection as LegacyRunOutcome["reflection"] } : {}),
    at: outcome.at,
  };
}


export class SqliteRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly deps: RunHistorySqliteAdapterDeps = defaultRunHistorySqliteAdapterDeps) {}

  async save(outcome: KernelRunOutcome): Promise<void> {
    this.deps.saveOutcome(toLegacyRunOutcome(outcome));
  }
}

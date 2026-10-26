
import { saveRunOutcome } from "./history";
import type { RunHistoryPort } from "@contexts/run-orchestration/application/index.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as StoredRunOutcome } from "../types";

/*
 * Dependency injection is the testing strategy (AGENTS.md): a test supplies a fake saveOutcome so
 * the mapping is verifiable without touching the real (lazily-initialized, module-singleton)
 * SQLite database history.ts owns.
 */
export interface RunHistorySqliteAdapterDeps {
  saveOutcome: (outcome: StoredRunOutcome) => void;
}

export const defaultRunHistorySqliteAdapterDeps: RunHistorySqliteAdapterDeps = {
  saveOutcome: saveRunOutcome,
};

/*
 * Maps the kernel RunOutcome onto the shell history store's shape. Optional/unknown
 * fields (errorClass, reflection, usage) are produced by the same taxonomy as history.ts.
 */
export function toStoredRunOutcome(outcome: KernelRunOutcome): StoredRunOutcome {
  return {
    runId: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    target: outcome.target,
    verdict: outcome.verdict,
    errorClass: outcome.errorClass as StoredRunOutcome["errorClass"],
    gateSignals: {
      static: outcome.gateSignals.static,
      coverageRatio: outcome.gateSignals.coverageRatio,
      valueScore: outcome.gateSignals.valueScore,
      ...(outcome.gateSignals.mutantCount !== undefined ? { mutantCount: outcome.gateSignals.mutantCount } : {}),
      ...(outcome.gateSignals.killedCount !== undefined ? { killedCount: outcome.gateSignals.killedCount } : {}),
      reviewerCorrections: outcome.gateSignals.reviewerCorrections,
      ...(outcome.gateSignals.reviewerRationale !== undefined ? { reviewerRationale: outcome.gateSignals.reviewerRationale } : {}),
      ...(outcome.gateSignals.reviewerApproved !== undefined ? { reviewerApproved: outcome.gateSignals.reviewerApproved } : {}),
      ...(outcome.gateSignals.reviewer !== undefined ? { reviewer: outcome.gateSignals.reviewer } : {}),
      flaky: outcome.gateSignals.flaky,
      retries: outcome.gateSignals.retries,
      ...(outcome.gateSignals.confinement !== undefined ? { confinement: outcome.gateSignals.confinement } : {}),
      ...(outcome.gateSignals.usage !== undefined ? { usage: outcome.gateSignals.usage as StoredRunOutcome["gateSignals"]["usage"] } : {}),
      ...(outcome.gateSignals.phaseTimings !== undefined ? { phaseTimings: outcome.gateSignals.phaseTimings } : {}),
      ...(outcome.gateSignals.furthestPhase !== undefined ? { furthestPhase: outcome.gateSignals.furthestPhase } : {}),
      ...(outcome.gateSignals.preExecAmbiguityCatches !== undefined ? { preExecAmbiguityCatches: outcome.gateSignals.preExecAmbiguityCatches } : {}),
      ...(outcome.gateSignals.deterministicSelectorBlocks !== undefined ? { deterministicSelectorBlocks: outcome.gateSignals.deterministicSelectorBlocks } : {}),
      ...(outcome.gateSignals.catalogGateInWindow !== undefined ? { catalogGateInWindow: outcome.gateSignals.catalogGateInWindow } : {}),
      ...(outcome.gateSignals.catalogGateAdvisory !== undefined ? { catalogGateAdvisory: outcome.gateSignals.catalogGateAdvisory } : {}),
      ...(outcome.gateSignals.catalogGateFailClosed !== undefined ? { catalogGateFailClosed: outcome.gateSignals.catalogGateFailClosed } : {}),
      ...(outcome.gateSignals.sandbox !== undefined ? { sandbox: outcome.gateSignals.sandbox } : {}),
      ...(outcome.gateSignals.reviewerIndependence !== undefined ? { reviewerIndependence: outcome.gateSignals.reviewerIndependence } : {}),
      ...(outcome.gateSignals.closedLoop !== undefined ? { closedLoop: outcome.gateSignals.closedLoop } : {}),
      ...(outcome.gateSignals.agentBrowser !== undefined ? { agentBrowser: outcome.gateSignals.agentBrowser } : {}),
      ...(outcome.gateSignals.coordination !== undefined ? { coordination: outcome.gateSignals.coordination } : {}),
      ...(outcome.gateSignals.noop !== undefined ? { noop: outcome.gateSignals.noop } : {}),

      ...(outcome.gateSignals.structuralSignalBytes !== undefined ? { structuralSignalBytes: outcome.gateSignals.structuralSignalBytes } : {}),
      ...(outcome.gateSignals.serviceLinksCount !== undefined ? { serviceLinksCount: outcome.gateSignals.serviceLinksCount } : {}),
      ...(outcome.gateSignals.contractDriftCount !== undefined ? { contractDriftCount: outcome.gateSignals.contractDriftCount } : {}),

      ...(outcome.gateSignals.crossRepoImpactedCount !== undefined ? { crossRepoImpactedCount: outcome.gateSignals.crossRepoImpactedCount } : {}),
      ...(outcome.gateSignals.coverage !== undefined ? { coverage: outcome.gateSignals.coverage } : {}),
      ...(outcome.gateSignals.value !== undefined ? { value: outcome.gateSignals.value } : {}),
      ...(outcome.gateSignals.integrity !== undefined ? { integrity: outcome.gateSignals.integrity } : {}),
      ...(outcome.gateSignals.intent !== undefined ? { intent: outcome.gateSignals.intent } : {}),
      ...(outcome.gateSignals.causal !== undefined ? { causal: outcome.gateSignals.causal } : {}),
      ...(outcome.gateSignals.coverageByCandidate !== undefined ? { coverageByCandidate: outcome.gateSignals.coverageByCandidate } : {}),
      ...(outcome.gateSignals.valueByCandidate !== undefined ? { valueByCandidate: outcome.gateSignals.valueByCandidate } : {}),
    },
    rulesRetrieved: outcome.rulesRetrieved,
    ...(outcome.reflection !== undefined ? { reflection: outcome.reflection as StoredRunOutcome["reflection"] } : {}),
    at: outcome.at,
  };
}


export class SqliteRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly deps: RunHistorySqliteAdapterDeps = defaultRunHistorySqliteAdapterDeps) {}

  async save(outcome: KernelRunOutcome): Promise<void> {
    this.deps.saveOutcome(toStoredRunOutcome(outcome));
  }
}

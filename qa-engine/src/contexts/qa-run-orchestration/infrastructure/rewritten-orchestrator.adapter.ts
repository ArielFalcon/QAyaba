/* RunPipelinePort over RunQaUseCase. No decision logic — maps RunInput into the use-case, then maps RunQaResult into a RunOutcome. RunHistoryPort is save-only, so this adapter cannot read back the persisted row. When the use-case persisted an outcome, return that exact object (identity, not a re-derivation whose `new Date()` would diverge). toOutcome() is the fallback for never-persisted terminals. */

import type { RunPipelinePort, RunInput } from "../application/ports/index.ts";
import { RunQaUseCase, type RunQaUseCaseDeps, type RunQaConfig, type RunQaResult } from "../application/run-qa.use-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export interface RewrittenOrchestratorAdapterDeps extends Omit<RunQaUseCaseDeps, "config"> {
  config?: Partial<RunQaConfig>;
}

export class RewrittenOrchestratorAdapter implements RunPipelinePort {
  private readonly useCase: RunQaUseCase;

  constructor(private readonly deps: RewrittenOrchestratorAdapterDeps) {
    this.useCase = new RunQaUseCase(deps);
  }

  async run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome> {
    const result = await this.useCase.run(input, signal);
    return result.outcome ?? toOutcome(input, result);
  }
}

/* Structural remap matching RunQaUseCase's private toRunOutcome(). Kept as a free function so the use-case surface stays "what gets persisted", not "what this adapter returns". Forward every field the use-case already computed — never re-hardcode null/[] and drop it. */
function toOutcome(input: RunInput, result: RunQaResult): RunOutcome {
  return {
    runId: input.runId,
    app: input.app,
    sha: input.sha.toString(),
    mode: input.mode,
    target: input.target,
    verdict: result.decision.verdict,
    errorClass: result.errorClass,
    gateSignals: {
      static: result.gateSignals.static,
      coverageRatio: result.gateSignals.coverageRatio,
      valueScore: result.gateSignals.valueScore,
      reviewerCorrections: [],
      ...(result.gateSignals.reviewerApproved !== undefined ? { reviewerApproved: result.gateSignals.reviewerApproved } : {}),
      flaky: result.decision.verdict === "flaky",
      retries: result.gateSignals.retries,
      preExecAmbiguityCatches: result.gateSignals.preExecAmbiguityCatches,
      deterministicSelectorBlocks: result.gateSignals.deterministicSelectorBlocks,
      catalogGateInWindow: result.gateSignals.catalogGateInWindow,
      catalogGateAdvisory: result.gateSignals.catalogGateAdvisory,
      catalogGateFailClosed: result.gateSignals.catalogGateFailClosed,
    },
    rulesRetrieved: result.rulesRetrieved,
    ...(result.note !== undefined ? { note: result.note } : {}),
    at: new Date().toISOString(),
    cases: result.cases,
    ...(result.logs !== undefined ? { logs: result.logs } : {}),
  };
}

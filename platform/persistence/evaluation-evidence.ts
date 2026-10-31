/*
 * The evidence port over the run history: reads one finished run's record, its outcome row, its agent turns and its span ledger and hands
 * them to the evaluation context, which derives the RunEvaluationEvidence. Reads only, and only what the run recorded. Every read is
 * injected (`*Deps`) so the assembly is unit-tested with fakes.
 */

import { assembleRunEvidence, type EvidencePort, type EvidenceSources, type LedgerSpan, type RunEvaluationEvidence, type UseCaseReference } from "@contexts/evaluation/application/index";
import { AGENT_NAME_FOR_ROLE } from "../agent-runtime/types";
import type { RunFactsPatch, RunPhases, SpecSnapshotRow } from "./repositories/run.repository";
import type { AgentTurnRecord } from "./repositories/telemetry.repository";
import type { RunOutcome, RunRecord } from "./types";
import { loadReferencesLeniently } from "./use-case-reference-loader";
import { getHistory } from "./index";

export interface EvidenceDeps {
  getRecord(id: string): RunRecord | undefined;
  getRunPhases(id: string): RunPhases | undefined;
  getRunFacts(id: string): Required<RunFactsPatch> | undefined;
  getRunOutcome(id: string): RunOutcome | undefined;
  getAgentTurns(id: string): AgentTurnRecord[];
  runSpans(id: string): LedgerSpan[];
  listSpecSnapshots(id: string): SpecSnapshotRow[];
  /* The plan the run kept, as JSON (`run_plans`). */
  getRunPlan(id: string): string | undefined;
}

export const defaultEvidenceDeps: EvidenceDeps = {
  getRecord: (id) => getHistory().runs.getRecord(id),
  getRunPhases: (id) => getHistory().runs.getRunPhases(id),
  getRunFacts: (id) => getHistory().runs.getRunFacts(id),
  getRunOutcome: (id) => getHistory().learning.getRunOutcome(id),
  getAgentTurns: (id) => getHistory().telemetry.getAgentTurns(id),
  runSpans: (id) => getHistory().telemetry.listRunSpans(id).map((s) => ({ name: s.name, spanId: s.spanId, parentSpanId: s.parentSpanId, attrs: s.attrs })),
  listSpecSnapshots: (id) => getHistory().runs.listSpecSnapshots(id),
  getRunPlan: (id) => getHistory().runs.getRunPlan(id),
};

export class HistoryEvidenceAdapter implements EvidencePort {
  constructor(private readonly deps: EvidenceDeps = defaultEvidenceDeps, private readonly references: () => readonly UseCaseReference[] = () => loadReferencesLeniently()) {}

  async load(runId: string): Promise<RunEvaluationEvidence | undefined> {
    return this.assemble(runId);
  }

  /* The same evidence, synchronously: the run view reads the spec counts the graders will use. */
  assemble(runId: string): RunEvaluationEvidence | undefined {
    const d = this.deps;
    const record = d.getRecord(runId);
    if (!record) return undefined;
    const sources: EvidenceSources = {
      runId,
      record,
      phases: d.getRunPhases(runId),
      facts: d.getRunFacts(runId),
      outcome: d.getRunOutcome(runId),
      spans: d.runSpans(runId),
      turns: d.getAgentTurns(runId),
      snapshots: d.listSpecSnapshots(runId),
      plan: d.getRunPlan(runId),
    };
    return assembleRunEvidence(sources, { references: this.references(), reviewerAgent: AGENT_NAME_FOR_ROLE.reviewer });
  }
}

/*
 * The evidence port over the run history: assembles one finished run's RunEvaluationEvidence from its record, its outcome row,
 * its agent turns and its span ledger. Reads only. Every read is injected (`*Deps`) so the assembly is unit-tested with fakes.
 */

import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import type { EvidencePort } from "@contexts/evaluation/application/ports/index";
import { DEFAULT_COVERAGE_MIN_RATIO, type RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence";
import { getRecord, getRunFacts, getRunOutcome, getRunPhases, getAgentTurns, listRunSpans, type AgentTurnRecord, type RunFactsPatch, type RunPhases } from "./history";
import { loadAppConfig, type AppConfig } from "../orchestrator/config-loader";
import type { RunOutcome, RunRecord } from "../types";

export interface EvidenceDeps {
  getRecord(id: string): RunRecord | undefined;
  getRunPhases(id: string): RunPhases | undefined;
  getRunFacts(id: string): RunFactsPatch | undefined;
  getRunOutcome(id: string): RunOutcome | undefined;
  getAgentTurns(id: string): AgentTurnRecord[];
  /* The attrs JSON of each `chat` span of the run (the ledger's name is the span's name). */
  chatSpanAttrs(id: string): string[];
  /* The app's coverage policy and whether it needs review; may throw (the app was removed): the evidence then carries what it knows. */
  loadApp(name: string): Pick<AppConfig, "qa">;
}

export const defaultEvidenceDeps: EvidenceDeps = {
  getRecord,
  getRunPhases,
  getRunFacts,
  getRunOutcome,
  getAgentTurns,
  chatSpanAttrs: (id) => listRunSpans(id).filter((s) => s.name === "chat" || s.name.startsWith("chat ")).map((s) => s.attrs),
  loadApp: loadAppConfig,
};

const STEP_INTENT_ATTR = "qayaba.step.intent";
const REVIEWER_ROLE = "qa-reviewer";
const rank = (phase: string): number => (RUN_PHASES as readonly string[]).indexOf(phase);

/* The final verdicts of a run that executed its specs. */
const EXECUTED_VERDICTS = ["pass", "fail", "flaky"];

function specBase(name: string): string {
  return (name.split("/").pop() ?? name).replace(/\.(spec|test)\.[jt]sx?$/, "");
}

/*
 * How many delivered specs passed. A stored case carries only its name, so a case is attributed to the spec whose file name it
 * contains. A spec with attributed cases passed when all of them did; with none attributed, it passed only when the run did.
 */
export function countPassedSpecs(specNames: readonly string[], cases: ReadonlyArray<{ name: string; status: string }>, valid: number, verdict: string | null): number {
  if (valid === 0) return 0;
  const bases = specNames.map(specBase);
  let passed = 0;
  for (const base of bases) {
    const mine = cases.filter((c) => base !== "" && c.name.includes(base));
    if (mine.length === 0 ? verdict === "pass" : mine.every((c) => c.status === "pass")) passed += 1;
  }
  return Math.min(passed, valid);
}

function stepIntentsOf(attrs: readonly string[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const raw of attrs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const intent = (parsed as Record<string, unknown> | null)?.[STEP_INTENT_ATTR];
    if (typeof intent === "string") counts[intent] = (counts[intent] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

export class HistoryEvidenceAdapter implements EvidencePort {
  constructor(private readonly deps: EvidenceDeps = defaultEvidenceDeps) {}

  async load(runId: string): Promise<RunEvaluationEvidence | undefined> {
    return this.assemble(runId);
  }

  /* The same evidence, synchronously: the run view reads the spec counts the graders will use. */
  assemble(runId: string): RunEvaluationEvidence | undefined {
    const d = this.deps;
    const record = d.getRecord(runId);
    if (!record) return undefined;
    const finished = record.status === "done" && record.verdict !== undefined;
    const verdict = record.verdict ?? null;
    const furthestPhase = d.getRunPhases(runId)?.furthestPhase ?? null;
    const facts = d.getRunFacts(runId);
    const outcome = d.getRunOutcome(runId);
    let app: Pick<AppConfig, "qa"> | undefined;
    try {
      app = d.loadApp(record.app);
    } catch {
      app = undefined;
    }
    const specNames = (record.specs ?? []).map((s) => s.name);
    const generated = specNames.length;
    const reachedExecution = furthestPhase !== null ? rank(furthestPhase) >= rank("health") : verdict !== null && EXECUTED_VERDICTS.includes(verdict);
    const valid = verdict === "invalid" || !reachedExecution ? 0 : generated;
    const g = outcome?.gateSignals;
    const policy = app?.qa.changeCoverage;
    return {
      runId,
      app: record.app,
      mode: record.mode,
      finished,
      verdict,
      errorClass: outcome?.errorClass ?? null,
      decision: facts?.decision ?? null,
      furthestPhase,
      specs: { generated, valid, passed: countPassedSpecs(specNames, record.cases, valid, verdict) },
      reviewerTurns: d.getAgentTurns(runId).filter((t) => t.role === REVIEWER_ROLE).length,
      reviewRequired: app?.qa.needsReview,
      signals: g
        ? {
            static: g.static,
            coverageRatio: g.coverageRatio,
            coverageMinRatio: policy?.minRatio ?? DEFAULT_COVERAGE_MIN_RATIO,
            coverageMode: policy?.mode,
            mutantCount: g.mutantCount,
            killedCount: g.killedCount,
            catalogGateFailClosed: g.catalogGateFailClosed,
          }
        : undefined,
      limit: facts?.limitFired ? { fired: facts.limitFired, role: facts.limitRole ?? undefined } : undefined,
      stepIntents: stepIntentsOf(d.chatSpanAttrs(runId)),
      finishedAt: outcome?.at ?? record.at,
    };
  }
}

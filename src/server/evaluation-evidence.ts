/*
 * The evidence port over the run history: assembles one finished run's RunEvaluationEvidence from its record, its outcome row,
 * its agent turns and its span ledger. Reads only, and only what the run recorded: what the engine decided at run time (a
 * reviewer was due, the coverage decision and policy, the limit that fired) is read back from the run's columns, never recomputed
 * from the app's current configuration, so a regrade today grades the run as it was. Where a fact was never recorded the evidence
 * says so (undefined or null) and the graders stay silent. Every read is injected (`*Deps`) so the assembly is unit-tested with fakes.
 */

import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import type { EvidencePort } from "@contexts/evaluation/application/ports/index";
import type { RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence";
import { AGENT_NAME_FOR_ROLE } from "../agent-runtime/types";
import { getRecord, getRunFacts, getRunOutcome, getRunPhases, getAgentTurns, listRunSpans, type AgentTurnRecord, type RunFactsPatch, type RunPhases } from "./history";
import type { RunOutcome, RunRecord } from "../types";

/* The slice of a ledger span the evidence reads. */
export interface LedgerSpan {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  /* The span's attributes as JSON. */
  attrs: string;
}

export interface EvidenceDeps {
  getRecord(id: string): RunRecord | undefined;
  getRunPhases(id: string): RunPhases | undefined;
  getRunFacts(id: string): Required<RunFactsPatch> | undefined;
  getRunOutcome(id: string): RunOutcome | undefined;
  getAgentTurns(id: string): AgentTurnRecord[];
  runSpans(id: string): LedgerSpan[];
}

export const defaultEvidenceDeps: EvidenceDeps = {
  getRecord,
  getRunPhases,
  getRunFacts,
  getRunOutcome,
  getAgentTurns,
  runSpans: (id) => listRunSpans(id).map((s) => ({ name: s.name, spanId: s.spanId, parentSpanId: s.parentSpanId, attrs: s.attrs })),
};

const STEP_INTENT_ATTR = "qayaba.step.intent";
const AGENT_NAME_ATTR = "gen_ai.agent.name";
const AGENT_ROLE_ATTR = "qayaba.agent.role";
const LIMIT_FIRED_ATTR = "qayaba.limit.fired";
const REVIEWER_AGENT = AGENT_NAME_FOR_ROLE.reviewer;
const rank = (phase: string): number => (RUN_PHASES as readonly string[]).indexOf(phase);

const COVERAGE_STATUSES = ["pass", "fail", "unknown"] as const;

const isChat = (s: LedgerSpan): boolean => s.name === "chat" || s.name.startsWith("chat ");
const isTurn = (s: LedgerSpan): boolean => s.name === "invoke_agent" || s.name.startsWith("invoke_agent ");

function attrsOf(s: LedgerSpan): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s.attrs);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/*
 * A case belongs to a spec when the file the report named for it is the spec's path, or the path's tail on a directory boundary
 * (the report names the file relative to the test directory, the spec list relative to the repository). A file that fits more
 * than one spec fits none: an ambiguous attribution is not one.
 */
function specOfCase(file: string | undefined, specNames: readonly string[]): string | undefined {
  if (!file) return undefined;
  const fits = specNames.filter((s) => s === file || s.endsWith(`/${file}`) || file.endsWith(`/${s}`));
  return fits.length === 1 ? fits[0] : undefined;
}

/*
 * How many delivered specs passed, or undefined when that cannot be told. Cases are tied to specs by file (specOfCase). When every
 * spec has at least one case, a spec passed when all of its cases did. When any spec has none, the cases cannot be tied to the
 * suite: only a run-level pass, which means every case passed, still answers.
 */
export function countPassedSpecs(specNames: readonly string[], cases: ReadonlyArray<{ name: string; status: string; file?: string | undefined }>, valid: number, verdict: string | null): number | undefined {
  if (valid === 0) return 0;
  const bySpec = new Map<string, string[]>();
  for (const c of cases) {
    const spec = specOfCase(c.file, specNames);
    if (spec) bySpec.set(spec, [...(bySpec.get(spec) ?? []), c.status]);
  }
  if (specNames.length > 0 && specNames.every((s) => bySpec.has(s))) {
    return specNames.filter((s) => bySpec.get(s)!.every((st) => st === "pass")).length;
  }
  return verdict === "pass" ? valid : undefined;
}

function stepIntentsOf(spans: readonly LedgerSpan[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const s of spans.filter(isChat)) {
    const intent = attrsOf(s)[STEP_INTENT_ATTR];
    if (typeof intent === "string") counts[intent] = (counts[intent] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/*
 * The intent of the last step of the turn that hit the limit, read from the agent-turn span model: `invoke_agent <agent>` turn spans
 * (`gen_ai.agent.name`, `qayaba.agent.role`, and `qayaba.limit.fired` once the turn ended), `qayaba.agent.attempt` children, and
 * `chat <model>` step spans under an attempt carrying `qayaba.step.intent`. Of the turns of the limiting role the one that fired a
 * limit wins, else the last. Undefined when the ledger holds none of it.
 */
function limitIntentOf(spans: readonly LedgerSpan[], role: string | undefined): string | undefined {
  if (!role) return undefined;
  const ofRole = spans.filter((s) => {
    if (!isTurn(s)) return false;
    const a = attrsOf(s);
    return a[AGENT_NAME_ATTR] === role || a[AGENT_ROLE_ATTR] === role;
  });
  const fired = ofRole.filter((s) => {
    const limit = attrsOf(s)[LIMIT_FIRED_ATTR];
    return typeof limit === "string" && limit !== "none";
  });
  const turn = (fired.length > 0 ? fired : ofRole).at(-1);
  if (!turn) return undefined;
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  /* A step hangs under its attempt, which hangs under the turn. */
  const steps = spans.filter((s) => isChat(s) && s.parentSpanId !== null && (s.parentSpanId === turn.spanId || byId.get(s.parentSpanId)?.parentSpanId === turn.spanId));
  const last = steps.at(-1);
  const intent = last ? attrsOf(last)[STEP_INTENT_ATTR] : undefined;
  return typeof intent === "string" ? intent : undefined;
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
    const spans = d.runSpans(runId);
    const turns = d.getAgentTurns(runId);

    const specNames = (record.specs ?? []).map((s) => s.name);
    const generated = specNames.length;
    /* Validation gates the whole suite: it is a measurement once the run got past it, and a failure when the run is invalid. */
    const valid: number | null = verdict === "invalid" ? 0 : furthestPhase !== null && rank(furthestPhase) > rank("validate") ? generated : null;
    const g = outcome?.gateSignals;
    const coverageStatus = COVERAGE_STATUSES.find((c) => c === facts?.coverageStatus);

    return {
      runId,
      app: record.app,
      mode: record.mode,
      finished,
      cancelled: facts?.cancelled === true,
      verdict,
      errorClass: outcome?.errorClass ?? null,
      decision: facts?.decision ?? null,
      furthestPhase,
      specs: { generated, valid, passed: valid === null ? undefined : countPassedSpecs(specNames, record.cases, valid, verdict) },
      reviewerTurns: turns.length === 0 ? undefined : turns.filter((t) => t.role === REVIEWER_AGENT).length,
      reviewRequired: facts?.reviewRequired ?? undefined,
      signals: g
        ? {
            static: g.static,
            reviewerApproved: g.reviewerApproved,
            coverageStatus,
            coverageMode: facts?.coverageMode ?? undefined,
            mutantCount: g.mutantCount,
            killedCount: g.killedCount,
            catalogGateFailClosed: g.catalogGateFailClosed,
          }
        : undefined,
      limit: facts?.limitFired ? { fired: facts.limitFired, role: facts.limitRole ?? undefined, intent: limitIntentOf(spans, facts.limitRole ?? undefined) } : undefined,
      stepIntents: stepIntentsOf(spans),
      finishedAt: outcome?.at ?? record.at,
    };
  }
}

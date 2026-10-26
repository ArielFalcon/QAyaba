/*
 * The shell's side of JudgeEvidencePort: what the LLM judges may read about one finished run, assembled from what the run stored and
 * nothing else (docs/observability-design.md section 11.3): the commit diff as the generator's prompt held it (already capped and
 * sanitized for prompts), the redacted spec snapshots the run delivered, the failure message of each failed case, the furthest phase
 * and the error class. No file is read from a mirror, no request goes to DEV, no repository is cloned. Every read is injected.
 */

import type { JudgeEvidencePort } from "@contexts/evaluation/application/index.ts";
import type { JudgeEvidence } from "@contexts/evaluation/application/index";
import { COMMIT_DIFF_HEADING } from "@contexts/generation/infrastructure/prompt-builders/prompts";
import { AGENT_NAME_FOR_ROLE } from "../agent-runtime/types";
import type { SpecSnapshotRow } from "./persistence/repositories/run.repository";
import type { AgentTurnRecord } from "./persistence/repositories/telemetry.repository";
import type { RunRecord } from "../types";
import { getHistory } from "./persistence/index";

export interface JudgeEvidenceDeps {
  getRecord(id: string): RunRecord | undefined;
  getRunFacts(id: string): { cancelled: boolean } | undefined;
  getRunPhases(id: string): { furthestPhase: string | null } | undefined;
  getRunOutcome(id: string): { errorClass?: string | null } | undefined;
  getAgentTurns(id: string): AgentTurnRecord[];
  listSpecSnapshots(id: string): SpecSnapshotRow[];
  /* The plan the run kept, as JSON (`run_plans`). */
  getRunPlan(id: string): string | undefined;
}

export const defaultJudgeEvidenceDeps: JudgeEvidenceDeps = {
  getRecord: (id) => getHistory().runs.getRecord(id),
  getRunFacts: (id) => {
    const facts = getHistory().runs.getRunFacts(id);
    return facts ? { cancelled: facts.cancelled === true } : undefined;
  },
  getRunPhases: (id) => getHistory().runs.getRunPhases(id),
  getRunOutcome: (id) => getHistory().learning.getRunOutcome(id),
  getAgentTurns: (id) => getHistory().telemetry.getAgentTurns(id),
  listSpecSnapshots: (id) => getHistory().runs.listSpecSnapshots(id),
  getRunPlan: (id) => getHistory().runs.getRunPlan(id),
};

const FENCE_OPEN = "```diff\n";
const FENCE_CLOSE = "\n```";

/* The diff of a prompt's "Commit diff" section, or undefined when the prompt holds none (or an empty one). */
export function extractCommitDiff(promptText: string): string | undefined {
  const heading = promptText.indexOf(`${COMMIT_DIFF_HEADING}\n`);
  if (heading < 0) return undefined;
  const open = promptText.indexOf(FENCE_OPEN, heading);
  if (open < 0) return undefined;
  const start = open + FENCE_OPEN.length;
  const close = promptText.indexOf(FENCE_CLOSE, start);
  const diff = (close < 0 ? promptText.slice(start) : promptText.slice(start, close)).trim();
  return diff === "" ? undefined : diff;
}

/* The prompts that carry a commit's diff to a model: the lead's planning turn, the generator's first pass, then the reviewer's. A repair re-prompt does not repeat it. */
const DIFF_PROMPT_ROLES: readonly string[] = [AGENT_NAME_FOR_ROLE.lead, AGENT_NAME_FOR_ROLE.author, AGENT_NAME_FOR_ROLE.reviewer];

function diffOf(turns: readonly AgentTurnRecord[]): string | undefined {
  const candidates = turns.filter((t) => DIFF_PROMPT_ROLES.includes(t.role) && !t.isRepair).sort((a, b) => a.ts.localeCompare(b.ts) || a.round - b.round);
  for (const turn of candidates) {
    const diff = extractCommitDiff(turn.promptText);
    if (diff !== undefined) return diff;
  }
  return undefined;
}

/* The newest snapshot of each spec the run delivered. */
function deliveredSpecs(rows: readonly SpecSnapshotRow[]): Array<{ path: string; text: string }> {
  const newest = new Map<string, SpecSnapshotRow>();
  for (const row of rows) {
    if (row.delivered !== 1) continue;
    const kept = newest.get(row.path);
    if (!kept || row.capturedAt >= kept.capturedAt) newest.set(row.path, row);
  }
  return [...newest.values()].sort((a, b) => a.path.localeCompare(b.path)).map((r) => ({ path: r.path, text: r.text }));
}

/* The flows of the plan the run kept: what each meant to cover. A plan that does not read as one is no plan. */
export function planFlowsOf(raw: string | undefined): JudgeEvidence["plan"] {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { flows?: unknown };
    if (!Array.isArray(parsed.flows)) return [];
    return parsed.flows.flatMap((value: unknown) => {
      const flow = value as { id?: unknown; objective?: unknown; acceptance?: unknown } | null;
      if (!flow || typeof flow.id !== "string" || typeof flow.objective !== "string") return [];
      const acceptance = Array.isArray(flow.acceptance) ? flow.acceptance.filter((a): a is string => typeof a === "string") : [];
      return [{ id: flow.id, objective: flow.objective, acceptance }];
    });
  } catch {
    return [];
  }
}

/* The use cases the plan had to answer for, as the run kept them; an entry that does not read as one is left out. */
export function planCandidatesOf(raw: string | undefined): NonNullable<JudgeEvidence["candidates"]> {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return [];
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    return parsed.candidates.flatMap((value: unknown) => {
      const c = value as { id?: unknown; entry?: unknown; tier?: unknown; reachability?: unknown; pages?: unknown; existingSpecs?: unknown } | null;
      if (!c || typeof c.id !== "string" || typeof c.tier !== "string" || typeof c.reachability !== "string") return [];
      return [{ id: c.id, entry: typeof c.entry === "string" ? c.entry : "", tier: c.tier, reachability: c.reachability, pages: strings(c.pages), existingSpecs: strings(c.existingSpecs) }];
    });
  } catch {
    return [];
  }
}

export class HistoryJudgeEvidence implements JudgeEvidencePort {
  constructor(private readonly deps: JudgeEvidenceDeps = defaultJudgeEvidenceDeps) {}

  load(runId: string): JudgeEvidence | undefined {
    const d = this.deps;
    const record = d.getRecord(runId);
    if (!record || record.status !== "done" || record.verdict === undefined) return undefined;
    return {
      runId,
      mode: record.mode,
      cancelled: d.getRunFacts(runId)?.cancelled === true,
      verdict: record.verdict,
      errorClass: d.getRunOutcome(runId)?.errorClass ?? null,
      furthestPhase: d.getRunPhases(runId)?.furthestPhase ?? null,
      diff: diffOf(d.getAgentTurns(runId)),
      specs: deliveredSpecs(d.listSpecSnapshots(runId)),
      failures: record.cases.filter((c) => c.status === "fail").map((c) => ({ name: c.name, message: c.detail ?? "the case failed; no detail was recorded" })),
      plan: planFlowsOf(d.getRunPlan(runId)),
      candidates: planCandidatesOf(d.getRunPlan(runId)),
    };
  }
}

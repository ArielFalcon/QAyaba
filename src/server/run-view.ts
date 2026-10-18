/*
 * What `GET /runs/:id` adds to the run record (docs/observability-design.md section 14): where the trace is, the time per phase in
 * canonical order, token usage, spec counts, the publication decision and which budget ended the run. Read-only over the history.
 */

import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import type { RunDetail, RunRecord } from "../contract/commands";
import { HistoryEvidenceAdapter } from "./evaluation-evidence";
import { getAgentRoleFacts, getAgentTurns, getRunCampaign, getRunFacts, getRunPhases, getStoredEffectiveConfig, type AgentTurnRecord } from "./history";
import { buildEffectiveConfig, parseStoredRunConfig } from "./effective-config";

export type RunViewExtras = Omit<RunDetail, keyof RunRecord | "schemaVersion">;

export interface RunViewDeps {
  getRunFacts: typeof getRunFacts;
  getRunPhases: typeof getRunPhases;
  getRunCampaign: typeof getRunCampaign;
  getStoredEffectiveConfig: typeof getStoredEffectiveConfig;
  getAgentTurns(id: string): AgentTurnRecord[];
  getAgentRoleFacts: typeof getAgentRoleFacts;
  evidence: Pick<HistoryEvidenceAdapter, "assemble">;
  /* False when QA_TELEMETRY=off: the run view then says null, whatever the history holds. */
  telemetryOn: () => boolean;
  /* QA_TRACE_URL_TEMPLATE: a URL containing {traceId}. */
  traceUrlTemplate: () => string | undefined;
}

export function defaultRunViewDeps(telemetryOn: () => boolean, env: Record<string, string | undefined> = process.env): RunViewDeps {
  return {
    getRunFacts,
    getRunPhases,
    getRunCampaign,
    getStoredEffectiveConfig,
    getAgentTurns,
    getAgentRoleFacts,
    evidence: new HistoryEvidenceAdapter(),
    telemetryOn,
    traceUrlTemplate: () => env.QA_TRACE_URL_TEMPLATE?.trim() || undefined,
  };
}

function usageOf(turns: readonly AgentTurnRecord[]): RunViewExtras["usage"] {
  const sum = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const t of turns) {
    /* usageTotal covers every step of the turn; the plain columns hold the last message alone. */
    const u = t.usageTotal;
    sum.inputTokens += u ? u.input : (t.tokensInput ?? 0);
    sum.outputTokens += u ? u.output : (t.tokensOutput ?? 0);
    sum.reasoningTokens += u ? u.reasoning : (t.tokensReasoning ?? 0);
    sum.cacheReadTokens += u ? u.cacheRead : (t.tokensCacheRead ?? 0);
    sum.cacheWriteTokens += u ? u.cacheWrite : (t.tokensCacheWrite ?? 0);
    sum.costUsd += u ? u.cost : (t.cost ?? 0);
  }
  return sum;
}

/* Undefined: no such run. */
export function buildRunViewExtras(runId: string, deps: RunViewDeps): RunViewExtras | undefined {
  const evidence = deps.evidence.assemble(runId);
  if (!evidence) return undefined;
  const facts = deps.getRunFacts(runId);
  const phases = deps.getRunPhases(runId);
  const template = deps.traceUrlTemplate();
  const traceId = facts?.traceId ?? null;
  const timings = phases?.phaseTimings ?? {};
  const turns = deps.getAgentTurns(runId);
  const campaign = deps.getRunCampaign(runId);
  const storedConfig = deps.getStoredEffectiveConfig(runId);
  return {
    telemetry:
      deps.telemetryOn() && traceId !== null
        ? { traceId, ...(template ? { traceUrl: template.split("{traceId}").join(encodeURIComponent(traceId)) } : {}) }
        : null,
    phases: RUN_PHASES.filter((p) => timings[p] !== undefined).map((p) => ({ name: p, durationMs: Math.max(0, timings[p] ?? 0) })),
    furthestPhase: phases?.furthestPhase ?? null,
    usage: usageOf(turns),
    specCounts: { generated: evidence.specs.generated, valid: evidence.specs.valid, passed: evidence.specs.passed ?? null },
    decision: facts?.decision ?? null,
    budgets: facts?.limitFired
      ? { exhausted: true, limit: facts.limitFired, ...(facts.limitRole ? { role: facts.limitRole } : {}) }
      : { exhausted: false },
    ...(campaign ? { campaign: { id: campaign.id, variant: { ...campaign.variant }, replicate: campaign.replicate } } : {}),
    effectiveConfig: buildEffectiveConfig(parseStoredRunConfig(storedConfig?.json), deps.getAgentRoleFacts(runId), {
      coverageMode: facts?.coverageMode ?? null,
      coverageMinRatio: facts?.coverageMinRatio ?? null,
      captureMode: storedConfig?.captureMode ?? null,
    }),
  };
}

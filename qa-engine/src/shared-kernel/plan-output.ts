import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";

/**
 * What a planning turn came to. `plan` is the object the lead's verdict carried, untrusted: only the orchestrator's admission reads
 * it. `noopReason` is the reason the lead gave for writing nothing when it declared that instead of planning. A turn that gives
 * neither is `parsed` when its verdict could be read at all; `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanOutput {
  plan?: Record<string, unknown>;
  /** The questions the lead asked the explore sidekicks instead of planning, untrusted: only the orchestrator's admission reads them. */
  explore?: unknown[];
  noopReason?: string;
  parsed: boolean;
  timedOut: boolean;
  turn?: AgentTurnStats;
  /** The lead's planning session, held open when the turn came back with a plan, for the lead's review of the flows. The caller disposes it. Also held when the turn asked to explore. */
  lead?: LeadSessionHandle;
}
/** The lead's planning session, held open for its next turn: asked read-only, a turn out of its time answers `timedOut`. */
export interface LeadTurnOpts {
  timeoutMs: number;
  /** The sizes and hashes of the sections the turn's prompt was assembled from; only for the trace. */
  sectionSizes?: Record<string, number>;
  sectionHashes?: Record<string, string>;
}
export interface LeadSessionHandle {
  ask(text: string, opts: LeadTurnOpts): Promise<{ output: string; timedOut: boolean }>;
  /** Asks the lead for its plan after the exploration it requested, read as a planning turn is read. */
  askForPlan(text: string, opts: LeadTurnOpts): Promise<Pick<PlanOutput, "plan" | "explore" | "noopReason" | "parsed" | "timedOut">>;
  dispose(): Promise<void>;
}

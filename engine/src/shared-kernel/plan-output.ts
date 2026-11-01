import type { AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import type { TimeLimitSource } from "@kernel/turn-limit.ts";

/**
 * What a planning turn came to. `plan` is the submission the lead's contract accepted (a plan of flows, or a declared no-op),
 * untrusted beyond that check: the orchestrator's admission reads it again under the run's time. A turn that delivered none, even
 * after its one continuation, says why in `noSubmission`; `timedOut` is a turn that ran out of its planning time.
 */
export interface PlanOutput {
  plan?: Record<string, unknown>;
  noSubmission?: string;
  timedOut: boolean;
  turn?: AgentTurnStats;
  /** The lead's planning session, held open whenever the turn answered: the plan's amendment and the review of the flows are asked there. The caller disposes it. */
  lead?: LeadSessionHandle;
}
/** The lead's planning session, held open for its next turn: asked read-only, a turn out of its time answers `timedOut`. */
export interface LeadTurnOpts {
  timeoutMs: number;
  /** The bound `timeoutMs` is (the plan budget, or the run deadline's allowance when that is smaller); absent: the plan budget. */
  timeLimit?: TimeLimitSource;
  /** The sizes and hashes of the sections the turn's prompt was assembled from; only for the trace. */
  sectionSizes?: Record<string, number>;
  sectionHashes?: Record<string, string>;
}
export interface LeadSessionHandle {
  ask(text: string, opts: LeadTurnOpts): Promise<{ output: string; timedOut: boolean }>;
  /** Asks the lead for its plan again, answered through the plan contract as a planning turn is. */
  askForPlan(text: string, opts: LeadTurnOpts): Promise<Pick<PlanOutput, "plan" | "noSubmission" | "timedOut">>;
  dispose(): Promise<void>;
}

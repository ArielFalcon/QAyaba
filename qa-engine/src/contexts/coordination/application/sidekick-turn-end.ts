/*
 * How a turn of a sidekick's session ended when it did not answer, as one typed end: the turn ran out of its time, it was stopped, a
 * fault of the runtime ended it (the transport, the provider; the fault's class says which), or the runtime says the session is gone.
 * Only the last ends the session. The vocabulary is the turn's (`TurnEnd`, `AgentErrorType`); this module adds the one end a turn
 * cannot have, a session the runtime no longer holds. A turn that answered has no end here: its answer is read.
 */
import { isAgentTimeoutError } from "@kernel/domain-error.ts";
import { isSessionGoneError, type TurnEnd } from "@kernel/turn-end.ts";
import { classifyAgentFault, type AgentErrorType } from "@contexts/generation/application/index.ts";

export const SESSION_GONE = "session-gone" as const;
export type SidekickEnd = Exclude<TurnEnd, "completed" | "exhausted"> | typeof SESSION_GONE;

export interface SidekickTurnEnd {
  readonly kind: SidekickEnd;
  /* The class of the fault, for a turn a fault ended. */
  readonly errorType?: AgentErrorType;
}

/* The end a fault of a turn is: the runtime's own word that its session is gone, then the turn's time, then a stop the caller asked for, then any other fault with its class. The run's own deadline is not a turn's end: it ends the run, and the caller rethrows it before asking. */
export function turnEndOf(err: unknown, stopped: boolean): SidekickTurnEnd {
  if (isSessionGoneError(err)) return { kind: SESSION_GONE };
  if (isAgentTimeoutError(err)) return { kind: "timeout" };
  if (stopped) return { kind: "aborted" };
  return { kind: "failed", errorType: classifyAgentFault(err) };
}

const SUMMARY: Record<SidekickEnd, string> = {
  timeout: "The turn ran out of its time before the sidekick answered.",
  aborted: "The turn was stopped before the sidekick answered.",
  failed: "A fault of the runtime ended the turn before the sidekick answered.",
  "session-gone": "The runtime no longer holds the sidekick's session.",
};

/* What a turn that did not answer says of itself, in words: the orchestrator's own statement, never the sidekick's. */
export function describeTurnEnd(end: SidekickTurnEnd): string {
  return `${SUMMARY[end.kind]}${end.errorType !== undefined ? ` (${end.errorType})` : ""}`;
}

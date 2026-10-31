import { LOG_EFFECT, type LogEffect } from "@kernel/ports/logger.port.ts";
import type { RunMode } from "@kernel/run-mode.ts";

/**
 * What a failed run precondition does to the run. `end` closes it with the infra-error verdict, which
 * opens no Issue in the watched repo; `continue` lets a run that never generates tests carry on.
 */
export type PreconditionTerminal =
  | { action: "continue" }
  | { action: "end"; verdict: "infra-error" };

/**
 * The single mapping from a failed precondition to how the run proceeds. A context run builds an
 * architecture map, not tests, and never ended on a login; every other mode ends on it.
 */
export function terminalForPrecondition(mode: RunMode): PreconditionTerminal {
  if (mode === "context") return { action: "continue" };
  return { action: "end", verdict: "infra-error" };
}

/** What a failed login does to the run, for the level of the line that announces it. */
export const PRECONDITION_EFFECT = {
  continue: LOG_EFFECT.CARRIED_ON,
  end: LOG_EFFECT.ENDED,
} as const satisfies Record<PreconditionTerminal["action"], LogEffect>;

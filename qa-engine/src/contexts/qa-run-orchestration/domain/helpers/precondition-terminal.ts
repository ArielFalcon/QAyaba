import type { RunMode } from "@kernel/run-mode.ts";
import { ERROR_CLASS, type ErrorClass } from "./error-class.ts";

/**
 * What a failed run precondition does to the run. `end` closes it with the infra-error verdict
 * (never an Issue in the watched repo) and always persists the outcome; `continue` lets a run that
 * never generates tests carry on.
 */
export type PreconditionTerminal =
  | { action: "continue" }
  | { action: "end"; verdict: "infra-error"; errorClass: ErrorClass; persisted: boolean };

/**
 * The single mapping from a failed precondition to how the run proceeds. A context run builds an
 * architecture map, not tests, and never ended on a login; every other mode ends on it.
 */
export function terminalForPrecondition(mode: RunMode): PreconditionTerminal {
  if (mode === "context") return { action: "continue" };
  return { action: "end", verdict: "infra-error", errorClass: ERROR_CLASS.PRECONDITION, persisted: true };
}

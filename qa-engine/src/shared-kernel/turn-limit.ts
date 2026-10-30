/* The limits that can bind or end an agent turn, as a closed set: the time limits (named by where their number comes from) and the other ways a turn is cut short. A caller that states a time for a prompt also states which limit it is, so the layer that finally fires it can say what fired. */

export const TIME_LIMIT_SOURCES = [
  /* The first-pass time of a diff run's effort tier. */
  "tier-budget",
  /* What is left of the run's wall-clock deadline (less the reserve of the phases after the purpose that asked). */
  "run-deadline",
  /* The lead's planning, review or correction turn, capped by `planBudgetMs`. */
  "plan-budget",
  /* One flow of a plan, capped by `flowBudgetMs`. */
  "flow-budget",
  /* One call of a tool the agent asks the orchestrator for (`run_spec`, the authenticated browser), capped by `perCallMs`. */
  "tool-call",
  /* The short cap of a contract-repair prompt. */
  "repair-cap",
  /* A session's timeout that no more specific name covers. */
  "session-timeout",
  /* A per-prompt budget a caller stated without a more specific name. */
  "prompt-budget",
  /* The longest the host lets any prompt run. */
  "host-cap",
] as const;

export type TimeLimitSource = (typeof TIME_LIMIT_SOURCES)[number];

/* `fault` is a turn ended by a fault of the transport or the provider and not by any limit: the turn's error class names the fault, and `none` stays for a turn nothing ended early. */
export const TURN_LIMITS = [...TIME_LIMIT_SOURCES, "stall", "step-cap", "cancel", "fault", "none"] as const;
export type TurnLimit = (typeof TURN_LIMITS)[number];

/* The turn ends that are no limit: a cancel stopped the turn on purpose, a fault broke it, and `none` means nothing ended it early. */
const NOT_A_LIMIT: ReadonlySet<string> = new Set<TurnLimit>(["cancel", "fault", "none"]);

/* Whether a turn's recorded `limit.fired` names a limit that bound it. */
export function isBindingLimit(fired: string): boolean {
  return !NOT_A_LIMIT.has(fired);
}

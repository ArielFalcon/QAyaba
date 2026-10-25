/* The limits that can bind or end an agent turn, as a closed set: the time limits (named by where their number comes from) and the other ways a turn is cut short. A caller that states a time for a prompt also states which limit it is, so the layer that finally fires it can say what fired. */

export const TIME_LIMIT_SOURCES = [
  /* The first-pass time of a diff run's effort tier. */
  "tier-budget",
  /* What is left of the run's wall-clock deadline. */
  "run-deadline",
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

export const TURN_LIMITS = [...TIME_LIMIT_SOURCES, "stall", "step-cap", "cancel", "none"] as const;
export type TurnLimit = (typeof TURN_LIMITS)[number];

/* Who executes next. */

export const COORDINATION_ACTIONS = [
  "direct",
  "delegate",
  "retry",
  "escalate",
  "abort",
] as const;
export type CoordinationAction = (typeof COORDINATION_ACTIONS)[number];

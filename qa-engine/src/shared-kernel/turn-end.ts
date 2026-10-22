/* How an agent turn ended: it answered (`completed`), answered after using every step it had (`exhausted`), or never answered because the prompt timeout elapsed (`timeout`) or the caller aborted it (`aborted`). */

export const TURN_ENDS = ["completed", "exhausted", "timeout", "aborted"] as const;

export type TurnEnd = (typeof TURN_ENDS)[number];

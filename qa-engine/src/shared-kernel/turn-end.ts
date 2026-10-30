/* How an agent turn ended: it answered (`completed`), answered after using every step it had (`exhausted`), or never answered because the prompt timeout elapsed (`timeout`), the caller aborted it (`aborted`) or a fault of the transport or the provider ended it (`failed`; the turn's error class says which). */

export const TURN_ENDS = ["completed", "exhausted", "timeout", "aborted", "failed"] as const;

export type TurnEnd = (typeof TURN_ENDS)[number];

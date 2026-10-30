/* How an agent turn ended: it answered (`completed`), answered after using every step it had (`exhausted`), or never answered because the prompt timeout elapsed (`timeout`), the caller aborted it (`aborted`) or a fault of the transport or the provider ended it (`failed`; the turn's error class says which). */

export const TURN_ENDS = ["completed", "exhausted", "timeout", "aborted", "failed"] as const;

export type TurnEnd = (typeof TURN_ENDS)[number];

/*
 * A session the runtime itself says it no longer has (deleted, swept, never there): the only fault after which a holder ends the
 * session and starts a fresh one. A transport or provider fault, a turn out of its time and a turn that was stopped leave the session
 * as it was, with its conversation and the proof the holder keeps beside it.
 */
export class SessionGoneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SessionGoneError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/* Whether a fault is the runtime saying its session is gone, by type or by name (the shell has error classes of its own, so `instanceof` can fail across it). A message that merely mentions a session is not one. */
export function isSessionGoneError(err: unknown): boolean {
  return err instanceof SessionGoneError || (err instanceof Error && err.name === "SessionGoneError");
}

/* The contract-repair turn: a re-prompt that only restates a verdict the agent already reached. It needs no tool and a minute or two, so it is given neither tools nor a long deadline. */

/** The longest one contract-repair prompt may run, in milliseconds, whatever time its caller has left. A repair that needs more than this is not restating anything, and its answer is not waited for. */
export const REPAIR_TURN_TIMEOUT_MS = 120_000;

/** What a generation says when its repair turn timed out under its own cap: the first turn's output stands, and no verdict could be read from it. */
export function renderRepairTimeoutNote(timeoutMs: number): string {
  return `The contract-repair turn (tools disabled) did not answer within ${Math.round(timeoutMs / 1000)} s, so the verdict stays unreadable.`;
}

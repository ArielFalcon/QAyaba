/* The contract-repair turn: a re-prompt that only restates a verdict the agent already reached. It needs no tool and a minute or two, so it is given neither tools nor a long deadline. */

/** The longest one contract-repair prompt may run, in milliseconds, whatever time its caller has left. A repair that needs more than this is not restating anything, and its answer is not waited for. */
export const REPAIR_TURN_TIMEOUT_MS = 120_000;

/** What a repair prompt is given: the smaller of its own cap and the time the caller has left (absent: the caller is not bounded), and whether the caller's remaining time is what binds. */
export function repairTurnLimit(input: { capMs: number; leftMs?: number }): { timeoutMs: number; boundByCaller: boolean } {
  if (input.leftMs === undefined || input.capMs < input.leftMs) return { timeoutMs: input.capMs, boundByCaller: false };
  return { timeoutMs: input.leftMs, boundByCaller: true };
}

/** What a generation says when its repair turn timed out under its own cap: the first turn's output stands, and no verdict could be read from it. */
export function renderRepairTimeoutNote(timeoutMs: number): string {
  return `The contract-repair turn (tools disabled) did not answer within ${Math.round(timeoutMs / 1000)} s, so the verdict stays unreadable.`;
}

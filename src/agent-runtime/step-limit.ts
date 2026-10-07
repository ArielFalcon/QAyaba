/*
 * The step limit a runtime enforces, from a value the runtime reported: a safe positive integer, else
 * none. A zero, a negative number, a fraction, NaN, a string or a missing value is no limit, and none is
 * made up for it: a prompt that states a limit must state one the runtime really enforces.
 */
export function enforcedStepLimit(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

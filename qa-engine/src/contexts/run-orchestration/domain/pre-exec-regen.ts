/*
 * Whether the corrections the pre-execution grounding raised earn a regeneration before the static gate. Pure: no I/O, no clock.
 * At most one regeneration is spent per run, and none when every delivered spec was seen passing against DEV.
 */

export type PreExecAction = "regenerate" | "proceed";

export interface PreExecInput {
  /** Corrections the grounding raised that a regeneration can repair. */
  corrections: number;
  /** Every delivered spec was seen passing in the run_spec loop: a static look at its selectors does not rewrite it. */
  retired: boolean;
  /** Corrective regenerations spent so far. */
  regenerated: number;
}

export const MAX_PRE_EXEC_REGENERATIONS = 1;

export function preExecAction({ corrections, retired, regenerated }: PreExecInput): PreExecAction {
  return corrections > 0 && !retired && regenerated < MAX_PRE_EXEC_REGENERATIONS ? "regenerate" : "proceed";
}

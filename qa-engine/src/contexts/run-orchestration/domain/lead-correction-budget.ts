/*
 * How many corrections of one run go through the lead's coordinated pass. The budget is the sum of the caps of the loops that can
 * correct (the static gate's repair rounds, the pre-execution regeneration, the fix loop's rounds, the coverage regeneration and
 * the review's rounds with their one retry), so it equals the most a run can reach and tightens none of them. Pure: no I/O, no clock.
 */

import { MAX_STATIC_FIX_ROUNDS } from "../../../shared-kernel/derive-cycle-backstop.ts";
import { MAX_COVERAGE_REGENERATIONS } from "./coverage-regen.ts";
import { MAX_PRE_EXEC_REGENERATIONS } from "./pre-exec-regen.ts";
import { MAX_REVIEW_ROUNDS } from "./review-action.ts";

export type LeadCorrectionAction = "through-lead" | "direct";

/** A review round corrects once and retries once when the contract refuses the first attempt. */
const CORRECTIONS_PER_REVIEW_ROUND = 2;

export function leadCorrectionBudget({ maxRetries }: { maxRetries: number }): number {
  return MAX_STATIC_FIX_ROUNDS + MAX_PRE_EXEC_REGENERATIONS + maxRetries + MAX_COVERAGE_REGENERATIONS + MAX_REVIEW_ROUNDS * CORRECTIONS_PER_REVIEW_ROUND;
}

export function leadCorrectionAction({ used, budget }: { used: number; budget: number }): LeadCorrectionAction {
  return used < budget ? "through-lead" : "direct";
}

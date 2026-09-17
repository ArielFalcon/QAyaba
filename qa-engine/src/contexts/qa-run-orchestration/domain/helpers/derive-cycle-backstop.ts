/* Regeneration-loop caps. MAX_REVIEW_ROUNDS — reviewer reject→regenerate rounds inside one generateAndReview(). MAX_STATIC_FIX_ROUNDS — static-gate (Filter B) repair rounds (tsc/eslint/list). The derivation and the loops that consume these caps share this source of truth. */
const MAX_REVIEW_ROUNDS = 2;
const MAX_STATIC_FIX_ROUNDS = 2;

/* Each generateAndReview() costs at most CYCLES_PER_GENERATE counter ticks: 1 for the entry invocation + up to (MAX_REVIEW_ROUNDS - 1) in-loop review-round regenerations. */
const CYCLES_PER_GENERATE = 1 + (MAX_REVIEW_ROUNDS - 1);
/* In-session contract-repair headroom: each generateAndReview() may fire up to ~2 repair re-prompts (one generator, one reviewer) that each tick the shared counter via onRepair. */
const REPAIR_HEADROOM_PER_GENERATE = 2;

/* Scope-dimensioned budget. The base backstop covers a single objective's full loop; extra objectives add one session's max cost (not the full loop — worker sessions do not go through generate→review→fix→coverage). numObjectives defaults to 1. */
export function deriveCycleBackstop(maxRetries: number, numObjectives = 1): number {
  const generateEntries = 1 + MAX_STATIC_FIX_ROUNDS + maxRetries + 1;
  const singleObjectiveBase = generateEntries * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
  const extraObjectives = Math.max(0, numObjectives - 1);
  return singleObjectiveBase + extraObjectives * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
}

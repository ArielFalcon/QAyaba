/*
 * A run waits for an onboarding job that is active before it touches the mirror, polling, and gives up past a ceiling so a stuck
 * flag cannot starve the queue. The ceiling is the sum of the named per-phase ceilings of the job plus a margin.
 */
export const ONBOARDING_POLL_MS = 5_000;

export const ONBOARDING_MIRROR_CEILING_MS = 5 * 60 * 1000;
export const ONBOARDING_JOB_CEILING_MS = 20 * 60 * 1000;
export const ONBOARDING_INDEXING_CEILING_MS = 10 * 60 * 1000;
export const ONBOARDING_WAIT_MARGIN_MS = 5 * 60 * 1000;
export const ONBOARDING_WAIT_MAX_MS =
  ONBOARDING_MIRROR_CEILING_MS + ONBOARDING_JOB_CEILING_MS + ONBOARDING_INDEXING_CEILING_MS + ONBOARDING_WAIT_MARGIN_MS;

/* What a run does while an onboarding job is active: an operator's cancel ends the wait, so does the ceiling, otherwise it polls again. */
export function onboardingWaitStep(aborted: boolean, waitedMs: number, maxMs: number): "cancelled" | "give-up" | "keep-waiting" {
  if (aborted) return "cancelled";
  return waitedMs > maxMs ? "give-up" : "keep-waiting";
}

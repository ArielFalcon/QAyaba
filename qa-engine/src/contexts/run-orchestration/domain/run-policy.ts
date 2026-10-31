/* What an app's configuration decides about how a run proceeds, and what the engine falls back to where the app says nothing. Pure: the shell hands in the blocks as the app declared them. */

/* How many times a failing execution goes back to the author before the run gives up. */
export const DEFAULT_FIX_LOOP_MAX_RETRIES = 2;

export function fixLoopMaxRetries(declared: { maxRetries?: number | undefined } | undefined): number {
  return declared?.maxRetries ?? DEFAULT_FIX_LOOP_MAX_RETRIES;
}

/* The test-intent lock: whether the contract a primary pass fixes is read against later regenerations. */
export interface IntentLockPolicy {
  mode: "off" | "signal";
  /* The share of a contract's clauses that may be opaque before the contract itself is flagged. */
  opacityFlagRatio: number;
}

/* Record the deltas a regeneration would be rejected for, reject none, and flag a contract more than half opaque. */
export const DEFAULT_INTENT_LOCK: Readonly<IntentLockPolicy> = { mode: "signal", opacityFlagRatio: 0.5 };

export function resolveIntentLock(declared: { mode?: IntentLockPolicy["mode"] | undefined; opacityFlagRatio?: number | undefined } | undefined): IntentLockPolicy {
  return { mode: declared?.mode ?? DEFAULT_INTENT_LOCK.mode, opacityFlagRatio: declared?.opacityFlagRatio ?? DEFAULT_INTENT_LOCK.opacityFlagRatio };
}

/* The pre-generation context pack carries the live DOM unless the run (an A/B arm) or the app turns that off; the run's choice wins. A run recorded before the lever carries null, which asks for nothing. */
export function resolveDomPack(requested: boolean | null | undefined, declared: boolean | undefined): boolean {
  return requested ?? declared ?? true;
}

/* The branch a run's checkout and its pull request are based on when the app names none. */
export const DEFAULT_BASE_BRANCH = "main";

export function baseBranchOf(app: { baseBranch?: string | undefined }): string {
  return app.baseBranch ?? DEFAULT_BASE_BRANCH;
}

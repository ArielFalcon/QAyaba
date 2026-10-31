/* Deterministic progress gate for the fix-loop. Fail-closed: if in doubt, do not spend a retry.
Signals: (A) failingCount decreased, (B) failingNames set changed, (C) lever2Flips > 0. If none hold, stop. The real-bug branch short-circuits when selectors all resolve uniquely and every failure is a value mismatch — file an Issue instead of burning retries on a genuine app defect. Pure: no I/O. */

import { classifyFailure } from "@kernel/failure-detail-class.ts";

export interface RoundResult {
  failingNames: Set<string>;
  /* May differ from failingNames.size if a test has multiple entries. */
  failingCount: number;
  absentSelectors: Set<string>;
  lever2Flips: number;
  /* Route visits producing this round (navigate, not snapshots). High count on a grounded regen means re-navigation instead of fixing from the injected tree. Downgrades a mere reshuffle to "no progress". Optional; defaults to 0 so the first-pass round is never gated. */
  reexploreNavigations?: number;
}

/* Regen with this many route navigations (or more) is thrashing. Sits above the anti-blinding allowance (1–2 uncovered routes are legitimate), so 3+ stops spend. */
const REEXPLORE_FLAIL_THRESHOLD = 3;

export interface GateDecision {
  spend: boolean;
  reason: string;
}

/* Fewest failures; ties go to the later round so the most recent rewrite is preferred. */
export function bestRound<T extends { failingCount: number }>(rounds: T[]): T | undefined {
  if (rounds.length === 0) return undefined;
  return rounds.reduce((best, cur) => (cur.failingCount <= best.failingCount ? cur : best));
}

/* Whether progress justifies spending the next retry. `prev === null` on the first retry: always allow (baseline). Caller owns the MAX_RETRIES hard cap. */
export function decideProgress(prev: RoundResult | null, cur: RoundResult): GateDecision {
  if (prev === null) {
    return { spend: true, reason: "first retry — baseline established" };
  }

  /* Regression: more failures than previous → stop. Caller keeps the best round. */
  if (cur.failingCount > prev.failingCount) {
    return { spend: false, reason: "regression — failing count increased; keeping best round" };
  }

  if (cur.failingCount < prev.failingCount) {
    return { spend: true, reason: `progress (A): failing count ${prev.failingCount} → ${cur.failingCount}` };
  }

  if (!setsEqual(cur.failingNames, prev.failingNames)) {
    /* Same count, different names after heavy re-exploration is thrashing, not progress. Signal A (fewer failures) already returned above and is never downgraded. */
    if ((cur.reexploreNavigations ?? 0) >= REEXPLORE_FLAIL_THRESHOLD) {
      return {
        spend: false,
        reason: `no progress — the failure set only reshuffled after ${cur.reexploreNavigations} re-exploration call(s) on a grounded retry; stopping loop`,
      };
    }
    return { spend: true, reason: "progress (B): failing test set changed" };
  }

  if (cur.lever2Flips > 0) {
    return { spend: true, reason: `progress (C): ${cur.lever2Flips} selector(s) flipped absent→present` };
  }

  return { spend: false, reason: "no progress — agent ignored ground truth; stopping loop" };
}

/* Real-bug: every proposed selector is unique and every failure is a value mismatch. Stop the loop and file an Issue. */
export function isLikelyRealBug(allSelectorsUnique: boolean, failureDetails: string[]): boolean {
  if (!allSelectorsUnique) return false;
  if (failureDetails.length === 0) return false;
  return failureDetails.every((d) => classifyFailure(d) === "value-mismatch");
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

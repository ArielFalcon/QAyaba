/* Deterministic progress gate for the fix-loop. Fail-closed: if in doubt, do not spend a retry.
Signals: (A) failingCount decreased, (B) failingNames set changed, (C) lever2Flips > 0. If none hold, stop. The real-bug branch short-circuits when selectors all resolve uniquely and every failure is a value mismatch — file an Issue instead of burning retries on a genuine app defect. Pure: no I/O. */

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

/* Value-oracle matchers (element is right; app returned wrong data). `toHave…` is not `(`-anchored because Playwright messages render both `.toHaveText(expected) failed` and `.toHaveText: Expected …`. The `toBe` family IS `(`-anchored so `toBeVisible` / `toBeAttached` stay presence matchers. */
const VALUE_MATCHER_RE =
  /\.toHave(?:Text|URL|Count|Values?|Attribute|Class|JSProperty|CSS|Title|Id|Role|Accessible(?:Name|Description))\b|\.toContainText\b|\.(?:toEqual|toStrictEqual|toMatchObject|toMatch|toContain|toBeCloseTo|toBeGreaterThan(?:OrEqual)?|toBeLessThan(?:OrEqual)?|toBe)\(/i;

/* Presence matchers: exists/visible/attached, not a value. They also emit Expected/Received pairs — must not be read as a value mismatch. */
const PRESENCE_MATCHER_RE =
  /\.toBe(?:Visible|Hidden|Attached|Detached|Enabled|Disabled|Checked|Unchecked|Focused|Editable|InViewport|Empty)\b/i;

/* Expected/Received diff. A value mismatch only when no presence matcher is in the message (toBeVisible emits the same pair). */
const EXPECTED_RECEIVED_RE =
  /Expected(?:\s+(?:string|pattern|array|value|substring))?\s*:[\s\S]*Received(?:\s+(?:string|object|value|array))?\s*:/i;

/* Classifies a failure detail. Distinct from PLAYWRIGHT_INFRA_RE (infra vs assertion/locator/timeout). Never throws. */
export function classifyFailure(detail: string): "value-mismatch" | "timeout" | "locator" | "other" {
  if (!detail) return "other";

  /* Value matcher first: Playwright 1.60 toHave* messages echo a Locator line and a Timeout trailer that would otherwise mis-label a value defect as locator/timeout and starve the real-bug branch. Presence matcher wins over an incidental `.toHaveText(` in the call log — otherwise a not-visible element becomes a spurious real-bug Issue. */
  if (!PRESENCE_MATCHER_RE.test(detail) && VALUE_MATCHER_RE.test(detail)) return "value-mismatch";
  /* Bare Expected/Received with no presence matcher is also a value mismatch. toBeVisible's Expected: visible / Received: <not found> stays a locator fault. */
  if (!PRESENCE_MATCHER_RE.test(detail) && EXPECTED_RECEIVED_RE.test(detail)) return "value-mismatch";

  /* Locator/selector: not found or ambiguous. Reached only when no value-assertion signature was present. */
  if (
    /strict mode violation|locator\.(?:click|fill|check|hover|press|select|tap)|element\(s\)? not found|not found|resolved to \d+ elements|waiting for (?:locator|selector)|waiting for .* to be visible/i.test(detail) ||
    /getBy(?:Role|Text|Label|TestId|Placeholder|AltText|Title)|no element|element not found/i.test(detail) ||
    /toBeVisible[\s\S]*?not (?:visible|found)|Target.*closed/i.test(detail)
  ) {
    return "locator";
  }

  /* Timeout: locator resolved but the element/network condition was not met in time. */
  if (
    /timed? ?out|exceeded.*timeout|page\.waitFor|locator\.wait|networkidle/i.test(detail) ||
    /Timeout \d+ms exceeded/i.test(detail)
  ) {
    return "timeout";
  }

  /* Free-text assertion phrasing with no matcher token and no Expected/Received pair. Last so a locator/timeout message that contains "to be" is not misclassified. */
  if (/to equal|value mismatch|assertion.*fail/i.test(detail)) {
    return "value-mismatch";
  }

  return "other";
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

/* Classifies the text of one failed case into a coarse class. Pure: no I/O. Shared by the run flow (progress gate, adjudication) and the lead's coordination (authoring failures). */

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

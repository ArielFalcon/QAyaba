/* RunVerdict paired with the SideEffect it triggers. "quarantine" names the flaky path even though it is silent at the deps-call level (no publish, no openIssue). Distinguishes flaky → quarantine from infra-error → none and no-op regression pass → none. */

import type { RunVerdict } from "@kernel/run-verdict.ts";

export type SideEffect = "pr" | "issue" | "shadow-log" | "quarantine" | "none";

export class RunDecision {
  private constructor(
    readonly verdict: RunVerdict,
    readonly sideEffect: SideEffect,
  ) {}

  static of(verdict: RunVerdict, sideEffect: SideEffect): RunDecision {
    return Object.freeze(new RunDecision(verdict, sideEffect));
  }
}

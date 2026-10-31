/* RunVerdict paired with the SideEffect it triggers. "quarantine" names the flaky path even though it is silent at the deps-call level (no publish, no openIssue). "held" is a green, approved suite that the change-coverage gate blocked under enforce: no PR and no Issue are opened, the PR text with the coverage report is kept on the run, and the suite stays out of the store; like quarantine it opens nothing, so shadow has nothing to replace. Distinguishes flaky → quarantine from infra-error → none and no-op regression pass → none. "shadow-log" is what runs when shadow replaces a pull request or an Issue; the decision itself (`outcome`) is still the one it replaced, and `shadowed` says so apart from it. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunDecisionOutcome } from "@kernel/run-trace-facts.ts";

export type SideEffect = "pr" | "issue" | "shadow-log" | "quarantine" | "held" | "none";

export class RunDecision {
  private constructor(
    readonly verdict: RunVerdict,
    readonly sideEffect: SideEffect,
    /* What the run decided: the side effect, or for a shadowed one what shadow replaced. */
    readonly outcome: RunDecisionOutcome,
    /* Whether shadow replaced the decision with a log line. */
    readonly shadowed: boolean,
  ) {}

  /* `replaced` is what a "shadow-log" side effect stands in for, and is required with it. */
  static of(verdict: RunVerdict, sideEffect: SideEffect, replaced?: "pr" | "issue"): RunDecision {
    if (sideEffect === "shadow-log") {
      if (replaced === undefined) throw new Error("a shadowed decision names the decision it replaced");
      return Object.freeze(new RunDecision(verdict, sideEffect, replaced, true));
    }
    return Object.freeze(new RunDecision(verdict, sideEffect, sideEffect, false));
  }
}

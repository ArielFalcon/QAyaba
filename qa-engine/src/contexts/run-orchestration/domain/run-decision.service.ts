/* Six-verdict policy in one pure function. Precedence is the safety property — reordering branches silently changes which side effect fires when more than one condition holds. Shadow never changes which branch wins, only whether that branch's issue/pr collapses to shadow-log.
onFailure !== "github-issue" silences fail/invalid (no Issue, no PR). flaky → quarantine and infra-error → none are shadow-invariant. skipped is always silent. Pass-path: !generating → none; reviewer rejection → issue (or shadow-log); blocksPublish → held (shadow-invariant: it opens nothing); shadow → shadow-log; else pr. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { RunDecision } from "./run-decision.ts";

export interface RunEvidence {
  verdict: RunVerdict;
  generating: boolean;
  needsReview: boolean;
  reviewerApproved: boolean;
  blocksPublish: boolean;
  shadow: boolean;
  /* app.report.onFailure: anything other than "github-issue" suppresses fail/invalid reporting. */
  onFailure: string;
}

/* What shadow turns a decision into: a log line, for the two that would have opened something on the app's repository. */
function shadowed(verdict: RunVerdict, outcome: "pr" | "issue", shadow: boolean): RunDecision {
  return RunDecision.of(verdict, shadow ? "shadow-log" : outcome, outcome);
}

/* Shared by every non-pass verdict. flaky/infra-error ignore both the onFailure guard outcome (except flaky stays quarantine) and shadow; skipped is always silent. */
function reportDecision(verdict: Exclude<RunVerdict, "pass">, onFailure: string, shadow: boolean): RunDecision {
  if (onFailure !== "github-issue") {
    return RunDecision.of(verdict, verdict === "flaky" ? "quarantine" : "none");
  }
  switch (verdict) {
    case "fail":
    case "invalid":
      return shadowed(verdict, "issue", shadow);
    case "infra-error":
      return RunDecision.of(verdict, "none");
    case "flaky":
      return RunDecision.of(verdict, "quarantine");
    case "skipped":
      return RunDecision.of(verdict, "none");
  }
}

export function decide(ev: RunEvidence): RunDecision {
  if (ev.verdict !== "pass") {
    return reportDecision(ev.verdict, ev.onFailure, ev.shadow);
  }

  /* Pass-path does not use the onFailure guard; a reviewer rejection still folds shadow → shadow-log. */
  if (!ev.generating) {
    return RunDecision.of("pass", "none");
  }

  if (ev.needsReview && !ev.reviewerApproved) {
    return shadowed("pass", "issue", ev.shadow);
  }

  /* The coverage gate holds the work in qayaba: nothing goes to the app's repository, so there is no PR or Issue for shadow to replace. */
  if (ev.blocksPublish) {
    return RunDecision.of("pass", "held");
  }

  return shadowed("pass", "pr", ev.shadow);
}

/**
 * Whether the run's suite is worth keeping for the next run: it passed (a flaky pass never does), generated something, got the
 * approval its app requires, and is not held back by the change-coverage signal. This is decide()'s "would publish" conjunction
 * without the shadow switch: shadow decides where a pull request would go, not whether the run proved the suite, so a shadow run
 * that nothing publishes still keeps what it proved.
 */
export function isAccepted(ev: RunEvidence): boolean {
  return ev.verdict === "pass" && ev.generating && (!ev.needsReview || ev.reviewerApproved) && !ev.blocksPublish;
}

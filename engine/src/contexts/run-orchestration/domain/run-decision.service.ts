/* Six-verdict policy in one pure function. Precedence is the safety property — reordering branches silently changes which side effect fires when more than one condition holds. Shadow never changes which branch wins, only whether that branch's issue/pr collapses to shadow-log.
A pass that found a defect (`defectFound`) is a fail; any other verdict keeps its own and a defect found opens its Issue beside it (a flaky run is still quarantined for its flaky case, and a declared no-op, an infra-error and a skip report the defect). onFailure !== "github-issue" silences fail/invalid and a defect's Issue (no Issue, no PR). Without a defect, flaky → quarantine and infra-error → none are shadow-invariant and skipped is silent. Pass-path: !generating → none; reviewer rejection → issue (or shadow-log); blocksPublish → held (shadow-invariant: it opens nothing); shadow → shadow-log; else pr. */

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
  /* The run found a defect by the engine's own facts (a contradiction the provider's contract lacks, in the change's reach): a green suite does not make the run pass, and whatever the verdict the defect is reported. */
  defectFound?: boolean;
}

/* What shadow turns a decision into: a log line, for the two that would have opened something on the app's repository. */
function shadowed(verdict: RunVerdict, outcome: "pr" | "issue", shadow: boolean): RunDecision {
  return RunDecision.of(verdict, shadow ? "shadow-log" : outcome, outcome);
}

/* Shared by every non-pass verdict. Without a defect, flaky/infra-error ignore both the onFailure guard outcome (except flaky stays quarantine) and shadow, and skipped is always silent; a defect found makes each of them an Issue, under the same shadow and report rules as a fail. */
function reportDecision(verdict: Exclude<RunVerdict, "pass">, onFailure: string, shadow: boolean, defectFound: boolean): RunDecision {
  if (onFailure !== "github-issue") {
    return RunDecision.of(verdict, verdict === "flaky" ? "quarantine" : "none");
  }
  switch (verdict) {
    case "fail":
    case "invalid":
      return shadowed(verdict, "issue", shadow);
    case "infra-error":
    case "skipped":
      return defectFound ? shadowed(verdict, "issue", shadow) : RunDecision.of(verdict, "none");
    case "flaky":
      return defectFound ? shadowed(verdict, "issue", shadow) : RunDecision.of(verdict, "quarantine");
  }
}

/* The verdict the run ends with: the execution's, unless it passed while a defect stands. */
export function verdictOf(ev: RunEvidence): RunVerdict {
  return ev.verdict === "pass" && ev.defectFound === true ? "fail" : ev.verdict;
}

export function decide(ev: RunEvidence): RunDecision {
  const verdict = verdictOf(ev);
  if (verdict !== "pass") {
    return reportDecision(verdict, ev.onFailure, ev.shadow, ev.defectFound === true);
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
  return verdictOf(ev) === "pass" && ev.generating && (!ev.needsReview || ev.reviewerApproved) && !ev.blocksPublish;
}

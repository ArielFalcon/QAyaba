/* Six-verdict policy in one pure function. Precedence is the safety property — reordering branches silently changes which side effect fires when more than one condition holds. Shadow never changes which branch wins, only whether that branch's issue/pr collapses to shadow-log.
onFailure !== "github-issue" silences fail/invalid (no Issue, no PR). flaky → quarantine and infra-error → none are shadow-invariant. skipped is always silent. Pass-path: !generating → none; reviewer rejection or blocksPublish → issue (or shadow-log); shadow → shadow-log; else pr. */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { RunDecision, type SideEffect } from "./run-decision.ts";

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

/* Shared by every non-pass verdict. flaky/infra-error ignore both the onFailure guard outcome (except flaky stays quarantine) and shadow. */
function reportSideEffect(verdict: RunVerdict, onFailure: string, shadow: boolean): SideEffect {
  if (onFailure !== "github-issue") {
    return verdict === "flaky" ? "quarantine" : "none";
  }
  switch (verdict) {
    case "fail":
      return shadow ? "shadow-log" : "issue";
    case "invalid":
      return shadow ? "shadow-log" : "issue";
    case "infra-error":
      return "none";
    case "flaky":
      return "quarantine";
    default:
      /* pass and skipped never reach this helper — decide() routes them first. */
      return "none";
  }
}

export function decide(ev: RunEvidence): RunDecision {
  if (ev.verdict === "skipped") {
    return RunDecision.of("skipped", "none");
  }

  if (ev.verdict !== "pass") {
    return RunDecision.of(ev.verdict, reportSideEffect(ev.verdict, ev.onFailure, ev.shadow));
  }

  /* Pass-path does not use the onFailure guard; reviewer-rejection and blocksPublish still fold shadow → shadow-log. */
  if (!ev.generating) {
    return RunDecision.of("pass", "none");
  }

  if (ev.needsReview && !ev.reviewerApproved) {
    return RunDecision.of("pass", ev.shadow ? "shadow-log" : "issue");
  }

  if (ev.blocksPublish) {
    return RunDecision.of("pass", ev.shadow ? "shadow-log" : "issue");
  }

  if (ev.shadow) {
    return RunDecision.of("pass", "shadow-log");
  }

  return RunDecision.of("pass", "pr");
}

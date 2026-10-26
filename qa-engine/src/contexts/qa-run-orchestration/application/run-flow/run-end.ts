/*
 * Why a run ended. Every end names one reason from this closed set; a reason is the stable key of what the end does to the run's
 * record, to publication and to learning, and the telemetry of a run reports it on the run's root span.
 */

export const END_REASONS = [
  "aborted",
  "deploy-gate-failed",
  "classify-skipped",
  "setup-failed",
  "auth-failed",
  "login-precondition",
  "generation-noop",
  "generation-ended-without-specs",
  "generation-empty-output",
  "static-gate-failed",
  "pre-execute-infra",
  "reviewer-unavailable",
  "review-disputed",
  "final-proof-guard",
  "publication-failed",
  "run-deadline",
  "sandbox-unavailable",
  "probe-sweep-failed",
  "decided",
  "context-pass",
] as const;

export type EndReason = (typeof END_REASONS)[number];

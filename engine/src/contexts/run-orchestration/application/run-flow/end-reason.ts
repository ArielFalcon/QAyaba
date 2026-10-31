/* The closed set of reasons a run ends for. */

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
  "no-author",
  "static-gate-failed",
  "pre-execute-infra",
  "reviewer-unavailable",
  "review-disputed",
  "final-proof-guard",
  "run-deadline",
  "sandbox-unavailable",
  "probe-sweep-failed",
  "decided",
  "context-pass",
] as const;

export type EndReason = (typeof END_REASONS)[number];

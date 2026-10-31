/* A request to rebuild an app's context map by a `context` run. */
export interface ContextHealRunRequest {
  app: string;
  /* The triggering run's own sha: the one DEV serves for a gated app that got this far. */
  sha: string;
  /* The run whose stale map asked for this rebuild. Optional: onboarding/tests may enqueue an unlinked heal. */
  parentRunId?: string;
}

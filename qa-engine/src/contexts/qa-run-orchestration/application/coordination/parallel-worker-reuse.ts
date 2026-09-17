/* ParallelWorkerInput is unused. Fields below exist on that type for inventory; they are not converted into DelegationBrief. The missing fields are why a sidekick cannot be driven from that type. */
export const PARALLEL_WORKER_REUSABLE_FIELDS = [
  "objective",
  "flow",
  "specFile",
  "repo",
  "mirrorDir",
  "e2eRelDir",
  "namespace",
  "baseUrl",
  "appName",
  "mode",
  "runId",
] as const;

export const PARALLEL_WORKER_MISSING_FOR_SIDEKICK = [
  "authority",
  "scope.readablePaths/writablePaths/allowedCommands",
  "acceptanceCriteria",
  "escalationPolicy",
  "validationPlan",
] as const;

// ParallelWorkerInput is dormant on the rewritten engine (generation-ports.ts). Fase 3 inspects
// it for reusable fields and does NOT convert it into DelegationBrief.
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


import { z } from "zod";
import { TestTargetSchema, RunModeSchema, RunVerdictSchema, RunEngineStatusSchema } from "./events";

export const CaseStatusSchema = z.enum(["pass", "fail", "flaky"]);

export const QaCaseSchema = z.object({
  name: z.string(),
  status: CaseStatusSchema,
  detail: z.string().optional(),
  flow: z.string().optional(),
  objective: z.string().optional(),
  reason: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const SpecRecordSchema = z.object({
  name: z.string(),
  objective: z.string().optional(),
  flow: z.string().optional(),
});

export const ActivityKindSchema = z.enum(["file", "command", "todo", "phase", "error"]);

export const AgentActivitySchema = z.object({
  kind: ActivityKindSchema,
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  ts: z.string(),
});

export const RunStatusSchema = z.enum(["enqueued", "running", "done"]);

export const RunRecordSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  ref: z.string().optional(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  step: z.string().optional(),
  stepDetail: z.string().optional(),
  verdict: RunVerdictSchema.optional(),
  /* Derived from `verdict` once the run is `done` (src/types.ts engineStatus). OPTIONAL — absent while the run is enqueued/running and has no verdict yet; a still-running run is not an "error". */
  engineStatus: RunEngineStatusSchema.optional(),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  retrying: z.boolean().optional(),
  parentRunId: z.string().optional(),
  triggerRepo: z.string().optional(),
  cases: z.array(QaCaseSchema),
  specs: z.array(SpecRecordSchema).optional(),
  logs: z.array(z.string()),
  activity: z.array(AgentActivitySchema).optional(),
  stepStartedAt: z.string().optional(),
  at: z.string(),
});

export const AppServiceViewSchema = z.object({
  repo: z.string(),
  openapi: z.string().optional(),
  versionUrl: z.string().optional(),
});

export const AppViewSchema = z.object({
  name: z.string(),
  repo: z.string(),
  baseUrl: z.string(),
  versionUrl: z.string(),
  code: z.boolean(),
  shadow: z.boolean(),
  needsReview: z.boolean(),
  testDataPrefix: z.string(),
  services: z.array(AppServiceViewSchema),
});

export const QueueStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z.object({ id: z.string(), app: z.string() }).nullable(),
});

export const ChatEntrySchema = z.object({ role: z.string(), text: z.string() });

export const VersionInfoSchema = z.object({
  serverVersion: z.string(),
  apiVersion: z.string(),
  minClientVersion: z.string(),
  compatible: z.boolean(),
  capabilities: z.array(z.string()),
  message: z.string().optional(),
  /* The server's GitHub OAuth App client id (public). Present when GitHub login is configured, so the console can run the device flow without the id being baked into the binary. */
  githubClientId: z.string().optional(),
});

/** ── Auth (GitHub device flow → server session) ──────────────────────────────── The client runs the GitHub OAuth device flow itself, then exchanges the resulting GitHub user token for a short-lived server session. The server verifies the token's identity and that the user can push to a watched repo before issuing the session. */
export const LoginRequestSchema = z.object({
  githubToken: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  token: z.string(),
  username: z.string(),
  expiresAt: z.string(),
});

export const CreateRunInputSchema = z.object({
  app: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  sha: z.string().optional(),
  ref: z.string().optional(),
  guidance: z.string().optional(),
  shadow: z.boolean().optional(),
  /* diff mode only: how many commits ending at the run's SHA the diff spans (default 1). Lets a run analyze a short series as one blast radius, not just the tip commit. */
  commits: z.number().int().min(1).max(20).optional(),
});

export const CreateRunResultSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  status: z.string(),
});

export const AskRequestSchema = z.object({
  question: z.string(),
  history: z.array(ChatEntrySchema).optional(),
});

export const AskResponseSchema = z.object({ answer: z.string() });

export const ContinueRequestSchema = z.object({
  cases: z.array(z.string()).optional(),
  guidance: z.string().optional(),
});

export const ContinueResultSchema = z.object({
  id: z.string(),
  parentRunId: z.string(),
});

export const OnboardServiceInputSchema = z.object({
  repo: z.string(),
  openapi: z.string().optional(),
  versionUrl: z.string().optional(),
});

export const RepoInfoSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
});

export const CreateAppInputSchema = z.object({
  repo: z.string(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  versionUrl: z.string().optional(),
  target: TestTargetSchema.optional(),
  needsReview: z.boolean().optional(),
  shadow: z.boolean().optional(),
  testDataPrefix: z.string().optional(),
  services: z.array(OnboardServiceInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
  validateOnly: z.boolean().optional(),
});

export const UpdateAppInputSchema = z.object({
  repo: z.string().optional(),
  baseUrl: z.string().optional(),
  versionUrl: z.string().optional(),
  target: TestTargetSchema.optional(),
  needsReview: z.boolean().optional(),
  shadow: z.boolean().optional(),
  testDataPrefix: z.string().optional(),
  services: z.array(OnboardServiceInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
});

export const CreateAppResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()).optional(),
  repoInfo: RepoInfoSchema.optional(),
  yaml: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  envApplied: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export const DeleteAppResultSchema = z.object({
  removed: z.array(z.string()),
});

export const RepoListItemSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
});

export const RepoListResponseSchema = z.object({
  repos: z.array(RepoListItemSchema),
  hasMore: z.boolean(),
});


export const HttpBoundaryProfileSchema = z.object({
  transport: z.literal("http"),
  frontFiles: z.string(),
  frontCallSite: z.object({ kind: z.string(), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string(),
  serviceRepoTemplate: z.string(),
  openApiPath: z.string(),
});

export const EventBoundaryProfileSchema = z.object({
  transport: z.literal("event"),
  files: z.string(),
  eventPattern: z.object({
    kind: z.string(),
    listenerBaseType: z.string(),
    listenerEventCall: z.string(),
    subscriberBaseType: z.string(),
    publishCall: z.string(),
  }),
});

export const HttpBackendBoundaryProfileSchema = z.object({
  transport: z.literal("http-backend"),
  sourceFiles: z.string(),
  callPattern: z.object({ kind: z.string(), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string(),
  serviceRepoTemplate: z.string(),
  openApiPath: z.string(),
});

export const BoundaryProfileSchema = z.discriminatedUnion("transport", [
  HttpBoundaryProfileSchema,
  EventBoundaryProfileSchema,
  HttpBackendBoundaryProfileSchema,
]);

export const MappingProgressSchema = z.object({
  runId: z.string().optional(),
  step: z.string().optional(),
  verdict: z.string().optional(),
});

export const OnboardStateSchema = z.enum(["idle", "resolvingMirrors", "proposing", "scoring", "indexing", "mapping", "done", "failed"]);
export const OnboardOutcomeSchema = z.enum(["winner", "no-profile"]);

export const RepoIndexStatusSchema = z.enum(["ok", "failed"]);

export const RepoIndexOutcomeSchema = z.object({
  repo: z.string(),
  status: RepoIndexStatusSchema,
  nodeCount: z.number().optional(),
  error: z.string().optional(),
});

export const BoundaryEdgeTransportSchema = z.enum(["http", "event", "rpc"]);

export const BoundaryEdgeSummarySchema = z.object({
  fromRepo: z.string(),
  toRepo: z.string(),
  transport: BoundaryEdgeTransportSchema,
  calls: z.number(),
});

export const ResolutionSummarySchema = z.object({
  edges: z.array(BoundaryEdgeSummarySchema),
  unresolved: z.number(),
  external: z.number(),
  drift: z.number(),
});

export const OnboardingJobStatusSchema = z.object({
  state: OnboardStateSchema,
  app: z.string().optional(),
  round: z.number(),
  ceiling: z.number(),
  candidatesScored: z.number(),
  lastResolvedScore: z.number().optional(),
  resolvedProfile: BoundaryProfileSchema.optional(),
  outcome: OnboardOutcomeSchema.optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  indexProgress: z.array(RepoIndexOutcomeSchema).optional(),
  mappingProgress: MappingProgressSchema.optional(),
  resolution: ResolutionSummarySchema.optional(),
});

export const ProposeBoundariesInputSchema = z.object({
  repo: z.string().optional(),
  services: z.array(z.string()).optional(),
});

export const ConfirmBoundariesInputSchema = z.object({
  confirm: z.literal(true),
});

export const AgentProviderSchema = z.enum(["opencode", "codex"]);
export const AgentModeSchema = z.enum(["single", "dual"]);
export const AgentRoleSchema = z.enum(["primary", "reviewer", "chat", "worker", "workerCode", "maintainer"]);

export const RoleAssignmentSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string(),
});

export const AgentAssignmentsSchema = z.object({
  primary: RoleAssignmentSchema,
  reviewer: RoleAssignmentSchema,
  chat: RoleAssignmentSchema,
});

export const KeyPresenceSchema = z.object({
  opencode: z.boolean(),
  codex: z.boolean(),
});

export const AgentConfigValidationSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  requiresSingleDowngradeConfirmation: z.boolean().optional(),
  downgradeProvider: AgentProviderSchema.optional(),
});

export const AgentRuntimeStatusSchema = z.enum(["stopped", "starting", "healthy", "degraded", "failed", "needs_config"]);

export const AgentProviderHealthSchema = z.object({
  provider: AgentProviderSchema,
  status: AgentRuntimeStatusSchema,
  configured: z.boolean(),
  error: z.string().optional(),
});

export const AgentHealthMapSchema = z.object({
  opencode: AgentProviderHealthSchema.optional(),
  codex: AgentProviderHealthSchema.optional(),
});

export const PublicAgentConfigSchema = z.object({
  mode: AgentModeSchema,
  singleProvider: AgentProviderSchema,
  assignments: AgentAssignmentsSchema,
  keys: KeyPresenceSchema,
  validation: AgentConfigValidationSchema,
  health: AgentHealthMapSchema.optional(),
});

export const AgentConfigUpdateSchema = z.object({
  mode: AgentModeSchema.optional(),
  singleProvider: AgentProviderSchema.optional(),
  assignments: AgentAssignmentsSchema.partial().optional(),
  apiKeys: z.object({
    opencode: z.string().optional(),
    codex: z.string().optional(),
  }).optional(),
  confirmSingleDowngrade: z.boolean().optional(),
});

export const AgentModelInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  provider: AgentProviderSchema.optional(),
});

export const AgentModelsResponseSchema = z.object({
  provider: AgentProviderSchema,
  models: z.array(AgentModelInfoSchema),
});

export const AgentConfigApplyResultSchema = z.object({
  config: PublicAgentConfigSchema,
  restarted: z.array(AgentProviderSchema),
  downgraded: z.boolean().optional(),
});

export const AgentRestartRequestSchema = z.object({
  provider: AgentProviderSchema,
});

export const AgentRestartResponseSchema = z.object({
  health: AgentProviderHealthSchema,
});

export type QaCase = z.infer<typeof QaCaseSchema>;
export type SpecRecord = z.infer<typeof SpecRecordSchema>;
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type AppView = z.infer<typeof AppViewSchema>;
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
export type ChatEntry = z.infer<typeof ChatEntrySchema>;
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type ContinueRequest = z.infer<typeof ContinueRequestSchema>;
export type ContinueResult = z.infer<typeof ContinueResultSchema>;
export type OnboardServiceInput = z.infer<typeof OnboardServiceInputSchema>;
export type RepoInfo = z.infer<typeof RepoInfoSchema>;
export type CreateAppInput = z.infer<typeof CreateAppInputSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppInputSchema>;
export type CreateAppResult = z.infer<typeof CreateAppResultSchema>;
export type DeleteAppResult = z.infer<typeof DeleteAppResultSchema>;
export type RepoListItem = z.infer<typeof RepoListItemSchema>;
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;
export type BoundaryProfileWire = z.infer<typeof BoundaryProfileSchema>;
export type OnboardingJobStatus = z.infer<typeof OnboardingJobStatusSchema>;
export type ProposeBoundariesInput = z.infer<typeof ProposeBoundariesInputSchema>;
export type ConfirmBoundariesInput = z.infer<typeof ConfirmBoundariesInputSchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;
export type PublicAgentConfig = z.infer<typeof PublicAgentConfigSchema>;
export type AgentConfigUpdate = z.infer<typeof AgentConfigUpdateSchema>;
export type AgentModelInfo = z.infer<typeof AgentModelInfoSchema>;
export type AgentConfigApplyResult = z.infer<typeof AgentConfigApplyResultSchema>;
export type AgentRestartRequest = z.infer<typeof AgentRestartRequestSchema>;
export type AgentRestartResponse = z.infer<typeof AgentRestartResponseSchema>;

/** ── Intelligence (read-only projections of the persisted learning artifacts) ────── The operator console renders these; they are honest views of what the ledger, the value-oracle scorecard and the curriculum actually hold — no signal is invented. */

export const LearningRuleViewSchema = z.object({
  trigger: z.string(),
  action: z.string(),
  errorClass: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  usageCount: z.number().int().nonnegative(),
  outcomeCount: z.number().int().nonnegative(),
  successRate: z.number().nullable(),
  /* "pending" is a RETIRED status (kept in the enum only for backward-compat with rows an older build may have written; nothing inserts it anymore — correction-sourced rules now enter as "candidate", see distiller.ts). */
  status: z.enum(["pending", "candidate", "active", "deprecated", "superseded"]),
});

export const ScorecardViewSchema = z.object({
  updatedAt: z.string(),
  totalRuns: z.number().int().nonnegative(),
  measuredRuns: z.number().int().nonnegative(),
  avgValueScore: z.number().nullable(),
  lastValueScore: z.number().nullable(),
  entries: z.array(
    z.object({
      valueScore: z.number().nullable(),
      mutantCount: z.number().int().nonnegative(),
      killedCount: z.number().int().nonnegative(),
      target: z.string(),
      at: z.string(),
    }),
  ),
});

export const CurriculumViewSchema = z.object({
  updatedAt: z.string(),
  archetypes: z.array(
    z.object({
      archetype: z.string(),
      /* Proven STRICTLY by the adjudicator's app_defect verdict — never by coverage. */
      caughtRealBug: z.boolean(),
      promotionCount: z.number().int().nonnegative(),
      /* The evidence ladder's second tier: runs in which this archetype was offered to the generator AND the run produced a determinable objective signal, and how many of those earned credit. The operator reads credited/evaluated as the archetype's hit rate for this app; evaluated 0 means "never tried", which every renderer must show as such and never as a 0/0 rate. */
      evaluated: z.number().int().nonnegative(),
      credited: z.number().int().nonnegative(),
    }),
  ),
});

export const IntelligenceViewSchema = z.object({
  app: z.string(),
  rules: z.array(LearningRuleViewSchema),
  scorecard: ScorecardViewSchema.nullable(),
  curriculum: CurriculumViewSchema.nullable(),
});

export type IntelligenceView = z.infer<typeof IntelligenceViewSchema>;

export const CoordinationSignalsSchema = z.object({
  measured: z.boolean(),
  totalRuns: z.number().int().nonnegative(),
  delegateRuns: z.number().int().nonnegative(),
  escalationRate: z.number().nullable(),
  contractFailureRate: z.number().nullable(),
  avgDelegationMs: z.number().nullable(),
});

export type CoordinationSignals = z.infer<typeof CoordinationSignalsSchema>;

/** ── Signals (fleet-wide integrity readout — the anti-Goodhart panel) ─────────────── The honest answer to "can I trust the fleet's green?". It juxtaposes the ground-truth value-oracle (◆, real, from the aggregated scorecards) against the proxy the rest of the console shows everywhere (◇ pass rate), and states plainly that change-coverage is not measured yet (⚠). Every field is derived from persisted data — nothing is invented. */
export const SignalsViewSchema = z.object({
  valueOracle: z.object({
    measured: z.boolean(),
    avgScore: z.number().nullable(),
    measuredRuns: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
  }),
  reviewer: z.object({
    passRate: z.number().nullable(),
    runs: z.number().int().nonnegative(),
  }),
  /* ◆/⚠ change-coverage: of runs that produced coverage data, what fraction of the changed lines did the tests actually exercise? avgRatio is null (→ "not measured") when no run carried a ratio — never a hard 0 painted as a reading. */
  coverage: z.object({
    measured: z.boolean(),
    avgRatio: z.number().nullable(),
    measuredRuns: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
  }),
  coordination: CoordinationSignalsSchema.optional(),
});

export type SignalsView = z.infer<typeof SignalsViewSchema>;

export const CoordinationEventSchema = z.object({
  runId: z.string(),
  kind: z.enum(["proposal", "delegation", "escalation", "router", "pushback", "outcome"]),
  action: z.string().optional(),
  capability: z.string().optional(),
  reason: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  delegationId: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  failureClass: z.string().optional(),
  progressFingerprint: z.string().optional(),
  finalOutcome: z.string().optional(),
  reviewOutcome: z.string().optional(),
  valueScore: z.number().nullable().optional(),
  coverageRatio: z.number().nullable().optional(),
  escalations: z.number().int().nonnegative().optional(),
  at: z.number().int().nonnegative(),
});

export const CoordinationEventsViewSchema = z.object({
  events: z.array(CoordinationEventSchema),
  truncated: z.boolean(),
});

export type CoordinationEvent = z.infer<typeof CoordinationEventSchema>;
export type CoordinationEventsView = z.infer<typeof CoordinationEventsViewSchema>;


export const TrendWindowSchema = z.object({
  current: z.number().int().nonnegative(),
  previous: z.number().int().nonnegative(),
});

export const CoverageTrendSchema = z.object({
  measured: z.boolean(),
  ratio: z.number().nullable(),
  previousRatio: z.number().nullable(),
  minRatio: z.number(),
  series: z.array(z.number()),
});

export const ValueTrendSchema = z.object({
  measured: z.boolean(),
  avgScore: z.number().nullable(),
  previousAvgScore: z.number().nullable(),
  series: z.array(z.number()),
});

export const FlakyTrendSchema = z.object({
  rate: z.number().nullable(),
  previousRate: z.number().nullable(),
  runs: z.number().int().nonnegative(),
});

export const ErrorClassCountSchema = z.object({
  errorClass: z.string(),
  count: z.number().int().nonnegative(),
  previousCount: z.number().int().nonnegative(),
  multiplier: z.number().nullable(),
});

export const DurationTrendSchema = z.object({
  avgMs: z.number().nullable(),
  previousMs: z.number().nullable(),
  runs: z.number().int().nonnegative(),
});

export const FlowStabilitySchema = z.object({
  flow: z.string(),
  runs: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
});

export const TrendsViewSchema = z.object({
  app: z.string(),
  generatedAt: z.string(),
  window: TrendWindowSchema,
  coverage: CoverageTrendSchema,
  valueOracle: ValueTrendSchema,
  verdictMix: z.record(z.string(), z.number().int().nonnegative()),
  reviewerPassRate: z.number().nullable(),
  flaky: FlakyTrendSchema,
  errorClasses: z.array(ErrorClassCountSchema),
  duration: DurationTrendSchema,
  flows: z.array(FlowStabilitySchema),
});

export type TrendsView = z.infer<typeof TrendsViewSchema>;

export const ReportChartSchema = z.enum([
  "big-number", "gauge", "paired-bars", "ranked-bars", "stacked-bar", "line", "area", "donut",
]);

export const InsightIntentSchema = z.enum([
  "single-value", "comparison", "trend", "composition", "distribution",
]);

export const InsightUnitSchema = z.enum(["ratio", "percent", "count", "ms", "score"]);

export const BreakdownItemSchema = z.object({
  label: z.string(),
  value: z.number(),
  semantic: z.enum(["good", "bad", "neutral"]).optional(),
});

export const ReportInsightSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: InsightIntentSchema,
  chart: ReportChartSchema,
  value: z.number().nullable(),
  unit: InsightUnitSchema.optional(),
  target: z.number().nullable().optional(),
  delta: z.number().nullable(),
  multiplier: z.number().nullable(),
  direction: z.enum(["up", "down", "flat"]),
  goodWhen: z.enum(["up", "down", "neutral"]),
  caption: z.string().optional(),
  series: z.array(z.number()).optional(),
  breakdown: z.array(BreakdownItemSchema).optional(),
  score: z.number(),
});

export const ReportViewSchema = z.object({
  app: z.string(),
  generatedAt: z.string(),
  window: TrendWindowSchema,
  headline: z.string(),
  insights: z.array(ReportInsightSchema),
});

export type ReportView = z.infer<typeof ReportViewSchema>;

export const RunReportViewSchema = z.object({
  current: ReportViewSchema,
  evolution: ReportViewSchema.nullable(),
});

export type RunReportView = z.infer<typeof RunReportViewSchema>;

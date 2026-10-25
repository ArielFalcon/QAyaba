
import { z } from "zod";
import { TURN_ENDS } from "../turn-end";
import { LoginPathSchema } from "../login-path";
import { TestTargetSchema, RunModeSchema, RunVerdictSchema, RunEngineStatusSchema } from "./events";
import { CAMPAIGN_ID_PATTERN, CAMPAIGN_LABEL_PATTERN, MAX_CAMPAIGN_REPLICATE, MAX_VARIANT_KEYS } from "../campaign";
import { CAPTURE_MODES } from "../telemetry/capture-mode";

export const CaseStatusSchema = z.enum(["pass", "fail", "flaky"]);

export const NetworkErrorSchema = z.object({
  /* origin+pathname only — never a query or fragment. */
  url: z.string(),
  status: z.number().int().optional(),
  errorText: z.string().optional(),
  resourceType: z.string().optional(),
});

/* Derived from the case's network errors and the run's egress report, never reported by the browser. */
export const NetworkClassSchema = z.enum(["egress", "backend", "dns", "other"]);

export const QaCaseSchema = z.object({
  name: z.string(),
  status: CaseStatusSchema,
  detail: z.string().optional(),
  flow: z.string().optional(),
  objective: z.string().optional(),
  reason: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  networkErrors: z.array(NetworkErrorSchema).optional(),
  networkClass: NetworkClassSchema.optional(),
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
  /** App login kind. Absent when the app is public. Secrets are not on this view. */
  authKind: z.enum(["form", "mtls"]).optional(),
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

/* How much content a run's trace may carry (docs/observability-design.md section 9.2). The server caps what a caller asks for. */
export const CaptureModeSchema = z.enum(CAPTURE_MODES);

/*
 * The campaign a run belongs to: stored and echoed as data. The variant labels never change what a run does (section 14):
 * only the explicit levers and the deployment's configuration do.
 */
export const CampaignInputSchema = z.object({
  id: z.string().regex(CAMPAIGN_ID_PATTERN, { error: "campaign.id must be 1-100 characters of A-Z a-z 0-9 _ . : -" }),
  variant: z
    .record(z.string().regex(CAMPAIGN_LABEL_PATTERN, { error: "campaign.variant keys must be 1-64 characters of A-Z a-z 0-9 _ . : -" }), z.string().regex(CAMPAIGN_LABEL_PATTERN, { error: "campaign.variant values must be 1-64 characters of A-Z a-z 0-9 _ . : -" }))
    .refine((v) => Object.keys(v).length <= MAX_VARIANT_KEYS, { error: `campaign.variant has at most ${MAX_VARIANT_KEYS} keys` })
    .refine((v) => !Object.hasOwn(v, "__proto__"), { error: "campaign.variant must not use the key __proto__" }),
  replicate: z.number().int().min(1).max(MAX_CAMPAIGN_REPLICATE),
});

/* The run's own choice of grounding sources (an A/B arm); every key absent means the app's setting. */
export const GroundingInputSchema = z.object({
  stitcher: z.boolean().optional(),
  structuralSignal: z.boolean().optional(),
  curriculum: z.boolean().optional(),
  domPack: z.boolean().optional(),
});
export type GroundingInput = z.infer<typeof GroundingInputSchema>;

export const CreateRunInputSchema = z.object({
  app: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  sha: z.string().optional(),
  /* diff mode: the range start — the run's diff spans baseSha..sha instead of the single commit at sha. Must be 7–40 hex characters. */
  baseSha: z.string().optional(),
  ref: z.string().optional(),
  guidance: z.string().optional(),
  shadow: z.boolean().optional(),
  /* diff mode only: how many commits ending at the run's SHA the diff spans (default 1). Lets a run analyze a short series as one blast radius, not just the tip commit. */
  commits: z.number().int().min(1).max(20).optional(),
  /* The run's own choice about the run_spec loop (an A/B arm), overriding the app's qa.closedLoop.enabled. Absent: the app's setting decides. */
  closedLoop: z.boolean().optional(),
  /* The run's own choice about the authenticated agent browser (an A/B arm), overriding the app's qa.agentBrowser.enabled. Absent: the app's setting decides. */
  agentBrowser: z.boolean().optional(),
  /* The campaign this run is a replicate of. Absent: an ordinary run. */
  campaign: CampaignInputSchema.optional(),
  /* The content capture the run's trace may carry, capped by the server's QA_TELEMETRY_MAX_CAPTURE (default metadata). The applied value is in the run's effectiveConfig. */
  captureMode: CaptureModeSchema.optional(),
  /* The run's own choice of grounding sources (an A/B arm), overriding the app's settings. Absent: the app decides. */
  grounding: GroundingInputSchema.optional(),
});

export const CreateRunResultSchema = z.object({
  schemaVersion: z.literal(1),
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

export const AppAuthInputSchema = z
  .object({
    kind: z.enum(["form", "mtls"]),
    usernameEnv: z.string().optional(),
    passwordEnv: z.string().optional(),
    certEnv: z.string().optional(),
    certPassEnv: z.string().optional(),
    /** A path on the app's own origin, for a form login whose page is not reachable by its links. */
    loginPath: LoginPathSchema.optional(),
  })
  .refine((auth) => auth.kind === "form" || auth.loginPath === undefined, {
    error: "loginPath is only valid for kind form",
    path: ["loginPath"],
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
  auth: AppAuthInputSchema.optional(),
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
  auth: AppAuthInputSchema.optional(),
  /** true drops the YAML auth block. Absent preserves it. */
  clearAuth: z.boolean().optional(),
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

/** How the app's login stands once the login phase has judged its run: signed in and proven by an accepted run (verified), not authored by that run (unauthored), or the run could not tell (failed: the login could not be completed, or the run did not finish). */
export const LoginBootstrapStatusSchema = z.enum(["verified", "unauthored", "failed"]);

/** The login phase's run, copied off its run record while it runs; `status` appears once the run has ended. */
export const LoginProgressSchema = z.object({
  runId: z.string().optional(),
  step: z.string().optional(),
  verdict: z.string().optional(),
  status: LoginBootstrapStatusSchema.optional(),
});

export const OnboardStateSchema = z.enum(["idle", "resolvingMirrors", "proposing", "scoring", "indexing", "mapping", "login", "done", "failed"]);
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
  /** Present once the login phase has started; absent for an app with no form login to bootstrap. */
  loginProgress: LoginProgressSchema.optional(),
  resolution: ResolutionSummarySchema.optional(),
});

/** What POST /apps/{name}/login-bootstrap answers: the run that establishes and proves the app's login, enqueued. */
export const LoginBootstrapResultSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  status: z.string(),
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

const BackendHealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down", "unconfigured"]),
  reason: z.string().optional(),
  checkedAt: z.string(),
  diskUsedRatio: z.number().min(0).optional(),
  lastDataAt: z.string().optional(),
});

/* GET /api/v1/telemetry/health (docs/observability-design.md §14). Counts and flags only. */
export const TelemetryHealthSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(["off", "local"]),
  campaignFreeze: z.boolean(),
  otlp: z.object({
    configured: z.boolean(),
    lastExportAt: z.string().optional(),
    lastError: z.string().optional(),
    dropped: z.number().int().min(0),
  }),
  ledger: z.object({
    ok: z.boolean(),
    spans: z.number().int().min(0),
    writeErrors: z.number().int().min(0),
  }),
  scoreSink: z.object({
    configured: z.boolean(),
    faults: z.number().int().min(1).optional(),
    lastExportAt: z.string().optional(),
    lastError: z.string().optional(),
  }),
  droppedAttributes: z.number().int().min(0),
  /* Loki, Tempo and the collectors verified end to end (docs/telemetry-local.md); present once a probe has finished. */
  backends: z
    .object({
      ok: z.boolean(),
      loki: BackendHealthSchema,
      tempo: BackendHealthSchema,
      collector: BackendHealthSchema,
    })
    .optional(),
  /* Present when the process runs host health (docs/observability-design.md §7). */
  host: z
    .object({
      suspends: z.number().int().min(0),
      lastSuspendAt: z.string().optional(),
      lastSuspendMs: z.number().min(0).optional(),
      blockedLoops: z.number().int().min(0),
      eventLoopP99Ms: z.number().min(0).optional(),
      zombies: z.number().int().min(0).optional(),
    })
    .optional(),
});

export type QaCase = z.infer<typeof QaCaseSchema>;
export type SpecRecord = z.infer<typeof SpecRecordSchema>;
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
/* Public evaluation contract (docs/observability-design.md section 14). Every body below carries schemaVersion 1, errors included. */

/* The body of every non-2xx answer of the evaluation and run endpoints. */
export const ApiErrorSchema = z.object({ schemaVersion: z.literal(1), error: z.string() });

export const ScoreSchema = z.object({
  name: z.string(),
  value: z.union([z.number(), z.boolean(), z.string()]),
  dataType: z.enum(["NUMERIC", "BOOLEAN", "CATEGORICAL"]),
  polarity: z.enum(["higher_better", "lower_better", "none"]),
  source: z.enum(["deterministic", "llm_judge", "human"]),
  graderVersion: z.string(),
  comment: z.string().optional(),
  observationId: z.string().optional(),
  /* Additive (section 14): present on `llm_judge` scores only, the model that answered. The prompt version is in `graderVersion`. */
  judgeModel: z.string().optional(),
});

export const RunEvaluationSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  /* Null when the run was not traced (QA_TELEMETRY=off). */
  traceId: z.string().nullable(),
  status: z.enum(["pending", "complete", "failed"]),
  /* Latest grader version per name by default; every stored version with ?versions=all. */
  scores: z.array(ScoreSchema),
});

export const EvaluationCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  /* The canonical pipeline phase order: the ordinal of furthest_phase and the order of GET /runs/:id phases. */
  phases: z.array(z.string()),
  /* Base names only; a family entry lists its closed set of suffixes (a score `<base>.<suffix>` inherits the base). */
  scores: z.array(
    z.object({
      name: z.string(),
      dataType: z.enum(["NUMERIC", "BOOLEAN", "CATEGORICAL"]),
      polarity: z.enum(["higher_better", "lower_better", "none"]),
      range: z.object({ min: z.number(), max: z.number().optional() }).optional(),
      categories: z.array(z.string()).optional(),
      suffixes: z.array(z.string()).optional(),
      graderVersion: z.string(),
      /* Additive (section 14): present on LLM-judge entries only. `experimental` is every judge's default; `calibrated` needs a passing calibration against human labels for the prompt version and model in force. No gate reads it. */
      status: z.enum(["experimental", "calibrated"]).optional(),
    }),
  ),
});

/* Exactly one of runIds, campaignId or since selects the runs; graders optionally narrows the re-run to some base names. */
export const RegradeRequestSchema = z
  .object({
    runIds: z.array(z.string()).min(1).max(500).optional(),
    campaignId: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    graders: z.array(z.string()).min(1).optional(),
  })
  .refine((r) => [r.runIds, r.campaignId, r.since].filter((v) => v !== undefined).length === 1, { message: "give exactly one of runIds, campaignId or since" });

export const RegradeStartedSchema = z.object({ schemaVersion: z.literal(1), jobId: z.string(), runs: z.number().int().min(0) });

export const RegradeJobSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string(),
  status: z.enum(["pending", "running", "complete", "failed"]),
  runs: z.number().int().min(0),
  graded: z.number().int().min(0),
  failed: z.array(z.object({ runId: z.string(), error: z.string() })),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

/*
 * What a run actually ran with, recorded at run time (docs/observability-design.md section 14). Every key is always present; a setting
 * that does not apply, or that the run did not record, is null. `agents` lists only the roles the run invoked.
 */
export const EffectiveConfigSchema = z.object({
  levers: z.object({
    closedLoop: z.boolean().nullable(),
    agentBrowser: z.boolean().nullable(),
    captureMode: CaptureModeSchema.nullable(),
  }),
  campaignFreeze: z.boolean().nullable(),
  runtime: z.string().nullable(),
  agents: z.record(
    z.string(),
    z.object({
      provider: z.string().nullable(),
      model: z.string().nullable(),
      reasoningEffort: z.string().nullable(),
      stepLimit: z.number().int().min(0).nullable(),
    }),
  ),
  prompt: z.object({ staticHash: z.string().nullable() }),
  grounding: z.object({
    stitcher: z.string().nullable(),
    structuralSignal: z.string().nullable(),
    curriculum: z.string().nullable(),
    domPack: z.boolean().nullable(),
  }),
  coverage: z.object({ mode: z.string().nullable(), minRatio: z.number().nullable() }),
  reflector: z.boolean().nullable(),
});

/* GET /campaigns/:id/runs: the campaign's runs, optionally narrowed by variant labels. */
export const CampaignRunsSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.string(),
  runs: z.array(
    z.object({
      id: z.string(),
      variant: z.record(z.string(), z.string()),
      replicate: z.number().int().min(1),
      status: RunStatusSchema,
      verdict: RunVerdictSchema.optional(),
      evaluationStatus: z.enum(["pending", "complete", "failed"]),
    }),
  ),
  /* True when every run of the campaign is done and graded (the server does not know the matrix the client requested). */
  complete: z.boolean(),
});

/* GET /runs/:id: the run record plus what observability knows about how it ended. Fields only add to RunRecord. */
export const RunDetailSchema = RunRecordSchema.extend({
  schemaVersion: z.literal(1),
  /* Null only when telemetry is off. traceUrl is present when QA_TRACE_URL_TEMPLATE is set. */
  telemetry: z.object({ traceId: z.string(), traceUrl: z.string().optional() }).nullable(),
  /* Time per phase the run entered, in canonical pipeline order. */
  phases: z.array(z.object({ name: z.string(), durationMs: z.number().min(0) })),
  furthestPhase: z.string().nullable(),
  usage: z.object({
    inputTokens: z.number().min(0),
    outputTokens: z.number().min(0),
    reasoningTokens: z.number().min(0),
    cacheReadTokens: z.number().min(0),
    cacheWriteTokens: z.number().min(0),
    costUsd: z.number().min(0),
  }),
  /*
   * Counts of the specs this run delivered. (`specs`, the list of those specs, keeps its place on RunRecord.) `valid` is null until the
   * run got past the validate phase; `passed` is null when valid is unknown or the cases cannot be tied to the specs.
   */
  specCounts: z.object({ generated: z.number().int().min(0), valid: z.number().int().min(0).nullable(), passed: z.number().int().min(0).nullable() }),
  /* "pr" | "issue" | "shadow-log" | "quarantine" | "none"; null for a run that recorded none. */
  decision: z.string().nullable(),
  budgets: z.object({ exhausted: z.boolean(), limit: z.string().optional(), role: z.string().optional() }),
  /* Present only for a run that belongs to a campaign. */
  campaign: z.object({ id: z.string(), variant: z.record(z.string(), z.string()), replicate: z.number().int().min(1) }).optional(),
  effectiveConfig: EffectiveConfigSchema,
});

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type AppView = z.infer<typeof AppViewSchema>;
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
export type ChatEntry = z.infer<typeof ChatEntrySchema>;
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export type TelemetryHealthView = z.infer<typeof TelemetryHealthSchema>;
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
export type LoginBootstrapResult = z.infer<typeof LoginBootstrapResultSchema>;
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
      /* null means "not measured" (the value-oracle never ran or reported no count) — distinct
       * from a genuine measured zero. Never a fabricated 0. */
      mutantCount: z.number().int().nonnegative().nullable(),
      killedCount: z.number().int().nonnegative().nullable(),
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
  /* null when the app has no curriculum yet OR its stored row is corrupt; curriculumCorrupt tells the two apart. */
  curriculum: CurriculumViewSchema.nullable(),
  /* true when a curriculum row exists but cannot be parsed. Renderers must show it as corrupt (the row is kept for repair, never silently reset), never as "no curriculum yet". */
  curriculumCorrupt: z.boolean(),
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

/** ── Architecture map (`e2e/.qa/context.json`) — the FE<->BE map a mode:context run produces,
 * persisted in the context_maps SQLite store and exposed read-only. Wire mirror of qa-engine's
 * port-local ArchitectureContext (generation-ports.ts / qa-run-orchestration ports/index.ts) —
 * same no-cross-context-import precedent as those two, now also mirrored at the contract boundary. */
export const ArchitectureRouteSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  component: z.string().optional(),
  source: z.string().optional(),
  /** Repo-relative paths of the files a change to the route's page would touch. */
  implementationFiles: z.array(z.string()).optional(),
});

export const ArchitectureApiOperationSchema = z.object({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  service: z.string().optional(),
  spec: z.string().optional(),
});

export const ArchitectureFeBeLinkSchema = z.object({
  route: z.string(),
  operationId: z.string(),
  via: z.string().optional(),
});

export const ArchitectureFlowSchema = z.object({
  id: z.string(),
  routes: z.array(z.string()),
  operations: z.array(z.string()).optional(),
});

export const ArchitectureContextSchema = z.object({
  builtAtSha: z.string(),
  routes: z.array(ArchitectureRouteSchema),
  api: z.array(ArchitectureApiOperationSchema),
  feBe: z.array(ArchitectureFeBeLinkSchema),
  flows: z.array(ArchitectureFlowSchema).optional(),
});

export const ContextMapViewSchema = z.object({
  app: z.string(),
  map: ArchitectureContextSchema,
  builtAtSha: z.string(),
  updatedAt: z.string(),
});

export type ContextMapView = z.infer<typeof ContextMapViewSchema>;

export type RunReportView = z.infer<typeof RunReportViewSchema>;

const nullableCount = z.number().int().nonnegative().nullable();

/** What a turn spent over every step it finished; the turn's own tokens and cost fields are those of its last assistant message alone. */
export const TurnUsageViewSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
});

/** One call of a turn's tool sequence: the tool, what it pointed at (null when it pointed at nothing), the path a search ran in, the part of the file a read asked for (absent for the whole file), and whether the runtime refused it. */
export const ToolSequenceEntryViewSchema = z.object({
  tool: z.string(),
  target: z.string().nullable(),
  scope: z.string().optional(),
  window: z.string().optional(),
  denied: z.literal(true).optional(),
});

/** ── Agent turns (GET /runs/:id/turns) ─────────────────────────────────────────────── One prompt/response cycle of one agent role. The efficiency fields (from totalCalls down) are measurements of what the agent did that turn; every one is null when the runtime cannot supply it or the turn was recorded before they existed — never a fabricated zero/false. exhausted null means unknown, false means known not exhausted. callBuckets counts calls per fine bucket (code_read, code_graph, browser, write, validate_run, script_run, memory, subagent, other); counts only, never paths or targets. ended says how the turn ended (completed, exhausted, timeout, aborted); null for a turn recorded before it was kept or by a runtime that does not say. A turn that ended by timeout or abort has empty outputText and only the calls measured up to its end. durationMs is the turn's wall time; timeToFirstCallMs and timeToFirstWriteMs count from when the turn started (null when it made no call / wrote nothing); deniedCallCount counts the calls the runtime refused under a permission rule (null, never 0, when the turn was not measured); toolSequence lists the turn's calls in order, each with the redacted, capped file, pattern, url or command it pointed at (never what it typed or wrote). usageTotal sums the tokens and cost of every step the turn finished, which the tokens and cost fields above (the last assistant message's alone) do not; null when the steps were not all observed or none finished. */
export const AgentTurnViewSchema = z.object({
  runId: z.string().nullable(),
  sessionId: z.string(),
  role: z.string(),
  round: z.number().int().nonnegative(),
  isRepair: z.boolean(),
  ts: z.string(),
  objective: z.string().nullable(),
  promptText: z.string(),
  outputText: z.string(),
  promptBytes: z.number().int().nonnegative(),
  tokensInput: z.number().nullable(),
  tokensOutput: z.number().nullable(),
  tokensReasoning: z.number().nullable(),
  tokensCacheRead: z.number().nullable(),
  tokensCacheWrite: z.number().nullable(),
  cost: z.number().nullable(),
  totalCalls: nullableCount,
  stepsUsed: nullableCount,
  maxSteps: nullableCount,
  callsBeforeFirstWrite: nullableCount,
  writeCount: nullableCount,
  redundantReadCount: nullableCount,
  sameFileReadCount: nullableCount,
  duplicateCallCount: nullableCount,
  promptProvidedReadCount: nullableCount,
  pathProvidedReadCount: nullableCount,
  graphProvidedReadCount: nullableCount,
  exhausted: z.boolean().nullable(),
  callBuckets: z.record(z.string(), z.number()).nullable(),
  ended: z.enum(TURN_ENDS).nullable(),
  durationMs: nullableCount,
  timeToFirstCallMs: nullableCount,
  timeToFirstWriteMs: nullableCount,
  deniedCallCount: nullableCount,
  toolSequence: z.array(ToolSequenceEntryViewSchema).nullable(),
  usageTotal: TurnUsageViewSchema.nullable(),
});

export type AgentTurnView = z.infer<typeof AgentTurnViewSchema>;

export const TelemetryRoleStatSchema = z.object({
  role: z.string(),
  medianPromptBytes: z.number().nullable(),
  p95PromptBytes: z.number().nullable(),
  medianCacheHitRate: z.number().nullable(),
  turnCount: z.number().int().nonnegative(),
});

/** Aggregates over the turns' persisted efficiency measurements; turns a runtime could not measure are left out of every figure, never counted as zero. */
export const TelemetryEfficiencySchema = z.object({
  turnsMeasured: z.number().int().nonnegative(),
  medianCallsBeforeFirstWrite: z.number().nullable(),
  exhaustedRate: z.number().nullable(),
  redundantReadRatio: z.number().nullable(),
  duplicateRatio: z.number().nullable(),
});

/** ── App telemetry (GET /apps/:name/telemetry) ─────────────────────────────────────── Prompt-size, grounding, repair and wall-clock aggregates over the app's agent turns, plus the agent-efficiency aggregates. */
export const AppTelemetryViewSchema = z.object({
  app: z.string(),
  generatedAt: z.string(),
  windowDays: z.number().int().nullable(),
  runCount: z.number().int().nonnegative(),
  byRole: z.array(TelemetryRoleStatSchema),
  reviewerConvergence: z.object({
    avgCorrectionsRound0: z.number().nullable(),
    avgCorrectionsRound1: z.number().nullable(),
    approveRate: z.number().nullable(),
  }),
  groundingPresence: z.number().nullable(),
  repairFraction: z.number().nullable(),
  medianTurnsPerRun: z.number().nullable(),
  medianWallClockSec: z.number().nullable(),
  p95WallClockSec: z.number().nullable(),
  efficiency: TelemetryEfficiencySchema,
});

export type AppTelemetryView = z.infer<typeof AppTelemetryViewSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type RunEvaluation = z.infer<typeof RunEvaluationSchema>;
export type EvaluationCatalog = z.infer<typeof EvaluationCatalogSchema>;
export type RegradeRequest = z.infer<typeof RegradeRequestSchema>;
export type RegradeStarted = z.infer<typeof RegradeStartedSchema>;
export type RegradeJob = z.infer<typeof RegradeJobSchema>;
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;
export type CampaignRuns = z.infer<typeof CampaignRunsSchema>;
export type CampaignInput = z.infer<typeof CampaignInputSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;

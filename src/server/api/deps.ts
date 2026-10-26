/* The dependencies the control API is built over. Every one is injected, so the routes are unit-tested over stubs with no fs or network. */

import type { z } from "zod";
import type { TelemetryBackendsHealth, TelemetryHealth } from "../../telemetry/telemetry-health";
import type { CampaignIdentity } from "../../contract/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import type { RunMode, TestTarget, RunRecord } from "../../types";
import type { AppConfig } from "../../orchestrator/config-loader";
import type { CreateAppInput as AdminCreateAppInput, CreateAppResult, UpdateAppInput as AdminUpdateAppInput } from "../app-admin";
import type {
  AgentModelInfo,
  AgentProvider,
  AgentProviderHealthSchema,
  PublicAgentConfig,
  OnboardingJobStatusSchema,
  ProposeBoundariesInputSchema,
  IntelligenceViewSchema,
  ContextMapViewSchema,
  SignalsViewSchema,
  CoordinationEventsViewSchema,
  TrendsViewSchema,
  ReportViewSchema,
  RunReportViewSchema,
  TelemetryHealthView,
  GroundingInput,
} from "../../contract/commands";
import type { RunEventStore } from "../run-events";
import type { AgentTurnRecord } from "../persistence/repositories/telemetry.repository";
import type { TelemetryAnalysis } from "../persistence/telemetry-analysis.query";
import type { EvaluationService } from "../evaluation-service";
import type { RunViewExtras } from "../run-view";

/*
 * Outcome of exchanging a GitHub user token for a server session: a minted session on
 * success, or a tagged failure the route maps to 401 (bad token) vs 403 (not a collaborator).
 */
export type LoginOutcome =
  | { ok: true; token: string; username: string; expiresAt: string }
  | { ok: false; reason: "identity" | "forbidden" };

/* What a run request adds for the evaluation side: the campaign replicate it is, and the content capture it asks for (the funnel caps it). Neither changes what the run does. */
export interface RunObservabilityRequest {
  campaign?: CampaignIdentity;
  captureMode?: CaptureMode;
}

export interface ApiDeps {
  queue: { readonly size: number };
  enqueue(app: string, sha: string, target: TestTarget, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number, triggerRepo?: string, baseSha?: string, closedLoop?: boolean, agentBrowser?: boolean, observability?: RunObservabilityRequest, grounding?: GroundingInput): string;
  loadApp(name: string): AppConfig;  /* throws AppNotFoundError when the app has no config and AppConfigInvalidError when its config cannot be loaded */
  listApps(): AppConfig[];
  resolveRef(repo: string, ref: string): Promise<string>;
  getRecord(id: string): RunRecord | undefined;
  listRecords(app: string, limit: number): RunRecord[];
  currentRun(): RunRecord | undefined;
  /*
   * Read-only intelligence projection (learning ledger + oracle scorecard + curriculum)
   * for an app. Absent ⇒ the /intelligence route returns 501.
   */
  intelligence?: (app: string) => z.infer<typeof IntelligenceViewSchema>;
  /*
   * Read-only FE<->BE architecture map (context.json) persisted from the app's last successful
   * mode:context run. Absent ⇒ the route returns 501; null ⇒ 404 (no stored map yet).
   */
  contextMap?: (app: string) => z.infer<typeof ContextMapViewSchema> | null;
  /*
   * Read-only fleet-wide integrity readout (ground-truth value-oracle vs. proxy pass-rate).
   * Absent ⇒ the /signals route returns 501.
   */
  signals?: () => z.infer<typeof SignalsViewSchema>;
  /* The telemetry stack's health, for GET /telemetry/health and the /health summary. Absent ⇒ the route returns 501 and /health omits the summary. */
  telemetryHealth?: () => TelemetryHealth;
  /* Host health (suspends, blocked loops, event-loop p99, sandbox zombies), merged into GET /telemetry/health as `host`. */
  hostHealth?: () => NonNullable<TelemetryHealthView["host"]>;
  /* Loki, Tempo and the collectors verified end to end (src/telemetry/backend-health.ts). `get` probes when its cache is stale; `peek` never waits. */
  backendHealth?: { get(): Promise<TelemetryBackendsHealth | undefined>; peek(): TelemetryBackendsHealth | undefined };
  /* Read-only multi-agent coordination audit tail. Absent ⇒ the route returns 501. */
  coordinationEvents?: (filter?: { runId?: string; limit?: number }) => z.infer<typeof CoordinationEventsViewSchema>;
  /*
   * Read-only period-over-period trends + the ad-hoc interestingness-ranked report for an app.
   * Absent ⇒ the /trends and /report routes return 501.
   */
  trends?: (app: string, window?: number) => z.infer<typeof TrendsViewSchema>;
  report?: (app: string, window?: number) => z.infer<typeof ReportViewSchema>;
  /*
   * The run-scoped report: the current-execution analysis plus the evolution-as-of-the-run, for the
   * post-run summary view. Outer null ⇒ 404 (no such run); `evolution` null ⇒ not enough history yet.
   */
  reportForRun?: (runId: string, window?: number) => z.infer<typeof RunReportViewSchema> | null;
  ask?: (input: { context: string; question: string; instruction?: string }) => Promise<string>;
  cancelRun?: (id: string) => boolean;
  /*
   * Continuation (human-in-the-loop): re-run fixing the parent run's failed cases. `depth` counts the continuations the
   * parent already is, `maxDepth` caps the chain, and `enqueue` starts the run ("" while shutting down). Absent ⇒ the route returns 501.
   */
  continuation?: {
    readonly maxDepth: number;
    depth(parent: RunRecord): number;
    enqueue(request: { parent: RunRecord; fixCases: RunRecord["cases"]; guidance?: string }): string;
  };
  /* App onboarding/deletion. Absent ⇒ the corresponding routes return 501. */
  createApp?: (input: AdminCreateAppInput) => Promise<CreateAppResult>;
  updateApp?: (input: AdminUpdateAppInput) => Promise<CreateAppResult>;
  deleteApp?: (name: string, purge: boolean) => { removed: string[] };
  listRepos?: (owner: string, page: number) => Promise<{ repos: Array<{ fullName: string; private: boolean; description: string | null }>; hasMore: boolean }>;
  runEvents?: RunEventStore;

  /*
   * Enqueues the run that authors the app's login and proves it (purpose login-bootstrap) at an explicit sha, and returns its
   * run id ("" while shutting down). Absent ⇒ the login-bootstrap route returns 501.
   */
  bootstrapLogin?: (app: string, sha: string) => string;

  boundaries?: {
    propose(app: string, input: z.infer<typeof ProposeBoundariesInputSchema>): { ok: true } | { ok: false; error: string } | Promise<{ ok: true } | { ok: false; error: string }>;
    status(app: string): z.infer<typeof OnboardingJobStatusSchema>;
    confirm(app: string): { ok: true } | { ok: false; error: string };
  };

  getAgentTurns?: (runId: string) => AgentTurnRecord[];

  /* What GET /runs/:id adds to the record (trace, phases, usage, spec counts, decision, budgets). Undefined return: no such run. Absent: the answer is the plain record. */
  runExtras?: (runId: string) => RunViewExtras | undefined;
  /* The evaluation context (scores, catalog, regrade). Absent: those routes answer 501. */
  evaluation?: EvaluationService;

  telemetryAnalysis?: (app: string, windowDays?: number) => TelemetryAnalysis;
  /*
   * Cadence (ms) of the SSE durable-poll loop in handleRunEvents. Injected so tests can drive
   * the poll fast; production uses DEFAULT_SSE_POLL_MS.
   */
  ssePollMs?: number;
  /*
   * Exchange a GitHub user token for a server session (POST /api/auth/login). Absent ⇒ the
   * route returns 501 (GitHub login not configured); the static QA_API_TOKEN still works.
   */
  login?: (githubToken: string) => Promise<LoginOutcome>;
  /*
   * Same-origin web-console bootstrap (GET /api/auth/local). Returns a minted session, or
   * null when this request is not trusted (not loopback / QA_WEB_AUTO_LOGIN off, or the Host
   * header names a non-loopback, non-allowlisted hostname — the DNS-rebinding check). Absent
   * or null ⇒ 404 — the capability is not advertised, and QA_API_TOKEN is never returned.
   */
  localLogin?: (remoteAddress: string, host: string | undefined) => { token: string; username: string; expiresAt: string } | null;
  /*
   * The OAuth App client id (public) advertised in the version handshake, so the console can run
   * the device flow without baking it in. Absent ⇒ not advertised (client falls back to its own).
   */
  githubClientId?: string;
  agentRuntime?: {
    getConfig(): PublicAgentConfig | Promise<PublicAgentConfig>;
    applyConfig(input: unknown): { config: PublicAgentConfig; restarted: AgentProvider[] } | Promise<{ config: PublicAgentConfig; restarted: AgentProvider[] }>;
    listModels(provider: AgentProvider): AgentModelInfo[] | Promise<AgentModelInfo[]>;
    restart(provider: AgentProvider): Promise<z.infer<typeof AgentProviderHealthSchema>> | z.infer<typeof AgentProviderHealthSchema>;
    hasOpenSessions?(): boolean;
  };
}

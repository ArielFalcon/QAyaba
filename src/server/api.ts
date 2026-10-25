/*
 * REST control API for the interactive layer (bin/qa) and any future operator
 * surface. It NEVER does git writes directly: it only enqueues runs on the same
 * sequential queue the webhook uses, and reads the in-memory run history. Every
 * dependency (config, ref resolution, history, queue) is injected via ApiDeps, so
 * the routing + validation logic is unit-tested with stubs — no fs or network.
 */

import { describeSandboxHealth } from "./sandbox-health";
import type { TelemetryBackendsHealth, TelemetryHealth } from "@kernel/telemetry/telemetry-health";
import { CAMPAIGN_ID_PATTERN, type CampaignIdentity } from "@kernel/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { RUN_MODES, RunMode, TestTarget, RunRecord, engineStatus } from "../types";
import { AppConfig, AppConfigInvalidError, AppNotFoundError } from "../orchestrator/config-loader";
import { sanitizeText, RedactionPortAdapter } from "../orchestrator/sanitizer";
import { buildRunContext, buildLearningContext, buildRunChatContext } from "./chat";
import { buildHelpContext } from "./help";
import { json, readBody } from "./helpers";
import { getOpenSessionCount, activityRouter } from "../integrations/opencode-client";
import type { CreateAppInput as AdminCreateAppInput, CreateAppResult, UpdateAppInput as AdminUpdateAppInput } from "./app-admin";
import {
  AgentConfigApplyResultSchema,
  AgentConfigUpdateSchema,
  AgentModelInfo,
  AgentModelsResponseSchema,
  AgentProvider,
  AgentProviderHealthSchema,
  AgentProviderSchema,
  AgentRestartRequestSchema,
  AgentRestartResponseSchema,
  AppViewSchema,
  AskResponseSchema,
  ContinueResultSchema,
  CreateAppInputSchema,
  CreateAppResultSchema,
  CreateRunResultSchema,
  CampaignInputSchema,
  CampaignRunsSchema,
  CaptureModeSchema,
  LoginBootstrapResultSchema,
  DeleteAppResultSchema,
  PublicAgentConfig,
  PublicAgentConfigSchema,
  QueueStatusSchema,
  RepoListResponseSchema,
  RunRecordSchema,
  OnboardingJobStatusSchema,
  ProposeBoundariesInputSchema,
  ConfirmBoundariesInputSchema,
  IntelligenceViewSchema,
  ContextMapViewSchema,
  AgentTurnViewSchema,
  AppTelemetryViewSchema,
  SignalsViewSchema,
  CoordinationEventsViewSchema,
  TrendsViewSchema,
  ReportViewSchema,
  RunReportViewSchema,
  UpdateAppInputSchema,
  VersionInfoSchema,
  TelemetryHealthSchema,
  type TelemetryHealthView,
  RunDetailSchema,
  RunEvaluationSchema,
  EvaluationCatalogSchema,
  RegradeRequestSchema,
  RegradeStartedSchema,
  RegradeJobSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  GroundingInputSchema,
  type GroundingInput,
} from "../contract/commands";
import { RunEventSchema, type RunEvent } from "../contract/events";
import { handshake } from "./version";
import { reportToCsv, trendsToCsv } from "./report-view";
import type { RunEventStore } from "./run-events";
import type { AgentTurnRecord, TelemetryAnalysis } from "./history";
import { CampaignCaptureMismatchError } from "./campaign-capture";
import { RegradeRequestError } from "@contexts/evaluation/application/regrade.use-case";
import type { EvaluationService } from "./evaluation-service";
import type { RunViewExtras } from "./run-view";

const TARGETS: TestTarget[] = ["e2e", "code"];


const redactionPort = new RedactionPortAdapter();

/*
 * SSE durable-poll cadence: how often an open run-event stream re-reads the durable store
 * for events produced out-of-process and re-checks the record for a terminal state. Small
 * enough to feel live, large enough not to hammer SQLite per open connection.
 */
const DEFAULT_SSE_POLL_MS = 1000;

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
   * Continuation (human-in-the-loop): re-run fixing the parent run's failed cases.
   * `cases` optionally narrows to specific failed case names; omitted → all failed.
   */
  continueRun?: (parentId: string, cases: string[] | undefined, guidance?: string) => string;
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

function contractJson(res: ServerResponse, status: number, schema: z.ZodTypeAny, body: unknown): void {
  const result = schema.safeParse(body);
  if (!result.success) {
    /*
     * Surface the drift loudly (AGENTS.md invariant) — a silent 500 hides a real
     * schema mismatch between the handler and the contract.
     */
    console.error("[contract] response validation failed:", result.error.issues);
    json(res, 500, { error: "contract response validation failed" });
    return;
  }
  json(res, status, result.data);
}

/* An error body of the public contract: schemaVersion first, on every status. */
function apiError(res: ServerResponse, status: number, error: string): void {
  json(res, status, { schemaVersion: 1, error });
}

/*
 * The one place a route loads the app it is about. An app with no config answers 404; an app whose config cannot be loaded
 * answers 422 with the reason (the operator can fix it, and "not found" would send them to onboard an app that exists). Any other
 * failure is not about the app and propagates. Returns what `run` returns, or undefined once the response has been written.
 */
function withApp<T>(res: ServerResponse, deps: ApiDeps, name: string, run: (app: AppConfig) => T): T | undefined {
  let app: AppConfig;
  try {
    app = deps.loadApp(name);
  } catch (err) {
    if (err instanceof AppNotFoundError) {
      apiError(res, 404, `app not found: '${name}'`);
      return undefined;
    }
    if (err instanceof AppConfigInvalidError) {
      apiError(res, 422, redactionPort.redactError(err));
      return undefined;
    }
    throw err;
  }
  return run(app);
}

function sseWrite(res: ServerResponse, event: unknown): void {
  /*
   * Guard the write-after-close race: the bus is synchronous, so an event emitted
   * as the socket closes can reach here after the stream already ended.
   */
  if (res.writableEnded) return;
  const result = RunEventSchema.safeParse(event);
  if (!result.success) {
    console.error("[sse] dropped malformed RunEvent:", result.error.issues);
    return;
  }
  const parsed = result.data;
  res.write(`id: ${parsed.seq}\n`);
  res.write(`event: ${parsed.body.type}\n`);
  res.write(`data: ${JSON.stringify(parsed)}\n\n`);
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return -1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

/* Returns true when the request matched an /api route (so the caller stops here). */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/^\/api\/v1(?=\/|$)/, "/api");

  if (req.method === "POST" && path === "/api/runs") {
    return handleCreateRun(req, res, deps);
  }

  const evaluationMatch = path.match(/^\/api\/runs\/([^/]+)\/evaluation$/);
  if (req.method === "GET" && evaluationMatch) {
    return handleRunEvaluation(res, deps, evaluationMatch[1]!, url.searchParams.get("versions"));
  }
  if (req.method === "GET" && path === "/api/evaluations/catalog") {
    return handleEvaluationCatalog(res, deps);
  }
  if (req.method === "POST" && path === "/api/evaluations/regrade") {
    return await handleRegrade(req, res, deps);
  }
  const regradeJobMatch = path.match(/^\/api\/evaluations\/regrade\/([^/]+)$/);
  if (req.method === "GET" && regradeJobMatch) {
    return handleRegradeJob(res, deps, regradeJobMatch[1]!);
  }

  const campaignMatch = path.match(/^\/api\/campaigns\/([^/]+)\/runs$/);
  if (req.method === "GET" && campaignMatch) {
    let campaignId: string;
    try {
      campaignId = decodeURIComponent(campaignMatch[1]!);
    } catch {
      apiError(res, 400, "the campaign id is not valid URL encoding");
      return true;
    }
    if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
      apiError(res, 400, "the campaign id must be 1-100 characters of A-Z a-z 0-9 _ . : -");
      return true;
    }
    return handleCampaignRuns(res, deps, campaignId, url.searchParams);
  }

  const eventMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventMatch) {
    return handleRunEvents(req, res, deps, eventMatch[1]!);
  }


  const turnsMatch = path.match(/^\/api\/runs\/([^/]+)\/turns$/);
  if (req.method === "GET" && turnsMatch) {
    return handleRunTurns(res, deps, turnsMatch[1]!);
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    return handleGetRun(res, deps, runMatch[1]!);
  }
  if (req.method === "DELETE" && runMatch) {
    return handleCancelRun(res, deps, runMatch[1]!);
  }

  if (req.method === "GET" && path === "/api/runs") {
    return handleListRuns(res, deps, url.searchParams.get("app"), Number(url.searchParams.get("limit")) || 10);
  }

  const appMatch = path.match(/^\/api\/apps\/([^/]+)$/);
  if (req.method === "POST" && path === "/api/apps") {
    return await handleCreateApp(req, res, deps);
  }
  if (req.method === "PUT" && appMatch) {
    return await handleUpdateApp(req, res, deps, appMatch[1]!);
  }
  if (req.method === "DELETE" && appMatch) {
    return handleDeleteApp(res, deps, appMatch[1]!, url.searchParams.get("purge") === "1");
  }
  if (req.method === "GET" && appMatch) {
    return handleGetApp(res, deps, appMatch[1]!);
  }

  const boundaryProposeMatch = path.match(/^\/api\/apps\/([^/]+)\/boundaries\/propose$/);
  if (req.method === "POST" && boundaryProposeMatch) {
    return await handleProposeBoundaries(req, res, deps, boundaryProposeMatch[1]!);
  }
  const boundaryStatusMatch = path.match(/^\/api\/apps\/([^/]+)\/boundaries\/propose\/status$/);
  if (req.method === "GET" && boundaryStatusMatch) {
    return handleBoundaryStatus(res, deps, boundaryStatusMatch[1]!);
  }
  const boundaryConfirmMatch = path.match(/^\/api\/apps\/([^/]+)\/boundaries\/confirm$/);
  if (req.method === "POST" && boundaryConfirmMatch) {
    return await handleConfirmBoundaries(req, res, deps, boundaryConfirmMatch[1]!);
  }

  const loginBootstrapMatch = path.match(/^\/api\/apps\/([^/]+)\/login-bootstrap$/);
  if (req.method === "POST" && loginBootstrapMatch) {
    return await handleLoginBootstrap(res, deps, loginBootstrapMatch[1]!);
  }

  const intelMatch = path.match(/^\/api\/apps\/([^/]+)\/intelligence$/);
  if (req.method === "GET" && intelMatch) {
    return handleAppIntelligence(res, deps, intelMatch[1]!);
  }

  const contextMapMatch = path.match(/^\/api\/apps\/([^/]+)\/context-map$/);
  if (req.method === "GET" && contextMapMatch) {
    return handleContextMap(res, deps, contextMapMatch[1]!);
  }

  const trendsMatch = path.match(/^\/api\/apps\/([^/]+)\/trends$/);
  if (req.method === "GET" && trendsMatch) {
    return handleAppTrends(res, deps, trendsMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }


  const telemetryMatch = path.match(/^\/api\/apps\/([^/]+)\/telemetry$/);
  if (req.method === "GET" && telemetryMatch) {
    return handleAppTelemetry(res, deps, telemetryMatch[1]!, parseWindow(url.searchParams.get("window")));
  }

  const reportMatch = path.match(/^\/api\/apps\/([^/]+)\/report$/);
  if (req.method === "GET" && reportMatch) {
    return handleAppReport(res, deps, reportMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }

  const runReportMatch = path.match(/^\/api\/runs\/([^/]+)\/report$/);
  if (req.method === "GET" && runReportMatch) {
    return handleRunReport(res, deps, runReportMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }

  if (req.method === "GET" && path === "/api/signals") {
    return handleSignals(res, deps);
  }

  const coordinationMatch = path.match(/^\/api\/coordination-events$/);
  if (req.method === "GET" && coordinationMatch) {
    return handleCoordinationEvents(res, deps, url.searchParams.get("runId") ?? undefined, parseLimit(url.searchParams.get("limit")));
  }

  if (req.method === "GET" && path === "/api/apps") {
    return handleListApps(res, deps);
  }

  if (req.method === "GET" && path === "/api/repos") {
    return await handleListRepos(res, deps, url.searchParams.get("owner"), Number(url.searchParams.get("page")) || 1);
  }

  if (req.method === "GET" && path === "/api/queue") {
    return handleQueue(res, deps);
  }

  if (req.method === "GET" && path === "/api/health") {
    /* Still 200 when the sandbox is degraded: the container stays up for the operator to read why. */
    const sandbox = describeSandboxHealth(process.env);
    /* Public route: a flag and a count each, never an endpoint or an error text. */
    const telemetry = deps.telemetryHealth?.();
    /* A degraded store never fails the route (the container stays up); it is a flag, with the reasons on the authenticated route. */
    let backends: TelemetryBackendsHealth | undefined;
    try {
      backends = deps.backendHealth?.peek();
    } catch {
      backends = undefined;
    }
    json(res, 200, {
      ok: true,
      openSessions: getOpenSessionCount(),
      sandbox,
      ...(telemetry ? { telemetry: { mode: telemetry.mode, ledgerOk: telemetry.ledger.ok, otlpConfigured: telemetry.otlp.configured, ...(backends ? { backendsOk: backends.ok } : {}) } } : {}),
    });
    return true;
  }

  if (req.method === "GET" && path === "/api/telemetry/health") {
    if (!deps.telemetryHealth) {
      json(res, 501, { schemaVersion: 1, error: "telemetry is not configured" });
      return true;
    }
    let host: TelemetryHealthView["host"];
    try {
      host = deps.hostHealth?.();
    } catch (err) {
      console.error(`[api] host health unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let backends: TelemetryBackendsHealth | undefined;
    try {
      backends = await deps.backendHealth?.get();
    } catch (err) {
      console.error(`[api] backend health unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    contractJson(res, 200, TelemetryHealthSchema, { schemaVersion: 1, ...deps.telemetryHealth(), ...(backends ? { backends } : {}), ...(host ? { host } : {}) });
    return true;
  }

  if (req.method === "GET" && path === "/api/version") {
    contractJson(res, 200, VersionInfoSchema, handshake(url.searchParams.get("client") ?? undefined, deps.githubClientId));
    return true;
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    return await handleLogin(req, res, deps);
  }

  if (req.method === "GET" && path === "/api/auth/local") {
    return handleLocalLogin(req, res, deps);
  }

  if (req.method === "GET" && path === "/api/agent/config") {
    return await handleGetAgentConfig(res, deps);
  }
  if (req.method === "PUT" && path === "/api/agent/config") {
    return await handlePutAgentConfig(req, res, deps);
  }
  if (req.method === "GET" && path === "/api/agent/models") {
    return await handleAgentModels(res, deps, url.searchParams.get("provider"));
  }
  if (req.method === "POST" && path === "/api/agent/restart") {
    return await handleAgentRestart(req, res, deps);
  }

  const askMatch = path.match(/^\/api\/runs\/([^/]+)\/ask$/);
  if (req.method === "POST" && askMatch) {
    return await handleAsk(req, res, deps, askMatch[1]!);
  }

  const continueMatch = path.match(/^\/api\/runs\/([^/]+)\/continue$/);
  if (req.method === "POST" && continueMatch) {
    return await handleContinue(req, res, deps, continueMatch[1]!);
  }

  if (req.method === "POST" && path === "/api/help") {
    return await handleHelp(req, res, deps);
  }

  return false;
}

async function handleCreateRun(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, "invalid JSON");
    return true;
  }

  const appName = typeof body.app === "string" ? body.app : null;
  if (!appName) {
    apiError(res, 400, "'app' is required (config/apps/<app>.yaml name)");
    return true;
  }

  const appConfig = withApp(res, deps, appName, (app) => app);
  if (!appConfig) return true;

  const target: TestTarget =
    typeof body.target === "string" && (TARGETS as string[]).includes(body.target)
      ? (body.target as TestTarget)
      : appConfig.code
        ? "code"  /* default to code mode for code-mode apps */
        : "e2e";
  const mode: RunMode =
    typeof body.mode === "string" && (RUN_MODES as readonly string[]).includes(body.mode) ? (body.mode as RunMode) : "diff";
  const guidance = typeof body.guidance === "string" ? body.guidance.slice(0, 2000) : undefined;
  const shadow = typeof body.shadow === "boolean" ? body.shadow : undefined;
  const commits =
    typeof body.commits === "number" && Number.isInteger(body.commits) && body.commits >= 1 && body.commits <= 20
      ? body.commits
      : undefined;

  let sha: string;
  if (typeof body.sha === "string" && /^[0-9a-f]{7,40}$/i.test(body.sha)) {
    sha = body.sha;
  } else if (typeof body.sha === "string" && body.sha.length > 0) {
    apiError(res, 400, "'sha' must be 7–40 hex characters");
    return true;
  } else {
    /*
     * Neither a sha nor an explicit ref: default to the app's base branch HEAD. This
     * is the TUI "launch" path (pick target/mode/shadow, no commit) — run the latest
     * of the configured branch. resolveRef uses `git ls-remote`, so no mirror is
     * required yet (works on the very first run).
     */
    const ref = typeof body.ref === "string" && body.ref.length > 0 ? body.ref : (appConfig.baseBranch ?? "main");
    try {
      sha = await deps.resolveRef(appConfig.repo, ref);
    } catch (err) {
      apiError(res, 400, redactionPort.redactError(err));
      return true;
    }
  }

  /* Range start for a diff run (the diff spans baseSha..sha), validated like the sha: it reaches git as an argument. */
  let baseSha: string | undefined;
  if (typeof body.baseSha === "string" && body.baseSha.length > 0) {
    if (!/^[0-9a-f]{7,40}$/i.test(body.baseSha)) {
      apiError(res, 400, "'baseSha' must be 7–40 hex characters");
      return true;
    }
    baseSha = body.baseSha;
  }

  if (body.closedLoop !== undefined && typeof body.closedLoop !== "boolean") {
    apiError(res, 400, "'closedLoop' must be a boolean");
    return true;
  }
  const closedLoop = typeof body.closedLoop === "boolean" ? body.closedLoop : undefined;

  if (body.agentBrowser !== undefined && typeof body.agentBrowser !== "boolean") {
    apiError(res, 400, "'agentBrowser' must be a boolean");
    return true;
  }
  const agentBrowser = typeof body.agentBrowser === "boolean" ? body.agentBrowser : undefined;

  let campaign: CampaignIdentity | undefined;
  if (body.campaign !== undefined) {
    const parsed = CampaignInputSchema.safeParse(body.campaign);
    if (!parsed.success) {
      apiError(res, 400, `'campaign' is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      return true;
    }
    campaign = parsed.data;
  }
  let captureMode: CaptureMode | undefined;
  if (body.captureMode !== undefined) {
    const parsed = CaptureModeSchema.safeParse(body.captureMode);
    if (!parsed.success) {
      apiError(res, 400, "'captureMode' must be \"off\", \"metadata\" or \"full\"");
      return true;
    }
    captureMode = parsed.data;
  }
  let grounding: GroundingInput | undefined;
  if (body.grounding !== undefined) {
    const parsed = GroundingInputSchema.safeParse(body.grounding);
    if (!parsed.success) {
      apiError(res, 400, `'grounding' is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      return true;
    }
    grounding = parsed.data;
  }
  const observability: RunObservabilityRequest = { ...(campaign ? { campaign } : {}), ...(captureMode ? { captureMode } : {}) };

  let id: string;
  try {
    id = deps.enqueue(appConfig.name, sha, target, mode, guidance, shadow, commits, undefined, baseSha, closedLoop, agentBrowser, observability, grounding);
  } catch (err) {
    if (err instanceof CampaignCaptureMismatchError) {
      apiError(res, 409, err.message);
      return true;
    }
    apiError(res, 500, `failed to enqueue run: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  if (!id) {
    apiError(res, 503, "service shutting down");
    return true;
  }
  contractJson(res, 202, CreateRunResultSchema, { schemaVersion: 1, id, app: appConfig.name, sha, target, mode, status: "enqueued" });
  return true;
}

/*
 * Sanitize a RunRecord before it leaves the system: logs, case details and the note can
 * carry DEV data or a secret the agent echoed. Same egress invariant the chat/Issue paths
 * already honor (AGENTS.md "Sanitize data leaving the system").
 */
function sanitizeRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    /*
     * Derive the run status on egress (never stored): present once a verdict exists, absent while the
     * run is still in-flight (a running run is not an "error"). Lets REST consumers read success vs
     * error directly instead of re-deriving from the verdict.
     */
    ...(record.verdict ? { engineStatus: engineStatus(record.verdict) } : {}),
    note: record.note ? sanitizeText(record.note).text : record.note,
    logs: record.logs.map((l) => sanitizeText(l).text),
    cases: record.cases.map((c) => {
      /*
       * Omit `detail` entirely when absent. A DB-backed record yields detail:null (history stores
       * `c.detail ?? null`), but the contract is z.string().optional() (string|undefined, NOT null),
       * so passing null through here 500s the run-status API. Strip it (and sanitize when present).
       */
      const { detail, networkErrors, ...rest } = c;
      /* A network error's URL and text are DEV data too: sanitize them on egress, not only by value at harvest. */
      const safeNetworkErrors = networkErrors?.map((e) => ({
        ...e,
        url: sanitizeText(e.url).text,
        ...(e.errorText !== undefined ? { errorText: sanitizeText(e.errorText).text } : {}),
        ...(e.resourceType !== undefined ? { resourceType: sanitizeText(e.resourceType).text } : {}),
      }));
      return {
        ...rest,
        ...(detail ? { detail: sanitizeText(detail).text } : {}),
        ...(safeNetworkErrors ? { networkErrors: safeNetworkErrors } : {}),
      };
    }),
    activity: record.activity?.map((a) => ({ ...a, text: sanitizeText(a.text).text })),
  };
}

function handleGetRun(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  const record = deps.getRecord(id);
  if (!record) {
    apiError(res, 404, `run not found: ${id}`);
    return true;
  }
  const extras = deps.runExtras?.(id);
  if (extras) {
    contractJson(res, 200, RunDetailSchema, { schemaVersion: 1, ...sanitizeRecord(record), ...extras });
  } else {
    contractJson(res, 200, RunRecordSchema.extend({ schemaVersion: z.literal(1) }), { schemaVersion: 1, ...sanitizeRecord(record) });
  }
  return true;
}

function handleRunEvaluation(res: ServerResponse, deps: ApiDeps, id: string, versions: string | null): boolean {
  if (!deps.evaluation) {
    apiError(res, 501, "evaluation is not configured");
    return true;
  }
  if (versions !== null && versions !== "all") {
    apiError(res, 400, "'versions' must be \"all\" or absent");
    return true;
  }
  const view = deps.evaluation.evaluation(id, versions === "all");
  if (!view) {
    apiError(res, 404, `run not found: ${id}`);
    return true;
  }
  contractJson(res, 200, RunEvaluationSchema, { schemaVersion: 1, ...view });
  return true;
}

/* GET /campaigns/:id/runs?variant.<k>=<v>: the campaign's runs, narrowed to those carrying every label named in the query. */
function handleCampaignRuns(res: ServerResponse, deps: ApiDeps, campaignId: string, query: URLSearchParams): boolean {
  if (!deps.evaluation) {
    apiError(res, 501, "evaluation is not configured");
    return true;
  }
  const filter: Record<string, string> = {};
  for (const [name, value] of query) {
    if (!name.startsWith("variant.")) {
      apiError(res, 400, `unknown query parameter '${name}': only 'variant.<key>=<value>' filters are accepted`);
      return true;
    }
    const key = name.slice("variant.".length);
    if (key === "" || Object.hasOwn(filter, key)) {
      apiError(res, 400, key === "" ? "a variant filter needs a key: variant.<key>=<value>" : `variant filter '${key}' is given more than once`);
      return true;
    }
    filter[key] = value;
  }
  contractJson(res, 200, CampaignRunsSchema, { schemaVersion: 1, ...deps.evaluation.campaignRuns(campaignId, filter) });
  return true;
}

function handleEvaluationCatalog(res: ServerResponse, deps: ApiDeps): boolean {
  if (!deps.evaluation) {
    apiError(res, 501, "evaluation is not configured");
    return true;
  }
  contractJson(res, 200, EvaluationCatalogSchema, { schemaVersion: 1, ...deps.evaluation.catalog() });
  return true;
}

async function handleRegrade(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.evaluation) {
    apiError(res, 501, "evaluation is not configured");
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    apiError(res, 400, "invalid JSON");
    return true;
  }
  const parsed = RegradeRequestSchema.safeParse(body);
  if (!parsed.success) {
    apiError(res, 400, parsed.error.issues.map((i) => i.message).join("; "));
    return true;
  }
  const { runIds, campaignId, since, graders } = parsed.data;
  const g = graders ? { graders } : {};
  try {
    const started = deps.evaluation.startRegrade(runIds ? { runIds, ...g } : campaignId ? { campaignId, ...g } : { since: since!, ...g });
    contractJson(res, 202, RegradeStartedSchema, { schemaVersion: 1, ...started });
  } catch (err) {
    if (err instanceof RegradeRequestError) apiError(res, 400, err.message);
    else apiError(res, 500, `failed to start the regrade: ${redactionPort.redactError(err)}`);
  }
  return true;
}

function handleRegradeJob(res: ServerResponse, deps: ApiDeps, jobId: string): boolean {
  if (!deps.evaluation) {
    apiError(res, 501, "evaluation is not configured");
    return true;
  }
  const job = deps.evaluation.regradeJob(jobId);
  if (!job) {
    apiError(res, 404, `regrade job not found: ${jobId}`);
    return true;
  }
  contractJson(res, 200, RegradeJobSchema, { schemaVersion: 1, ...job });
  return true;
}

function handleRunEvents(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.runEvents) {
    json(res, 501, { error: "run event stream is not available" });
    return true;
  }
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  const runEvents = deps.runEvents;  /* narrowed past the 501 guard; stable for the closures below */

  /*
   * Track the high-water seq streamed so the durable poll never re-sends an event the live
   * bus already delivered (and vice-versa).
   */
  let lastSentSeq = parseLastEventId(req);
  const send = (event: RunEvent): void => {
    sseWrite(res, event);
    if (event.seq > lastSentSeq) lastSentSeq = event.seq;
  };

  for (const event of runEvents.replay(id, lastSentSeq)) send(event);

  /*
   * A terminated run emits nothing more: replay, then close so the client stops
   * waiting on a stream that will never produce another event.
   */
  if (record.status === "done") {
    res.end();
    return true;
  }

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => {};
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  /* Live tail for a run executing IN THIS process: the in-process bus delivers each publish. */
  unsubscribe = runEvents.subscribe(id, (event) => {
    send(event);
    /*
     * run.verdict is terminal — close the stream once the run finishes so the
     * connection (and its bus listener) is not held open indefinitely.
     */
    if (event.body.type === "run.verdict") finish();
  });

  /*
   * Durable poll — the robustness net. The bus above only sees SAME-PROCESS publishes, so a
   * run produced by another process (e.g. the CLI's own queue) would otherwise stream nothing
   * and never close. Each tick (a) flushes events persisted since lastSentSeq — surfacing an
   * out-of-process run's progress through the shared store — then (b) ends the stream once the
   * record is terminal, so a missed/absent run.verdict can never leave the connection hanging.
   */
  const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;
  timer = setInterval(() => {
    if (closed) return;
    for (const event of runEvents.replay(id, lastSentSeq)) send(event);
    /*
     * Close only on an EXPLICIT terminal record. getRecord is durable (SQLite), so a missing
     * record mid-stream is anomalous — treating it as terminal could drop a healthy stream, so
     * we don't; the run record reaching "done" is the single close trigger here.
     */
    if (deps.getRecord(id)?.status === "done") finish();
  }, pollMs);
  timer.unref?.();

  /*
   * Client disconnect → tear everything down. The write-after-close race is also guarded
   * centrally in sseWrite (writableEnded), so a late event is a no-op.
   */
  req.on("close", () => finish());
  return true;
}


function handleRunTurns(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.getAgentTurns) {
    json(res, 501, { error: "agent turns are not available" });
    return true;
  }
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }
  /*
   * Defensive egress sanitization, matching sanitizeRecord on the sibling run-read endpoints.
   * prompt_text embeds the live-DEV domSnapshot and is persisted RAW (output_text is sanitized at
   * capture, but re-sanitizing is idempotent and keeps the egress pass uniform across both fields).
   */
  const turns = deps.getAgentTurns(id).map((t) => ({
    ...t,
    promptText: sanitizeText(t.promptText).text,
    outputText: sanitizeText(t.outputText).text,
  }));
  contractJson(res, 200, z.array(AgentTurnViewSchema), turns);
  return true;
}

function handleCancelRun(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.cancelRun) {
    json(res, 501, { error: "cancel is not available" });
    return true;
  }

  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  if (record.status !== "running" && record.status !== "enqueued") {
    json(res, 409, { error: `run ${id} is not running (status: ${record.status})` });
    return true;
  }

  const cancelled = deps.cancelRun(id);
  if (cancelled) {
    json(res, 200, { id, status: "cancelled" });
  } else if (deps.getRecord(id)?.status === "done") {
    /*
     * cancelRun returned false but finalized the record: it was either still enqueued (pulled
     * from the queue before it could start) or a stale "running" record the live queue no longer
     * held (finalized so the operator's stop clears it). Either way it is no longer active.
     */
    json(res, 200, { id, status: "cancelled", message: "run was not actively executing — finalized and removed from the queue" });
  } else {
    /*
     * Running per the (stale) record, but it is no longer the run holding the queue —
     * it already finished or a successor is now executing. Do NOT report it cancelled.
     */
    json(res, 409, { id, status: "running", message: "run is no longer the active run (it finished or a successor is now running)" });
  }
  return true;
}

function handleListRuns(res: ServerResponse, deps: ApiDeps, app: string | null | undefined, limit: number): boolean {
  if (!app) {
    json(res, 400, { error: "?app=<name> query parameter is required" });
    return true;
  }
  contractJson(res, 200, z.array(RunRecordSchema), deps.listRecords(app, limit).map(sanitizeRecord));
  return true;
}

function appView(app: AppConfig): { name: string; repo: string; baseUrl: string; versionUrl: string; code: boolean; shadow: boolean; needsReview: boolean; testDataPrefix: string; services: Array<{ repo: string; openapi?: string; versionUrl?: string }>; authKind?: "form" | "mtls" } {
  /* Code-mode apps have no dev environment (and no baseUrl). */
  return {
    name: app.name,
    repo: app.repo,
    baseUrl: app.dev?.baseUrl ?? "",
    versionUrl: app.dev?.versionUrl ?? "",
    code: app.code ?? false,
    shadow: app.qa.shadow ?? false,
    needsReview: app.qa.needsReview,
    testDataPrefix: app.qa.testDataPrefix,
    services: (app.services ?? []).map((s) => ({
      repo: s.repo,
      openapi: typeof s.openapi === "string" ? s.openapi : s.openapi?.[0],
      versionUrl: s.versionUrl,
    })),
    ...(app.auth ? { authKind: app.auth.kind } : {}),
  };
}

function handleGetApp(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  withApp(res, deps, name, (app) => contractJson(res, 200, AppViewSchema, appView(app)));
  return true;
}

function handleAppIntelligence(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  if (!deps.intelligence) {
    json(res, 501, { error: "intelligence is not available" });
    return true;
  }
  const { intelligence } = deps;
  withApp(res, deps, name, () => contractJson(res, 200, IntelligenceViewSchema, intelligence(name)));
  return true;
}

function handleContextMap(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  if (!deps.contextMap) {
    json(res, 501, { error: "context map is not available" });
    return true;
  }
  if (!withApp(res, deps, name, () => true)) return true;
  const view = deps.contextMap(name);
  if (!view) {
    json(res, 404, { error: `no stored architecture map for app '${name}'` });
    return true;
  }
  contractJson(res, 200, ContextMapViewSchema, view);
  return true;
}

function handleSignals(res: ServerResponse, deps: ApiDeps): boolean {
  if (!deps.signals) {
    json(res, 501, { error: "signals is not available" });
    return true;
  }
  try {
    contractJson(res, 200, SignalsViewSchema, deps.signals());
  } catch (err) {
    /* A ledger read failure (e.g. permission error) is a real fault, not an empty-fleet view — surface it loudly instead of hanging the request or fabricating zeros. */
    json(res, 500, { error: `signals query failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return true;
}

function handleCoordinationEvents(res: ServerResponse, deps: ApiDeps, runId: string | undefined, limit: number | undefined): boolean {
  if (!deps.coordinationEvents) {
    json(res, 501, { error: "coordinationEvents is not available" });
    return true;
  }
  try {
    contractJson(res, 200, CoordinationEventsViewSchema, deps.coordinationEvents({ runId, limit }));
  } catch (err) {
    json(res, 500, { error: `coordination-events query failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return true;
}

/*
 * Parses "?limit=" defensively: absent/invalid falls back to the view's default (200), values
 * beyond the schema cap (1000) are clamped by the reader itself.
 */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
/*
 * A client-supplied trends window (?window=N), clamped to [1,50] — listRunOutcomes caps the read at
 * 100 rows, so the current + previous windows (window*2) must stay within it. Invalid/absent →
 * undefined (the view falls back to its default of 20).
 */
function parseWindow(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, 50);
}

function handleAppTrends(
  res: ServerResponse,
  deps: ApiDeps,
  name: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.trends) {
    json(res, 501, { error: "trends is not available" });
    return true;
  }
  if (!withApp(res, deps, name, () => true)) return true;
  const trends = deps.trends(name, window);
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(trendsToCsv(trends));
    return true;
  }
  contractJson(res, 200, TrendsViewSchema, trends);
  return true;
}

function handleAppReport(
  res: ServerResponse,
  deps: ApiDeps,
  name: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.report) {
    json(res, 501, { error: "report is not available" });
    return true;
  }
  if (!withApp(res, deps, name, () => true)) return true;
  const report = deps.report(name, window);
  /*
   * ?format=csv → a spreadsheet-friendly flat table (one row per insight); default stays the
   * contract-validated JSON ReportView.
   */
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(reportToCsv(report));
    return true;
  }
  contractJson(res, 200, ReportViewSchema, report);
  return true;
}

function handleRunReport(
  res: ServerResponse,
  deps: ApiDeps,
  runId: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.reportForRun) {
    json(res, 501, { error: "report is not available" });
    return true;
  }
  const report = deps.reportForRun(runId, window);
  if (!report) {
    json(res, 404, { error: `run not found: '${runId}'` });
    return true;
  }
  /*
   * CSV exports the run's OWN facts (the current-execution report); the evolution half belongs to a
   * chart, not a flat table, and the app-level /report?format=csv already exports the trend table.
   */
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(reportToCsv(report.current));
    return true;
  }
  contractJson(res, 200, RunReportViewSchema, report);
  return true;
}


function handleAppTelemetry(res: ServerResponse, deps: ApiDeps, name: string, window?: number): boolean {
  if (!deps.telemetryAnalysis) {
    json(res, 501, { error: "telemetry analysis is not available" });
    return true;
  }
  if (!withApp(res, deps, name, () => true)) return true;
  try {
    const analysis = deps.telemetryAnalysis(name, window);
    contractJson(res, 200, AppTelemetryViewSchema, analysis);
  } catch (err) {
    json(res, 500, { error: `telemetry query failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return true;
}

function handleListApps(res: ServerResponse, deps: ApiDeps): boolean {
  const apps: Array<{ name: string; repo: string; baseUrl: string; shadow: boolean }> = [];
  for (const app of deps.listApps()) {
    try {
      apps.push(appView(app));
    } catch {
      /* A single malformed config should not hide every other app. */
    }
  }
  contractJson(res, 200, z.array(AppViewSchema), apps);
  return true;
}

function handleQueue(res: ServerResponse, deps: ApiDeps): boolean {
  const running = deps.currentRun();
  contractJson(res, 200, QueueStatusSchema, {
    pending: deps.queue.size,
    running: running ? { id: running.id, app: running.app } : null,
  });
  return true;
}

async function handleGetAgentConfig(res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  try {
    contractJson(res, 200, PublicAgentConfigSchema, await deps.agentRuntime.getConfig());
  } catch (err) {
    json(res, 502, { error: `agent runtime failed: ${redactionPort.redactError(err)}` });
  }
  return true;
}

async function handlePutAgentConfig(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  if (isAgentRuntimeBusy(deps)) {
    json(res, 409, { error: "agent runtime cannot be changed while a run or agent session is active" });
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = AgentConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid agent runtime config", issues: parsed.error.issues });
    return true;
  }

  try {
    const result = await deps.agentRuntime.applyConfig(parsed.data);
    contractJson(res, 200, AgentConfigApplyResultSchema, result);
  } catch (err) {
    const message = redactionPort.redactError(err);
    json(res, runtimeStatusFromErrorMessage(message), { error: message });
  }
  return true;
}

async function handleAgentModels(res: ServerResponse, deps: ApiDeps, rawProvider: string | null): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  const provider = AgentProviderSchema.safeParse(rawProvider);
  if (!provider.success) {
    json(res, 400, { error: "?provider=opencode is required" });
    return true;
  }
  try {
    const models = await deps.agentRuntime.listModels(provider.data);
    contractJson(res, 200, AgentModelsResponseSchema, { provider: provider.data, models });
  } catch (err) {
    json(res, 502, { error: `failed to list agent models: ${redactionPort.redactError(err)}` });
  }
  return true;
}

async function handleAgentRestart(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  if (isAgentRuntimeBusy(deps)) {
    json(res, 409, { error: "agent runtime cannot be restarted while a run or agent session is active" });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = AgentRestartRequestSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid restart request", issues: parsed.error.issues });
    return true;
  }
  try {
    const health = await deps.agentRuntime.restart(parsed.data.provider);
    contractJson(res, 200, AgentRestartResponseSchema, { health });
  } catch (err) {
    json(res, 502, { error: `failed to restart agent provider: ${redactionPort.redactError(err)}` });
  }
  return true;
}

function isAgentRuntimeBusy(deps: ApiDeps): boolean {
  const run = deps.currentRun();
  return run?.status === "running" || run?.status === "enqueued" || deps.agentRuntime?.hasOpenSessions?.() === true;
}

function runtimeStatusFromErrorMessage(message: string): number {
  if (message.includes("active") || message.includes("session")) return 409;
  if (message.includes("model") || message.includes("API_KEY") || message.includes("required") || message.includes("invalid")) return 422;
  return 502;
}

async function handleAsk(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<boolean> {
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  if (!deps.ask) {
    json(res, 501, { error: "ask is not available" });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    json(res, 400, { error: "'question' is required" });
    return true;
  }
  /* Truncate to prevent context window exhaustion */
  const MAX_QUESTION_LEN = 4000;
  if (question.length > MAX_QUESTION_LEN) {
    question = question.substring(0, MAX_QUESTION_LEN) + " [truncated]";
  }

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        historyLines.push(`${entry.role === "q" ? "Operator" : "Assistant"}: ${String((entry as { text: unknown }).text)}`);
      }
    }
  }

  try {
    /* Load app config so the assistant knows what repo is being tested and where. */
    let appInfo: { repo: string; baseUrl?: string } | undefined;
    try {
      const cfg = deps.loadApp(record.app);
      appInfo = { repo: cfg.repo, baseUrl: cfg.dev?.baseUrl };
    } catch { /* app not configured — proceed without */ }

    /* Context is bounded (cases + logs capped) and sanitized on ingress (secrets redacted). */
    const activityCtx = activityRouter.contextForRun(record.id);
    const learningCtx = buildLearningContext(record.app);
    const runCtx = buildRunContext(record, undefined, appInfo, activityCtx || undefined, learningCtx || undefined);
    const productCtx = buildRunChatContext();
    const historyCtx = historyLines.length > 0 ? `\n\nRecent conversation:\n${historyLines.slice(-6).join("\n")}` : "";
    const answer = await deps.ask({ context: `${productCtx}\n\n---\n\n${runCtx}${historyCtx}`, question });
    /* Sanitize on egress (logs→chat is a new egress path). */
    contractJson(res, 200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `assistant failed: ${msg}` });
  }
  return true;
}

async function handleHelp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.ask) {
    json(res, 501, { error: "help chat is not available (ask not wired)" });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    json(res, 400, { error: "'question' is required" });
    return true;
  }

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        const role = String((entry as { role: unknown }).role);
        const text = String((entry as { text: unknown }).text);
        historyLines.push(`${role}: ${text}`);
      }
    }
  }

  const productContext = buildHelpContext();
  let fullContext = productContext;
  if (historyLines.length > 0) {
    fullContext += `\n\n## Recent conversation\n${historyLines.slice(-10).join("\n")}`;
  }

  try {
    const answer = await deps.ask({
      context: fullContext,
      question,
      instruction:
        "You are a helpful assistant answering questions about qayaba (the TUI for qayaba). " +
        "Use ONLY the context below. " +
        "TERMINAL-FRIENDLY FORMATTING (this renders in a TUI via Ink <Text>): " +
        "allowed: blank lines, indentation, capitalized headers (RESUMEN, USO), " +
        "plain text lists with '-', '───' separators between topics. " +
        "forbidden: **bold**, `code`, # headings, code fences, emojis, HTML. " +
        "Respond in the SAME language as the question. Be concise. " +
        "If the context lacks the answer, say so and suggest what to ask instead.",
    });
    contractJson(res, 200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `assistant failed: ${msg}` });
  }
  return true;
}

/*
 * Exchange a GitHub user token (obtained by the client via the OAuth device flow) for a
 * short-lived server session. The deps.login closure does the GitHub verification + repo
 * authorization + session minting; this handler is pure validation + status mapping:
 * 400 malformed, 401 bad/unknown GitHub token, 403 authenticated-but-not-a-collaborator.
 */
async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.login) {
    json(res, 501, { error: "GitHub login is not configured on this server" });
    return true;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  const parsed = LoginRequestSchema.safeParse(raw);
  if (!parsed.success) {
    json(res, 400, { error: "'githubToken' is required" });
    return true;
  }

  try {
    const outcome = await deps.login(parsed.data.githubToken);
    if (outcome.ok) {
      contractJson(res, 200, LoginResponseSchema, {
        token: outcome.token,
        username: outcome.username,
        expiresAt: outcome.expiresAt,
      });
    } else if (outcome.reason === "forbidden") {
      json(res, 403, { error: "this GitHub account cannot push to any watched repo" });
    } else {
      json(res, 401, { error: "the GitHub token was rejected" });
    }
  } catch (err) {
    /*
     * A GitHub API outage is infra, not a credential problem — surface it loudly, don't
     * masquerade it as a 401 (which would send the operator chasing a non-existent token bug).
     */
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `GitHub login failed: ${msg}` });
  }
  return true;
}

function handleLocalLogin(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): boolean {
  if (!deps.localLogin) {
    json(res, 404, { error: "local console login is not available" });
    return true;
  }
  const remoteAddress = req.socket?.remoteAddress ?? "";
  const outcome = deps.localLogin(remoteAddress, req.headers.host);
  if (!outcome) {
    json(res, 404, { error: "local console login is not available" });
    return true;
  }
  contractJson(res, 200, LoginResponseSchema, outcome);
  return true;
}

/*
 * Continuation: re-run the parent's FAILED cases with optional human guidance. The
 * data model (parentRunId/fixCases) and pipeline support this; this is the HTTP entry
 * the TUI's `continue` command calls.
 */
async function handleContinue(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, parentId: string): Promise<boolean> {
  const parent = deps.getRecord(parentId);
  if (!parent) {
    json(res, 404, { error: `run not found: ${parentId}` });
    return true;
  }
  if (!deps.continueRun) {
    json(res, 501, { error: "continue is not available" });
    return true;
  }
  if (parent.status !== "done") {
    json(res, 409, { error: `run ${parentId} is not finished yet (status: ${parent.status})` });
    return true;
  }
  const failedNames = new Set(parent.cases.filter((c) => c.status === "fail").map((c) => c.name));
  if (failedNames.size === 0) {
    json(res, 409, { error: `run ${parentId} has no failed cases to continue` });
    return true;
  }

  /* Optional body: { cases?: string[], guidance?: string }. */
  let cases: string[] | undefined;
  let guidance: string | undefined;
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      guidance = typeof body.guidance === "string" ? body.guidance.slice(0, 2000) : undefined;
      if (Array.isArray(body.cases)) cases = body.cases.filter((c): c is string => typeof c === "string");
    }
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  /*
   * If specific cases were requested, they must name actual failed cases of the parent
   * (otherwise the continuation would have nothing to fix).
   */
  if (cases && cases.length > 0) {
    const unknown = cases.filter((c) => !failedNames.has(c));
    if (unknown.length > 0) {
      json(res, 409, { error: `not failed cases of ${parentId}: ${unknown.join(", ")}` });
      return true;
    }
  }

  const id = deps.continueRun(parentId, cases, guidance);
  if (!id) {
    json(res, 503, { error: "service shutting down" });
    return true;
  }
  contractJson(res, 202, ContinueResultSchema, { id, parentRunId: parentId, app: parent.app, sha: parent.sha, status: "enqueued" });
  return true;
}

async function handleCreateApp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.createApp) {
    json(res, 501, { error: "app onboarding is not available" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = CreateAppInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid app create input", issues: parsed.error.issues });
    return true;
  }
  if (!parsed.data.repo.includes("/")) {
    json(res, 400, { error: "'repo' is required in 'org/name' form" });
    return true;
  }
  try {
    const result = await deps.createApp(parsed.data as AdminCreateAppInput);
    if (!result.ok) {
      json(res, 422, { errors: result.errors ?? ["invalid app config"] });
      return true;
    }
    /* env VALUES never travel back; CreateAppResult only carries the key names. */
    contractJson(res, parsed.data.dryRun || parsed.data.validateOnly ? 200 : 201, CreateAppResultSchema, result);
  } catch (err) {
    json(res, 500, { error: redactionPort.redactError(err) });
  }
  return true;
}

async function handleUpdateApp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, name: string): Promise<boolean> {
  if (!deps.updateApp) {
    json(res, 501, { error: "app update is not available" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = UpdateAppInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid app update input", issues: parsed.error.issues });
    return true;
  }
  try {
    const result = await deps.updateApp({ ...parsed.data, name } as AdminUpdateAppInput);
    if (!result.ok) {
      json(res, 422, { errors: result.errors ?? ["invalid app config"] });
      return true;
    }
    contractJson(res, 200, CreateAppResultSchema, result);
  } catch (err) {
    json(res, 500, { error: redactionPort.redactError(err) });
  }
  return true;
}

function handleDeleteApp(res: ServerResponse, deps: ApiDeps, name: string, purge: boolean): boolean {
  if (!deps.deleteApp) {
    json(res, 501, { error: "app deletion is not available" });
    return true;
  }
  try {
    contractJson(res, 200, DeleteAppResultSchema, deps.deleteApp(name, purge));
  } catch (err) {
    const msg = redactionPort.redactError(err);
    json(res, err instanceof AppNotFoundError ? 404 : err instanceof AppConfigInvalidError ? 422 : 500, { error: msg });
  }
  return true;
}


/*
 * The run that establishes and proves an app's login. Only a form login is authored (a client certificate needs no login script,
 * a public app no login, a code app no browser), so anything else is a 409 rather than a run that could only fail.
 */
async function handleLoginBootstrap(res: ServerResponse, deps: ApiDeps, name: string): Promise<boolean> {
  if (!deps.bootstrapLogin) {
    json(res, 501, { error: "login bootstrap is not available" });
    return true;
  }
  const appConfig = withApp(res, deps, name, (app) => app);
  if (!appConfig) return true;
  if (appConfig.code === true || appConfig.auth?.kind !== "form") {
    json(res, 409, { error: `app '${name}' declares no form login to bootstrap` });
    return true;
  }
  let sha: string;
  try {
    sha = await deps.resolveRef(appConfig.repo, appConfig.baseBranch ?? "main");
  } catch (err) {
    json(res, 400, { error: redactionPort.redactError(err) });
    return true;
  }
  let id: string;
  try {
    id = deps.bootstrapLogin(appConfig.name, sha);
  } catch (err) {
    json(res, 500, { error: `failed to enqueue the login run: ${err instanceof Error ? err.message : String(err)}` });
    return true;
  }
  if (!id) {
    json(res, 503, { error: "service shutting down" });
    return true;
  }
  contractJson(res, 202, LoginBootstrapResultSchema, { id, app: appConfig.name, sha, status: "enqueued" });
  return true;
}

async function handleProposeBoundaries(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, name: string): Promise<boolean> {
  if (!deps.boundaries) {
    json(res, 501, { error: "boundary-profile onboarding is not available" });
    return true;
  }
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = ProposeBoundariesInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid propose-boundaries input", issues: parsed.error.issues });
    return true;
  }
  /*
   * propose() rejects the mutex SYNCHRONOUSLY (a plain {ok:false} object, not a promise) — see
   * onboarding-job.ts's own contract. Only that synchronous shape can be inspected here; an
   * ACCEPTED kickoff returns a Promise the handler deliberately never awaits (fire-and-forget)
   * — any error surfacing later only shows up on the next status() poll.
   */
  const result = deps.boundaries.propose(name, parsed.data);
  if (!(result instanceof Promise) && !result.ok) {
    json(res, 409, { error: result.error });
    return true;
  }
  contractJson(res, 202, OnboardingJobStatusSchema, deps.boundaries.status(name));
  return true;
}

function handleBoundaryStatus(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  if (!deps.boundaries) {
    json(res, 501, { error: "boundary-profile onboarding is not available" });
    return true;
  }
  contractJson(res, 200, OnboardingJobStatusSchema, deps.boundaries.status(name));
  return true;
}

async function handleConfirmBoundaries(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, name: string): Promise<boolean> {
  if (!deps.boundaries) {
    json(res, 501, { error: "boundary-profile onboarding is not available" });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = ConfirmBoundariesInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid confirm-boundaries input", issues: parsed.error.issues });
    return true;
  }
  const result = deps.boundaries.confirm(name);
  if (!result.ok) {
    json(res, 422, { error: result.error });
    return true;
  }
  contractJson(res, 200, CreateAppResultSchema, { ok: true });
  return true;
}

async function handleListRepos(res: ServerResponse, deps: ApiDeps, owner: string | null, page: number): Promise<boolean> {
  if (!owner) {
    json(res, 400, { error: "'owner' query parameter is required (e.g. /api/repos?owner=arielyumn)" });
    return true;
  }
  if (!deps.listRepos) {
    json(res, 501, { error: "repo listing is not available" });
    return true;
  }
  try {
    const result = await deps.listRepos(owner, page);
    contractJson(res, 200, RepoListResponseSchema, result);
  } catch (err) {
    const msg = redactionPort.redactError(err);
    const status = msg.includes("not found") || msg.includes("no repos found") ? 404
      : msg.includes("token") || msg.includes("GITHUB_TOKEN") ? 401
      : 500;
    json(res, status, { error: msg });
  }
  return true;
}

/*
 * Control plane: webhook + sequential queue + HTTP API. One run at a time against DEV.
 */

import { PendingChangeSets } from "./server/pending-change-sets";
import { createServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { qayabaDataDir, qayabaRoot } from "./paths";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { JobQueue } from "./server/queue";
import { handleWebhook } from "./server/webhook";
import { describeAppLoadFailure, loadAppConfig, listAppConfigs } from "./orchestrator/config-loader";

import { YamlAppConfigAdapter } from "../qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter";
import { resolveWebhookDispatch, type WebhookDispatch } from "./server/webhook-routing";
import { handleApi, ApiDeps, type RunObservabilityRequest } from "./server/api";
import { authorizeBearer, createLocalConsoleLogin, issueSession, isPublicControlPlaneRoute } from "./server/auth";
import { verifyGithubIdentity, authorizeUser } from "./server/github-auth";
import { createFixedWindowLimiter } from "./server/rate-limit";
import { loadIntelligenceView } from "./server/intelligence-view";
import { toSignalsView } from "./server/signals-view";
import { readRecentCoordinationEvents, toCoordinationSignals } from "./server/coordination-events";
import { toTrendsView } from "./server/trends-view";
import { toReportView } from "./server/report-view";
import { toRunReportView } from "./server/run-report-view";
import { createDurableRunEventStore } from "./server/durable-run-events";
import { serveDashboard, resolveDashboardDir } from "./server/static";
import { handleMaintainerApi, recordIncident, getMaintainerStatus, getIncidents } from "./server/maintainer";
import { getRecord, listRecords, currentRun, continuationDepth, MAX_CONTINUATION_DEPTH, getRunFacts } from "./server/history";
import { createEvaluationService } from "./server/evaluation-service";
import { composeJudges } from "./server/judges-composition";
import { LangfuseScoreSink, resolveLangfuseConfig, scoreSinkHealthOf } from "./telemetry/langfuse-score-sink";
import { ScoreMetricsSink, composeScoreSinks } from "./telemetry/score-metrics-sink";
import { guardRequestHandler, guardResponse } from "./server/guarded-handler";
import { hashStaticPrompts, type RunConfigEnvironment } from "./server/effective-config";
import { resolveTelemetryConfig } from "./telemetry/config";
import { resolveReflectorEnabled } from "./server/reflector-switch";
import { resolveCampaignFreeze } from "./server/campaign-freeze";
import { buildRunViewExtras, defaultRunViewDeps } from "./server/run-view";
import { enqueueTrackedRun, enqueueContextMapRun, enqueueLoginBootstrapRun, cancelTrackedRun, finalizeInterruptedRuns, type RunnerDeps } from "./server/runner";
import { codeGraphFor } from "./server/engine-root";
import { appAuthDir, appSuiteStoreDir, createRunEngineFactory, resolveCodeSandbox } from "./server/run-engine-factory";
import type { ContextHealRunRequest } from "@contexts/run-orchestration/application/index";
import { egressGateFor } from "./server/egress-wiring";
import { SandboxedBinaryRunnerAdapter } from "../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";
import { deleteSuiteStoreDir } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
import { pruneMirrors, defaultMirrorPruneDeps, getDirectorySize } from "./server/mirror-prune";
import { buildArtifactBytesMetrics, type ArtifactSizeCache } from "./server/metrics";
import { createMaintainerRuntime } from "./server/maintainer-runtime";
import { installHttpDispatcher } from "./util/net";
import { resolveRef, defaultMirrorDeps, ensureMirrorAtBranch, getHeadSha } from "./integrations/repo-mirror";
import { askAssistant, AgentDeps, getOpenSessionCount, defaultAgentDeps, setAgentBrowserGrantLookup, setCodeGraphGrantLookup, setGeolocationGrantLookup } from "./integrations/opencode-client";
import { createAgentRuntimeManager, logAgentConfigWarnings } from "./server/agent-runtime";
import { keyPresence, retiredSelectorWarnings, validateAgentRuntimeConfig } from "./agent-runtime/config";
import { OpenCodeRuntimeStrategy } from "./agent-runtime";
import { appendLog, appendActivity, deleteAppHistory, runVerdictCounts } from "./server/history";
import { getHistoryDatabase } from "./server/persistence/index";
import { pruneHistory, retentionPolicyFrom } from "./server/persistence/retention";
import { backupDatabase } from "./server/persistence/backup";
import { type RunMode, type TestTarget } from "./types";
import { github } from "./integrations/github";
import { createApp as adminCreateApp, updateApp as adminUpdateApp, deleteApp as adminDeleteApp, type AppAdminDeps } from "./server/app-admin";
import { writeConfig, configExists } from "./server/onboard";
import { applyEnvVars, defaultEnvStoreFs } from "./server/env-store";
import { logJson } from "./integrations/logger";
import { createOnboardingJob, type RepoIndexOutcome } from "./server/onboarding/onboarding-job";
import { LlmProfileProposerAdapter, PROPOSER_MODEL } from "./server/onboarding/llm-profile-proposer.adapter";
import { OnboardingService } from "@contexts/service-topology/application/index";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory";

import { RedactionPortAdapter } from "./orchestrator/sanitizer";
import { processTelemetry, TELEMETRY_SHUTDOWN_TIMEOUT_MS } from "./telemetry/process-telemetry";
import { HostHealth } from "./telemetry/host-health";
import { BackendHealthMonitor, resolveBackendHealthConfig, systemBackendFetch } from "./telemetry/backend-health";
import { resolveSandbox } from "../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { resolvePort, resolveListenHost, describeListenAddress, serverErrorListener } from "./server/port";
import { createToolsServer, resolveToolsListenHost, resolveToolsPort, resolveToolsToken } from "./server/tools-endpoint";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry";
import { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry";
import { GeolocationRegistry } from "@contexts/agent-tools/infrastructure/geolocation-registry";
import { CodeGraphToolRegistry } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry";
import { FsDelegationWorkspaceAdapter } from "@contexts/coordination/infrastructure/adapters/delegation-workspace.adapter";
import { DELEGATIONS_DIR } from "./paths";
import { workdirRoot } from "./integrations/repo-mirror";
import { sweepOrphanAgentBrowsers } from "../qa-engine/src/shared-infrastructure/process-sandbox/orphan-browser-sweep";
import { buildScriptExec, execWorkRoot } from "./server/exec-sandbox-factory";
import { resolveApiToken } from "./server/api-token";
import { shouldLogApiRequest } from "./server/api-request-log";
import { suiteHoldsVerifiedLoginFor } from "./server/login-bootstrap-wiring";
import { contextMapNeedsRebuildFor } from "./server/context-map-wiring";
import { getHistory } from "./server/persistence/index";

const SELF_REPO = process.env.QAYABA_REPO ?? "ArielFalcon/qayaba";
const ROOT = qayabaRoot();

const appCatalog = new YamlAppConfigAdapter({ load: loadAppConfig, list: listAppConfigs });

const redactionPort = new RedactionPortAdapter();
/*
 * Telemetry is built once, here, before anything that could emit (QA_TELEMETRY=off|local; a mistyped value stops the boot).
 * The engine factory takes `telemetry.telemetry` as a dep; the API reports `telemetry.health()`.
 */
const telemetry = processTelemetry();
/* Process-wide host health (suspends, blocked loops, sandbox zombies): runs with no run active and is stopped on shutdown. Fail-open and unref'd. */
const sandboxIdentity = resolveSandbox(process.env);
const queue = new JobQueue((e) => {
  console.error("[qa] run failed:", e);
  /*
   * Incidents are recorded by the runner (with infra-vs-code classification).
   * This handler only fires for truly unhandled rejections that escape the job's
   * own catch — duplicates there would create maintainer noise for infra blips.
   */
});

/* Scores and regrade jobs. Grading is scheduled off the queue by the runner's post-run hook; a regrade job left open by a previous process ends failed at boot. */
/* The Langfuse mirror of the scores: built only when LANGFUSE_BASE_URL and both keys are set (docker-compose.langfuse.yml). Fail-open: stored scores never depend on it. */
const langfuseConfig = resolveLangfuseConfig(process.env);
const langfuseSink = langfuseConfig
  ? new LangfuseScoreSink({ config: langfuseConfig, traceIdOf: (runId) => getRunFacts(runId)?.traceId ?? null, sanitize: (text) => redactionPort.redact(text) })
  : undefined;
/*
 * The LLM judges (docs/observability-design.md section 11.3): off unless QA_JUDGES_ENABLED=true. They run as low-priority work on the same
 * sequential queue, so never beside a run, and only for a campaign run or a regrade that names a judge. They never gate anything.
 */
const judges = composeJudges({ env: process.env, root: ROOT, queue, mirrorsRoot: workdirRoot() });
/* The score metrics sink makes the grades visible in Grafana; the Langfuse mirror stays optional and human-facing. */
const scoreMetricsSink = new ScoreMetricsSink({
  telemetry: telemetry.telemetry,
  appOf: (runId) => getRecord(runId)?.app,
  verdictOf: (runId) => getHistory().learning.getRunOutcome(runId)?.verdict ?? getRecord(runId)?.verdict,
});
const evaluation = createEvaluationService({
  judges: judges.service,
  sink: composeScoreSinks([scoreMetricsSink, ...(langfuseSink ? [langfuseSink] : [])]),
});
/* Hands a finished run to the deterministic graders and, for a campaign run, to the judges' low-priority job. Neither blocks the queue. */
const afterRun = (runId: string): void => {
  evaluation.scheduleGrading(runId);
  judges.service.scheduleForRun(runId);
};
evaluation.recoverInterrupted();
/* Score configs are ensured in the background at boot; the sink also retries before its first score. */
void langfuseSink?.ensureScoreConfigs();
const runViewDeps = defaultRunViewDeps(() => telemetry.health().mode !== "off");
const hostHealth = new HostHealth({ telemetry: telemetry.telemetry, ...(sandboxIdentity ? { sandboxUid: sandboxIdentity.uid } : {}) });
hostHealth.start();
/* Loki, Tempo and the collectors verified end to end; off with telemetry. Probe addresses come from QA_TELEMETRY_*_URL(S). */
const backendHealth = telemetry.health().mode === "off" ? undefined : new BackendHealthMonitor({ config: resolveBackendHealthConfig(process.env), fetch: systemBackendFetch, now: () => Date.now() });
/*
 * Durable backing lives in createDurableRunEventStore, shared with the CLI so every
 * trigger persists events identically: the live SSE stream survives a restart (e.g. the
 * maintainer hot-swap's process.exit) and eviction from the in-memory ring.
 */
const runEvents = createDurableRunEventStore();
/*
 * The maintainer's autonomous merge+hot-swap is OFF by default. Opt-in with
 * SELF_MAINTAINER_AUTOMERGE=true (requires branch protection on the self-repo).
 */
const AUTONOMOUS_MAINTAINER = process.env.SELF_MAINTAINER_AUTOMERGE === "true";

const port = resolvePort(process.env);
const listenHost = resolveListenHost(process.env);
const MAX_BODY = 1_000_000;
const secret = process.env.WEBHOOK_SECRET;

/*
 * API token: env var wins. If absent, reuse the persisted file (data/.api_token, src/server/api-token.ts) so the
 * TUI can discover it across restarts. Only generate a new one if neither exists. The file an earlier version kept in
 * config/ is removed either way, and a copy that cannot be removed stops the start.
 */
const apiToken: string = resolveApiToken(process.env, ROOT);

/*
 * Session signing secret for GitHub-user logins. Reuses QA_API_TOKEN by default (one secret
 * to manage), or a dedicated AUTH_SIGNING_KEY when an operator wants to rotate sessions
 * independently of the machine token. Sessions live AUTH_SESSION_TTL_SECONDS (default 24h).
 */
const signingSecret = process.env.AUTH_SIGNING_KEY ?? apiToken;
const AUTH_SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 24 * 60 * 60);

/*
 * Per-IP throttle for the public login endpoint (20 attempts / minute), guarding against a
 * flood that would amplify into GitHub API calls from this server's address.
 */
const loginLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });

/*
 * The set of repos a GitHub user must be able to push to in order to log in: every watched
 * app's primary repo plus its service repos. A collaborator on any one earns a session.
 */
function watchedRepos(): string[] {
  const repos = new Set<string>();
  for (const app of listAppConfigs()) {
    repos.add(app.repo);
    for (const svc of app.services ?? []) repos.add(svc.repo);
  }
  return [...repos];
}

/*
 * Fail closed on the webhook surface: without a configured secret, signatures cannot
 * be verified, so an unauthenticated POST could enqueue runs for any configured repo.
 * Reject unsigned webhooks unless explicitly opted in (local dev).
 */
const ALLOW_UNSIGNED_WEBHOOK = process.env.WEBHOOK_ALLOW_UNSIGNED === "true";
if (!secret && !ALLOW_UNSIGNED_WEBHOOK) {
  console.warn(
    "[qa] CRITICAL: WEBHOOK_SECRET is not set — webhook POSTs will be REJECTED. " +
      "Set WEBHOOK_SECRET, or set WEBHOOK_ALLOW_UNSIGNED=true to accept unsigned webhooks (local only).",
  );
}


let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 25_000;
const eventStreamController = new AbortController();
const agentRuntime = createAgentRuntimeManager({
  env: process.env,
  fs: defaultEnvStoreFs(),
  strategies: {
    opencode: new OpenCodeRuntimeStrategy({ env: process.env }),
  },
  hasOpenSessions: () => getOpenSessionCount() > 0,
});

logAgentConfigWarnings([
  ...validateAgentRuntimeConfig(agentRuntime.current(), keyPresence(process.env)).warnings,
  ...retiredSelectorWarnings(process.env),
]);

function currentAgentDeps(): AgentDeps {
  return agentRuntime.facade().deps();
}


/*
 * Forward-declared so enqueueContextHealRun (below) can close over it — the same pattern
 * onboarding's own enqueueContextRun uses to close over `onboardingJob` before it exists (both
 * closures only ever run after this module has finished initializing).
 */
let engineFactory: ReturnType<typeof createRunEngineFactory>;

/* Assigned once the tools token is known, below; read when a run starts. */
let runConfigEnvironment: RunConfigEnvironment;

/* The question behind the automatic login bootstrap; absent under QA_CAMPAIGN_FREEZE (a mistyped value throws here, at boot, like the engine's own read of it). */
const suiteHoldsVerifiedLogin = suiteHoldsVerifiedLoginFor(process.env, ROOT);

/* The question behind the context-map rebuild before a run; absent under QA_CAMPAIGN_FREEZE. */
const contextMapNeedsRebuild = contextMapNeedsRebuildFor(process.env);

/*
 * The runner deps every enqueue path shares — the event store, the engine factory and the
 * onboarding mirror-race guard — so no path can skip parking while onboarding provisions mirrors.
 * Built at call time: engineFactory and onboardingJob are assigned later in this module.
 */
/* The change sets of the runs waiting in the queue: a push of an app that lands while one of its runs waits joins it (src/server/pending-change-sets.ts). */
const pendingChangeSets = new PendingChangeSets();

function runnerDeps(): RunnerDeps {
  return { pendingChangeSets, runConfig: runConfigEnvironment, runEvents, engineFactory, telemetry: telemetry.telemetry, clock: telemetry.clock, afterRun, isOnboardingActive: () => onboardingJob.isActive(), ...(suiteHoldsVerifiedLogin ? { suiteHoldsVerifiedLogin } : {}), ...(contextMapNeedsRebuild ? { contextMapNeedsRebuild } : {}) };
}

/*
 * Context-map rebuild trigger for run-engine-factory.ts's process-audit context heal. The
 * sha is the triggering run's own sha (never the mirror HEAD, which at composition time is the
 * previous run's sha — a gated app would wait for a version DEV no longer serves). Returns "" while
 * draining; the factory then keeps the stale flag armed for the next run.
 */
const enqueueContextHealRun = ({ app, sha, parentRunId }: ContextHealRunRequest): string => {
  if (shuttingDown) return "";
  return enqueueContextMapRun(queue, app, sha, runnerDeps(), parentRunId);
};

/*
 * The agents' tools' side of the orchestrator: where the generator's sessions find the run_spec loop, the authoring sessions the
 * run's authenticated browser, and every authoring session its run's location, and the internal listener the tools call (a second
 * port, not published by compose, behind a service token). Listening starts with the control plane's.
 */
const closedLoopRegistry = new ClosedLoopRegistry();
const agentBrowserRegistry = new AgentBrowserRegistry();
const geolocationRegistry = new GeolocationRegistry();
const codeGraphRegistry = new CodeGraphToolRegistry();
/* An authoring agent's prompt lists the browser's tools only when this run's session was granted them (see opencode-client.ts). */
setAgentBrowserGrantLookup((sessionId) => agentBrowserRegistry.find(sessionId) !== undefined);
/* The same for the location tool: a session of a run that carries no authoring location is not offered it. */
setGeolocationGrantLookup((sessionId) => geolocationRegistry.find(sessionId) !== undefined);
/* And for the lead's code-graph tools: a session of a run whose app is not in the graph, or the lead's session for a flow, is not offered them. */
setCodeGraphGrantLookup((sessionId) => codeGraphRegistry.find(sessionId) !== undefined);
/* A browser the authenticated agent tools started and a previous process of this container never stopped (it was restarted in place) ends here; a run closes its own browser when it ends. */
const orphanBrowsers = sweepOrphanAgentBrowsers(execWorkRoot(process.env));
if (orphanBrowsers > 0) logJson("warn", `stopped ${orphanBrowsers} agent browser process(es) a previous orchestrator process left behind`);
/* The workspaces of a run's sidekicks that a previous process never removed. */
void new FsDelegationWorkspaceAdapter({ root: join(workdirRoot(), DELEGATIONS_DIR) }).sweepAll().then(
  (swept) => { if (swept > 0) logJson("warn", `removed ${swept} sidekick workspace(s) a previous orchestrator process left behind`); },
  (err: unknown) => logJson("error", `sweeping the sidekick workspaces failed: ${err instanceof Error ? err.message : String(err)}`),
);
const toolsPort = resolveToolsPort(process.env);
const toolsToken = resolveToolsToken(process.env);
if (toolsToken.generated) logJson("warn", "QA_TOOLS_TOKEN is not set: no run is granted the run_spec or authenticated browser tools until the same value is set on the orchestrator and agents services");
/* What every run records of the process around it (its effectiveConfig): the agent runtime, the prompt layers, the tool grants and the operator switches, each read where it is configured. */
/* Memoised for the process's life: editing a prompt file needs a restart to show in later runs' effectiveConfig (docs/observability-design.md section 14). */
let staticPromptHash: string | null | undefined;
runConfigEnvironment = {
  runtime: () => agentRuntime.current().assignments.primary.provider,
  staticPromptHash: () => (staticPromptHash === undefined ? (staticPromptHash = hashStaticPrompts(ROOT)) : staticPromptHash),
  toolsGranted: !toolsToken.generated,
  reflectorEnabled: resolveReflectorEnabled(process.env),
  campaignFrozen: resolveCampaignFreeze(process.env),
  maxCapture: resolveTelemetryConfig(process.env).maxCapture,
};
const toolsServer = createToolsServer({ token: toolsToken.token, registry: closedLoopRegistry, browsers: agentBrowserRegistry, geolocations: geolocationRegistry, codeGraphs: codeGraphRegistry });
toolsServer.on("error", (err: Error & { code?: string }) => logJson("error", `the tools endpoint cannot listen on port ${toolsPort}: ${err.message}; the agents' run_spec, authenticated browser and location calls will fail`));

engineFactory = createRunEngineFactory({
  telemetry: telemetry.telemetry,
  clock: telemetry.clock,
  /* A token this process made up cannot match the agents service's, so a tool the generator is told about would only be refused: no run is granted it. */
  ...(toolsToken.generated ? {} : { closedLoopRegistry, agentBrowserRegistry, geolocationRegistry, codeGraphRegistry }),
  getAgentDeps: currentAgentDeps,
  /* The facade is read per run, from the same manager the deps above come from: the runtime is switchable. */
  getAgentFacade: () => agentRuntime.facade(),
  enqueueContextRun: enqueueContextHealRun,
});

/*
 * Auto-maintenance runtime (ARCH-01): the self-deploy path lives in maintainer-runtime.ts; the
 * entrypoint only wires it to the values it owns (queue, agent deps, the shuttingDown setter, the
 * repo identity, the port). The destructured handles keep the existing call sites unchanged.
 */
const maintainer = createMaintainerRuntime({
  queue,
  getAgentDeps: currentAgentDeps,
  setShuttingDown: (v) => {
    shuttingDown = v;
  },
  root: ROOT,
  selfRepo: SELF_REPO,
  autonomous: AUTONOMOUS_MAINTAINER,
  port,
});
const { triggerMaintainer, confirmSwapAfterBoot, recoverMaintainerState, recoverRollbackRecord } = maintainer;

process.on("SIGTERM", () => {
  console.log("[qa] SIGTERM received — cancelling in-flight run and draining");
  shuttingDown = true;
  hostHealth.stop();
  eventStreamController.abort();

  /*
   * Cancel the in-flight job: abort its signal so the pipeline's checkSignal()
   * unwinds deterministically, letting teardown/cleanup run before exit.
   */
  queue.cancel();

  /*
   * Drain: wait for the cancelled job's finally block. If it takes too long,
   * force-exit so the orchestrator doesn't hang the host process indefinitely.
   */
  const drainTimer = setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    /* Synchronous: commit the buffered span ledger rows before the process is cut. */
    telemetry.telemetry.flush();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  queue.drain().finally(async () => {
    clearTimeout(drainTimer);
    console.log("[qa] drained — exiting");
    await telemetry.shutdown(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[qa] SIGINT received — cancelling in-flight run and draining");
  shuttingDown = true;
  hostHealth.stop();
  eventStreamController.abort();
  queue.cancel();
  const drainTimer = setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    /* Synchronous: commit the buffered span ledger rows before the process is cut. */
    telemetry.telemetry.flush();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  queue.drain().finally(async () => {
    clearTimeout(drainTimer);
    console.log("[qa] drained — exiting");
    await telemetry.shutdown(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
    process.exit(0);
  });
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[qa] unhandled rejection:", reason instanceof Error ? reason.stack ?? msg : msg);
  recordIncident({ source: "qa-author", severity: "error", summary: `unhandled rejection: ${msg}` });
});

/* One path for the control API and the webhook; the trigger is what tells their runs apart in the trace. */
function enqueueRunFrom(trigger: "api" | "webhook", app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number, triggerRepo?: string, baseSha?: string, closedLoop?: boolean, agentBrowser?: boolean, observability?: RunObservabilityRequest, grounding?: import("./contract/commands").GroundingInput): string {
  if (shuttingDown) {
    console.warn(`[qa] rejecting run ${app}@${sha} — shutting down`);
    return "";
  }

  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, commits, source: "webhook", trigger, triggerRepo, baseSha, ...(closedLoop !== undefined ? { closedLoop } : {}), ...(agentBrowser !== undefined ? { agentBrowser } : {}), ...(observability?.campaign ? { campaign: observability.campaign } : {}), ...(observability?.captureMode ? { captureMode: observability.captureMode } : {}), ...(grounding ? { grounding } : {}) }, runnerDeps());
}

const enqueueApiRun: ApiDeps["enqueue"] = (...args) => enqueueRunFrom("api", ...args);
const enqueueWebhookRun: ApiDeps["enqueue"] = (...args) => enqueueRunFrom("webhook", ...args);

/*
 * Orphan-session sweep threshold. Must always exceed the longest possible agent
 * turn: when an operator raises OPENCODE_TIMEOUT_MS above 30 min, a live session
 * would otherwise be deleted mid-prompt. The 5-min buffer covers dispose/teardown.
 */
const MAX_SESSION_AGE_MS = Math.max(
  30 * 60 * 1000,
  (Number(process.env.OPENCODE_TIMEOUT_MS) || 0) + 5 * 60 * 1000,
);

async function cleanupOrphanedSessions(): Promise<void> {
  const deps = currentAgentDeps();
  if (!deps.cleanupOrphans) return;
  try {
    const cleaned = await deps.cleanupOrphans(MAX_SESSION_AGE_MS);
    if (cleaned > 0) {
      recordIncident({ source: "health-check", severity: "warn", summary: `cleaned up ${cleaned} orphaned OpenCode session(s)` });
    }
  } catch (err) {
    console.warn(`[qa] orphan session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * Module-level cache for the artifact-bytes scan (TTL: 60 s). A fresh scan on every
 * scrape would block the response for large mirrors; this amortises the cost and ensures
 * a scan error never crashes the metrics endpoint.
 */
const artifactSizeCache: { current: ArtifactSizeCache | null } = { current: null };
const ARTIFACT_SIZE_TTL_MS = 60_000;

function generatePrometheusMetrics(queue: JobQueue, openSessions: number): string {
  const lines: string[] = [];
  lines.push(`# HELP qayaba_queue_depth Current depth of the job queue`);
  lines.push(`# TYPE qayaba_queue_depth gauge`);
  lines.push(`qayaba_queue_depth ${queue.size}`);
  lines.push(`# HELP qayaba_open_sessions Number of open OpenCode sessions`);
  lines.push(`# TYPE qayaba_open_sessions gauge`);
  lines.push(`qayaba_open_sessions ${openSessions}`);
  /*
   * Completed runs by verdict — the metric an operator alerts on (fail/invalid/
   * infra-error rate shift). Sourced from the durable runs table, never a wrong-when-restarted
   * in-memory counter. Always emit the known verdict labels so a 0 is explicit (no missing series).
   */
  let counts: Record<string, number> = {};
  try {
    counts = runVerdictCounts();
  } catch (err) {
    console.warn(`[qa] metrics: verdict counts unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  lines.push(`# HELP qayaba_runs_total Completed runs by verdict`);
  lines.push(`# TYPE qayaba_runs_total counter`);
  for (const verdict of ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]) {
    lines.push(`qayaba_runs_total{verdict="${verdict}"} ${counts[verdict] ?? 0}`);
  }
  /*
   * Artifact size gauge: best-effort, TTL-cached. A scan error yields 0 for that app;
   * the gauge block is omitted entirely when no apps are configured.
   */
  const artifactBlock = buildArtifactBytesMetrics(
    {
      listAppConfigs,
      mirrorRoot: () => process.env.MIRROR_DIR ?? join(ROOT, ".mirrors"),
      getDirectorySize,
    },
    artifactSizeCache,
    ARTIFACT_SIZE_TTL_MS,
    Date.now(),
  );
  if (artifactBlock) lines.push(artifactBlock);
  return lines.join("\n");
}

let backupTick = 0;
let pruneTick = 0;

/* Deletes the history the retention windows no longer keep. A failure is logged and never stops the process. */
function runHistoryRetention(): void {
  try {
    const report = pruneHistory(getHistoryDatabase(), retentionPolicyFrom(process.env), Date.now());
    logJson("info", "history retention pruned", { report });
  } catch (err) {
    logJson("error", "history retention failed", { error: redactionPort.redactError(err) });
  }
}
const PRUNE_INTERVAL_TICKS = 360;  /* 6 hours (360 × 60 s) */

function startHealthPoller(): void {
  let fails = 0;
  let lastQueueWarn = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (!res.ok) throw new Error(`health probe returned ${res.status}`);
      fails = 0;
    } catch {
      fails++;
      if (fails === 3) {
        recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (3 consecutive failures)" });
      }
      if (fails === 10) {
        recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (10 consecutive failures — likely crashed)" });
      }
    }
    await cleanupOrphanedSessions();
    const depth = queue.size;
    if (depth > 10 && lastQueueWarn <= 10) {
      recordIncident({ source: "health-check", severity: "warn", summary: `queue depth is ${depth} (possible stuck job)` });
    }
    lastQueueWarn = depth;

    const pending = getIncidents().filter((i) => i.status === "pending");
    if (pending.length > 0 && getMaintainerStatus() === "idle") {
      triggerMaintainer();
    }

    /* SQLite backup every 24h (1440 ticks at 60s intervals) */
    backupTick++;
    if (backupTick >= 1440) {
      backupTick = 0;
      runHistoryRetention();
      const r = await backupDatabase(getHistoryDatabase());
      if (r.backedUp) {
        logJson("info", "SQLite backup created", { path: r.path });
      } else if (r.error) {
        logJson("warn", "SQLite backup failed", { error: r.error });
      }
    }

    /* Mirror prune every 6h (360 ticks at 60s intervals) */
    pruneTick++;
    if (pruneTick >= PRUNE_INTERVAL_TICKS) {
      pruneTick = 0;
      pruneMirrors(defaultMirrorPruneDeps(() => queue.current));
    }
  }, 60_000);
}

/*
 * A request is authorized if it carries EITHER the static machine token (CI/automation) OR a
 * valid user-session JWT minted by POST /api/auth/login. authorizeBearer does the constant-time
 * static compare and the signature/expiry check; both paths are unit-tested in auth.test.ts.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  return authorizeBearer(typeof header === "string" ? header : undefined, apiToken, signingSecret) !== null;
}

const ASSISTANT_CWD = "/tmp";

/*
 * Server-side app onboarding/deletion deps: the orchestrator owns the GitHub
 * token, the config dir and the mirror cache, so the TUI never touches them directly.
 */
const appAdminDeps: AppAdminDeps = {
  getRepoInfo: (repo) => github.getRepo(repo),
  configExists: (name) => configExists(name, ROOT),
  writeConfig: (name, yaml) => writeConfig(name, yaml, ROOT),
  deleteConfig: (name) => unlinkSync(join(ROOT, "config", "apps", `${name}.yaml`)),
  deleteMirror: (repo) => rmSync(join(process.env.MIRROR_DIR ?? join(ROOT, ".mirrors"), repo.replaceAll("/", "__")), { recursive: true, force: true }),
  deleteHistory: (app) => deleteAppHistory(app),
  deleteAuthMaterial: (app) => rmSync(appAuthDir(ROOT, app), { recursive: true, force: true }),
  deleteSuiteStore: (app) => deleteSuiteStoreDir(appSuiteStoreDir(ROOT, app)),
  deleteCodeGraphCache: (app) => rmSync(join(qayabaDataDir(), "code-graph", app), { recursive: true, force: true }),
  applyEnv: (vars) => applyEnvVars(vars, { fs: defaultEnvStoreFs(), env: process.env }),
  loadApp: (name) => loadAppConfig(name),
  readConfig: (name) => readFileSync(join(ROOT, "config", "apps", `${name}.yaml`), "utf8"),
  env: process.env,
};

/*
 * Build the period-over-period TrendsView for an app from one outcomes read. The trends and report
 * deps both route through this so the read logic — and the `100` window literal — live in one place
 * instead of being duplicated at each site; each call performs its own read (trends and report are
 * separate HTTP requests, so there is no cross-request reuse).
 */
const buildTrends = (app: string, window?: number) =>
  toTrendsView({ app, outcomes: getHistory().learning.listRunOutcomes(app, 100), records: listRecords(app, 100), now: new Date().toISOString(), window });


function opencodeConfigPath(): string {
  return process.env.OPENCODE_CONFIG ?? join(ROOT, "agents", "opencode.json");
}


async function hasProposerAgentConfigured(): Promise<boolean> {
  try {
    const path = opencodeConfigPath();
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { agent?: Record<string, unknown> };
    return Boolean(raw.agent?.["qa-proposer"]);
  } catch {
    return false;
  }
}


/*
 * Onboarding builds each repo's first code-graph store through the same path a run takes (the workspace of the commit the
 * mirror is checked out at, the engine in the launcher's graph profile, the store published to the app's cache), in a
 * launcher scope of its own since it has no run to borrow one from. The next run then syncs that store.
 */
const onboardingSandbox = resolveCodeSandbox(process.env);
const onboardingExec = buildScriptExec(process.env, onboardingSandbox, egressGateFor(process.env, onboardingSandbox));
const onboardingGit = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });

async function indexRepoForOnboarding(repo: string, mirrorDir: string, app: string): Promise<RepoIndexOutcome> {
  /* The cache is per app: without its name there is nowhere to publish the store. */
  if (!app) return { repo, status: "failed", error: "the onboarded app has no name yet" };
  try {
    const sha = await getHeadSha(mirrorDir, defaultMirrorDeps);
    let exclude: readonly string[] = [];
    try {
      exclude = loadAppConfig(app).qa.structuralSignals?.exclude ?? [];
    } catch {
      /* Not configured yet: the declared languages alone. */
    }
    const record = await onboardingExec.scoped({ runId: `onboard-index-${Date.now()}` }, () =>
      codeGraphFor({ exec: onboardingExec.exec, git: onboardingGit, dataDir: qayabaDataDir(), sandbox: onboardingSandbox, processKill: new ProcessKillAdapter() })(app, exclude).syncTo(mirrorDir, sha),
    );
    if (record.outcome === "failed" || record.outcome === "timeout" || record.outcome === "skipped") {
      return { repo, status: "failed", error: record.reason ?? record.outcome };
    }
    return { repo, status: "ok", ...(record.nodeCount !== null ? { nodeCount: record.nodeCount } : {}) };
  } catch (err) {
    return { repo, status: "failed", error: redactionPort.redactError(err) };
  }
}

const onboardingJob = createOnboardingJob({
  isRunnerBusy: () => {
    const running = currentRun();
    return queue.size > 0 || (running !== undefined && running.status === "running");
  },
  ensureMirrorAtBranch: (repo, baseBranch) =>
    ensureMirrorAtBranch(repo, baseBranch, defaultMirrorDeps),
  hasOpencodeApiKey: () => Boolean(process.env.OPENCODE_API_KEY),
  hasProposerAgent: () => hasProposerAgentConfigured(),
  buildProposer: (ctx) => new LlmProfileProposerAdapter(defaultAgentDeps, PROPOSER_MODEL, ctx),
  buildOnboardingService: (proposer, onRound) => new OnboardingService(proposer, buildServiceBoundaryResolver, 3, onRound),
  resolveLinks: (profile, system, front) => buildServiceBoundaryResolver([profile]).resolveLinks(system, front),
  readConfig: (path) => readFileSync(path, "utf8"),
  writeConfig: (path, content) => writeFileSync(path, content, "utf8"),
  configPath: (app) => join(ROOT, "config", "apps", `${app}.yaml`),
  indexRepo: (repo, mirrorDir, app) => indexRepoForOnboarding(repo, mirrorDir, app),
  enqueueContextRun: async ({ app, mirrorDir }) => {
    /*
     * Same shutdown guard every other enqueue path in this file honors (enqueueApiRun,
     * continueRun): refuse new work once draining, rather than resolving HEAD and enqueueing a
     * run that queue.drain() would just have to outlive. onboarding-job.ts's runMapping()
     * already treats an empty-string return as a clean "spec skip", never a fail-open warning.
     */
    if (shuttingDown) return "";
    const sha = await getHeadSha(mirrorDir, defaultMirrorDeps);
    /*
     * The SQLite context_maps store (history.ts, wired via ContextMapCapturePort) is the map's
     * durability mechanism — it captures the validated map on every clean context-mode pass
     * regardless of shadow, so the map survives the next mirror wipe without a context.json PR.
     */
    return enqueueContextMapRun(queue, app, sha, runnerDeps());
  },
  getContextRun: (runId) => {
    const rec = getRecord(runId);
    if (!rec) return undefined;
    return { runId: rec.id, status: rec.status, step: rec.step, verdict: rec.verdict };
  },
  isCodeApp: (app) => Boolean(loadAppConfig(app).code),
  /*
   * The login phase after the map: a manual run for the login purpose at the mirror's HEAD, under the app's own qa.shadow. Same
   * shutdown guard as the map's enqueue; "" is a clean skip for the job. An accepted run keeps the login and its smoke spec in
   * the suite store (run-qa.use-case.ts), which is what "verified" means.
   */
  enqueueLoginRun: async ({ app, mirrorDir }) => {
    if (shuttingDown) return "";
    return enqueueLoginBootstrapRun(queue, app, await getHeadSha(mirrorDir, defaultMirrorDeps), runnerDeps());
  },
  hasLogin: (app) => loadAppConfig(app).auth?.kind === "form",
});

const apiDeps: ApiDeps = {
  queue,
  telemetryHealth: () => ({ ...telemetry.health(), scoreSink: scoreSinkHealthOf(langfuseSink) }),
  hostHealth: () => hostHealth.snapshot(),
  ...(backendHealth ? { backendHealth } : {}),
  enqueue: enqueueApiRun,
  loadApp: (name) => loadAppConfig(name),
  listApps: () => listAppConfigs(),
  createApp: (input) => adminCreateApp(input, appAdminDeps),
  updateApp: (input) => adminUpdateApp(input, appAdminDeps),
  deleteApp: (name, purge) => adminDeleteApp(name, purge, appAdminDeps),
  bootstrapLogin: (app, sha) => (shuttingDown ? "" : enqueueLoginBootstrapRun(queue, app, sha, runnerDeps())),
  listRepos: (owner, page) => github.listRepos(owner, page),
  runEvents,

  boundaries: {
    propose: (name, input) => {
      let app;
      try {
        app = loadAppConfig(name);
      } catch (err) {
        const error = describeAppLoadFailure(name, err);
        if (error === undefined) throw err;
        return { ok: false, error };
      }
      const repo = input.repo ?? app.repo;
      const services = input.services ?? app.services?.map((s) => s.repo) ?? [];
      return onboardingJob.propose({ app: name, repo, services, baseBranch: app.baseBranch });
    },
    status: (name) => onboardingJob.status(name),
    confirm: (name) => onboardingJob.confirm(name),
  },

  getAgentTurns: (runId) => getHistory().telemetry.getAgentTurns(runId),
  runExtras: (runId) => buildRunViewExtras(runId, runViewDeps),
  evaluation,

  telemetryAnalysis: (app, windowDays) => getHistory().telemetry.computeTelemetryAnalysis(app, windowDays),
  resolveRef: (repo, ref) => resolveRef(repo, ref, defaultMirrorDeps),
  getRecord,
  listRecords,
  currentRun,
  intelligence: loadIntelligenceView,
  /* Read-only stored FE<->BE architecture map. null (no row yet) -> the route 404s. */
  contextMap: (app) => {
    const stored = getHistory().contexts.loadContextMap(app);
    if (!stored) return null;
    return { app, map: stored.data, builtAtSha: stored.builtAtSha, updatedAt: stored.updatedAt };
  },
  signals: () => toSignalsView(
    listAppConfigs().map((a) => ({ scorecard: getHistory().learning.loadScorecard(a.name), runs: listRecords(a.name, 50), outcomes: getHistory().learning.listRunOutcomes(a.name, 50) })),
    toCoordinationSignals(readRecentCoordinationEvents({ limit: 1000 }).events),
  ),
  /*
   * Durable coordination ledger tail — full window (cap 1000 per read) so the audit UI can
   * scroll back further than a single run.
   */
  coordinationEvents: (filter) => readRecentCoordinationEvents(filter),
  /*
   * Each handler builds its own TrendsView via buildTrends (one SQLite read per request); report
   * then feeds that view to toReportView. buildTrends is the single home for the read + the 100
   * window literal — it does NOT dedup across the (separate) trends and report requests.
   */
  trends: (app, window) => buildTrends(app, window),
  report: (app, window) => toReportView(buildTrends(app, window), { weights: loadAppConfig(app).qa.reports?.weights }),
  /*
   * The run-scoped report: TWO analyses for the post-run summary view. `current` is the
   * self-describing report about the run that just finished (its verdict, case mix, this run's
   * change-coverage/value/duration). `evolution` is the period-over-period report of the same app
   * as it stood at this run (outcomes/records up to the run's timestamp), so a recent execution can
   * open the trends exactly as they were then — null until there is a prior run to compare against.
   * Outer null ⇒ 404 (no such run).
   */
  reportForRun: (runId, window) => {
    const rec = getRecord(runId);
    if (!rec) return null;
    let weights: Record<string, number> | undefined;
    let minRatio: number | undefined;
    try {
      const cfg = loadAppConfig(rec.app);
      weights = cfg.qa.reports?.weights;
      minRatio = cfg.qa.changeCoverage?.minRatio;
    } catch {
      /* app config gone but the run survives — still produce its report from defaults */
    }
    const current = toRunReportView({ record: rec, outcome: getHistory().learning.getRunOutcome(runId) ?? null, minRatio, weights });
    const outcomes = getHistory().learning.listRunOutcomes(rec.app, 200).filter((o) => o.at <= rec.at);
    const records = listRecords(rec.app, 200).filter((r) => r.at <= rec.at);
    const evolution =
      outcomes.length >= 2
        ? toReportView(toTrendsView({ app: rec.app, outcomes, records, now: rec.at, window }), { weights })
        : null;
    return { current, evolution };
  },
  ask: async (input) => askAssistant(input, currentAgentDeps(), ASSISTANT_CWD),
  /*
   * Advertise the OAuth App client id (public) in the version handshake so the console can run
   * the device flow without baking it in — configure GitHub login once, here on the server.
   */
  githubClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
  /*
   * GitHub-user login: verify the token's identity, confirm push access to a watched repo,
   * then mint a session. Failures are tagged so the route returns 401 (bad token) vs 403
   * (authenticated but not a collaborator). The static QA_API_TOKEN remains the machine path.
   */
  login: async (githubToken) => {
    const username = await verifyGithubIdentity(githubToken);
    if (!username) return { ok: false, reason: "identity" };
    if (!(await authorizeUser(githubToken, watchedRepos()))) return { ok: false, reason: "forbidden" };
    const now = Date.now();
    const token = issueSession(username, signingSecret, AUTH_SESSION_TTL_SECONDS, now);
    return { ok: true, token, username, expiresAt: new Date(now + AUTH_SESSION_TTL_SECONDS * 1000).toISOString() };
  },
  /* Same-origin web console: a short-lived session only for a trusted peer AND Host (see auth.ts). */
  localLogin: createLocalConsoleLogin(process.env, signingSecret, AUTH_SESSION_TTL_SECONDS),
  agentRuntime,
  /*
   * Cancel through the single funnel (runner.ts): aborts a live run we hold, and ALSO finalizes
   * an enqueued or stale "running" record so the operator's stop always clears the run — never
   * leaving a zombie stuck at "0%" answering 409 to every stop press. queue.cancel(id) inside it
   * protects an innocent successor (it aborts only when the id matches the active run).
   */
  cancelRun: (id) => cancelTrackedRun(queue, id, { runEvents, afterRun }),
  continueRun: (parentId, cases, guidance) => {
    if (shuttingDown) return "";
    const parent = getRecord(parentId);
    if (!parent) return "";
    /*
     * Cap the continuation chain: an operator can chain continue→continue→continue
     * indefinitely, each carrying fresh guidance to nudge the suite toward green.
     * After MAX_CONTINUATION_DEPTH rounds, refuse — the suite needs a fresh run.
     */
    const depth = continuationDepth(parent);
    if (depth >= MAX_CONTINUATION_DEPTH) {
      console.warn(`[qa] rejecting continuation of ${parentId}: depth ${depth} >= ${MAX_CONTINUATION_DEPTH} (max)`);
      return "";
    }
    let failed = parent.cases.filter((c) => c.status === "fail");
    if (cases && cases.length > 0) {
      const want = new Set(cases);
      failed = failed.filter((c) => want.has(c.name));
    }
    return enqueueTrackedRun(queue, {
      app: parent.app,
      sha: parent.sha,
      target: parent.target,
      mode: parent.mode,
      guidance,
      fixCases: failed,
      parentRunId: parentId,
      source: "manual",
      trigger: "continuation",
      /* Continuations run on the active agent runtime, exactly like the webhook path above. */
    }, runnerDeps());
  },
};

const server = createServer(guardRequestHandler(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const traceId = req.headers["x-trace-id"] as string | undefined;
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path.startsWith("/api")) {
    /*
     * The liveness probe (session count only) and the version/capability handshake
     * are unauthenticated: the internal poller and external checks need the former,
     * and the connect screen needs the latter BEFORE auth so a stale binary can be
     * told to update even with a wrong token. Neither exposes secrets.
     */
    const apiPath = path.replace(/^\/api\/v1(?=\/|$)/, "/api");
    /*
     * Public (pre-auth) surface: liveness, the version handshake, GitHub login, and the
     * same-origin local-console bootstrap. None of these return QA_API_TOKEN. /auth/local
     * is public at the gate; the handler 404s untrusted callers (see localWebLoginAllowed).
     */
    const isPublic = isPublicControlPlaneRoute(req.method ?? "GET", apiPath);
    if (!isPublic && !authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, error: "unauthorized" }));
      return;
    }
    /*
     * Throttle the public auth bootstrap per client IP. Login fans out to GitHub; local
     * minting is cheap but still unauthenticated, so it shares the same window.
     */
    const isAuthBootstrap = apiPath === "/api/auth/login" || apiPath === "/api/auth/local";
    if (isAuthBootstrap && !loginLimiter.allow(req.socket.remoteAddress ?? "")) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "too many login attempts — try again in a minute" }));
      return;
    }
    if (path === "/api/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(generatePrometheusMetrics(queue, getOpenSessionCount()));
      return;
    }
    if (path.startsWith("/api/maintainer")) {
      if (await handleMaintainerApi(req, res, triggerMaintainer)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (await handleApi(req, res, apiDeps)) {
      if (shouldLogApiRequest(req.method, res.statusCode)) logJson("info", `API request`, { traceId, path, duration: Date.now() - startTime });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  /*
   * The web console (web/public, served as-is) is served same-origin at /app, so it shares the
   * orchestrator's origin and the operator's credentials (no CORS). A missing web/public answers a
   * placeholder page. The /api surface above stays Bearer-protected.
   */
  if (req.method === "GET" && (path === "/app" || path.startsWith("/app/"))) {
    if (await serveDashboard(req, res, { dir: resolveDashboardDir(ROOT) })) return;
  }

  if (req.method === "POST") {
    /* Fail closed: no webhook secret configured and not explicitly opted in → reject. */
    if (!secret && !ALLOW_UNSIGNED_WEBHOOK) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "webhook secret not configured (set WEBHOOK_SECRET or WEBHOOK_ALLOW_UNSIGNED=true)" }));
      return;
    }
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => void guardResponse(res, async () => {
      if (aborted) return;
      const sig = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
      const result = handleWebhook(body, sig, { secret });
      if (result.payload) {
        if (shuttingDown) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "shutting down" }));
          return;
        }
        const { repo, sha, mode, guidance, baseSha } = result.payload;

        let dispatch: WebhookDispatch[];
        try {
          dispatch = await resolveWebhookDispatch(appCatalog, repo, { mode, guidance, baseSha });
        } catch (err) {
          logJson("error", "webhook dispatch resolution failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "internal error — could not resolve webhook dispatch" }));
          return;
        }
        if (dispatch.length === 0) logJson("warn", "no config/apps entry for repo; event ignored", { repo });
        for (const d of dispatch) {
          try {
            enqueueWebhookRun(d.app, sha, d.target, d.mode, d.guidance, undefined, undefined, d.triggerRepo, d.baseSha);
          } catch (err) {
            logJson("error", "webhook enqueue failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "internal error — run could not be enqueued" }));
            return;
          }
        }
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: result.message }));
    }, (message) => logJson("error", message)));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}, (message) => logJson("error", message)));

/*
 * Finalize zombie runs from a previous process BEFORE accepting traffic: a webhook
 * landing during boot creates a legitimate `enqueued` record that a late sweep would
 * wrongly finalize as infra-error.
 */
runHistoryRetention();
finalizeInterruptedRuns({ runEvents, afterRun });

server.on(
  "error",
  serverErrorListener({
    port,
    listening: () => server.listening,
    log: logJson,
    exit: (code) => process.exit(code),
    redact: (err) => redactionPort.redactError(err),
  }),
);

toolsServer.listen(toolsPort, resolveToolsListenHost(process.env, listenHost), () => logJson("info", `tools endpoint listening on ${describeListenAddress(toolsServer.address())}`));

server.listen(port, listenHost, () => {
  logJson("info", `qayaba listening on ${describeListenAddress(server.address())}${apiToken ? " (API auth on)" : ""}`);
  /*
   * Make global fetch proxy-aware (HTTP(S)_PROXY/NO_PROXY) from boot, before any GitHub API or
   * health call. No-op when no proxy is configured. (A per-run build refines the timeouts.)
   */
  const startupTimeout = Number(process.env.OPENCODE_TIMEOUT_MS) || 900_000;
  installHttpDispatcher(startupTimeout).catch((err) => logJson("warn", "HTTP dispatcher setup failed", { error: err instanceof Error ? err.message : String(err) }));
  /*
   * Start the SSE event stream from OpenCode so agent activity (tool calls,
   * file edits, streaming text) is routed to RunRecord logs in real time.
   */
  agentRuntime.facade().startEventStream?.(
    (a) => {
      /* Structured event → the live TUI panel; display line → the human log feed. */
      appendActivity(a.runId, { kind: a.kind, text: a.text, status: a.status });
      appendLog(a.runId, a.display);
    },
    eventStreamController.signal,
    (runId, body) => {
      /*
       * Rich live activity (agent.activity/plan.updated/...) onto the RunEvent SSE
       * stream. Advisory: a bad event must never break the reconnect loop.
       */
      try { runEvents.publish(runId, body); } catch { /* advisory */ }
    },
  )?.catch((err) => logJson("warn", "event stream reconnect loop failed", { error: err instanceof Error ? err.message : String(err) }));
  recoverRollbackRecord();
  confirmSwapAfterBoot();
  startHealthPoller();
  recoverMaintainerState();
});

/*
 * NOTE: SIGTERM/SIGINT are handled by the single pair of handlers registered near the
 * top of this file (they cancel the in-flight run via queue.cancel(), drain, then exit).
 * The database is closed via process.on("exit") in history.ts. There is intentionally no
 * second shutdown path here — two handlers for one signal raced (two drain timers, two
 * exits) and made `docker stop` behavior non-deterministic.
 */

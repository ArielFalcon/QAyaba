
import { PendingChangeSets } from "./pending-change-sets";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { qayabaDataDir, qayabaRoot } from "../paths";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { JobQueue } from "./queue";
import { describeAppLoadFailure, loadAppConfig, listAppConfigs } from "../orchestrator/config-loader";

import { YamlAppConfigAdapter } from "../../qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter";
import { routeApi } from "./api";
import type { ApiDeps } from "./api/deps";
import type { ApiRunRequest } from "./api/run-request";
import { authorizeBearer, createLocalConsoleLogin, issueSession } from "./auth";
import { verifyGithubIdentity, authorizeUser } from "./github-auth";
import { createFixedWindowLimiter } from "./rate-limit";
import { loadIntelligenceView } from "./intelligence-view";
import { toSignalsView } from "./signals-view";
import { readRecentCoordinationEvents, toCoordinationSignals } from "./coordination-events";
import { toTrendsView } from "./trends-view";
import { toReportView } from "./report-view";
import { toRunReportView } from "./run-report-view";
import { createDurableRunEventStore } from "./durable-run-events";
import { serveDashboard, resolveDashboardDir } from "./static";
import { handleMaintainerApi, recordIncident, getMaintainerStatus, getIncidents } from "./maintainer";
import { MAX_CONTINUATION_DEPTH } from "./persistence/repositories/run.repository";
import { createEvaluationService } from "./evaluation-service";
import { composeJudges } from "./judges-composition";
import { LangfuseScoreSink, scoreSinkHealthOf } from "../telemetry/langfuse-score-sink";
import { ScoreMetricsSink, composeScoreSinks } from "../telemetry/score-metrics-sink";
import { hashStaticPrompts, type RunConfigEnvironment } from "./effective-config";
import { buildRunViewExtras, defaultRunViewDeps } from "./run-view";
import { enqueueTrackedRun, enqueueContextMapRun, enqueueLoginBootstrapRun, cancelTrackedRun, finalizeInterruptedRuns, type RunnerDeps } from "./runner";
import { codeGraphFor } from "./engine-root";
import { appAuthDir, appSuiteStoreDir, createRunEngineFactory, resolveCodeSandbox } from "./run-engine-factory";
import type { ContextHealRunRequest } from "@contexts/run-orchestration/application/index";
import { egressGateFor } from "./egress-wiring";
import { SandboxedBinaryRunnerAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";
import { deleteSuiteStoreDir } from "@contexts/workspace-and-publication/infrastructure/suite-store.adapter";
import { pruneMirrors, defaultMirrorPruneDeps, getDirectorySize } from "./mirror-prune";
import { buildArtifactBytesMetrics, type ArtifactSizeCache } from "./metrics";
import { createMaintainerRuntime } from "./maintainer-runtime";
import { installHttpDispatcher } from "../util/net";
import { resolveRef, defaultMirrorDeps, ensureMirrorAtBranch, getHeadSha } from "../integrations/repo-mirror";
import { askAssistant, AgentDeps, getOpenSessionCount, defaultAgentDeps, setAgentBrowserGrantLookup, setCodeGraphGrantLookup, setGeolocationGrantLookup } from "../integrations/opencode-client";
import { createAgentRuntimeManager, logAgentConfigWarnings } from "./agent-runtime";
import { keyPresence, retiredSelectorWarnings, validateAgentRuntimeConfig } from "../agent-runtime/config";
import { OpenCodeRuntimeStrategy } from "../agent-runtime";
import { getHistoryDatabase } from "./persistence/index";
import { pruneHistory, retentionPolicyFrom } from "./persistence/retention";
import { backupDatabase } from "./persistence/backup";
import { type RunMode, type TestTarget } from "../types";
import { installShutdown, installUnhandledRejectionRecorder } from "./shutdown";
import { startHealthPoller } from "./health-poller";
import { github } from "../integrations/github";
import { createApp as adminCreateApp, updateApp as adminUpdateApp, deleteApp as adminDeleteApp, type AppAdminDeps } from "./app-admin";
import { writeConfig, configExists } from "./onboard";
import { applyEnvVars, defaultEnvStoreFs } from "./env-store";
import { logJson } from "../integrations/logger";
import { createOnboardingJob, type RepoIndexOutcome } from "./onboarding/onboarding-job";
import { LlmProfileProposerAdapter, PROPOSER_MODEL } from "./onboarding/llm-profile-proposer.adapter";
import { OnboardingService } from "@contexts/service-topology/application/index";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory";

import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { processTelemetry, TELEMETRY_SHUTDOWN_TIMEOUT_MS } from "../telemetry/process-telemetry";
import { HostHealth } from "../telemetry/host-health";
import { BackendHealthMonitor, systemBackendFetch } from "../telemetry/backend-health";
import { resolveSandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { createToolsServer, resolveToolsListenHost, resolveToolsToken } from "./tools-endpoint";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry";
import { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry";
import { GeolocationRegistry } from "@contexts/agent-tools/infrastructure/geolocation-registry";
import { CodeGraphToolRegistry } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry";
import { FsDelegationWorkspaceAdapter } from "@contexts/coordination/infrastructure/adapters/delegation-workspace.adapter";
import { DELEGATIONS_DIR } from "../paths";
import { workdirRoot } from "../integrations/repo-mirror";
import { sweepOrphanAgentBrowsers } from "../../qa-engine/src/shared-infrastructure/process-sandbox/orphan-browser-sweep";
import { buildScriptExec, execWorkRoot } from "./exec-sandbox-factory";
import { loadOrCreateApiToken } from "./api-token";
import { shouldLogApiRequest } from "./api-request-log";
import { suiteHoldsVerifiedLoginFor } from "./login-bootstrap-wiring";
import { contextMapNeedsRebuildFor } from "./context-map-wiring";
import { getHistory } from "./persistence/index";
import type { SettingsStore } from "../settings/store";
import { createApp, type App } from "./create-app";

/*
 * The production wiring of the control plane: every real adapter is built here from the typed settings and handed to
 * createApp, so the process entry (src/index.ts) is only `main()`. Nothing runs until wireApp is called. The engine
 * factory this wiring hands runs to is replaced by per-context builders in the hexagonal re-cut (odd/tasks/arch-p3-hexagonal-recut.md).
 */

export interface WiredApp {
  app: App;
  /* Run once before `app.listen()`: retention, and finalizing the runs a previous process left unfinished. */
  beforeListen(): void;
}

export function wireApp(settingsStore: SettingsStore): WiredApp {
  /* Every value below comes from the typed settings (docs/settings.md). The store reloads them after the onboarding surface applies variables to the live environment. */
  const settings = settingsStore.current();
  for (const warning of settings.warnings) console.warn(warning);

  const SELF_REPO = settings.server.selfRepo;
  const ROOT = qayabaRoot();

  const appCatalog = new YamlAppConfigAdapter({ load: loadAppConfig, list: listAppConfigs });

  const redactionPort = new RedactionPortAdapter();
  /*
   * Telemetry is built once, here, before anything that could emit (QA_TELEMETRY=off|local; a mistyped value stops the boot).
   * The engine factory takes `telemetry.telemetry` as a dep; the API reports `telemetry.health()`.
   */
  const telemetry = processTelemetry(settings.environment);
  /* Process-wide host health (suspends, blocked loops, sandbox zombies): runs with no run active and is stopped on shutdown. Fail-open and unref'd. */
  const sandboxIdentity = resolveSandbox(settings.environment);
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
  const langfuseConfig = settings.telemetry.langfuse;
  const langfuseSink = langfuseConfig
    ? new LangfuseScoreSink({ config: langfuseConfig, traceIdOf: (runId) => getHistory().runs.getRunFacts(runId)?.traceId ?? null, sanitize: (text) => redactionPort.redact(text) })
    : undefined;
  /*
   * The LLM judges (docs/observability-design.md section 11.3): off unless QA_JUDGES_ENABLED=true. They run as low-priority work on the same
   * sequential queue, so never beside a run, and only for a campaign run or a regrade that names a judge. They never gate anything.
   */
  const judges = composeJudges({ env: settings.environment, root: ROOT, queue, mirrorsRoot: workdirRoot() });
  /* The score metrics sink makes the grades visible in Grafana; the Langfuse mirror stays optional and human-facing. */
  const scoreMetricsSink = new ScoreMetricsSink({
    telemetry: telemetry.telemetry,
    appOf: (runId) => getHistory().runs.getRecord(runId)?.app,
    verdictOf: (runId) => getHistory().learning.getRunOutcome(runId)?.verdict ?? getHistory().runs.getRecord(runId)?.verdict,
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
  const runViewDeps = defaultRunViewDeps(() => telemetry.health().mode !== "off", settings.environment);
  const hostHealth = new HostHealth({ telemetry: telemetry.telemetry, ...(sandboxIdentity ? { sandboxUid: sandboxIdentity.uid } : {}) });
  hostHealth.start();
  /* Loki, Tempo and the collectors verified end to end; off with telemetry. Probe addresses come from QA_TELEMETRY_*_URL(S). */
  const backendHealth = telemetry.health().mode === "off" ? undefined : new BackendHealthMonitor({ config: settings.telemetry.backendHealth, fetch: systemBackendFetch, now: () => Date.now() });
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
  const AUTONOMOUS_MAINTAINER = settings.maintainer.autoMerge;

  const port = settings.server.port;
  const listenHost = settings.server.listenHost;
  const secret = settings.webhook.secret;

  /*
   * API token: env var wins. If absent, reuse the persisted file (data/.api_token, src/server/api-token.ts) so the
   * TUI can discover it across restarts. Only generate a new one if neither exists. The file an earlier version kept in
   * config/ is removed either way, and a copy that cannot be removed stops the start.
   */
  const apiToken: string = settings.auth.apiToken ?? loadOrCreateApiToken(ROOT);

  /*
   * Session signing secret for GitHub-user logins. Reuses QA_API_TOKEN by default (one secret
   * to manage), or a dedicated AUTH_SIGNING_KEY when an operator wants to rotate sessions
   * independently of the machine token. Sessions live AUTH_SESSION_TTL_SECONDS (default 24h).
   */
  const signingSecret = settings.auth.signingKey ?? apiToken;
  const AUTH_SESSION_TTL_SECONDS = settings.auth.sessionTtlSeconds;

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
  const ALLOW_UNSIGNED_WEBHOOK = settings.webhook.allowUnsigned;
  if (!secret && !ALLOW_UNSIGNED_WEBHOOK) {
    console.warn(
      "[qa] CRITICAL: WEBHOOK_SECRET is not set — webhook POSTs will be REJECTED. " +
        "Set WEBHOOK_SECRET, or set WEBHOOK_ALLOW_UNSIGNED=true to accept unsigned webhooks (local only).",
    );
  }


  const eventStreamController = new AbortController();
  /* The one SIGTERM/SIGINT pair: cancels the in-flight run, drains, flushes telemetry and exits (src/server/shutdown.ts). */
  const lifecycle = installShutdown({
    queue,
    telemetry: { flush: () => telemetry.telemetry.flush(), shutdown: (timeoutMs) => telemetry.shutdown(timeoutMs) },
    hostHealth,
    eventStream: eventStreamController,
    drainMs: settings.server.drainMs,
    telemetryShutdownMs: TELEMETRY_SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
  });
  installUnhandledRejectionRecorder(
    (summary) => recordIncident({ source: "qa-author", severity: "error", summary }),
    (message) => console.error(message),
  );
  const agentRuntime = createAgentRuntimeManager({
    env: settings.environment,
    fs: defaultEnvStoreFs(),
    strategies: {
      opencode: new OpenCodeRuntimeStrategy({ env: settings.environment }),
    },
    hasOpenSessions: () => getOpenSessionCount() > 0,
  });

  logAgentConfigWarnings([
    ...validateAgentRuntimeConfig(agentRuntime.current(), keyPresence(settings.environment)).warnings,
    ...retiredSelectorWarnings(settings.environment),
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
  const suiteHoldsVerifiedLogin = suiteHoldsVerifiedLoginFor(settings.environment, ROOT);

  /* The question behind the context-map rebuild before a run; absent under QA_CAMPAIGN_FREEZE. */
  const contextMapNeedsRebuild = contextMapNeedsRebuildFor(settings.environment);

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
    if (lifecycle.shuttingDown()) return "";
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
  const orphanBrowsers = sweepOrphanAgentBrowsers(execWorkRoot(settings.environment));
  if (orphanBrowsers > 0) logJson("warn", `stopped ${orphanBrowsers} agent browser process(es) a previous orchestrator process left behind`);
  /* The workspaces of a run's sidekicks that a previous process never removed. */
  void new FsDelegationWorkspaceAdapter({ root: join(workdirRoot(), DELEGATIONS_DIR) }).sweepAll().then(
    (swept) => { if (swept > 0) logJson("warn", `removed ${swept} sidekick workspace(s) a previous orchestrator process left behind`); },
    (err: unknown) => logJson("error", `sweeping the sidekick workspaces failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  const toolsPort = settings.server.toolsPort;
  const toolsToken = resolveToolsToken(settings.environment);
  if (toolsToken.generated) logJson("warn", "QA_TOOLS_TOKEN is not set: no run is granted the run_spec or authenticated browser tools until the same value is set on the orchestrator and agents services");
  /* What every run records of the process around it (its effectiveConfig): the agent runtime, the prompt layers, the tool grants and the operator switches, each read where it is configured. */
  /* Memoised for the process's life: editing a prompt file needs a restart to show in later runs' effectiveConfig (docs/observability-design.md section 14). */
  let staticPromptHash: string | null | undefined;
  runConfigEnvironment = {
    runtime: () => agentRuntime.current().assignments.primary.provider,
    staticPromptHash: () => (staticPromptHash === undefined ? (staticPromptHash = hashStaticPrompts(ROOT)) : staticPromptHash),
    toolsGranted: !toolsToken.generated,
    reflectorEnabled: settings.agent.reflectorEnabled,
    campaignFrozen: settings.run.campaignFrozen,
    maxCapture: settings.telemetry.config.maxCapture,
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
    setShuttingDown: (v) => lifecycle.setShuttingDown(v),
    root: ROOT,
    selfRepo: SELF_REPO,
    autonomous: AUTONOMOUS_MAINTAINER,
    port,
  });
  const { triggerMaintainer, confirmSwapAfterBoot, recoverMaintainerState, recoverRollbackRecord } = maintainer;

  /* One path for the control API and the webhook; the trigger is what tells their runs apart in the trace. */
  function enqueueRunFrom(trigger: "api" | "webhook", request: ApiRunRequest): string {
    if (lifecycle.shuttingDown()) {
      console.warn(`[qa] rejecting run ${request.app}@${request.sha} — shutting down`);
      return "";
    }

    return enqueueTrackedRun(queue, { ...request, source: "webhook", trigger }, runnerDeps());
  }

  const enqueueApiRun: ApiDeps["enqueue"] = (request) => enqueueRunFrom("api", request);
  const enqueueWebhookRun: ApiDeps["enqueue"] = (request) => enqueueRunFrom("webhook", request);

  /*
   * Orphan-session sweep threshold. Must always exceed the longest possible agent
   * turn: when an operator raises OPENCODE_TIMEOUT_MS above 30 min, a live session
   * would otherwise be deleted mid-prompt. The 5-min buffer covers dispose/teardown.
   */
  const MAX_SESSION_AGE_MS = Math.max(
    30 * 60 * 1000,
    (settings.agent.timeoutMs ?? 0) + 5 * 60 * 1000,
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
      counts = getHistory().runs.runVerdictCounts();
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
        mirrorRoot: () => settingsStore.current().git.mirrorDir ?? join(ROOT, ".mirrors"),
        getDirectorySize,
      },
      artifactSizeCache,
      ARTIFACT_SIZE_TTL_MS,
      Date.now(),
    );
    if (artifactBlock) lines.push(artifactBlock);
    return lines.join("\n");
  }

  /* Deletes the history the retention windows no longer keep. A failure is logged and never stops the process. */
  function runHistoryRetention(): void {
    try {
      const report = pruneHistory(getHistoryDatabase(), retentionPolicyFrom(settings.retention), Date.now());
      logJson("info", "history retention pruned", { report });
    } catch (err) {
      logJson("error", "history retention failed", { error: redactionPort.redactError(err) });
    }
  }
  function startPoller(): void {
    startHealthPoller({
      port,
      fetch: (url) => fetch(url),
      queueSize: () => queue.size,
      recordIncident,
      hasPendingIncidents: () => getIncidents().some((i) => i.status === "pending"),
      maintainerIdle: () => getMaintainerStatus() === "idle",
      triggerMaintainer: () => void triggerMaintainer(),
      cleanupOrphanedSessions,
      runHistoryRetention,
      backupDatabase: () => backupDatabase(getHistoryDatabase()),
      pruneMirrors: () => void pruneMirrors(defaultMirrorPruneDeps(() => queue.current)),
      log: logJson,
    });
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
    deleteMirror: (repo) => rmSync(join(settingsStore.current().git.mirrorDir ?? join(ROOT, ".mirrors"), repo.replaceAll("/", "__")), { recursive: true, force: true }),
    deleteHistory: (app) => getHistory().purgeApp(app),
    deleteAuthMaterial: (app) => rmSync(appAuthDir(ROOT, app), { recursive: true, force: true }),
    deleteSuiteStore: (app) => deleteSuiteStoreDir(appSuiteStoreDir(ROOT, app)),
    deleteCodeGraphCache: (app) => rmSync(join(qayabaDataDir(), "code-graph", app), { recursive: true, force: true }),
    applyEnv: (vars) => {
      const applied = applyEnvVars(vars, { fs: defaultEnvStoreFs(), env: settings.environment });
      try {
        settingsStore.reload();
      } catch (err) {
        logJson("error", "the applied variables do not form valid settings; the previous settings stay in force", { error: redactionPort.redactError(err) });
      }
      return applied;
    },
    loadApp: (name) => loadAppConfig(name),
    readConfig: (name) => readFileSync(join(ROOT, "config", "apps", `${name}.yaml`), "utf8"),
    env: settings.environment,
  };

  /*
   * Build the period-over-period TrendsView for an app from one outcomes read. The trends and report
   * deps both route through this so the read logic — and the `100` window literal — live in one place
   * instead of being duplicated at each site; each call performs its own read (trends and report are
   * separate HTTP requests, so there is no cross-request reuse).
   */
  const buildTrends = (app: string, window?: number) =>
    toTrendsView({ app, outcomes: getHistory().learning.listRunOutcomes(app, 100), records: getHistory().runs.listRecords(app, 100), now: new Date().toISOString(), window });


  function opencodeConfigPath(): string {
    return settingsStore.current().agent.configPath ?? join(ROOT, "agents", "opencode.json");
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
  const onboardingSandbox = resolveCodeSandbox(settings.environment);
  const onboardingExec = buildScriptExec(settings.environment, onboardingSandbox, egressGateFor(settings.environment, onboardingSandbox));
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
      const running = getHistory().runs.currentRun();
      return queue.size > 0 || (running !== undefined && running.status === "running");
    },
    ensureMirrorAtBranch: (repo, baseBranch) =>
      ensureMirrorAtBranch(repo, baseBranch, defaultMirrorDeps),
    hasOpencodeApiKey: () => Boolean(settings.environment.OPENCODE_API_KEY),
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
      if (lifecycle.shuttingDown()) return "";
      const sha = await getHeadSha(mirrorDir, defaultMirrorDeps);
      /*
       * The SQLite context_maps store (ContextRepository, wired via ContextMapCapturePort) is the map's
       * durability mechanism — it captures the validated map on every clean context-mode pass
       * regardless of shadow, so the map survives the next mirror wipe without a context.json PR.
       */
      return enqueueContextMapRun(queue, app, sha, runnerDeps());
    },
    getContextRun: (runId) => {
      const rec = getHistory().runs.getRecord(runId);
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
      if (lifecycle.shuttingDown()) return "";
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
    bootstrapLogin: (app, sha) => (lifecycle.shuttingDown() ? "" : enqueueLoginBootstrapRun(queue, app, sha, runnerDeps())),
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
    getRecord: (id) => getHistory().runs.getRecord(id),
    listRecords: (app, limit) => getHistory().runs.listRecords(app, limit),
    currentRun: () => getHistory().runs.currentRun(),
    intelligence: loadIntelligenceView,
    /* Read-only stored FE<->BE architecture map. null (no row yet) -> the route 404s. */
    contextMap: (app) => {
      const stored = getHistory().contexts.loadContextMap(app);
      if (!stored) return null;
      return { app, map: stored.data, builtAtSha: stored.builtAtSha, updatedAt: stored.updatedAt };
    },
    signals: () => toSignalsView(
      listAppConfigs().map((a) => ({ scorecard: getHistory().learning.loadScorecard(a.name), runs: getHistory().runs.listRecords(a.name, 50), outcomes: getHistory().learning.listRunOutcomes(a.name, 50) })),
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
      const rec = getHistory().runs.getRecord(runId);
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
      const records = getHistory().runs.listRecords(rec.app, 200).filter((r) => r.at <= rec.at);
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
    githubClientId: settings.auth.githubOAuthClientId,
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
    localLogin: createLocalConsoleLogin(settings.environment, signingSecret, AUTH_SESSION_TTL_SECONDS),
    agentRuntime,
    /*
     * Cancel through the single funnel (runner.ts): aborts a live run we hold, and ALSO finalizes
     * an enqueued or stale "running" record so the operator's stop always clears the run — never
     * leaving a zombie stuck at "0%" answering 409 to every stop press. queue.cancel(id) inside it
     * protects an innocent successor (it aborts only when the id matches the active run).
     */
    cancelRun: (id) => cancelTrackedRun(queue, id, { runEvents, afterRun }),
    /* Continuations run on the active agent runtime, exactly like the webhook path above. */
    continuation: {
      maxDepth: MAX_CONTINUATION_DEPTH,
      depth: (parent) => getHistory().runs.continuationDepth(parent),
      enqueue: ({ parent, fixCases, guidance }) => {
        if (lifecycle.shuttingDown()) return "";
        return enqueueTrackedRun(queue, {
          app: parent.app,
          sha: parent.sha,
          target: parent.target,
          mode: parent.mode,
          guidance,
          fixCases,
          parentRunId: parent.id,
          source: "manual",
          trigger: "continuation",
        }, runnerDeps());
      },
    },
  };

  const toolsHost = resolveToolsListenHost(settings.environment, listenHost);

  /* The control plane as a value (src/server/create-app.ts): nothing listens until the caller asks. */
  const app = createApp({
    control: {
      authorize: authorized,
      metrics: () => generatePrometheusMetrics(queue, getOpenSessionCount()),
      maintainer: (req, res) => handleMaintainerApi(req, res, triggerMaintainer),
      api: (req, res) => routeApi(req, res, apiDeps),
      dashboard: (req, res) => serveDashboard(req, res, { dir: resolveDashboardDir(ROOT) }),
      shouldLogApiRequest,
      log: logJson,
      now: Date.now,
    },
    /* Deliveries on any non-API path: fail closed without a secret, signature check, one run per dispatched app. */
    webhook: {
      secret,
      allowUnsigned: ALLOW_UNSIGNED_WEBHOOK,
      catalog: appCatalog,
      enqueue: enqueueWebhookRun,
      shuttingDown: () => lifecycle.shuttingDown(),
      log: logJson,
    },
    toolsServer,
    lifecycle,
    listen: { port, host: listenHost, toolsPort, toolsHost, apiAuthOn: Boolean(apiToken) },
    onListening: () => {
      /*
       * Make global fetch proxy-aware (HTTP(S)_PROXY/NO_PROXY) from boot, before any GitHub API or
       * health call. No-op when no proxy is configured. (A per-run build refines the timeouts.)
       */
      const startupTimeout = settings.agent.timeoutMs ?? 900_000;
      installHttpDispatcher(startupTimeout).catch((err) => logJson("warn", "HTTP dispatcher setup failed", { error: err instanceof Error ? err.message : String(err) }));
      /*
       * Start the SSE event stream from OpenCode so agent activity (tool calls,
       * file edits, streaming text) is routed to RunRecord logs in real time.
       */
      agentRuntime.facade().startEventStream?.(
        (a) => {
          /* Structured event → the live TUI panel; display line → the human log feed. */
          getHistory().runs.appendActivity(a.runId, { kind: a.kind, text: a.text, status: a.status });
          getHistory().runs.appendLog(a.runId, a.display);
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
      startPoller();
      recoverMaintainerState();
    },
    log: logJson,
    exit: (code) => process.exit(code),
    redact: (err) => redactionPort.redactError(err),
  });

  return {
    app,
    /*
     * Finalize zombie runs from a previous process BEFORE accepting traffic: a webhook
     * landing during boot creates a legitimate `enqueued` record that a late sweep would
     * wrongly finalize as infra-error.
     */
    beforeListen: () => {
      runHistoryRetention();
      finalizeInterruptedRuns({ runEvents, afterRun });
    },
  };
}

/*
 * The single funnel for starting a run. EVERY trigger — webhook, control API, and
 * the CLI — goes through here, so there is exactly ONE queued, recorded,
 * API-addressable entity per run. This is what makes "the control API is the single
 * contract" actually true: nothing may start a pipeline that bypasses the sequential
 * queue (which would run concurrent QA against DEV) or the run history (which would be
 * invisible to the TUI/continue/chat).
 */

import { appLogger } from "../telemetry/redacting-logger";
import { JobQueue } from "./queue";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { assertUniformCapture, CAMPAIGN_CAPTURE_MODE, requestedCaptureMode, specCountsOf } from "@contexts/evaluation/application/index";
import { serializablePhases, type RunFactsPatch } from "../persistence/repositories/run.repository";
import {
  ONBOARDING_POLL_MS,
  ONBOARDING_WAIT_MAX_MS,
  PendingChangeSets,
  PreworkMemory,
  RunTrace,
  SYSTEM_CLOCK,
  UNKNOWN_RUN_CONFIG_ENVIRONMENT,
  changeEntryOf,
  contextMapRebuildRequest,
  contextMapRequest,
  declaredReposOf,
  declaresRepo,
  isCoalescible,
  liveAnnouncement,
  loginBootstrapRequest,
  markEnqueued,
  mayBePreceded,
  mayHaveLeftTestData,
  needsLoginBootstrap,
  onboardingWaitStep,
  phaseSnapshotOf,
  runCrashEnding,
  runFactsOfCrash,
  runFactsOfOutcome,
  runIdentityOf,
  sourceOfTrigger,
  terminalCaseEvent,
  withTurnLimits as withTurnLimitsOf,
  type DeclaredRepos,
  type LiveAnnouncedStatus,
  type RunFacts,
  type RunTrigger,
} from "@contexts/run-orchestration/application/index";
import { testDataNamespace } from "./test-data";
import { RunMode, TestTarget, TriggerSource, QaCase, QaRunResult, engineStatus, type RunChangeEntry } from "../persistence/types";
import { RedactionPortAdapter } from "../telemetry/sanitizer";
import { sleep as sleepWithAbort } from "./sleep";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "@kernel/contract/events";
import { Sha } from "@kernel/sha";
import { ChangeSet, anchorProjection, type ChangeEntry } from "@contexts/change-analysis/application/index";
import type { RunPurpose } from "@kernel/run-mode";
import type { CampaignIdentity } from "./contract/campaign";
import { capCaptureMode, type CaptureMode } from "@kernel/telemetry/capture-mode";
import { decideRunFreeze, type RunFreeze } from "./run-freeze";
import { configInEffect, resolveRunConfig, type RunConfigEnvironment, type StoredRunConfig } from "./effective-config";
import type { GroundingInput } from "./contract/commands";
import { ENGINE_VERSION } from "./version";
import { hostListeners } from "../telemetry/host-listeners";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import type { RunPipelinePort, RunInput, ObserverPort } from "@contexts/run-orchestration/application/index.ts";
import { getHistory } from "../persistence/index";

type RunStepEvent = Extract<RunEventBody, { type: "step.changed" }>;
type RunStep = RunStepEvent["step"];


const redactionPort = new RedactionPortAdapter();

/* The pre-run work this process has already done: the login bootstraps it queued and the context maps it rebuilt. */
const prework = new PreworkMemory();

export interface RunRequest {
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  guidance?: string;
  shadow?: boolean;
  source?: TriggerSource;  /* "webhook" (default) | "manual" */
  trigger?: RunTrigger;  /* what started the run, for its trace; absent: "api" for a manual source, "webhook" otherwise */
  fixCases?: QaCase[]; 
  parentRunId?: string;  /* continuation: the run this continues */
  triggerRepo?: string;  /* cross-repo runs: the service repo whose commit originated this run */
  previousNamespace?: string;  /* cleanup: namespace from an interrupted previous run */
  commits?: number;  /* diff mode: how many commits ending at the SHA the diff spans (default 1) */
  baseSha?: string;  /* PR/push range: when set, diff spans baseSha..sha (range diff) */
  purpose?: RunPurpose;  /* why the run was started, when it is not a change to test (login bootstrap) */
  closedLoop?: boolean;  /* the run's own choice about the run_spec loop (an A/B arm), overriding the app's setting */
  agentBrowser?: boolean;  /* the run's own choice about the authenticated agent browser (an A/B arm), overriding the app's setting */
  grounding?: GroundingInput;  /* the run's own choice of grounding sources (an A/B arm), overriding the app's settings */
  /* The campaign replicate this run is. Stored and traced as data; its labels are never passed to the engine. Its presence freezes the run (run-freeze.ts). */
  campaign?: CampaignIdentity;
  /* The content capture the run's trace was granted: the request's choice already capped by the server's ceiling. Absent: the process default. */
  captureMode?: CaptureMode;
}

/* Side-effecting collaborators, injected so the funnel is unit-testable with stubs. */
export interface RunnerDeps {
  /* The process's telemetry port and the wall clock it was built on. Absent: the run is not traced. */
  telemetry?: TelemetryPort;
  clock?: TelemetryClock;
  /*
   * Told once per run, after its trace has ended and its record is final (done by the run, a crash or a cancel). The evaluation
   * grader hangs here. It is never awaited and a fault in it is only said: it can neither delay the next run nor change how this one ended.
   */
  afterRun?: (runId: string) => void | Promise<void>;
  /* The process-level facts a run's effectiveConfig records (agent runtime, static prompt hash, tool grants, switches). Absent: those are recorded as unknown. */
  runConfig?: RunConfigEnvironment;
  loadApp?: (name: string) => AppConfig;  /* defaults to the real config loader */
  /* The change sets of queued runs: present, a webhook push of an app joins a run of that app still waiting in the queue (see pending-change-sets.ts). Absent: every push is a run of its own. */
  pendingChangeSets?: PendingChangeSets;
  runEvents?: RunEventStore;

  engineFactory?: (
    appConfig: AppConfig,
    namespace: string,
    run: { mode: RunMode; guidance?: string; triggerRepo?: string; changeSet?: ChangeSet; sha?: string; runId?: string; grounding?: GroundingInput | StoredRunConfig["grounding"]; freeze?: RunFreeze },
    observer?: ObserverPort,
    previousNamespace?: string,
  ) => RunPipelinePort;


  isOnboardingActive?: () => boolean;
  /*
   * Whether the app's suite store holds a login a run proved. Present: a run for an e2e app that declares a login and whose store
   * holds none is preceded by that app's login bootstrap (once per app and process, see enqueueTrackedRun), unless the request is
   * frozen (a campaign keeps control of the suite's warmth, run-freeze.ts). May throw: the question then costs the requested run
   * nothing but the bootstrap.
   */
  suiteHoldsVerifiedLogin?: (app: string) => boolean;
  /*
   * Whether the app's context map fails to describe the commit a run is at. Present: such a run executes a context run at its sha
   * first, in its own queue turn (once per app and commit, see rebuildContextMapFirst), unless the request is frozen (a campaign keeps
   * its map fixed, run-freeze.ts). May reject: the run then goes on with the stored map.
   */
  contextMapNeedsRebuild?: (app: string, sha: string) => Promise<boolean>;
  /*
   * Test/ops seam: override the poll granularity and defensive upper bound (the context's defaults
   * ONBOARDING_POLL_MS / ONBOARDING_WAIT_MAX_MS). Production never overrides these.
   */
  onboardingPollMs?: number;
  onboardingWaitMaxMs?: number;
  /*
   * Test seam: override the signal-aware sleep the poll loop awaits (module default is the real
   * util/sleep.ts implementation). Production never overrides this.
   */
  sleep?: (ms: number, opts?: { signal?: AbortSignal }) => Promise<void>;
}


function buildRunObserver(runId: string, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): ObserverPort {
  return {
    onStep(step: RunStep, detail?: string): void {
      try {
        getHistory().runs.updateRecord(runId, { step, stepDetail: detail ?? null, retrying: step === "retry" });
        runEvents?.publish(runId, { type: "step.changed", step, detail });
      } catch (err) {
        appLogger.error("[qa] observer onStep failed (non-fatal, run continues):", { error: err });
      }
    },
    onEvent(body: RunEventBody): void {
      try {
        const announced = liveAnnounced ? liveAnnouncement(body) : undefined;
        if (liveAnnounced && announced) liveAnnounced.set(announced.name, announced.status);
        runEvents?.publish(runId, body);
      } catch (err) {
        appLogger.error("[qa] observer onEvent failed (non-fatal, run continues):", { error: err });
      }
    },
  };
}

function assertTriggerRepoDeclared(appConfig: AppConfig, triggerRepo: string | undefined): void {
  if (!triggerRepo) return;
  if (!declaresRepo(declaredReposOf(appConfig.name, appConfig), triggerRepo)) {
    throw new Error(`trigger repo ${triggerRepo} is not a declared service of app ${appConfig.name}`);
  }
}


function recordCase(runId: string, c: QaCase, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): void {
  getHistory().runs.addCase(runId, c);
  getHistory().runs.appendActivity(runId, { kind: "todo", text: c.name, status: "completed" });
  const event = terminalCaseEvent(c, liveAnnounced?.get(c.name));
  if (event) runEvents?.publish(runId, event);
}

/* What the run delivered, for the root span: the same counts the run view and the graders read. Fail-open: observability never changes how a run ends. */
function specCountsForTrace(runId: string, furthestPhase: string | null): RunFacts["specs"] {
  try {
    const current = getHistory().runs.getRecord(runId);
    if (!current) return undefined;
    return specCountsOf(current, getHistory().runs.listSpecSnapshots(runId), furthestPhase);
  } catch (err) {
    appLogger.error(`[qa] the spec counts of run ${runId} could not be read for its trace (the run is unaffected): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/* The run's facts with the limits its agent turns ended on added (withTurnLimits of the engine); the record and the root span both take the result. Fail-open like the other reads for the trace: a history that cannot answer leaves the engine's own. */
function withTurnLimits<F extends Pick<RunFacts, "limits" | "limitFired" | "limitRole">>(facts: F, runId: string): F {
  try {
    return withTurnLimitsOf(facts, getHistory().telemetry.getTurnLimits(runId));
  } catch (err) {
    appLogger.error(`[qa] the limits the turns of run ${runId} ended on could not be read (the engine's own are kept): ${err instanceof Error ? err.message : String(err)}`);
    return facts;
  }
}

/* The facts a run's record keeps of how it ended: the ones the root span states, in the same words. A key the run did not record is stored as unknown (null), never as a default. */
function recordedFacts(facts: Omit<RunFacts, "verdict" | "errorClass">): RunFactsPatch {
  return {
    decision: facts.decision ?? null,
    shadowed: facts.shadowed ?? null,
    limitFired: facts.limitFired ?? null,
    limitRole: facts.limitRole ?? null,
    limits: facts.limits ? [...facts.limits] : null,
    degradations: facts.degradations ? [...facts.degradations] : null,
    reviewRequired: facts.reviewRequired ?? null,
    timeBudget: facts.timeBudget ?? null,
    coverageStatus: facts.coverage?.status ?? null,
    coverageMode: facts.coverage?.mode ?? null,
    coverageMinRatio: facts.coverage?.minRatio ?? null,
  };
}

async function runViaEngine(
  port: RunPipelinePort,
  req: RunRequest,
  runId: string,
  signal: AbortSignal,
  appConfig: AppConfig,
  runEvents: RunEventStore | undefined,
  liveAnnounced?: Map<string, LiveAnnouncedStatus>,

  previousNamespace?: string,
  /* The set the run took from the queue's registry when other pushes joined it; absent: the request's own single entry. */
  joinedChangeSet?: ChangeSet,
): Promise<QaRunResult & { phases?: { furthestPhase: string; phaseTimings: Record<string, number> }; facts: RunFacts }> {
  assertTriggerRepoDeclared(appConfig, req.triggerRepo);
  const changeSet = joinedChangeSet ?? ChangeSet.of(req.app, [changeEntryOf(req, appConfig.repo)]);
  const projection = anchorProjection(changeSet);
  const input: RunInput = {
    app: req.app,
    changeSet,
    sha: projection.sha,
    source: req.source ?? "webhook",
    mode: req.mode,
    target: req.target,
    runId,
    ...(req.guidance ? { guidance: req.guidance } : {}),
    ...(projection.triggerRepo ? { triggerRepo: projection.triggerRepo } : {}),
    ...(previousNamespace ? { previousNamespace } : {}),
    ...(projection.baseSha ? { baseSha: projection.baseSha } : {}),

    ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
    ...(req.purpose ? { purpose: req.purpose } : {}),
    ...(req.closedLoop !== undefined ? { closedLoop: req.closedLoop } : {}),
    ...(req.agentBrowser !== undefined ? { agentBrowser: req.agentBrowser } : {}),
  };
  const outcome = await port.run(input, signal);

  const cases = outcome.cases ?? [];
  for (const c of cases) {
    recordCase(runId, c, runEvents, liveAnnounced);
  }

  if (outcome.gateSignals.reviewerApproved !== undefined) {
    runEvents?.publish(runId, {
      type: "reviewer.verdict",
      approved: outcome.gateSignals.reviewerApproved,
      reasons: outcome.gateSignals.reviewerCorrections,
    });
  }
  const facts = runFactsOfOutcome(outcome);
  return {
    facts: withTurnLimits(facts, runId),
    sha: outcome.sha,
    verdict: outcome.verdict,
    passed: outcome.verdict === "pass",
    cases,
    logs: outcome.logs ?? "",
    /* The note is an engine-written text that reaches the record, the verdict event and the API: the shell redacts it where it takes it over. */
    ...(outcome.note !== undefined ? { note: redactionPort.redact(outcome.note) } : {}),
    ...(outcome.gateSignals.furthestPhase !== undefined ? { phases: { furthestPhase: outcome.gateSignals.furthestPhase, phaseTimings: outcome.gateSignals.phaseTimings ?? {} } } : {}),
  };
}

/*
 * A context-map run (the FE<->BE architecture map rebuild): an e2e run in context mode at an
 * explicit sha, from a manual source, under the app's own qa.shadow. Never given a triggerRepo —
 * context mode cannot be driven from a service repo.
 */
export function enqueueContextMapRun(queue: JobQueue, app: string, sha: string, deps: RunnerDeps, parentRunId?: string): string {
  return enqueueTrackedRun(queue, contextMapRequest(app, sha, parentRunId), deps);
}

/*
 * An app onboarded before the suite store has no verified login, so its first runs start cold and author the login while they
 * do something else. When a run is enqueued for an e2e app that declares a login and the store holds none, the app's bootstrap
 * is queued first and the run follows it on the same sequential queue. Not for a run that is itself a bootstrap, a
 * context-map run (onboarding queues its own bootstrap after it), a cross-repo run (its sha belongs to the service repo) or a
 * continuation. Best effort: a question that cannot be answered says so and the run goes on.
 */
function enqueueLoginBootstrapFirst(queue: JobQueue, req: RunRequest, deps: RunnerDeps): void {
  const holds = deps.suiteHoldsVerifiedLogin;
  if (!holds || !mayBePreceded(req, decideRunFreeze(req).frozen)) return;
  if (prework.loginBootstrapWasAsked(req.app)) return;
  try {
    const app = (deps.loadApp ?? loadAppConfig)(req.app);
    if (!needsLoginBootstrap(app.auth !== undefined, () => holds(req.app))) return;
    const id = enqueueLoginBootstrapRun(queue, req.app, req.sha, deps);
    appLogger.info(`[qa] login bootstrap: ${req.app} declares a login and its suite store holds no verified one; queued ${id} ahead of this ${req.mode} run at ${req.sha.slice(0, 7)} (once per process; ask POST /api/apps/${req.app}/login-bootstrap to repeat it)`);
  } catch (err) {
    appLogger.warn(`[qa] login bootstrap for ${req.app} not queued (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * A login-bootstrap run: a manual e2e generation whose purpose is the app's login. It is accepted like any run (green, reviewed, not
 * held back by coverage), and an accepted run keeps the login and its smoke spec in the suite store, which is what makes the login a
 * verified step of onboarding. Under the app's own qa.shadow; never given a triggerRepo.
 */
export function enqueueLoginBootstrapRun(queue: JobQueue, app: string, sha: string, deps: RunnerDeps): string {
  prework.askedLoginBootstrap(app);
  return enqueueTrackedRun(queue, loginBootstrapRequest(app, sha), deps);
}

/*
 * Creates the tracked RunRecord and enqueues the pipeline on the shared queue.
 * Returns the record id immediately (the run executes asynchronously, one at a time).
 */
/* The one door the control API and the deploy webhook enter through: a request is stamped with the source its trigger implies, so the engine can tell a deploy from a replay. */
export function enqueueDoorRun(queue: JobQueue, trigger: "api" | "webhook", request: Omit<RunRequest, "source" | "trigger">, deps: RunnerDeps): string {
  return enqueueTrackedRun(queue, { ...request, source: sourceOfTrigger(trigger), trigger }, deps);
}

export function enqueueTrackedRun(queue: JobQueue, req: RunRequest, deps: RunnerDeps = {}): string {
  /* The capture a run gets is decided here, for every door: what it asked for, never above the server's ceiling. */
  const runConfigEnv = deps.runConfig ?? UNKNOWN_RUN_CONFIG_ENVIRONMENT;
  const captureMode = capCaptureMode(requestedCaptureMode(req), runConfigEnv.maxCapture);
  if (req.campaign && requestedCaptureMode(req) === CAMPAIGN_CAPTURE_MODE && captureMode !== CAMPAIGN_CAPTURE_MODE)
    appLogger.warn(`[qa] campaign '${req.campaign.id}' captures '${captureMode}', not '${CAMPAIGN_CAPTURE_MODE}': the server ceiling QA_TELEMETRY_MAX_CAPTURE is '${runConfigEnv.maxCapture}', so its prompts are not stored`);
  /* A run joins a campaign only with the capture mode its siblings have; refused before anything is queued or marked. */
  if (req.campaign) assertUniformCapture(req.campaign.id, captureMode, getHistory().runs.getCampaignCaptureMode(req.campaign.id));
  /* A push that can join a run still waiting for its turn does: that run reads it, and it needs no run, record or bootstrap of its own. */
  const declared = declaredRepos(req, deps);
  const joined = declared ? coalesceInto(req, declared, deps) : undefined;
  if (joined) return joined;
  /* After every refusal: a refused request must leave nothing behind, a queued bootstrap or a marked app included. */
  enqueueLoginBootstrapFirst(queue, req, deps);
  const run = trackRun(req, deps, captureMode, `queue: ${queue.size + 1}`);
  if (declared) deps.pendingChangeSets?.register(run.id, req, declared);
  queue.enqueue(run.execute, run.id);
  return run.id;
}

/* The repos the request's app declares, when the request could share a run and the registry is wired. A config that cannot be read means no sharing, never a failed enqueue: trackRun reports it the way it always has. */
function declaredRepos(req: RunRequest, deps: RunnerDeps): DeclaredRepos | undefined {
  if (!deps.pendingChangeSets || !isCoalescible(req)) return undefined;
  try {
    const app = (deps.loadApp ?? loadAppConfig)(req.app);
    return declaredReposOf(req.app, app);
  } catch {
    return undefined;
  }
}

/* A change entry as the run record lists it: plain strings, the way the API returns it. */
function recordedEntry(entry: ChangeEntry): RunChangeEntry {
  return {
    repo: entry.repo,
    role: entry.role,
    headSha: entry.headSha.toString(),
    ...(entry.baseSha ? { baseSha: entry.baseSha.toString() } : {}),
    ...(entry.commits !== undefined ? { commits: entry.commits } : {}),
  };
}

function coalesceInto(req: RunRequest, declared: DeclaredRepos, deps: RunnerDeps): string | undefined {
  const runId = deps.pendingChangeSets!.offer(req, declared, (id) => getHistory().runs.getRecord(id)?.status === "enqueued");
  if (!runId) return undefined;
  const repo = req.triggerRepo ?? declared.primary;
  appLogger.info(`[qa] coalesced ${repo}@${req.sha} into ${runId}`);
  const set = deps.pendingChangeSets!.joinedSet(runId);
  if (set) getHistory().runs.updateRecord(runId, { changeSet: set.entries.map(recordedEntry) });
  deps.runEvents?.publish(runId, { type: "log.line", level: "info", text: `${repo}@${req.sha} joined this run before it started` });
  return runId;
}

/*
 * Creates the tracked RunRecord and returns how to execute it. The queue executes a run in its turn; a context-map rebuild
 * executes inside the turn of the run that needed it (rebuildContextMapFirst).
 */
function trackRun(req: RunRequest, deps: RunnerDeps, captureMode: CaptureMode, where: string, insideRun = false): { id: string; execute: (signal: AbortSignal) => Promise<void> } {
  const loadApp = deps.loadApp ?? loadAppConfig;
  const runConfigEnv = deps.runConfig ?? UNKNOWN_RUN_CONFIG_ENVIRONMENT;

  /*
   * Orphan-data cleanup runs through the SINGLE funnel so EVERY trigger (webhook, CLI,
   * continuation) cleans an interrupted prior run's DEV data — not only the webhook. The
   * prior run's exact namespace is reconstructed from its record (same prefix/sha/runId).
   */
  let previousNamespace = req.previousNamespace;
  if (previousNamespace === undefined) {
    try {
      const prev = getHistory().runs.listRecords(req.app, 1)[0];
      if (prev && mayHaveLeftTestData(prev)) {
        previousNamespace = testDataNamespace(loadApp(req.app).qa.testDataPrefix, prev.sha, prev.id);
      }
    } catch {
      /* best-effort: skip cleanup if the prior record/config is unavailable */
    }
  }

  const record = getHistory().runs.createRecord({
    app: req.app, sha: req.sha, target: req.target, mode: req.mode, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo,
    ...(req.campaign ? { campaign: req.campaign } : {}),
    captureMode,
  });
  /* The engine that ran the run is a fact of the run from its first moment, so a run that crashes, is cancelled or never ends still names it. */
  getHistory().runs.updateRecord(record.id, { facts: { engineVersion: ENGINE_VERSION } });
  appLogger.info(`[qa] enqueued ${req.app}@${req.sha} mode=${req.mode}${req.parentRunId ? ` (continue of ${req.parentRunId})` : ""} (${where})`);

  /* The trace of the run: a short span here, in the caller's context, and a root of its own when the queue hands the run its turn (run-trace.ts). */
  const telemetry = guardTelemetry(deps.telemetry ?? new NoopTelemetry());
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const identity = runIdentityOf(req, { runId: record.id, engineVersion: ENGINE_VERSION, captureMode: requestedCaptureMode(req) === undefined ? undefined : captureMode });
  const enqueued = markEnqueued(telemetry, clock, identity, { root: insideRun });

  const job = async (signal: AbortSignal, trace: RunTrace): Promise<void> => {
    /* First thing at its turn: the run closes its set, so a push that arrives from here on queues a run of its own. */
    const joined = deps.pendingChangeSets?.take(record.id);
    try {
      /*
       * If the run was cancelled while still enqueued, the record is already finalized
       * (status "done"). Skip it — do NOT resurrect a cancelled run into execution.
       */
      if (getHistory().runs.getRecord(record.id)?.status === "done") {
        appLogger.info(`[qa] skipping ${req.app}@${req.sha} — cancelled before it started`);
        /* The pushes that joined it were acknowledged into this run; the cancel drops them with it, and says which. */
        if (joined) {
          const pushes = joined.entries.map((e) => `${e.repo}@${e.headSha.toString()}`).join(", ");
          appLogger.info(`[qa] cancelled run ${record.id} drops the pushes that joined it: ${pushes}`);
        }
        cancelledTrace(record.id, trace);
        return;
      }

      /*
       * Marked "running" BEFORE the mirror-race poll loop below (not after it): the queue slot is
       * genuinely held from this point on, and cancelTrackedRun's abort branch is gated on
       * record.status === "running" — moving this earlier is what makes cancellation during the
       * poll wait actually reach queue.cancel()/this callback's own AbortSignal, instead of falling
       * into the "still enqueued" finalize-without-abort branch.
       */
      getHistory().runs.updateRecord(record.id, { status: "running" });


      const isOnboardingActive = deps.isOnboardingActive ?? (() => false);
      const onboardingPollMs = deps.onboardingPollMs ?? ONBOARDING_POLL_MS;
      const onboardingWaitMaxMs = deps.onboardingWaitMaxMs ?? ONBOARDING_WAIT_MAX_MS;
      const waitForOnboarding = deps.sleep ?? sleepWithAbort;
      const waitStart = Date.now();
      const parkedAt = trace.now();
      let parkLogged = false;
      while (isOnboardingActive()) {
        /*
         * Park visibility: without this line an operator sees status "running" with no progress
         * and no run.started event for up to the wait ceiling — say WHY, once.
         */
        if (!parkLogged) {
          parkLogged = true;
          appLogger.info(`[qa] run parked: onboarding job active — waiting before mirror work (${req.app}@${req.sha})`);
        }
        const step = onboardingWaitStep(signal.aborted, Date.now() - waitStart, onboardingWaitMaxMs);
        if (step === "cancelled") break;  /* an operator cancel during the wait — handled below */
        if (step === "give-up") {
          appLogger.warn(
            `[qa] onboarding still active after ${onboardingWaitMaxMs}ms — proceeding anyway to avoid starving the QA pipeline (${req.app}@${req.sha})`,
          );
          break;
        }
        await waitForOnboarding(onboardingPollMs, { signal });
      }
      if (parkLogged) trace.onboardingWait(trace.now() - parkedAt);
      if (signal.aborted) {
        /*
         * cancelTrackedRun already finalized the record (status "done", verdict "infra-error") the
         * moment it aborted this signal — this is a NO-OP guard, not a second finalize.
         */
        appLogger.info(`[qa] skipping ${req.app}@${req.sha} — cancelled while waiting for onboarding to clear`);
        cancelledTrace(record.id, trace);
        return;
      }

      await rebuildContextMapFirst(req, record.id, deps, signal);
      if (signal.aborted) {
        appLogger.info(`[qa] skipping ${req.app}@${req.sha} — cancelled while its context map was rebuilt`);
        cancelledTrace(record.id, trace);
        return;
      }

      const appConfig = loadApp(req.app);
      deps.runEvents?.publish(record.id, { type: "run.started", app: req.app, sha: req.sha, mode: req.mode, target: req.target });
      /* Runtime shadow override from the TUI/API takes precedence over the YAML config. */
      if (req.shadow !== undefined) {
        appConfig.qa.shadow = req.shadow;
      }
      if (appConfig.qa.shadow !== undefined) trace.shadow(appConfig.qa.shadow);
      const resolvedRunConfig = recordRunConfig(record.id, appConfig, req, captureMode, runConfigEnv, trace);

      if (!deps.engineFactory) {
        throw new Error(
          "enqueueTrackedRun: RunnerDeps.engineFactory is required. " +
            "Wire src/server/run-engine-factory.ts's createRunEngineFactory(...) at the caller.",
        );
      }

      const runNamespace = testDataNamespace(appConfig.qa.testDataPrefix, req.sha, record.id);
      /*
       * Per-run observer so RunQaUseCase.onStep() reaches the same updateRecord + RunEvents.publish
       * machinery (TUI/API progress). liveAnnounced dedups live test.* announcements vs the post-hoc
       * recordCase loop so a case's terminal event publishes once, with a correcting event on divergence.
       */
      const liveAnnounced = new Map<string, LiveAnnouncedStatus>();
      const observer = buildRunObserver(record.id, deps.runEvents, liveAnnounced);
      const run = await runViaEngine(

        deps.engineFactory(
          appConfig,
          runNamespace,
          {
            mode: req.mode, runId: record.id,
            /* A run that other pushes joined is anchored on its primary entry, whichever push queued it. */
            sha: joined ? anchorProjection(joined).sha.toString() : req.sha,
            ...(req.guidance ? { guidance: req.guidance } : {}),
            ...(joined ? { changeSet: joined, ...(anchorProjection(joined).triggerRepo ? { triggerRepo: anchorProjection(joined).triggerRepo } : {}) } : req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}),
            ...(resolvedRunConfig ? { grounding: resolvedRunConfig.grounding } : {}),
            freeze: decideRunFreeze(req) },
          observer,
          previousNamespace,
        ),
        req,
        record.id,
        signal,
        appConfig,
        deps.runEvents,
        liveAnnounced,
        /*
         * Audit CRITICAL (task #33): the SAME resolved previousNamespace — threads the CleanupPort
         * gate.
         */
        previousNamespace,
        joined,
      );

      if (getHistory().runs.getRecord(record.id)?.status === "done") {
        appLogger.info(`[qa] discarding stale late resolution for ${req.app}@${req.sha} — record already finalized (cancelled)`);
        cancelledTrace(record.id, trace);
        return;
      }
      deps.runEvents?.publish(record.id, {
        type: "run.verdict",
        verdict: run.verdict,
        engineStatus: engineStatus(run.verdict),
        passed: run.cases.filter((x) => x.status === "pass").length,
        failed: run.cases.filter((x) => x.status === "fail").length,
        /*
         * What the run PRODUCED (PR/Issue URL + merged state, or the reason note) — so the
         * TUI summary shows the real outcome, not a generic guess.
         */
        ...(run.outcome || run.note ? { outcome: run.outcome ?? run.note } : {}),
      });
      getHistory().runs.updateRecord(record.id, {
        status: "done",
        verdict: run.verdict,
        step: "done",
        retrying: false,
        note: run.note || undefined,
        phases: serializablePhases(run.phases),
        facts: { traceId: trace.traceId(), ...recordedFacts(run.facts) },
        /*
         * passed/failed are NOT written here: addCase() is the single source of truth — it dedups
         * by name and recomputes both columns from the cases table on every streamed case.
         * Writing them again from the in-memory run.cases gave two writers for one derived value
         * that could silently disagree with the table they are supposed to summarize.
         */
      });
      /* After the record is written, so the trace never says more than the record does (a throw above lands in the catch, which overrides). */
      const specs = specCountsForTrace(record.id, run.facts.furthestPhase ?? null);
      trace.finished(specs ? { ...run.facts, specs } : run.facts);
      appLogger.info(`[qa] run finished ${req.app}@${req.sha}: verdict=${run.verdict}`);
    } catch (err) {

      if (getHistory().runs.getRecord(record.id)?.status === "done") {
        appLogger.info(`[qa] discarding post-cancel crash for ${req.app}@${req.sha} — record already finalized`);
        cancelledTrace(record.id, trace);
        return;
      }
      /*
       * A crash MUST finalize the record (status=done) — otherwise it stays
       * "running" forever and `qa run --watch` hangs waiting for a verdict.
       */
      const msg = redactionPort.redactError(err);
      /* One class for the run's record, its outcome, its trace root and the metric (see runCrashEnding). */
      const { errorClass, note, label } = runCrashEnding(err, msg);
      /* The engine tells where the run stood and how generation ended when it threw, on the error itself; a failure from anywhere else has nothing to add. */
      const reached = phaseSnapshotOf(err);
      const specs = specCountsForTrace(record.id, reached?.furthestPhase ?? null);
      const crashed = withTurnLimits(runFactsOfCrash(err, reached, specs), record.id);
      trace.crashed(err, errorClass, crashed);
      /* Where the run stood, stored with the final status, never apart from it. */
      const phases = reached?.furthestPhase ? serializablePhases({ furthestPhase: reached.furthestPhase, phaseTimings: reached.phaseTimings as Record<string, number> }) : undefined;
      getHistory().runs.updateRecord(record.id, { status: "done", step: "done", verdict: "infra-error", note, phases, facts: { traceId: trace.traceId(), ...recordedFacts(crashed) } });
      deps.runEvents?.publish(record.id, { type: "agent.error", detail: note });
      deps.runEvents?.publish(record.id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error") });
      appLogger.error(`[qa] run ${label} ${req.app}@${req.sha}: ${msg}`);
      /* The outcome row is what the graders and the value report read: it carries the same class the trace root and the metric just did. */
      getHistory().learning.saveCrashedRunOutcome(record, errorClass);
    }
  };

  const execute = async (signal: AbortSignal): Promise<void> => {
    /* Opened at dequeue, on a context of its own (see run-trace.ts), and ended on every path out of the job. */
    const trace = new RunTrace(telemetry, clock, identity, enqueued, hostListeners);
    try {
      await trace.within(() => job(signal, trace));
    } finally {
      trace.end();
      notifyRunFinished(deps, record.id);
    }
  };
  return { id: record.id, execute };
}

/*
 * The context map a run grounds on must describe its commit. When the injected question says the app's map does not (missing,
 * marked stale, or a file it names changed since it was built), a context run at the run's sha executes first, in this run's queue
 * turn and linked to it, so this run already reads the fresh map. Once per app and commit. Not for a run that cannot use a map: a
 * context run, a run with a purpose, a cross-repo run (its sha belongs to the service repo) or a continuation. A question
 * that cannot be answered says so and the run goes on with what the map has.
 */
async function rebuildContextMapFirst(req: RunRequest, runId: string, deps: RunnerDeps, signal: AbortSignal): Promise<void> {
  const needs = deps.contextMapNeedsRebuild;
  if (!needs || !mayBePreceded(req, decideRunFreeze(req).frozen)) return;
  if (prework.contextMapWasRebuilt(req.app, req.sha)) return;
  try {
    if (!(await needs(req.app, req.sha))) return;
  } catch (err) {
    appLogger.warn(`[qa] context map for ${req.app} not checked against ${req.sha.slice(0, 7)} (the run goes on with the stored map): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  prework.rebuiltContextMap(req.app, req.sha);
  const rebuild = trackRun(contextMapRebuildRequest(req.app, req.sha, runId), deps, capCaptureMode(req.captureMode, (deps.runConfig ?? UNKNOWN_RUN_CONFIG_ENVIRONMENT).maxCapture), `before ${runId}`, true);
  appLogger.info(`[qa] context map for ${req.app} does not describe ${req.sha.slice(0, 7)}: rebuilding it in ${rebuild.id} before ${runId}`);
  await rebuild.execute(signal);
}

/*
 * Resolves what the run starts with and keeps it on the run (and on its trace root). Observability never changes how a run ends: a fault
 * here is said loudly and the run goes on, its effectiveConfig then answering unknown.
 */
function recordRunConfig(runId: string, app: AppConfig, req: RunRequest, captureMode: CaptureMode, env: RunConfigEnvironment, trace: RunTrace): StoredRunConfig | undefined {
  try {
    const config = resolveRunConfig(app, req, captureMode, env);
    getHistory().runs.recordEffectiveConfig(runId, JSON.stringify(config));
    trace.configInEffect(configInEffect(config));
    return config;
  } catch (err) {
    appLogger.error(`[qa] the effective configuration of run ${runId} could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/* The job found its run already finalized by a cancel: the trace says cancelled, and the run keeps the trace id it has (the cancel could not know it). */
function cancelledTrace(runId: string, trace: RunTrace): void {
  trace.cancelled();
  try {
    const traceId = trace.traceId();
    if (traceId !== null) getHistory().runs.updateRecord(runId, { facts: { traceId } });
  } catch (err) {
    appLogger.error(`[qa] the trace id of cancelled run ${runId} could not be stored: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* Hands a finished run to `afterRun` without waiting for it: whatever it does, the queue moves on. */
function notifyRunFinished(deps: Pick<RunnerDeps, "afterRun">, runId: string): void {
  try {
    const pending = deps.afterRun?.(runId);
    if (pending && typeof pending.catch === "function") {
      pending.catch((err: unknown) => appLogger.error(`[qa] post-run hook failed for ${runId} (the run is unaffected): ${err instanceof Error ? err.message : String(err)}`));
    }
  } catch (err) {
    appLogger.error(`[qa] post-run hook failed for ${runId} (the run is unaffected): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * Cancels a tracked run on the shared queue, the counterpart to enqueueTrackedRun. Returns true
 * ONLY when a LIVE run was aborted (its in-flight turn interrupted via the queue's AbortSignal).
 * The subtle case this exists for: a record can read "running"/"enqueued" while the in-memory
 * queue does NOT actually hold it — a zombie left by a process restart or crash race, or an
 * operator view that lagged a queue advance. Left unfinalized, such a record would make the
 * cancel endpoint answer 409 and the stuck run would never clear, so a cancellable record is
 * ALWAYS finalized:
 * - live run we hold        → abort its turn + finalize, return true
 * - enqueued (not started)  → finalize so the queued job skips itself,       return false
 * - stale "running" zombie  → finalize so the operator's stop clears it,      return false
 * queue.cancel(id) is what protects an innocent successor: it aborts ONLY when `id` is the run
 * currently holding the queue, so finalizing a stale record never touches the run that is
 * actually executing against DEV. The boolean return + the now-terminal record together let
 * handleCancelRun answer 200 vs 409 accurately.
 */
export function cancelTrackedRun(queue: JobQueue, id: string, deps: Pick<RunnerDeps, "runEvents" | "afterRun"> = {}): boolean {
  const record = getHistory().runs.getRecord(id);
  if (!record) return false;
  if (record.status !== "running" && record.status !== "enqueued") return false;

  /* Abort the live job first — succeeds only when this id is the one holding the queue. */
  if (record.status === "running" && queue.cancel(id)) {
    finalizeUnfinished(id, "cancelled by operator", deps, true);
    return true;
  }

  /*
   * Not the live job: still enqueued (never started), or a "running" record the queue no longer
   * holds. Finalize it either way so it stops being the active run; the successor is untouched.
   */
  const note = record.status === "enqueued"
    ? "cancelled by operator"
    : "cancelled by operator (run was no longer active)";
  finalizeUnfinished(id, note, deps, true);
  return false;
}

/*
 * Finalizes a run that will never reach its own verdict — cancelled, or interrupted by a restart —
 * as infra-error, and ends its event stream with that verdict. The job of a cancelled run discards
 * its late resolution once the record is done, so this is the run's only run.verdict; without it
 * a watching client only learns the run is over by reading the record.
 */
function finalizeUnfinished(id: string, note: string, deps: Pick<RunnerDeps, "runEvents" | "afterRun">, cancelled: boolean): void {
  /* An operator's cancel is recorded as such, so grading says "cancelled" and nothing else about a run that never ran its pipeline. */
  getHistory().runs.updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note, ...(cancelled ? { facts: { cancelled: true } } : {}) });
  deps.runEvents?.publish(id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error"), outcome: note });
  notifyRunFinished(deps, id);
}

/*
 * Finalizes the runs a previous process left enqueued or running. Called at boot BEFORE traffic is
 * accepted: a webhook landing during boot creates a legitimate enqueued record that a late sweep
 * would wrongly finalize.
 */
export function finalizeInterruptedRuns(deps: Pick<RunnerDeps, "runEvents" | "afterRun"> = {}): void {
  const zombies = getHistory().runs.interruptedRecords();
  if (zombies.length === 0) {
    appLogger.info("[qa] no interrupted runs from previous process — queue is clean");
    return;
  }
  appLogger.info(`[qa] recovering ${zombies.length} interrupted run(s) from previous process...`);
  for (const r of zombies) {
    finalizeUnfinished(r.id, "process restarted — run was interrupted", deps, false);
    appLogger.info(`[qa]   finalized ${r.id} (${r.app}@${r.sha.slice(0, 7)}) as infra-error (was ${r.status}, step ${r.step ?? "unknown"})`, { ship: true });
  }
  appLogger.info(`[qa] recovery complete — ${zombies.length} run(s) marked as infra-error`);
}

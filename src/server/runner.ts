/*
 * The single funnel for starting a run. EVERY trigger — webhook, control API, and
 * the CLI — goes through here, so there is exactly ONE queued, recorded,
 * API-addressable entity per run. This is what makes "the control API is the single
 * contract" actually true: nothing may start a pipeline that bypasses the sequential
 * queue (which would run concurrent QA against DEV) or the run history (which would be
 * invisible to the TUI/continue/chat).
 */

import { JobQueue } from "./queue";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { createRecord, updateRecord, addCase, getRecord, appendActivity, listRecords, interruptedRecords, serializablePhases } from "./history";
import { traceFactsOf } from "@kernel/run-trace-facts";
import { phaseSnapshotOf } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import { recordIncident } from "./maintainer";
import { testDataNamespace } from "../qa/test-data";
import { RunMode, TestTarget, TriggerSource, QaCase, QaRunResult, engineStatus } from "../types";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { sleep as sleepWithAbort } from "../util/sleep";
import { isInfraError } from "../errors";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "../contract/events";
import { Sha } from "@kernel/sha";
import { RUN_PURPOSE, type RunPurpose } from "@kernel/run-mode";
import { isUntrustedGitTreeError } from "@kernel/domain-error";
import type { CoordinationMode } from "@kernel/coordination";
import { RunTrace, SYSTEM_CLOCK, markEnqueued, type RunFacts, type RunIdentity, type RunTrigger } from "./run-trace";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { selectEngine } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag";
import type { RunPipelinePort, RunInput, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";

type RunStepEvent = Extract<RunEventBody, { type: "step.changed" }>;
type RunStep = RunStepEvent["step"];


const redactionPort = new RedactionPortAdapter();


const ONBOARDING_POLL_MS = 5_000;

export const ONBOARDING_MIRROR_CEILING_MS = 5 * 60 * 1000;
export const ONBOARDING_JOB_CEILING_MS = 20 * 60 * 1000;
export const ONBOARDING_INDEXING_CEILING_MS = 10 * 60 * 1000;
export const ONBOARDING_WAIT_MARGIN_MS = 5 * 60 * 1000;
export const ONBOARDING_WAIT_MAX_MS =
  ONBOARDING_MIRROR_CEILING_MS + ONBOARDING_JOB_CEILING_MS + ONBOARDING_INDEXING_CEILING_MS + ONBOARDING_WAIT_MARGIN_MS;

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
  coordinationMode?: CoordinationMode;  /* the run's own choice of coordination mode (an A/B arm), overriding the app's setting */
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
  loadApp?: (name: string) => AppConfig;  /* defaults to the real config loader */
  runEvents?: RunEventStore;

  engineFactory?: (
    appConfig: AppConfig,
    namespace: string,
    run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string; sha?: string },
    observer?: ObserverPort,
    previousNamespace?: string,
  ) => RunPipelinePort;


  isOnboardingActive?: () => boolean;
  /*
   * Whether the app's suite store holds a login a run proved. Present: a run for an e2e app that declares a login and whose store
   * holds none is preceded by that app's login bootstrap (once per app and process, see enqueueTrackedRun). Absent: no run queues
   * one on its own, which is how a campaign (QA_CAMPAIGN_FREEZE) keeps control of the suite's warmth. May throw: the question then
   * costs the requested run nothing but the bootstrap.
   */
  suiteHoldsVerifiedLogin?: (app: string) => boolean;
  /*
   * Test/ops seam: override the poll granularity and defensive upper bound (module defaults
   * ONBOARDING_POLL_MS / ONBOARDING_WAIT_MAX_MS above). Production never overrides these.
   */
  onboardingPollMs?: number;
  onboardingWaitMaxMs?: number;
  /*
   * Test seam: override the signal-aware sleep the poll loop awaits (module default is the real
   * util/sleep.ts implementation). Production never overrides this.
   */
  sleep?: (ms: number, opts?: { signal?: AbortSignal }) => Promise<void>;
}


type LiveAnnouncedStatus = "passed" | "failed" | "flaky";


function buildRewrittenObserver(runId: string, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): ObserverPort {
  return {
    onStep(step: RunStep, detail?: string): void {
      try {
        updateRecord(runId, { step, stepDetail: detail, retrying: step === "retry" });
        runEvents?.publish(runId, { type: "step.changed", step, detail });
      } catch (err) {
        console.error("[qa] observer onStep failed (non-fatal, run continues):", err);
      }
    },
    onEvent(body: RunEventBody): void {
      try {
        if (
          liveAnnounced &&
          (body.type === "test.passed" || body.type === "test.failed" || body.type === "test.flaky") &&
          typeof (body as { name?: unknown }).name === "string"
        ) {
          const status = body.type.slice("test.".length) as LiveAnnouncedStatus;
          liveAnnounced.set((body as { name: string }).name, status);
        }
        runEvents?.publish(runId, body);
      } catch (err) {
        console.error("[qa] observer onEvent failed (non-fatal, run continues):", err);
      }
    },
  };
}

/*
 * Maps a final QaCase.status ("pass"|"fail"|"flaky") into the LiveAnnouncedStatus vocabulary
 * ("passed"|"failed"|"flaky") so recordCase can compare the store's own truth against what was last
 * announced live.
 */
function finalStatusAsAnnounced(status: QaCase["status"]): LiveAnnouncedStatus {
  return status === "pass" ? "passed" : status === "fail" ? "failed" : "flaky";
}


function assertTriggerRepoDeclared(appConfig: AppConfig, triggerRepo: string | undefined): void {
  if (!triggerRepo || triggerRepo === appConfig.repo) return;
  const declared = appConfig.services?.some((s) => s.repo === triggerRepo);
  if (!declared) {
    throw new Error(`trigger repo ${triggerRepo} is not a declared service of app ${appConfig.name}`);
  }
}


function recordCase(runId: string, c: QaCase, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): void {
  addCase(runId, c);
  appendActivity(runId, { kind: "todo", text: c.name, status: "completed" });
  const lastAnnounced = liveAnnounced?.get(c.name);
  if (lastAnnounced !== undefined && lastAnnounced === finalStatusAsAnnounced(c.status)) return;
  runEvents?.publish(runId, c.status === "pass"
    ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
    : c.status === "fail"
      ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
      : { type: "test.flaky", name: c.name, attempts: 2 });
}

async function runViaRewrittenEngine(
  port: RunPipelinePort,
  req: RunRequest,
  runId: string,
  signal: AbortSignal,
  appConfig: AppConfig,
  runEvents: RunEventStore | undefined,
  liveAnnounced?: Map<string, LiveAnnouncedStatus>,

  previousNamespace?: string,
): Promise<QaRunResult & { phases?: { furthestPhase: string; phaseTimings: Record<string, number> }; facts: RunFacts }> {
  assertTriggerRepoDeclared(appConfig, req.triggerRepo);
  const input: RunInput = {
    app: req.app,
    sha: Sha.of(req.sha),
    source: req.source ?? "webhook",
    mode: req.mode,
    target: req.target,
    runId,
    ...(req.guidance ? { guidance: req.guidance } : {}),
    ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}),
    ...(previousNamespace ? { previousNamespace } : {}),
    ...(req.baseSha ? { baseSha: Sha.of(req.baseSha) } : {}),

    ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
    ...(req.purpose ? { purpose: req.purpose } : {}),
    ...(req.closedLoop !== undefined ? { closedLoop: req.closedLoop } : {}),
    ...(req.agentBrowser !== undefined ? { agentBrowser: req.agentBrowser } : {}),
    ...(req.coordinationMode !== undefined ? { coordinationMode: req.coordinationMode } : {}),
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
  const traceFacts = traceFactsOf(outcome);
  const facts: RunFacts = {
    verdict: outcome.verdict,
    errorClass: outcome.errorClass,
    furthestPhase: outcome.gateSignals.furthestPhase,
    decision: traceFacts?.decision,
    generationEnd: traceFacts?.generationEnd,
    limitFired: traceFacts?.limitFired,
    limitRole: traceFacts?.limitRole,
    reviewRequired: traceFacts?.reviewRequired,
    coverage: traceFacts?.coverage,
  };
  return {
    facts,
    sha: outcome.sha,
    verdict: outcome.verdict,
    passed: outcome.verdict === "pass",
    cases,
    logs: outcome.logs ?? "",
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    ...(outcome.gateSignals.furthestPhase !== undefined ? { phases: { furthestPhase: outcome.gateSignals.furthestPhase, phaseTimings: outcome.gateSignals.phaseTimings ?? {} } } : {}),
  };
}

/*
 * A context-map run (the FE<->BE architecture map rebuild): an e2e run in context mode at an
 * explicit sha, from a manual source, under the app's own qa.shadow. Never given a triggerRepo —
 * context mode cannot be driven from a service repo.
 */
export function enqueueContextMapRun(queue: JobQueue, app: string, sha: string, deps: RunnerDeps): string {
  return enqueueTrackedRun(queue, { app, sha, target: "e2e", mode: "context", source: "manual", trigger: "context" }, deps);
}

/*
 * What a login-bootstrap run is told. App-agnostic: the app's login comes from its own declaration (the test account in the run's
 * environment), the page to prove it on from the app's own routes. The run is a manual generation, so the generator's login section
 * (the stock seed did not sign in) and every gate apply as for any run; the login is kept only because the run was accepted.
 */
export const LOGIN_BOOTSTRAP_GUIDANCE = [
  "Establish and prove the app's login.",
  "Make e2e/auth.setup.ts sign in with the configured test account (DEV_TEST_USER and DEV_TEST_PASS) so that the session it saves reaches the app's signed-in area.",
  "Then write one smoke spec that opens one route that needs that session and asserts something only a signed-in user sees.",
  "Write no other spec, and do not change the app's code.",
].join(" ");

/*
 * The apps whose login bootstrap this process has queued, by anyone: an operator, onboarding, or the automatic one below. It is the
 * whole of "once": a bootstrap that is pending or running is in it, and so is one that finished or failed. A failed bootstrap
 * therefore never triggers another on the next run (that would repeat the same failure on every run, each time ahead of the
 * run that was asked for); it is retried by a restart or by asking for it (POST /api/apps/{name}/login-bootstrap), and a bootstrap
 * that worked leaves a login in the store, so the question is not asked again anyway. Memory only, on purpose: nothing persistent
 * can wedge an app off a warm start.
 */
const loginBootstrapAsked = new Set<string>();

/*
 * An app onboarded before the suite store has no verified login, so its first runs start cold and author the login while they
 * do something else. When a run is enqueued for an e2e app that declares a login and the store holds none, the app's bootstrap
 * is queued first and the run follows it on the same sequential queue. Not for a run that is itself a bootstrap, a code run, a
 * context-map run (onboarding queues its own bootstrap after it), a cross-repo run (its sha belongs to the service repo) or a
 * continuation. Best effort: a question that cannot be answered says so and the run goes on.
 */
function enqueueLoginBootstrapFirst(queue: JobQueue, req: RunRequest, deps: RunnerDeps): void {
  const holds = deps.suiteHoldsVerifiedLogin;
  if (!holds || req.target !== "e2e" || req.mode === "context" || req.purpose !== undefined || req.triggerRepo !== undefined || req.parentRunId !== undefined) return;
  if (loginBootstrapAsked.has(req.app)) return;
  try {
    const app = (deps.loadApp ?? loadAppConfig)(req.app);
    if (app.code === true || app.auth === undefined || holds(req.app)) return;
    const id = enqueueLoginBootstrapRun(queue, req.app, req.sha, deps);
    console.log(`[qa] login bootstrap: ${req.app} declares a login and its suite store holds no verified one; queued ${id} ahead of this ${req.mode} run at ${req.sha.slice(0, 7)} (once per process; ask POST /api/apps/${req.app}/login-bootstrap to repeat it)`);
  } catch (err) {
    console.warn(`[qa] login bootstrap for ${req.app} not queued (the run goes on without it): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * A login-bootstrap run: a manual e2e generation whose purpose is the app's login. It is accepted like any run (green, reviewed, not
 * held back by coverage), and an accepted run keeps the login and its smoke spec in the suite store, which is what makes the login a
 * verified step of onboarding. Under the app's own qa.shadow; never given a triggerRepo.
 */
export function enqueueLoginBootstrapRun(queue: JobQueue, app: string, sha: string, deps: RunnerDeps): string {
  loginBootstrapAsked.add(app);
  return enqueueTrackedRun(queue, { app, sha, target: "e2e", mode: "manual", source: "manual", guidance: LOGIN_BOOTSTRAP_GUIDANCE, purpose: RUN_PURPOSE.LOGIN_BOOTSTRAP, trigger: "login-bootstrap" }, deps);
}

/*
 * Creates the tracked RunRecord and enqueues the pipeline on the shared queue.
 * Returns the record id immediately (the run executes asynchronously, one at a time).
 */
export function enqueueTrackedRun(queue: JobQueue, req: RunRequest, deps: RunnerDeps = {}): string {
  const loadApp = deps.loadApp ?? loadAppConfig;
  enqueueLoginBootstrapFirst(queue, req, deps);

  /*
   * Orphan-data cleanup runs through the SINGLE funnel so EVERY trigger (webhook, CLI,
   * continuation) cleans an interrupted prior run's DEV data — not only the webhook. The
   * prior run's exact namespace is reconstructed from its record (same prefix/sha/runId).
   */
  let previousNamespace = req.previousNamespace;
  if (previousNamespace === undefined) {
    try {
      const prev = listRecords(req.app, 1)[0];
      const wasInterrupted = prev && (prev.status === "running" || prev.status === "enqueued" || prev.verdict === "infra-error");
      if (wasInterrupted) {
        previousNamespace = testDataNamespace(loadApp(req.app).qa.testDataPrefix, prev.sha, prev.id);
      }
    } catch {
      /* best-effort: skip cleanup if the prior record/config is unavailable */
    }
  }

  const record = createRecord({ app: req.app, sha: req.sha, target: req.target, mode: req.mode, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo });
  console.log(`[qa] enqueued ${req.app}@${req.sha} mode=${req.mode}${req.parentRunId ? ` (continue of ${req.parentRunId})` : ""} (queue: ${queue.size + 1})`);

  /* The trace of the run: a short span here, in the caller's context, and a root of its own when the queue hands the run its turn (run-trace.ts). */
  const telemetry = guardTelemetry(deps.telemetry ?? new NoopTelemetry());
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const identity: RunIdentity = {
    runId: record.id,
    app: req.app,
    sha: req.sha,
    mode: req.mode,
    target: req.target,
    trigger: req.trigger ?? (req.source === "manual" ? "api" : "webhook"),
    parentRunId: req.parentRunId,
    triggerRepo: req.triggerRepo,
    shadow: req.shadow,
  };
  const enqueued = markEnqueued(telemetry, clock, identity);

  const job = async (signal: AbortSignal, trace: RunTrace): Promise<void> => {
    try {
      /*
       * If the run was cancelled while still enqueued, the record is already finalized
       * (status "done"). Skip it — do NOT resurrect a cancelled run into execution.
       */
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled before it started`);
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
      updateRecord(record.id, { status: "running" });


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
          console.log(`[qa] run parked: onboarding job active — waiting before mirror work (${req.app}@${req.sha})`);
        }
        if (signal.aborted) break;  /* an operator cancel during the wait — handled below */
        if (Date.now() - waitStart > onboardingWaitMaxMs) {
          console.warn(
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
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled while waiting for onboarding to clear`);
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

      selectEngine(process.env);
      if (!deps.engineFactory) {
        throw new Error(
          "enqueueTrackedRun: RunnerDeps.engineFactory is required. " +
            "Wire src/server/rewritten-engine-factory.ts's createRewrittenEngineFactory(...) at the caller.",
        );
      }

      const runNamespace = testDataNamespace(appConfig.qa.testDataPrefix, req.sha, record.id);
      /*
       * Per-run observer so RunQaUseCase.onStep() reaches the same updateRecord + RunEvents.publish
       * machinery (TUI/API progress). liveAnnounced dedups live test.* announcements vs the post-hoc
       * recordCase loop so a case's terminal event publishes once, with a correcting event on divergence.
       */
      const liveAnnounced = new Map<string, LiveAnnouncedStatus>();
      const observer = buildRewrittenObserver(record.id, deps.runEvents, liveAnnounced);
      const run = await runViaRewrittenEngine(

        deps.engineFactory(
          appConfig,
          runNamespace,
          { mode: req.mode, target: req.target, sha: req.sha, ...(req.guidance ? { guidance: req.guidance } : {}), ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}) },
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
      );

      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] discarding stale late resolution for ${req.app}@${req.sha} — record already finalized (cancelled)`);
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
      updateRecord(record.id, {
        status: "done",
        verdict: run.verdict,
        step: "done",
        retrying: false,
        note: run.note || undefined,
        phases: serializablePhases(run.phases),
        facts: {
          traceId: trace.traceId(),
          decision: run.facts.decision ?? null,
          limitFired: run.facts.limitFired ?? null,
          limitRole: run.facts.limitRole ?? null,
          reviewRequired: run.facts.reviewRequired ?? null,
          coverageStatus: run.facts.coverage?.status ?? null,
          coverageMode: run.facts.coverage?.mode ?? null,
          coverageMinRatio: run.facts.coverage?.minRatio ?? null,
        },
        /*
         * passed/failed are NOT written here: addCase() is the single source of truth — it dedups
         * by name and recomputes both columns from the cases table on every streamed case.
         * Writing them again from the in-memory run.cases gave two writers for one derived value
         * that could silently disagree with the table they are supposed to summarize.
         */
      });
      /* After the record is written, so the trace never says more than the record does (a throw above lands in the catch, which overrides). */
      trace.finished(run.facts);
      console.log(`[qa] run finished ${req.app}@${req.sha}: verdict=${run.verdict}`);
    } catch (err) {

      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] discarding post-cancel crash for ${req.app}@${req.sha} — record already finalized`);
        cancelledTrace(record.id, trace);
        return;
      }
      /*
       * A crash MUST finalize the record (status=done) — otherwise it stays
       * "running" forever and `qa run --watch` hangs waiting for a verdict.
       */
      const msg = redactionPort.redactError(err);
      /*
       * Classify by TYPE, not by substring. Genuine INFRASTRUCTURE (an InfraError or one of its
       * subclasses — deploy-gate timeout, agent unavailable or stalled — or an operator cancel) is
       * a transient, non-code condition. Anything else thrown out of the engine (a rejected git
       * push, a JSON.parse that threw, an open circuit breaker) is an UNEXPECTED INTERNAL ERROR —
       * still inconclusive, but a defect to surface, NOT silently laundered into a benign
       * "infrastructure, ignore".
       */
      const infra = isInfraError(err);
      /*
       * A working copy whose git dir is not the orchestrator's own is a SECURITY REFUSAL: nothing ran, so the
       * verdict is inconclusive, but it is neither a transient infrastructure fault nor a code defect. It is loud
       * and has its own note. It opens NO maintainer incident: the incident summary is fed to the maintainer's
       * model prompt, and the refusal names paths the sandboxed repository controls.
       */
      const refusal = isUntrustedGitTreeError(err);
      trace.crashed(err, refusal ? "security-refusal" : infra ? "E-INFRA" : "internal-error");
      const note = refusal
        ? `security refusal — the working copy's git dir is not the orchestrator's own, so no git ran: ${msg}`
        : infra
          ? msg
          : `unexpected internal error (not infrastructure — investigate): ${msg}`;
      /* The engine tells where the run stood when it threw; a failure from anywhere else has nothing to record. Stored with the final status, never apart from it. */
      const reached = phaseSnapshotOf(err);
      const phases = reached?.furthestPhase ? serializablePhases({ furthestPhase: reached.furthestPhase, phaseTimings: reached.phaseTimings as Record<string, number> }) : undefined;
      updateRecord(record.id, { status: "done", step: "done", verdict: "infra-error", note, phases, facts: { traceId: trace.traceId() } });
      deps.runEvents?.publish(record.id, { type: "agent.error", detail: note });
      deps.runEvents?.publish(record.id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error") });
      console.error(`[qa] run ${refusal ? "REFUSED (security refusal: untrusted git tree)" : infra ? "infra-error" : "CRASHED (internal error)"} ${req.app}@${req.sha}: ${msg}`);

      /*
       * Only a genuine infrastructure condition or a security refusal is exempt from a maintainer-eligible incident
       * (it must not trigger an autonomous self-modification for a non-code fault). An unexpected
       * internal error DOES record an incident so the failure is visible and not swallowed.
       */
      if (!infra && !refusal) {
        recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash for ${req.app}: ${msg}` });
      }
    }
  };

  queue.enqueue(async (signal) => {
    /* Opened at dequeue, on a context of its own (see run-trace.ts), and ended on every path out of the job. */
    const trace = new RunTrace(telemetry, clock, identity, enqueued);
    try {
      await trace.within(() => job(signal, trace));
    } finally {
      trace.end();
      notifyRunFinished(deps, record.id);
    }
  }, record.id);

  return record.id;
}

/* The job found its run already finalized by a cancel: the trace says cancelled, and the run keeps the trace id it has (the cancel could not know it). */
function cancelledTrace(runId: string, trace: RunTrace): void {
  trace.cancelled();
  try {
    const traceId = trace.traceId();
    if (traceId !== null) updateRecord(runId, { facts: { traceId } });
  } catch (err) {
    console.error(`[qa] the trace id of cancelled run ${runId} could not be stored: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* Hands a finished run to `afterRun` without waiting for it: whatever it does, the queue moves on. */
function notifyRunFinished(deps: Pick<RunnerDeps, "afterRun">, runId: string): void {
  try {
    const pending = deps.afterRun?.(runId);
    if (pending && typeof pending.catch === "function") {
      pending.catch((err: unknown) => console.error(`[qa] post-run hook failed for ${runId} (the run is unaffected): ${err instanceof Error ? err.message : String(err)}`));
    }
  } catch (err) {
    console.error(`[qa] post-run hook failed for ${runId} (the run is unaffected): ${err instanceof Error ? err.message : String(err)}`);
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
  const record = getRecord(id);
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
  updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note, ...(cancelled ? { facts: { cancelled: true } } : {}) });
  deps.runEvents?.publish(id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error"), outcome: note });
  notifyRunFinished(deps, id);
}

/*
 * Finalizes the runs a previous process left enqueued or running. Called at boot BEFORE traffic is
 * accepted: a webhook landing during boot creates a legitimate enqueued record that a late sweep
 * would wrongly finalize.
 */
export function finalizeInterruptedRuns(deps: Pick<RunnerDeps, "runEvents" | "afterRun"> = {}): void {
  const zombies = interruptedRecords();
  if (zombies.length === 0) {
    console.log("[qa] no interrupted runs from previous process — queue is clean");
    return;
  }
  console.log(`[qa] recovering ${zombies.length} interrupted run(s) from previous process...`);
  for (const r of zombies) {
    finalizeUnfinished(r.id, "process restarted — run was interrupted", deps, false);
    recordIncident({
      source: "health-check",
      severity: "warn",
      summary: `run ${r.id} (${r.app}@${r.sha.slice(0, 7)}) was interrupted by process restart`,
      detail: `Previous status: ${r.status}, step: ${r.step ?? "unknown"}`,
    });
    console.log(`[qa]   finalized ${r.id} (${r.app}@${r.sha.slice(0, 7)}) as infra-error`);
  }
  console.log(`[qa] recovery complete — ${zombies.length} run(s) marked as infra-error`);
}

/*
 * The single funnel for starting a run. EVERY trigger — webhook, control API, and
 * the CLI — goes through here, so there is exactly ONE queued, recorded,
 * API-addressable entity per run. This is what makes "the control API is the single
 * contract" actually true: nothing may start a pipeline that bypasses the sequential
 * queue (which would run concurrent QA against DEV) or the run history (which would be
 * invisible to the TUI/continue/chat). See docs/interactive-layer.md §3.1.
 */

import { JobQueue } from "./queue";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { createRecord, updateRecord, addCase, getRecord, appendActivity, listRecords } from "./history";
import { recordIncident } from "./maintainer";
import { testDataNamespace } from "../qa/test-data";
import { RunMode, TestTarget, TriggerSource, QaCase, QaRunResult, engineStatus } from "../types";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { sleep as sleepWithAbort } from "../util/sleep";
import { isInfraError } from "../errors";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "../contract/events";
import { Sha } from "@kernel/sha";
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
  fixCases?: QaCase[]; 
  parentRunId?: string;  /* continuation: the run this continues */
  triggerRepo?: string;  /* cross-repo runs: the service repo whose commit originated this run */
  previousNamespace?: string;  /* cleanup: namespace from an interrupted previous run */
  commits?: number;  /* diff mode: how many commits ending at the SHA the diff spans (default 1) */
  baseSha?: string;  /* PR/push range: when set, diff spans baseSha..sha (range diff) */
}

/* Side-effecting collaborators, injected so the funnel is unit-testable with stubs. */
export interface RunnerDeps {
  loadApp?: (name: string) => AppConfig;  /* defaults to the real config loader */
  runEvents?: RunEventStore;
  
  engineFactory?: (
    appConfig: AppConfig,
    namespace: string,
    run: { mode: RunMode; target?: TestTarget; guidance?: string; triggerRepo?: string },
    observer?: ObserverPort,
    previousNamespace?: string,
  ) => RunPipelinePort;

  
  isOnboardingActive?: () => boolean;
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
): Promise<QaRunResult> {
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
  return {
    sha: outcome.sha,
    verdict: outcome.verdict,
    passed: outcome.verdict === "pass",
    cases,
    logs: outcome.logs ?? "",
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
  };
}

/*
 * Creates the tracked RunRecord and enqueues the pipeline on the shared queue.
 * Returns the record id immediately (the run executes asynchronously, one at a time).
 */
export function enqueueTrackedRun(queue: JobQueue, req: RunRequest, deps: RunnerDeps = {}): string {
  const loadApp = deps.loadApp ?? loadAppConfig;

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

  queue.enqueue(async (signal) => {
    try {
      /*
       * If the run was cancelled while still enqueued, the record is already finalized
       * (status "done"). Skip it — do NOT resurrect a cancelled run into execution.
       */
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled before it started`);
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
      if (signal.aborted) {
        /*
         * cancelTrackedRun already finalized the record (status "done", verdict "infra-error") the
         * moment it aborted this signal — this is a NO-OP guard, not a second finalize.
         */
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled while waiting for onboarding to clear`);
        return;
      }

      const appConfig = loadApp(req.app);
      deps.runEvents?.publish(record.id, { type: "run.started", app: req.app, sha: req.sha, mode: req.mode, target: req.target });
      /* Runtime shadow override from the TUI/API takes precedence over the YAML config. */
      if (req.shadow !== undefined) {
        appConfig.qa.shadow = req.shadow;
      }
      
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
      const run: QaRunResult = await runViaRewrittenEngine(
        
        deps.engineFactory(
          appConfig,
          runNamespace,
          { mode: req.mode, target: req.target, ...(req.guidance ? { guidance: req.guidance } : {}), ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}) },
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
        /*
         * passed/failed are NOT written here: addCase() is the single source of truth — it dedups
         * by name and recomputes both columns from the cases table on every streamed case (A18).
         * Writing them again from the in-memory run.cases gave two writers for one derived value
         * that could silently disagree with the table they are supposed to summarize.
         */
      });
      console.log(`[qa] run finished ${req.app}@${req.sha}: verdict=${run.verdict}`);
    } catch (err) {
      
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] discarding post-cancel crash for ${req.app}@${req.sha} — record already finalized`);
        return;
      }
      /*
       * A crash MUST finalize the record (status=done) — otherwise it stays
       * "running" forever and `qa run --watch` hangs waiting for a verdict.
       */
      const msg = redactionPort.redactError(err);
      /*
       * Classify by TYPE, not by substring. Genuine INFRASTRUCTURE (DeployTimeout, operator
       * cancel, anything wrapped in InfraError) is a transient, non-code condition. Anything else
       * thrown out of the pipeline (an OpenCode 500, a rejected git push, a JSON.parse that threw,
       * an open circuit breaker) is an UNEXPECTED INTERNAL ERROR — still inconclusive, but a defect
       * to surface, NOT silently laundered into a benign "infrastructure, ignore".
       */
      const infra = isInfraError(err);
      const note = infra ? msg : `unexpected internal error (not infrastructure — investigate): ${msg}`;
      updateRecord(record.id, { status: "done", step: "done", verdict: "infra-error", note });
      deps.runEvents?.publish(record.id, { type: "agent.error", detail: note });
      deps.runEvents?.publish(record.id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error") });
      console.error(`[qa] run ${infra ? "infra-error" : "CRASHED (internal error)"} ${req.app}@${req.sha}: ${msg}`);

      /*
       * Only a genuine infrastructure condition is exempt from a maintainer-eligible incident
       * (it must not trigger an autonomous self-modification for a non-code fault). An unexpected
       * internal error DOES record an incident so the failure is visible and not swallowed.
       */
      if (!infra) {
        recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash for ${req.app}: ${msg}` });
      }
    }
  }, record.id);

  return record.id;
}

/*
 * Cancels a tracked run on the shared queue, the counterpart to enqueueTrackedRun. Returns true
 * ONLY when a LIVE run was aborted (its in-flight turn interrupted via the queue's AbortSignal).
 * The subtle case this exists for: a record can read "running"/"enqueued" while the in-memory
 * queue does NOT actually hold it — a zombie left by a process restart or crash race, or an
 * operator view that lagged a queue advance. The old path returned without finalizing such a
 * record, so the cancel endpoint answered 409 and the stuck run never cleared (it sat at "0%"
 * forever, deaf to every stop press). Here we ALWAYS finalize a cancellable record:
 * - live run we hold        → abort its turn + finalize, return true
 * - enqueued (not started)  → finalize so the queued job skips itself,       return false
 * - stale "running" zombie  → finalize so the operator's stop clears it,      return false
 * queue.cancel(id) is what protects an innocent successor: it aborts ONLY when `id` is the run
 * currently holding the queue, so finalizing a stale record never touches the run that is
 * actually executing against DEV. The boolean return + the now-terminal record together let
 * handleCancelRun answer 200 vs 409 accurately.
 */
export function cancelTrackedRun(queue: JobQueue, id: string): boolean {
  const record = getRecord(id);
  if (!record) return false;
  if (record.status !== "running" && record.status !== "enqueued") return false;

  /* Abort the live job first — succeeds only when this id is the one holding the queue. */
  if (record.status === "running" && queue.cancel(id)) {
    updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note: "cancelled by operator" });
    return true;
  }

  /*
   * Not the live job: still enqueued (never started), or a "running" record the queue no longer
   * holds. Finalize it either way so it stops being the active run; the successor is untouched.
   */
  const note = record.status === "enqueued"
    ? "cancelled by operator"
    : "cancelled by operator (run was no longer active)";
  updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note });
  return false;
}

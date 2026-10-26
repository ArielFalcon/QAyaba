/*
 * The shell's composition of the LLM judges (docs/observability-design.md section 11.3): when they run, where, and what status they hold.
 *
 *  - They run as LOW-PRIORITY work on the sequential queue (`JobQueue.enqueueIdle`): started only when no run is pending, never beside one,
 *    and told to yield as soon as a run is waiting. Judges share the provider quota with the runs (F7), so they never compete with one.
 *  - They run only when `QA_JUDGES_ENABLED=true`, the setup resolves (prompt version, a model that is not the generator's) and the live
 *    OpenCode server lists the `qa-judge` role. Otherwise a job refuses to run and says why, and nothing else changes.
 *  - A finished CAMPAIGN run is judged automatically; anything else is judged only on an explicit regrade naming a judge.
 *  - They are fail-open and inert: a judge never changes a verdict, a decision or an evaluation status, and its status (calibrated or
 *    experimental) is information for a reader of the catalog, never an input to any gate.
 */

import type { CalibrationStorePort, JudgeRegradePort } from "@contexts/evaluation/application/index.ts";
import type { JudgeBatchResult, JudgeWorkItem, RunJudgesUseCase } from "@contexts/evaluation/application/run-judges.use-case";
import { JUDGE_NAMES, type JudgeName, type JudgeStatus } from "@contexts/evaluation/domain/judges";
import type { JudgeSetup, JudgeSwitch } from "./judge-settings";
import { JUDGE_AGENT_NAME } from "./judge-agent";
import { DEFAULT_CALIBRATION } from "@contexts/evaluation/domain/judge-calibration";

export interface JudgeServiceDeps {
  queue: { enqueueIdle(job: (signal: AbortSignal, shouldYield: () => boolean) => Promise<void>): void };
  switch: JudgeSwitch;
  setup: JudgeSetup;
  /* Whether the live OpenCode server lists the judge role. A throw is a refusal, with its message. */
  agentAvailable: () => Promise<boolean>;
  runner: Pick<RunJudgesUseCase, "execute">;
  isCampaignRun: (runId: string) => boolean;
  runIsFinished: (runId: string) => boolean;
  calibrations: CalibrationStorePort;
  /* The model that answered the judge's newest score of the prompt in force, or undefined when it has none. */
  latestModel: (judge: JudgeName, promptVersion: string) => string | undefined;
  /* How long the live agent-list check may take before the job refuses (default 15 s): a wedged agents container must not hold the queue. */
  availabilityTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface JudgeService extends JudgeRegradePort {
  /* The runner's post-run hook: queues the judges for a finished campaign run. Never throws. */
  scheduleForRun(runId: string): void;
  /* `calibrated` only for a calibrated report of the prompt in force, on the model that is answering now. */
  statusOf(judge: JudgeName): JudgeStatus;
  /* The version of the pinned judge prompt in force; undefined when the setup is refused. */
  promptVersion(): string | undefined;
}

const key = (item: JudgeWorkItem): string => `${item.runId}\u0000${item.judge}`;

export function createJudgeService(deps: JudgeServiceDeps): JudgeService {
  const log = deps.log ?? ((m: string) => console.error(m));
  /* What waits for the idle job: one entry per (run, judge), forced when anyone asked for it by name. */
  const pending = new Map<string, JudgeWorkItem & { force: boolean }>();
  let jobQueued = false;

  const unavailable = (): string | undefined => {
    if (!deps.switch.enabled) return "judges are off (QA_JUDGES_ENABLED is not true)";
    if (!deps.setup.ok) return `judges are unavailable: ${deps.setup.reason}`;
    return undefined;
  };

  const add = (runId: string, judges: readonly JudgeName[], force: boolean): void => {
    for (const judge of judges) {
      const item = { runId, judge, force };
      const kept = pending.get(key(item));
      pending.set(key(item), { ...item, force: force || kept?.force === true });
    }
    kick();
  };

  const kick = (): void => {
    if (jobQueued || pending.size === 0) return;
    jobQueued = true;
    try {
      deps.queue.enqueueIdle(job);
    } catch (err) {
      jobQueued = false;
      log(`[judge] could not queue the judges: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const job = async (signal: AbortSignal, shouldYield: () => boolean): Promise<void> => {
    jobQueued = false;
    try {
      let available: boolean;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          available = await Promise.race([
            deps.agentAvailable(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timed out")), deps.availabilityTimeoutMs ?? 15_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        log(`[judge] not running: the agent list could not be read (${err instanceof Error ? err.message : String(err)})`);
        pending.clear();
        return;
      }
      if (!available) {
        log(`[judge] not running: the live OpenCode server does not list the ${JUDGE_AGENT_NAME} role (re-record the agent-list fixture and restart the agents container, see docs/observability-design.md section 19)`);
        pending.clear();
        return;
      }
      /* Forced and ordinary work are separate batches: a forced one re-asks what was already answered. */
      for (const force of [true, false]) {
        const batch = [...pending.values()].filter((p) => p.force === force);
        for (const item of batch) pending.delete(key(item));
        if (batch.length === 0) continue;
        const result: JudgeBatchResult = await deps.runner.execute(batch.map(({ runId, judge }) => ({ runId, judge })), { force, signal, shouldYield });
        report(result);
        if (result.stopped === "budget") {
          log(`[judge] the daily token budget is spent: ${result.remaining.length + pending.size} judgment(s) deferred; ask for them again with a regrade naming the judge`);
          pending.clear();
          return;
        }
        if (result.stopped === "yield" || result.stopped === "aborted") {
          /* Cut for a waiting run (or a drain): what was not done goes back behind it. */
          for (const item of result.remaining) pending.set(key(item), { ...item, force });
          break;
        }
      }
    } catch (err) {
      log(`[judge] the judge job failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      kick();
    }
  };

  const report = (result: JudgeBatchResult): void => {
    if (result.unparseable > 0 || result.errors > 0) log(`[judge] batch: ${result.scored} scored, ${result.unparseable} unparseable (no score), ${result.errors} error(s), ${result.notApplicable} not applicable`);
  };

  return {
    scheduleForRun(runId) {
      try {
        if (unavailable() !== undefined || !deps.isCampaignRun(runId)) return;
        add(runId, JUDGE_NAMES, false);
      } catch (err) {
        log(`[judge] could not schedule ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    unavailable,
    request(runId, judges) {
      if (unavailable() !== undefined || !deps.runIsFinished(runId)) return "unavailable-run";
      add(runId, judges, true);
      return "scheduled";
    },
    statusOf(judge) {
      if (!deps.setup.ok) return "experimental";
      const promptVersion = deps.setup.promptVersion;
      const report = deps.calibrations.latest(judge, promptVersion);
      if (!report || report.status !== "calibrated" || report.promptVersion !== promptVersion) return "experimental";
      /* A report computed with a lowered bar (a small --min-n, a lax rate) is a diagnostic, never the catalog's word. */
      const bar = report.thresholds;
      if (bar.minN < DEFAULT_CALIBRATION.minN || bar.minTpr < DEFAULT_CALIBRATION.minTpr || bar.minTnr < DEFAULT_CALIBRATION.minTnr) return "experimental";
      /* A calibration is for the model that was judged. If another model answers now, it has not been calibrated. */
      return deps.latestModel(judge, promptVersion) === report.model ? "calibrated" : "experimental";
    },
    promptVersion() {
      return deps.setup.promptVersion;
    },
  };
}

/*
 * Re-grades a set of finished runs with the current graders: by explicit run ids, by campaign, or by date. A request becomes a
 * job (pending, then running, then complete); the runs are graded one after another, yielding the event loop between runs, and a
 * run that fails is listed on the job without stopping the rest. A job only fails when it could not run at all.
 */

import { isCatalogName, isGradedName } from "../domain/grader-catalog.ts";
import { isJudgeName, type JudgeName } from "../domain/judges.ts";
import type { GradeRunUseCase } from "./grade-run.use-case.ts";
import type { RegradeJob } from "../domain/evidence.ts";
import type { RegradeJobStorePort } from "./ports/regrade-job-store.port.ts";
import type { RunSelectorPort } from "./ports/run-selector.port.ts";
import type { JudgeRegradePort } from "./ports/judge-regrade.port.ts";

export type RegradeRequest =
  | { runIds: readonly string[]; graders?: readonly string[] }
  | { campaignId: string; graders?: readonly string[] }
  | { since: string; graders?: readonly string[] };

/* The most runs one regrade job may cover, and the longest error text a job keeps per run. */
export const MAX_REGRADE_RUNS = 500;
export const MAX_JOB_ERROR_CHARS = 500;
/* A job writes its progress this often, and at its end. */
export const REGRADE_PROGRESS_EVERY = 10;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/* The request names something the engine cannot grade (an unknown grader): a client error, not a failed job. */
export class RegradeRequestError extends Error {}

export interface RegradeDeps {
  runs: RunSelectorPort;
  jobs: RegradeJobStorePort;
  grade: Pick<GradeRunUseCase, "execute">;
  /* The LLM judges. A request names one to have it re-run on the low-priority job; absent, a judge name is refused. */
  judges?: JudgeRegradePort;
  newId: () => string;
  /* Makes an error text safe to leave the system (secrets redacted). */
  sanitize?: (text: string) => string;
  now: () => string;
  /* Lets the process serve other work between two runs. */
  yieldToLoop: () => Promise<void>;
}

export class RegradeUseCase {
  constructor(private readonly deps: RegradeDeps) {}

  /* Resolves the runs and records the job; the work itself is `run(jobId)`. */
  start(request: RegradeRequest): { jobId: string; runs: number } {
    const requested = request.graders ?? [];
    const judgeNames = requested.filter(isJudgeName);
    if (judgeNames.length > 0) {
      const why = this.deps.judges ? this.deps.judges.unavailable() : "the LLM judges are not wired in this deployment";
      if (why !== undefined) throw new RegradeRequestError(`cannot regrade with a judge (${judgeNames.join(", ")}): ${why}`);
    }
    const names = requested.filter((n) => !isJudgeName(n));
    const unknown = names.filter((n) => !isCatalogName(n));
    if (unknown.length > 0) throw new RegradeRequestError(`unknown grader: ${unknown.join(", ")}`);
    const pending = names.filter((n) => !isGradedName(n));
    if (pending.length > 0) throw new RegradeRequestError(`grader not available yet (no data is recorded for it): ${pending.join(", ")}`);
    const runIds = this.resolve(request);
    if (runIds.length > MAX_REGRADE_RUNS) throw new RegradeRequestError(`the request selects ${runIds.length} runs; a regrade covers at most ${MAX_REGRADE_RUNS}`);
    const job: RegradeJob = {
      jobId: this.deps.newId(),
      status: "pending",
      runIds,
      graders: request.graders ? [...request.graders] : undefined,
      runs: runIds.length,
      graded: 0,
      failed: [],
      startedAt: this.deps.now(),
      finishedAt: undefined,
    };
    this.deps.jobs.create(job);
    return { jobId: job.jobId, runs: job.runs };
  }

  async run(jobId: string): Promise<void> {
    const { jobs, grade, now, yieldToLoop } = this.deps;
    const job = jobs.get(jobId);
    if (!job || job.status !== "pending") return;
    try {
      job.status = "running";
      jobs.update(job);
      let done = 0;
      /* The deterministic graders and the judges are separate work: a request naming only judges grades nothing deterministically. */
      const judges: JudgeName[] = job.graders?.filter(isJudgeName) ?? [];
      const graders = job.graders?.filter((n) => !isJudgeName(n));
      const gradesDeterministically = graders === undefined || graders.length > 0;
      for (const runId of job.runIds) {
        let error: string | undefined;
        if (gradesDeterministically) {
          const result = await grade.execute(runId, graders ? { graders } : {});
          if (result.status !== "complete") error = result.status === "failed" ? result.error : result.reason === "unknown-run" ? "unknown run" : "run not finished";
        }
        if (error === undefined && judges.length > 0 && this.deps.judges?.request(runId, judges) !== "scheduled") error = "run not finished or unknown to the judges";
        if (error === undefined) job.graded += 1;
        else job.failed.push({ runId, error: this.errorText(error) });
        done += 1;
        if (done % REGRADE_PROGRESS_EVERY === 0) jobs.update(job);
        await yieldToLoop();
      }
      job.status = "complete";
    } catch (err) {
      job.status = "failed";
      job.failed.push({ runId: "", error: this.errorText(err instanceof Error ? err.message : String(err)) });
    }
    job.finishedAt = now();
    jobs.update(job);
  }

  private errorText(text: string): string {
    return (this.deps.sanitize ? this.deps.sanitize(text) : text).slice(0, MAX_JOB_ERROR_CHARS);
  }

  private resolve(request: RegradeRequest): string[] {
    const { runs } = this.deps;
    if ("runIds" in request) {
      if (request.runIds.length > MAX_REGRADE_RUNS) throw new RegradeRequestError(`a regrade names at most ${MAX_REGRADE_RUNS} runs, got ${request.runIds.length}`);
      return [...new Set(request.runIds)];
    }
    if ("campaignId" in request) return runs.ofCampaign(request.campaignId);
    if (!ISO_8601.test(request.since) || !Number.isFinite(Date.parse(request.since))) throw new RegradeRequestError(`'since' must be an ISO-8601 date or timestamp, got ${JSON.stringify(request.since.slice(0, 40))}`);
    return runs.finishedSince(request.since);
  }
}

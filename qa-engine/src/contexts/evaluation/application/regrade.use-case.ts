/*
 * Re-grades a set of finished runs with the current graders: by explicit run ids, by campaign, or by date. A request becomes a
 * job (pending, then running, then complete); the runs are graded one after another, yielding the event loop between runs, and a
 * run that fails is listed on the job without stopping the rest. A job only fails when it could not run at all.
 */

import { isCatalogName } from "../domain/grader-catalog.ts";
import type { GradeRunUseCase } from "./grade-run.use-case.ts";
import type { RegradeJob, RegradeJobStorePort, RunSelectorPort } from "./ports/index.ts";

export type RegradeRequest =
  | { runIds: readonly string[]; graders?: readonly string[] }
  | { campaignId: string; graders?: readonly string[] }
  | { since: string; graders?: readonly string[] };

/* The request names something the engine cannot grade (an unknown grader): a client error, not a failed job. */
export class RegradeRequestError extends Error {}

export interface RegradeDeps {
  runs: RunSelectorPort;
  jobs: RegradeJobStorePort;
  grade: Pick<GradeRunUseCase, "execute">;
  newId: () => string;
  now: () => string;
  /* Lets the process serve other work between two runs. */
  yieldToLoop: () => Promise<void>;
}

export class RegradeUseCase {
  constructor(private readonly deps: RegradeDeps) {}

  /* Resolves the runs and records the job; the work itself is `run(jobId)`. */
  start(request: RegradeRequest): { jobId: string; runs: number } {
    for (const name of request.graders ?? []) {
      if (!isCatalogName(name)) throw new RegradeRequestError(`unknown grader: ${name}`);
    }
    const runIds = this.resolve(request);
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
      for (const runId of job.runIds) {
        const result = await grade.execute(runId, job.graders ? { graders: job.graders } : {});
        if (result.status === "complete") job.graded += 1;
        else job.failed.push({ runId, error: result.status === "failed" ? result.error : result.reason });
        jobs.update(job);
        await yieldToLoop();
      }
      job.status = "complete";
    } catch (err) {
      job.status = "failed";
      job.failed.push({ runId: "", error: err instanceof Error ? err.message : String(err) });
    }
    job.finishedAt = now();
    jobs.update(job);
  }

  private resolve(request: RegradeRequest): string[] {
    const { runs } = this.deps;
    if ("runIds" in request) return [...new Set(request.runIds)].filter((id) => runs.exists(id));
    if ("campaignId" in request) return runs.ofCampaign(request.campaignId);
    return runs.finishedSince(request.since);
  }
}

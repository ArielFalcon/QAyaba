import { test } from "node:test";
import assert from "node:assert/strict";
import { RegradeUseCase, RegradeRequestError } from "@contexts/evaluation/application/regrade.use-case.ts";
import type { GradeRunResult } from "@contexts/evaluation/application/grade-run.use-case.ts";
import { MemoryJobStore, selector } from "./fakes.ts";

function build(results: Record<string, GradeRunResult>, runs = selector({ existing: ["a", "b", "c"], since: ["b", "c"], campaign: { camp: ["a"] } })) {
  const jobs = new MemoryJobStore();
  const graded: Array<{ id: string; graders: readonly string[] | undefined }> = [];
  let n = 0;
  const useCase = new RegradeUseCase({
    runs,
    jobs,
    grade: { execute: async (id, opts) => { graded.push({ id, graders: opts?.graders }); return results[id] ?? { status: "complete", scores: 1 }; } },
    newId: () => `job-${++n}`,
    now: () => "2026-10-17T12:00:00.000Z",
    yieldToLoop: async () => undefined,
  });
  return { useCase, jobs, graded };
}

test("a regrade by run ids starts a pending job over the runs that exist", () => {
  const { useCase, jobs } = build({});
  const started = useCase.start({ runIds: ["a", "ghost", "a"] });
  assert.deepEqual(started, { jobId: "job-1", runs: 1 });
  assert.equal(jobs.get("job-1")?.status, "pending");
});

test("a regrade by date covers the runs finished since then", () => {
  assert.equal(build({}).useCase.start({ since: "2026-10-01" }).runs, 2);
});

test("a regrade by an unknown campaign covers no run", () => {
  assert.equal(build({}).useCase.start({ campaignId: "unknown" }).runs, 0);
  assert.equal(build({}).useCase.start({ campaignId: "camp" }).runs, 1);
});

test("running a job grades every run and completes it", async () => {
  const { useCase, jobs } = build({});
  const { jobId } = useCase.start({ runIds: ["a", "b"] });
  await useCase.run(jobId);
  const job = jobs.get(jobId)!;
  assert.equal(job.status, "complete");
  assert.equal(job.graded, 2);
  assert.deepEqual(job.failed, []);
  assert.equal(job.finishedAt, "2026-10-17T12:00:00.000Z");
});

test("a run that fails is listed on the job and the others still get graded", async () => {
  const { useCase, jobs } = build({ a: { status: "failed", scores: 0, error: "boom" } });
  const { jobId } = useCase.start({ runIds: ["a", "b"] });
  await useCase.run(jobId);
  const job = jobs.get(jobId)!;
  assert.equal(job.status, "complete");
  assert.equal(job.graded, 1);
  assert.deepEqual(job.failed, [{ runId: "a", error: "boom" }]);
});

test("a run that is not finished is listed as failed with the reason", async () => {
  const { useCase, jobs } = build({ a: { status: "skipped", reason: "not-finished" } });
  const { jobId } = useCase.start({ runIds: ["a"] });
  await useCase.run(jobId);
  assert.deepEqual(jobs.get(jobId)!.failed, [{ runId: "a", error: "not-finished" }]);
});

test("named graders reach every run of the job", async () => {
  const { useCase, graded } = build({});
  await useCase.run(useCase.start({ runIds: ["a"], graders: ["furthest_phase"] }).jobId);
  assert.deepEqual(graded[0]?.graders, ["furthest_phase"]);
});

test("a grader name outside the catalog is refused before any job exists", () => {
  const { useCase, jobs } = build({});
  assert.throws(() => useCase.start({ runIds: ["a"], graders: ["not_a_grader"] }), RegradeRequestError);
  assert.equal(jobs.jobs.size, 0);
});

test("a job that was already run is not run twice", async () => {
  const { useCase, graded } = build({});
  const { jobId } = useCase.start({ runIds: ["a"] });
  await useCase.run(jobId);
  await useCase.run(jobId);
  assert.equal(graded.length, 1);
});

test("an unexpected fault ends the job failed instead of leaving it running", async () => {
  const jobs = new MemoryJobStore();
  const useCase = new RegradeUseCase({
    runs: selector({ existing: ["a"] }),
    jobs,
    grade: { execute: async () => { throw new Error("store gone"); } },
    newId: () => "job-x",
    now: () => "t",
    yieldToLoop: async () => undefined,
  });
  useCase.start({ runIds: ["a"] });
  await useCase.run("job-x");
  assert.equal(jobs.get("job-x")?.status, "failed");
  assert.match(jobs.get("job-x")!.failed[0]!.error, /store gone/);
});

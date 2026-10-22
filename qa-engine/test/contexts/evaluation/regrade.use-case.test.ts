import { test } from "node:test";
import assert from "node:assert/strict";
import { RegradeUseCase, RegradeRequestError, MAX_REGRADE_RUNS, MAX_JOB_ERROR_CHARS, REGRADE_PROGRESS_EVERY } from "@contexts/evaluation/application/regrade.use-case.ts";
import type { GradeRunResult } from "@contexts/evaluation/application/grade-run.use-case.ts";
import { MemoryJobStore, selector } from "./fakes.ts";

function build(results: Record<string, GradeRunResult>, runs = selector({ since: ["b", "c"], campaign: { camp: ["a"] } }), sanitize?: (t: string) => string) {
  const jobs = new MemoryJobStore();
  const graded: Array<{ id: string; graders: readonly string[] | undefined }> = [];
  let n = 0;
  let updates = 0;
  const countingJobs = Object.assign(Object.create(jobs), { update: (j: Parameters<typeof jobs.update>[0]) => { updates += 1; jobs.update(j); }, get: (id: string) => jobs.get(id), create: (j: Parameters<typeof jobs.create>[0]) => jobs.create(j) });
  const useCase = new RegradeUseCase({
    runs,
    jobs: countingJobs,
    grade: { execute: async (id, opts) => { graded.push({ id, graders: opts?.graders }); return results[id] ?? { status: "complete", scores: 1 }; } },
    newId: () => `job-${++n}`,
    now: () => "2026-10-17T12:00:00.000Z",
    yieldToLoop: async () => undefined,
    ...(sanitize ? { sanitize } : {}),
  });
  return { useCase, jobs, graded, updates: () => updates };
}

test("a regrade by run ids starts a pending job over the distinct ids", () => {
  const { useCase, jobs } = build({});
  assert.deepEqual(useCase.start({ runIds: ["a", "ghost", "a"] }), { jobId: "job-1", runs: 2 });
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

test("an unknown run id is listed on the job as an unknown run", async () => {
  const { useCase, jobs } = build({ ghost: { status: "skipped", reason: "unknown-run" } });
  const { jobId } = useCase.start({ runIds: ["ghost"] });
  await useCase.run(jobId);
  assert.deepEqual(jobs.get(jobId)!.failed, [{ runId: "ghost", error: "unknown run" }]);
});

test("a run that is not finished is listed as failed with the reason", async () => {
  const { useCase, jobs } = build({ a: { status: "skipped", reason: "not-finished" } });
  const { jobId } = useCase.start({ runIds: ["a"] });
  await useCase.run(jobId);
  assert.equal(jobs.get(jobId)!.failed[0]?.runId, "a");
  assert.match(jobs.get(jobId)!.failed[0]!.error, /not finished/);
});

test("the error a job keeps is redacted and capped", async () => {
  const { useCase, jobs } = build({ a: { status: "failed", scores: 0, error: `token=SECRET ${"x".repeat(2000)}` } }, undefined, (t) => t.replace("SECRET", "[redacted]"));
  const { jobId } = useCase.start({ runIds: ["a"] });
  await useCase.run(jobId);
  const error = jobs.get(jobId)!.failed[0]!.error;
  assert.ok(error.startsWith("token=[redacted]"));
  assert.equal(error.length, MAX_JOB_ERROR_CHARS);
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

test("a grader that is declared but not graded yet is refused by name", () => {
  const { useCase } = build({});
  assert.throws(() => useCase.start({ runIds: ["a"], graders: ["selector_stability", "spec_pass_rate", "cost_per_useful_spec"] }), (e: Error) => e instanceof RegradeRequestError && e.message.includes("selector_stability") && e.message.includes("cost_per_useful_spec") && !e.message.includes("spec_pass_rate"));
});

test("a since that is not an ISO-8601 date is refused", () => {
  const { useCase } = build({});
  for (const bad of ["yesterday", "10/01/2026", "2026-13-45", "2026-10-01 garbage", ""]) {
    assert.throws(() => useCase.start({ since: bad }), RegradeRequestError, bad);
  }
  assert.doesNotThrow(() => useCase.start({ since: "2026-10-01T10:00:00Z" }));
});

test("a regrade over more runs than the cap is refused with a clear error", () => {
  const many = Array.from({ length: MAX_REGRADE_RUNS + 1 }, (_, i) => `r${i}`);
  const { useCase } = build({}, selector({ since: many }));
  assert.throws(() => useCase.start({ runIds: many }), /at most 500/);
  assert.throws(() => useCase.start({ since: "2026-01-01" }), /at most 500/);
});

test("a job writes its progress every ten runs and at its end", async () => {
  const ids = Array.from({ length: REGRADE_PROGRESS_EVERY * 2 + 3 }, (_, i) => `r${i}`);
  const { useCase, updates } = build({});
  const { jobId } = useCase.start({ runIds: ids });
  await useCase.run(jobId);
  /* running + two progress writes + the end */
  assert.equal(updates(), 4);
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
    runs: selector(),
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

/* A regrade naming a judge hands the runs to the low-priority judge job; the deterministic graders are untouched. */
function buildWithJudges(judges: { unavailable?: string; unfinished?: string[] } = {}) {
  const jobs = new MemoryJobStore();
  const graded: Array<{ id: string; graders: readonly string[] | undefined }> = [];
  const requested: Array<{ id: string; judges: readonly string[] }> = [];
  let n = 0;
  const useCase = new RegradeUseCase({
    runs: selector(),
    jobs,
    grade: { execute: async (id, opts) => { graded.push({ id, graders: opts?.graders }); return { status: "complete", scores: 1 }; } },
    judges: {
      unavailable: () => judges.unavailable,
      request: (id, names) => {
        requested.push({ id, judges: names });
        return judges.unfinished?.includes(id) ? "unavailable-run" : "scheduled";
      },
    },
    newId: () => `job-${++n}`,
    now: () => "t",
    yieldToLoop: async () => undefined,
  });
  return { useCase, jobs, graded, requested };
}

test("a regrade naming only a judge asks the judges for each run and grades nothing deterministically", async () => {
  const { useCase, jobs, graded, requested } = buildWithJudges();
  const { jobId } = useCase.start({ runIds: ["a", "b"], graders: ["spec_relevance"] });
  await useCase.run(jobId);
  assert.deepEqual(graded, []);
  assert.deepEqual(requested.map((r) => [r.id, r.judges]), [["a", ["spec_relevance"]], ["b", ["spec_relevance"]]]);
  assert.equal(jobs.get(jobId)?.graded, 2);
});

test("a regrade naming a judge and a grader does both, each only with its own names", async () => {
  const { useCase, graded, requested } = buildWithJudges();
  const { jobId } = useCase.start({ runIds: ["a"], graders: ["spec_relevance", "approval_consistent"] });
  await useCase.run(jobId);
  assert.deepEqual(graded[0]?.graders, ["approval_consistent"]);
  assert.deepEqual(requested[0]?.judges, ["spec_relevance"]);
});

test("a regrade that names no grader never asks the judges: they cost tokens and are requested by name", async () => {
  const { useCase, requested } = buildWithJudges();
  const { jobId } = useCase.start({ runIds: ["a"] });
  await useCase.run(jobId);
  assert.deepEqual(requested, []);
});

test("a request naming a judge is refused as a client error when judges cannot run, with the reason", () => {
  const { useCase } = buildWithJudges({ unavailable: "judges are off (QA_JUDGES_ENABLED is not true)" });
  assert.throws(() => useCase.start({ runIds: ["a"], graders: ["spec_relevance"] }), (err: unknown) => err instanceof RegradeRequestError && /QA_JUDGES_ENABLED/.test(err.message));
  assert.doesNotThrow(() => useCase.start({ runIds: ["a"], graders: ["approval_consistent"] }));
});

test("without any judge wiring a judge name is refused, not mistaken for an unknown grader", () => {
  const { useCase } = build({});
  assert.throws(() => useCase.start({ runIds: ["a"], graders: ["spec_relevance"] }), (err: unknown) => err instanceof RegradeRequestError && /judge/.test(err.message));
});

test("a run the judges cannot take is listed on the job as failed and the others go on", async () => {
  const { useCase, jobs } = buildWithJudges({ unfinished: ["a"] });
  const { jobId } = useCase.start({ runIds: ["a", "b"], graders: ["failure_root_cause"] });
  await useCase.run(jobId);
  const job = jobs.get(jobId)!;
  assert.equal(job.graded, 1);
  assert.deepEqual(job.failed.map((f) => f.runId), ["a"]);
});

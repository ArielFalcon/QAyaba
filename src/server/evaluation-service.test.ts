import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvaluationService } from "./evaluation-service";
import { HistoryEvidenceAdapter, countPassedSpecs, defaultEvidenceDeps } from "./evaluation-evidence";
import { buildRunViewExtras, type RunViewDeps } from "./run-view";
import { createRecord, updateRecord, addCase, saveRunOutcome, replaceRunScores, getRunFacts, saveAgentTurn, listRunScoreRows, getRegradeJob, saveRegradeJob, failInterruptedRegradeJobs } from "./history";
import type { RunOutcome } from "../types";

const quiet = () => undefined;

/* Runs scheduled work on demand, so a test decides when the background job happens. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => void queue.push(fn),
    flush: async () => {
      while (queue.length > 0) {
        queue.shift()!();
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      }
    },
  };
}

function finishedRun(app: string, over: { verdict?: RunOutcome["verdict"]; decision?: string | null; specs?: string[]; cases?: Array<{ name: string; status: "pass" | "fail" }>; furthest?: string; traceId?: string | null } = {}): string {
  const r = createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
  const verdict = over.verdict ?? "pass";
  updateRecord(r.id, {
    status: "done",
    verdict,
    step: "done",
    phases: { furthestPhase: over.furthest ?? "learn", phaseTimings: { gate: 4, generate: 100, execute: 50 } },
    facts: { traceId: over.traceId === undefined ? "b".repeat(32) : over.traceId, decision: over.decision === undefined ? "pr" : over.decision, limitFired: null, limitRole: null },
    specs: (over.specs ?? ["e2e/login.spec.ts", "e2e/cart.spec.ts"]).map((name) => ({ name })),
  });
  for (const c of over.cases ?? [{ name: "login works", status: "pass" }, { name: "cart totals", status: "pass" }]) addCase(r.id, c);
  const outcome: RunOutcome = {
    runId: r.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict, errorClass: verdict === "infra-error" ? "E-TIME-BUDGET" : null,
    gateSignals: { static: true, coverageRatio: 0.9, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-10-17T10:00:00.000Z",
  };
  saveRunOutcome(outcome);
  saveAgentTurn({
    runId: r.id, sessionId: "s", role: "qa-reviewer", round: 0, isRepair: false, ts: "2026-10-17T10:00:00.000Z", objective: null, promptText: "p", outputText: "o", promptBytes: 1,
    tokensInput: 10, tokensOutput: 5, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: 0.5,
  });
  return r.id;
}

test("a finished run is graded in the background and its scores and status are readable", async () => {
  const id = finishedRun("eval-a");
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  assert.equal(service.evaluation(id, false)?.status, "pending");
  service.scheduleGrading(id);
  assert.equal(service.evaluation(id, false)?.status, "pending", "scheduling must not grade in the caller's turn");
  await sched.flush();
  const view = service.evaluation(id, false)!;
  assert.equal(view.status, "complete");
  assert.equal(view.traceId, "b".repeat(32));
  const byName = new Map(view.scores.map((s) => [s.name, s]));
  assert.equal(byName.get("empty_output_guard")?.value, true);
  assert.equal(byName.get("spec_pass_rate")?.value, 1);
  assert.equal(byName.get("change_coverage")?.value, "pass");
  assert.equal(byName.get("furthest_phase")?.value, "learn");
});

test("the default is the latest grader version per name and ?versions=all lists every stored version", async () => {
  const id = finishedRun("eval-b");
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  service.scheduleGrading(id);
  await sched.flush();
  replaceRunScores([{ runId: id, name: "spec_pass_rate", graderVersion: "0", dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", value: 0.1, comment: null, observationId: null }], "t");
  replaceRunScores([{ runId: id, name: "spec_pass_rate", graderVersion: "10", dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", value: 0.9, comment: null, observationId: null }], "t");
  const latest = service.evaluation(id, false)!.scores.filter((s) => s.name === "spec_pass_rate");
  assert.deepEqual(latest.map((s) => s.graderVersion), ["10"], "10 is newer than 1 even though it sorts before it as text");
  const all = service.evaluation(id, true)!.scores.filter((s) => s.name === "spec_pass_rate");
  assert.deepEqual(all.map((s) => s.graderVersion).sort(), ["0", "1", "10"]);
});

test("grading the same run twice leaves one stored score per name and version", async () => {
  const id = finishedRun("eval-c");
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  service.scheduleGrading(id);
  await sched.flush();
  const first = listRunScoreRows(id).length;
  service.scheduleGrading(id);
  await sched.flush();
  assert.equal(listRunScoreRows(id).length, first);
});

test("an unknown run has no evaluation", () => {
  assert.equal(createEvaluationService({ log: quiet }).evaluation("run-ghost", false), undefined);
});

test("a grading that crashes is said and never thrown into the caller", async () => {
  const logs: string[] = [];
  const sched = manualScheduler();
  const service = createEvaluationService({ evidence: { load: async () => { throw new Error("disk gone"); } }, schedule: sched.schedule, log: (m) => logs.push(m) });
  const id = finishedRun("eval-d");
  assert.doesNotThrow(() => service.scheduleGrading(id));
  await sched.flush();
  assert.equal(service.evaluation(id, false)?.status, "failed");
  assert.ok(logs.some((l) => l.includes("disk gone")));
});

test("a scheduler that throws does not reach the caller", () => {
  const service = createEvaluationService({ schedule: () => { throw new Error("no timers"); }, log: quiet });
  assert.doesNotThrow(() => service.scheduleGrading("run-x"));
});

test("a regrade job grades the named runs and reports its progress", async () => {
  const a = finishedRun("eval-e");
  const b = finishedRun("eval-e");
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet, newId: () => "job-e" });
  const started = service.startRegrade({ runIds: [a, b, "run-ghost"] });
  assert.deepEqual(started, { jobId: "job-e", runs: 2 });
  assert.equal(service.regradeJob("job-e")?.status, "pending");
  await sched.flush();
  const job = service.regradeJob("job-e")!;
  assert.equal(job.status, "complete");
  assert.equal(job.graded, 2);
  assert.deepEqual(job.failed, []);
  assert.ok(job.finishedAt);
  assert.equal(service.evaluation(a, false)?.status, "complete");
});

test("a regrade by date covers finished runs only", () => {
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet, newId: () => "job-f" });
  finishedRun("eval-f");
  const queued = createRecord({ target: "e2e", app: "eval-f", sha: "abcdef1234", mode: "diff" });
  assert.ok(service.startRegrade({ since: "2020-01-01" }).runs >= 1);
  assert.equal(service.startRegrade({ campaignId: "nope" }).runs, 0);
  assert.equal(queued.status, "enqueued");
});

test("a regrade job a previous process left open ends failed at boot", () => {
  saveRegradeJob({ jobId: "job-open", status: "running", runIds: ["r"], graders: null, runs: 1, graded: 0, failed: [], startedAt: "t", finishedAt: null });
  assert.ok(failInterruptedRegradeJobs("later") >= 1);
  const job = getRegradeJob("job-open")!;
  assert.equal(job.status, "failed");
  assert.equal(job.finishedAt, "later");
  assert.match(job.failed[0]!.error, /restarted/);
});

test("the evidence counts the specs a run delivered, valid and passed", async () => {
  const id = finishedRun("eval-g", { cases: [{ name: "login works", status: "pass" }, { name: "cart totals", status: "fail" }], verdict: "fail", decision: "issue" });
  const e = await new HistoryEvidenceAdapter(defaultEvidenceDeps).load(id);
  assert.deepEqual(e?.specs, { generated: 2, valid: 2, passed: 1 }, "the passing case names login, the failing one names cart");
  assert.equal(e?.reviewerTurns, 1);
  assert.equal(e?.decision, "issue");
});

test("a case is attributed to the spec whose file name it contains", () => {
  const specs = ["e2e/login.spec.ts", "e2e/cart.spec.ts"];
  const cases = [{ name: "cart.spec.ts > totals", status: "fail" }, { name: "login.spec.ts > signs in", status: "pass" }];
  assert.equal(countPassedSpecs(specs, cases, 2, "fail"), 1);
  assert.equal(countPassedSpecs(specs, [], 2, "pass"), 2);
  assert.equal(countPassedSpecs(specs, [], 2, "fail"), 0);
  assert.equal(countPassedSpecs(specs, cases, 0, "pass"), 0);
});

test("an invalid run has no valid spec", async () => {
  const id = finishedRun("eval-h", { verdict: "invalid", furthest: "validate", decision: "none" });
  const e = await new HistoryEvidenceAdapter(defaultEvidenceDeps).load(id);
  assert.equal(e?.specs.valid, 0);
  assert.equal(e?.specs.generated, 2);
});

test("a run still running is not finished", async () => {
  const r = createRecord({ target: "e2e", app: "eval-i", sha: "abcdef1234", mode: "diff" });
  updateRecord(r.id, { status: "running" });
  assert.equal((await new HistoryEvidenceAdapter(defaultEvidenceDeps).load(r.id))?.finished, false);
});

test("the run view reports the phases in canonical order, usage sums, spec counts and the decision", () => {
  const id = finishedRun("eval-j");
  const view = buildRunViewExtras(id, { ...(viewDeps(true)) })!;
  assert.deepEqual(view.phases.map((p) => p.name), ["gate", "generate", "execute"]);
  assert.equal(view.furthestPhase, "learn");
  assert.equal(view.usage.inputTokens, 10);
  assert.equal(view.usage.costUsd, 0.5);
  assert.equal(view.specCounts.generated, 2);
  assert.equal(view.decision, "pr");
  assert.deepEqual(view.budgets, { exhausted: false });
});

test("the run view links the trace through the template and is null when telemetry is off or the run has no trace", () => {
  const id = finishedRun("eval-k");
  assert.equal(buildRunViewExtras(id, viewDeps(true, "https://t.example/{traceId}"))?.telemetry?.traceUrl, `https://t.example/${"b".repeat(32)}`);
  assert.equal(buildRunViewExtras(id, viewDeps(true))?.telemetry?.traceUrl, undefined);
  assert.equal(buildRunViewExtras(id, viewDeps(false, "https://t.example/{traceId}"))?.telemetry, null);
  const untraced = finishedRun("eval-k", { traceId: null });
  assert.equal(buildRunViewExtras(untraced, viewDeps(true))?.telemetry, null);
  assert.equal(buildRunViewExtras("run-ghost", viewDeps(true)), undefined);
});

test("a run that a limit ended reports which", () => {
  const r = createRecord({ target: "e2e", app: "eval-l", sha: "abcdef1234", mode: "diff" });
  updateRecord(r.id, { status: "done", verdict: "infra-error", facts: { traceId: null, decision: "none", limitFired: "run-deadline", limitRole: "qa-generator" } });
  assert.deepEqual(getRunFacts(r.id), { traceId: null, decision: "none", limitFired: "run-deadline", limitRole: "qa-generator" });
  assert.deepEqual(buildRunViewExtras(r.id, viewDeps(true))?.budgets, { exhausted: true, limit: "run-deadline", role: "qa-generator" });
});

function viewDeps(on: boolean, template?: string): RunViewDeps {
  return {
    getRunFacts: (id) => getRunFacts(id),
    getRunPhases: (id) => defaultViewDeps.getRunPhases(id),
    getAgentTurns: (id) => defaultViewDeps.getAgentTurns(id),
    evidence: new HistoryEvidenceAdapter(defaultEvidenceDeps),
    telemetryOn: () => on,
    traceUrlTemplate: () => template,
  };
}

import { defaultRunViewDeps } from "./run-view";
const defaultViewDeps = defaultRunViewDeps(() => true, {});

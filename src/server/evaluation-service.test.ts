import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvaluationService } from "./evaluation-service";
import { judgeCatalog } from "@contexts/evaluation/domain/judges";
import { HistoryEvidenceAdapter, countPassedSpecs, defaultEvidenceDeps } from "./evaluation-evidence";
import { buildRunViewExtras, type RunViewDeps } from "./run-view";
import Database from "better-sqlite3";
import { RegradeRequestError } from "@contexts/evaluation/application/regrade.use-case";
import { createRecord, updateRecord, addCase, saveRunOutcome, replaceRunScores, getRunFacts, saveAgentTurn, getRunIdByTraceId, listRunScoreRows, getRegradeJob, saveRegradeJob, failInterruptedRegradeJobs, getRecord } from "./history";
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

type TestCase = { name: string; status: "pass" | "fail"; file?: string };

function finishedRun(app: string, over: { verdict?: RunOutcome["verdict"]; decision?: string | null; specs?: string[]; cases?: TestCase[]; furthest?: string; traceId?: string | null; facts?: NonNullable<Parameters<typeof updateRecord>[1]["facts"]>; reviewerTurn?: boolean } = {}): string {
  const r = createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
  const verdict = over.verdict ?? "pass";
  updateRecord(r.id, {
    status: "done",
    verdict,
    step: "done",
    phases: { furthestPhase: over.furthest ?? "learn", phaseTimings: { gate: 4, generate: 100, execute: 50 } },
    facts: {
      traceId: over.traceId === undefined ? "b".repeat(32) : over.traceId,
      decision: over.decision === undefined ? "pr" : over.decision,
      limitFired: null,
      limitRole: null,
      reviewRequired: true,
      coverageStatus: "pass",
      coverageMode: "signal",
      coverageMinRatio: 0.7,
      ...over.facts,
    },
    specs: (over.specs ?? ["e2e/login.spec.ts", "e2e/cart.spec.ts"]).map((name) => ({ name })),
  });
  for (const c of over.cases ?? [{ name: "login works", status: "pass", file: "login.spec.ts" }, { name: "cart totals", status: "pass", file: "cart.spec.ts" }]) addCase(r.id, c);
  const outcome: RunOutcome = {
    runId: r.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict, errorClass: verdict === "infra-error" ? "E-TIME-BUDGET" : null,
    gateSignals: { static: true, coverageRatio: 0.9, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-10-17T10:00:00.000Z",
  };
  saveRunOutcome(outcome);
  saveAgentTurn({
    runId: r.id, sessionId: "s", role: over.reviewerTurn === false ? "qa-generator" : "qa-reviewer", round: 0, isRepair: false, ts: "2026-10-17T10:00:00.000Z", objective: null, promptText: "p", outputText: "o", promptBytes: 1,
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
  assert.deepEqual(started, { jobId: "job-e", runs: 3 });
  assert.equal(service.regradeJob("job-e")?.status, "pending");
  await sched.flush();
  const job = service.regradeJob("job-e")!;
  assert.equal(job.status, "complete");
  assert.equal(job.graded, 2);
  assert.deepEqual(job.failed, [{ runId: "run-ghost", error: "unknown run" }]);
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

const evidenceOf = async (id: string) => new HistoryEvidenceAdapter(defaultEvidenceDeps).load(id);

test("the evidence ties each case to the spec its file names and counts the specs that passed", async () => {
  const id = finishedRun("eval-g", { verdict: "fail", decision: "issue", cases: [{ name: "login works", status: "pass", file: "login.spec.ts" }, { name: "cart totals", status: "fail", file: "cart.spec.ts" }] });
  const e = await evidenceOf(id);
  assert.deepEqual(e?.specs, { generated: 2, valid: 2, passed: 1 });
  assert.equal(e?.reviewerTurns, 1);
  assert.equal(e?.decision, "issue");
});

test("a case whose name merely contains a spec's name is not attributed to it", async () => {
  const id = finishedRun("eval-g2", { verdict: "fail", decision: "issue", cases: [{ name: "login works", status: "pass" }, { name: "cart totals", status: "fail" }] });
  assert.equal((await evidenceOf(id))?.specs.passed, undefined, "no case carries a file, so a failing run cannot say how many specs passed");
  const passing = finishedRun("eval-g3", { cases: [{ name: "login works", status: "pass" }, { name: "cart totals", status: "pass" }] });
  assert.equal((await evidenceOf(passing))?.specs.passed, 2, "a run-level pass means every spec passed");
});

test("a spec left without cases makes the passed count unknown unless the run passed", async () => {
  const id = finishedRun("eval-g4", { verdict: "fail", decision: "issue", cases: [{ name: "login works", status: "pass", file: "login.spec.ts" }] });
  assert.equal((await evidenceOf(id))?.specs.passed, undefined);
});

test("a file that fits two specs fits neither", () => {
  const specs = ["e2e/a/x.spec.ts", "e2e/b/x.spec.ts"];
  assert.equal(countPassedSpecs(specs, [{ name: "t", status: "pass", file: "x.spec.ts" }], 2, "fail"), undefined);
  assert.equal(countPassedSpecs(specs, [{ name: "t", status: "pass", file: "a/x.spec.ts" }, { name: "u", status: "fail", file: "b/x.spec.ts" }], 2, "fail"), 1);
});

test("an invalid run has no valid spec, and a run that never got past validation has an unknown count", async () => {
  const invalid = await evidenceOf(finishedRun("eval-h", { verdict: "invalid", furthest: "validate", decision: "none" }));
  assert.equal(invalid?.specs.valid, 0);
  assert.equal(invalid?.specs.generated, 2);
  const early = await evidenceOf(finishedRun("eval-h2", { verdict: "infra-error", furthest: "generate", decision: "none" }));
  assert.equal(early?.specs.valid, null);
  assert.equal(early?.specs.passed, undefined);
});

test("what the engine decided at run time is read back from the run, whatever the app's configuration says now", async () => {
  const id = finishedRun("eval-removed-app", { facts: { reviewRequired: false, coverageStatus: "fail", coverageMode: "enforce" } });
  const e = await evidenceOf(id);
  assert.equal(e?.reviewRequired, false);
  assert.equal(e?.signals?.coverageStatus, "fail");
  assert.equal(e?.signals?.coverageMode, "enforce");
});

test("a run that recorded no run-time facts reports them unknown", async () => {
  const r = createRecord({ target: "e2e", app: "eval-old", sha: "abcdef1234", mode: "diff" });
  updateRecord(r.id, { status: "done", verdict: "pass" });
  const e = await evidenceOf(r.id);
  assert.equal(e?.reviewRequired, undefined);
  assert.equal(e?.reviewerTurns, undefined);
  assert.equal(e?.decision, null);
});

test("the reviewer turn is told by the reviewer agent's name", async () => {
  const id = finishedRun("eval-rt", { reviewerTurn: false });
  assert.equal((await evidenceOf(id))?.reviewerTurns, 0);
});

test("a cancelled run is graded as cancelled and for nothing else", async () => {
  const r = createRecord({ target: "e2e", app: "eval-cx", sha: "abcdef1234", mode: "diff" });
  updateRecord(r.id, { status: "done", verdict: "infra-error", facts: { cancelled: true } });
  assert.equal((await evidenceOf(r.id))?.cancelled, true);
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  service.scheduleGrading(r.id);
  await sched.flush();
  assert.deepEqual(service.evaluation(r.id, false)?.scores.map((s) => [s.name, s.value]), [["infra_error", "cancelled"]]);
  assert.equal(service.evaluation(r.id, false)?.status, "complete");
});

test("the budget_exhaustion intent is the last step of the limiting turn", async () => {
  const id = finishedRun("eval-lim", { verdict: "infra-error", furthest: "generate", decision: "none", facts: { limitFired: "step-cap", limitRole: "qa-generator" } });
  const spans = [
    { name: "invoke_agent qa-generator", spanId: "t1", parentSpanId: null, attrs: JSON.stringify({ "gen_ai.agent.name": "qa-generator", "qayaba.limit.fired": "step-cap" }) },
    { name: "qayaba.agent.attempt", spanId: "a1", parentSpanId: "t1", attrs: "{}" },
    { name: "chat m", spanId: "c1", parentSpanId: "a1", attrs: JSON.stringify({ "qayaba.step.intent": "explore" }) },
    { name: "chat m", spanId: "c2", parentSpanId: "a1", attrs: JSON.stringify({ "qayaba.step.intent": "write_spec" }) },
    { name: "invoke_agent qa-reviewer", spanId: "t2", parentSpanId: null, attrs: JSON.stringify({ "gen_ai.agent.name": "qa-reviewer" }) },
    { name: "qayaba.agent.attempt", spanId: "a2", parentSpanId: "t2", attrs: "{}" },
    { name: "chat m", spanId: "c3", parentSpanId: "a2", attrs: JSON.stringify({ "qayaba.step.intent": "review" }) },
  ];
  const e = await new HistoryEvidenceAdapter({ ...defaultEvidenceDeps, runSpans: () => spans }).load(id);
  assert.deepEqual(e?.limit, { fired: "step-cap", role: "qa-generator", intent: "write_spec" });
  assert.equal((await evidenceOf(id))?.limit?.intent, undefined);
});

test("a run from before the run-time facts were recorded gets no coverage score, and a missing reviewer requirement leaves the guard silent", async () => {
  const id = finishedRun("eval-silent", { facts: { reviewRequired: null, coverageStatus: null } });
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  service.scheduleGrading(id);
  await sched.flush();
  const byName = new Map(service.evaluation(id, false)!.scores.map((s) => [s.name, s]));
  assert.equal(byName.has("change_coverage"), false);
  assert.equal(byName.has("empty_output_guard"), false);
});

test("a coverage decision recorded as unknown is graded unknown", async () => {
  const id = finishedRun("eval-cov-unknown", { facts: { coverageStatus: "unknown" } });
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  service.scheduleGrading(id);
  await sched.flush();
  assert.equal(service.evaluation(id, false)!.scores.find((s) => s.name === "change_coverage")?.value, "unknown");
});

test("a full regrade removes a stored score the graders no longer emit, and a subset regrade leaves the others", () => {
  const id = finishedRun("eval-del");
  const row = (name: string) => ({ runId: id, name, graderVersion: "1", dataType: "NUMERIC", polarity: "none", source: "deterministic", value: 0.5, comment: null, observationId: null });
  replaceRunScores([row("retired"), row("step_intent_mix.auth"), row("step_intent_mix"), row("stepXintent_mix.auth"), row("kept")], "t");
  replaceRunScores([], "t2", { runId: id, graderVersion: "1", baseNames: ["step_intent_mix"] });
  assert.deepEqual(listRunScoreRows(id).map((r) => r.name).sort(), ["kept", "retired", "stepXintent_mix.auth"]);
  replaceRunScores([row("fresh")], "t3", { runId: id, graderVersion: "1" });
  assert.deepEqual(listRunScoreRows(id).map((r) => r.name), ["fresh"]);
});

test("a corrupt score row is skipped and said, never shipped as an empty value", () => {
  const id = finishedRun("eval-corrupt");
  replaceRunScores([{ runId: id, name: "good", graderVersion: "1", dataType: "NUMERIC", polarity: "none", source: "deterministic", value: 1, comment: null, observationId: null }], "t");
  const raw = new Database(process.env.HISTORY_DB_PATH!);
  try {
    raw.prepare("INSERT INTO run_scores (run_id, name, grader_version, data_type, polarity, source, value, graded_at) VALUES (?, 'bad_json', '1', 'NUMERIC', 'none', 'deterministic', 'not json', 't')").run(id);
    raw.prepare("INSERT INTO run_scores (run_id, name, grader_version, data_type, polarity, source, value, graded_at) VALUES (?, 'bad_type', '1', 'NUMERIC', 'none', 'deterministic', '\"text\"', 't')").run(id);
  } finally {
    raw.close();
  }
  assert.deepEqual(listRunScoreRows(id).map((r) => r.name), ["good"]);
});

test("a regrade with an invalid since or a pending grader is refused", () => {
  const service = createEvaluationService({ schedule: () => undefined, log: quiet });
  assert.throws(() => service.startRegrade({ since: "last week" }), RegradeRequestError);
  assert.throws(() => service.startRegrade({ runIds: ["x"], graders: ["selector_stability"] }), /selector_stability/);
});

test("a regrade lists an unknown run id as an unknown run", async () => {
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet, newId: () => "job-unknown" });
  service.startRegrade({ runIds: ["run-nowhere"] });
  await sched.flush();
  assert.deepEqual(service.regradeJob("job-unknown")?.failed, [{ runId: "run-nowhere", error: "unknown run" }]);
});

test("a case stored with its file keeps it", () => {
  const r = createRecord({ target: "e2e", app: "eval-file", sha: "abcdef1234", mode: "diff" });
  addCase(r.id, { name: "t", status: "pass", file: "a.spec.ts" });
  assert.equal(getRecord(r.id)?.cases[0]?.file, "a.spec.ts");
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
  const { limitFired, limitRole, decision } = getRunFacts(r.id)!;
  assert.deepEqual({ limitFired, limitRole, decision }, { limitFired: "run-deadline", limitRole: "qa-generator", decision: "none" });
  assert.deepEqual(buildRunViewExtras(r.id, viewDeps(true))?.budgets, { exhausted: true, limit: "run-deadline", role: "qa-generator" });
});

function viewDeps(on: boolean, template?: string): RunViewDeps {
  return {
    getRunFacts: (id) => getRunFacts(id),
    getRunPhases: (id) => defaultViewDeps.getRunPhases(id),
    getRunCampaign: (id) => defaultViewDeps.getRunCampaign(id),
    getStoredEffectiveConfig: (id) => defaultViewDeps.getStoredEffectiveConfig(id),
    getAgentTurns: (id) => defaultViewDeps.getAgentTurns(id),
    getAgentRoleFacts: (id) => defaultViewDeps.getAgentRoleFacts(id),
    evidence: new HistoryEvidenceAdapter(defaultEvidenceDeps),
    telemetryOn: () => on,
    traceUrlTemplate: () => template,
  };
}

import { defaultRunViewDeps } from "./run-view";
const defaultViewDeps = defaultRunViewDeps(() => true, {});

test("by default only grader rows are returned, one per name; human labels appear with versions=all", () => {
  const id = finishedRun("labels-shadow");
  const service = createEvaluationService({ log: quiet });
  const row = (source: string, graderVersion: string, value: number) => ({ runId: id, name: "spec_pass_rate", graderVersion, dataType: "NUMERIC", polarity: "higher_better", source, value, comment: null, observationId: null });
  replaceRunScores([row("deterministic", "1", 0.5), row("human", "human", 1)], "t");
  const byDefault = service.evaluation(id, false)!.scores.filter((s) => s.name === "spec_pass_rate");
  assert.deepEqual(byDefault.map((s) => [s.source, s.graderVersion, s.value]), [["deterministic", "1", 0.5]]);
  const all = service.evaluation(id, true)!.scores.filter((s) => s.name === "spec_pass_rate");
  assert.deepEqual(all.map((s) => s.source).sort(), ["deterministic", "human"]);
});

test("a name only a human labelled is not in the default view", () => {
  const id = finishedRun("labels-only");
  const service = createEvaluationService({ log: quiet });
  replaceRunScores([{ runId: id, name: "furthest_phase", graderVersion: "human", dataType: "CATEGORICAL", polarity: "none", source: "human", value: "learn", comment: null, observationId: null }], "t");
  assert.equal(service.evaluation(id, false)!.scores.some((s) => s.name === "furthest_phase" && s.source === "human"), false);
});

test("a run is found by its trace id, and an unknown trace is not guessed at", () => {
  const id = finishedRun("trace-lookup", { traceId: "c".repeat(32) });
  assert.equal(getRunIdByTraceId("c".repeat(32)), id);
  assert.equal(getRunIdByTraceId("d".repeat(32)), undefined);
});

test("the trace-id lookup is served by an index on runs", () => {
  finishedRun("trace-index");
  const raw = new Database(process.env.HISTORY_DB_PATH!, { readonly: true });
  try {
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT id FROM runs WHERE trace_id = ? LIMIT 1").all("x") as Array<{ detail: string }>;
    assert.match(plan.map((p) => p.detail).join(" "), /idx_runs_trace_id/);
  } finally {
    raw.close();
  }
});

function campaignRun(campaignId: string, variant: Record<string, string>, replicate: number, done = true): string {
  const r = createRecord({ target: "e2e", app: "eval-campaign", sha: "abcdef1234", mode: "diff", campaign: { id: campaignId, variant, replicate } });
  if (done) updateRecord(r.id, { status: "done", verdict: "pass", step: "done" });
  return r.id;
}

test("a regrade by campaign grades exactly the finished runs of that campaign", async () => {
  const campaign = `regrade-camp-${Date.now()}`;
  const a = campaignRun(campaign, { arm: "x" }, 1);
  const b = campaignRun(campaign, { arm: "y" }, 1);
  const running = campaignRun(campaign, { arm: "y" }, 2, false);
  campaignRun(`other-${campaign}`, { arm: "x" }, 1);
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet, newId: () => "job-campaign" });
  const started = service.startRegrade({ campaignId: campaign });
  assert.equal(started.runs, 2);
  await sched.flush();
  const job = service.regradeJob("job-campaign")!;
  assert.equal(job.status, "complete");
  assert.equal(job.runs, 2);
  assert.deepEqual([a, b].map((id) => service.evaluation(id, false)?.status), ["complete", "complete"]);
  assert.equal(service.evaluation(running, false)?.status, "pending");
});

test("a regrade by a campaign that holds no run covers none", () => {
  const service = createEvaluationService({ schedule: () => undefined, log: quiet, newId: () => "job-empty" });
  assert.equal(service.startRegrade({ campaignId: `nothing-${Date.now()}` }).runs, 0);
});

test("a regrade by a campaign larger than the cap is refused instead of covering part of it", () => {
  const campaign = `big-camp-${Date.now()}`;
  for (let i = 0; i < 501; i++) campaignRun(campaign, { arm: "x" }, i + 1);
  const service = createEvaluationService({ schedule: () => undefined, log: quiet });
  assert.throws(() => service.startRegrade({ campaignId: campaign }), RegradeRequestError);
});

test("the campaign listing carries the labels, replicate, status and grading state, and is complete only once every run is graded", async () => {
  const campaign = `list-camp-${Date.now()}`;
  const a = campaignRun(campaign, { arm: "x", model: "m1" }, 1);
  const b = campaignRun(campaign, { arm: "y", model: "m1" }, 1);
  const sched = manualScheduler();
  const service = createEvaluationService({ schedule: sched.schedule, log: quiet });
  const before = service.campaignRuns(campaign, {});
  assert.deepEqual(before.runs.map((r) => [r.id, r.variant, r.replicate, r.status, r.verdict, r.evaluationStatus]), [
    [a, { arm: "x", model: "m1" }, 1, "done", "pass", "pending"],
    [b, { arm: "y", model: "m1" }, 1, "done", "pass", "pending"],
  ]);
  assert.equal(before.complete, false);
  service.scheduleGrading(a);
  service.scheduleGrading(b);
  await sched.flush();
  const after = service.campaignRuns(campaign, {});
  assert.deepEqual(after.runs.map((r) => r.evaluationStatus), ["complete", "complete"]);
  assert.equal(after.complete, true);
  assert.deepEqual(service.campaignRuns(campaign, { arm: "y" }).runs.map((r) => r.id), [b]);
});

test("a run that is not part of a campaign is never listed in one", () => {
  const r = createRecord({ target: "e2e", app: "eval-campaign", sha: "abcdef1234", mode: "diff" });
  assert.equal(createEvaluationService({ log: quiet }).campaignRuns("anything", {}).runs.some((x) => x.id === r.id), false);
});

test("the catalog lists the judges after the graders only when judges are wired, and a regrade naming a judge reaches them", async () => {
  const requested: string[] = [];
  const judges = {
    catalog: () => judgeCatalog("1", () => "experimental"),
    unavailable: () => undefined,
    request: (runId: string) => {
      requested.push(runId);
      return "scheduled" as const;
    },
  };
  const sched = manualScheduler();
  const without = createEvaluationService({ schedule: sched.schedule, log: quiet });
  assert.ok(!without.catalog().scores.some((s) => s.name === "spec_relevance"));
  const withJudges = createEvaluationService({ schedule: sched.schedule, log: quiet, newId: () => "job-j", judges });
  const names = withJudges.catalog().scores.map((s) => s.name);
  assert.ok(names.indexOf("spec_relevance") > names.indexOf("spec_pass_rate"));
  const run = finishedRun("eval-judge-regrade");
  withJudges.startRegrade({ runIds: [run], graders: ["spec_relevance"] });
  await sched.flush();
  assert.deepEqual(requested, [run]);
  assert.equal(withJudges.regradeJob("job-j")?.graded, 1);
  assert.throws(() => without.startRegrade({ runIds: [run], graders: ["spec_relevance"] }), RegradeRequestError);
});

/* The acceptance every arm of an experiment is judged by: the specs an arm delivered are validated, executed twice with no retry, measured for change-coverage and, when asked, reviewed, and the same decide() / isAccepted() the pipeline publishes by say whether they would have been kept. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { AcceptDeliveredSpecsUseCase, type AcceptInput } from "@contexts/run-orchestration/application/accept-delivered-specs.use-case.ts";
import type { ExecutionOpts } from "@contexts/run-orchestration/application/ports/index.ts";

const PASS: QaCase[] = [{ name: "flows/a.spec.ts › loads", status: "pass", file: "flows/a.spec.ts" }];
const FAIL: QaCase[] = [{ name: "flows/a.spec.ts › loads", status: "fail", file: "flows/a.spec.ts", detail: "boom" }];

interface Rig {
  validated: Array<{ specDir: string; changedFiles?: string[] }>;
  executed: Array<{ specDir: string; opts: ExecutionOpts }>;
  measured: Array<{ namespace?: string; baselineCases?: string[] }>;
  reviewed: number;
  useCase: AcceptDeliveredSpecsUseCase;
}

function rig(script: {
  validate?: { ok: boolean; errors: string[]; infra?: boolean };
  runs?: Array<{ verdict: RunVerdict; cases: QaCase[] }>;
  coverage?: { status: "pass" | "fail" | "unknown"; ratio: number | null };
  blocks?: boolean;
  review?: { approved: boolean; corrections: string[]; blockingCount?: number; parsed?: boolean; unavailable?: boolean } | "none";
} = {}): Rig {
  const r: Rig = { validated: [], executed: [], measured: [], reviewed: 0, useCase: undefined as never };
  const runs = script.runs ?? [{ verdict: "pass", cases: PASS }, { verdict: "pass", cases: PASS }];
  let call = 0;
  r.useCase = new AcceptDeliveredSpecsUseCase({
    validation: { validate: async (specDir, changedFiles) => (r.validated.push({ specDir, ...(changedFiles ? { changedFiles } : {}) }), script.validate ?? { ok: true, errors: [] }) },
    execution: { execute: async (specDir, opts) => { r.executed.push({ specDir, opts: opts as ExecutionOpts }); const run = runs[Math.min(call++, runs.length - 1)]!; return { verdict: run.verdict, cases: run.cases, logs: "" }; } },
    objectiveSignal: {
      measure: async (_br, _dir, _diff, baselineCases, opts) => { r.measured.push({ ...(opts?.namespace ? { namespace: opts.namespace } : {}), ...(baselineCases ? { baselineCases } : {}) }); return script.coverage ?? { status: "pass", ratio: 0.9 }; },
      blocks: () => script.blocks ?? false,
    },
    ...(script.review === "none" || script.review === undefined ? {} : { review: { review: async () => { r.reviewed++; return script.review as never; } } }),
  });
  return r;
}

const INPUT: AcceptInput = { specDir: "/copy/e2e", specs: ["flows/a.spec.ts"], diff: "diff --git a/x b/x", changedFiles: ["src/x.ts"], sha: Sha.of("abc1234"), namespace: "qa-bot-abc1234-arm", reviewRequired: false };

test("delivered specs that validate, pass twice with no retry and are not held back by coverage are accepted", async () => {
  const r = rig();
  const report = await r.useCase.accept(INPUT);
  assert.equal(report.accepted, true);
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.validate, { ok: true, infra: false, errors: [] });
  assert.equal(report.runs.length, 2);
  assert.ok(report.runs.every((run) => run.ms >= 0 && Number.isFinite(run.ms)));
  assert.deepEqual(report.decision, { verdict: "pass", sideEffect: "pr" });
  assert.equal(report.reviewer, null, "no review was asked for");
  assert.deepEqual(r.validated, [{ specDir: "/copy/e2e", changedFiles: ["src/x.ts"] }]);
});

test("each run executes the delivered specs alone, once, in a namespace of its own", async () => {
  const r = rig();
  await r.useCase.accept(INPUT);
  assert.equal(r.executed.length, 2);
  for (const call of r.executed) {
    assert.deepEqual(call.opts.specFiles, ["flows/a.spec.ts"]);
    assert.equal(call.opts.retries, 0, "a spec passes only when it passes the first time");
  }
  assert.deepEqual(r.executed.map((c) => c.opts.namespace), ["qa-bot-abc1234-arm-acc1", "qa-bot-abc1234-arm-acc2"]);
});

test("coverage is measured on the first run's namespace and its passing cases", async () => {
  const r = rig();
  const report = await r.useCase.accept(INPUT);
  assert.deepEqual(r.measured, [{ namespace: "qa-bot-abc1234-arm-acc1", baselineCases: ["flows/a.spec.ts › loads"] }]);
  assert.deepEqual(report.coverage, { status: "pass", ratio: 0.9, blocks: false });
});

test("a coverage policy that blocks holds the specs back, as it holds a pull request", async () => {
  const r = rig({ coverage: { status: "fail", ratio: 0.2 }, blocks: true });
  const report = await r.useCase.accept(INPUT);
  assert.equal(report.accepted, false);
  assert.deepEqual(report.decision, { verdict: "pass", sideEffect: "issue" });
});

test("a coverage of unknown never blocks", async () => {
  const r = rig({ coverage: { status: "unknown", ratio: null }, blocks: false });
  assert.equal((await r.useCase.accept(INPUT)).accepted, true);
});

test("a gate that fails ends the acceptance invalid without executing anything", async () => {
  const r = rig({ validate: { ok: false, errors: ["[lint] no-wait-for-timeout"] } });
  const report = await r.useCase.accept(INPUT);
  assert.equal(report.accepted, false);
  assert.equal(report.verdict, "invalid");
  assert.equal(r.executed.length, 0);
  assert.equal(r.measured.length, 0);
  assert.deepEqual(report.validate.errors, ["[lint] no-wait-for-timeout"]);
});

test("a gate that could not run is an infrastructure error, not an invalid suite", async () => {
  const report = await rig({ validate: { ok: false, errors: ["tsc crashed"], infra: true } }).useCase.accept(INPUT);
  assert.equal(report.verdict, "infra-error");
  assert.equal(report.accepted, false);
});

test("one run green and one red is flaky, and a flaky suite is never accepted; two red is a failure", async () => {
  const flaky = await rig({ runs: [{ verdict: "pass", cases: PASS }, { verdict: "fail", cases: FAIL }] }).useCase.accept(INPUT);
  assert.equal(flaky.verdict, "flaky");
  assert.equal(flaky.accepted, false);
  const failed = await rig({ runs: [{ verdict: "fail", cases: FAIL }] }).useCase.accept(INPUT);
  assert.equal(failed.verdict, "fail");
  assert.equal(failed.accepted, false);
});

test("a run that could not execute makes the acceptance an infrastructure error", async () => {
  const report = await rig({ runs: [{ verdict: "infra-error", cases: [] }] }).useCase.accept(INPUT);
  assert.equal(report.verdict, "infra-error");
  assert.equal(report.accepted, false);
});

test("a suite that did not pass is neither measured nor reviewed", async () => {
  const r = rig({ runs: [{ verdict: "fail", cases: FAIL }], review: { approved: true, corrections: [] } });
  await r.useCase.accept({ ...INPUT, reviewRequired: true });
  assert.equal(r.measured.length, 0);
  assert.equal(r.reviewed, 0);
});

test("nothing delivered is nothing accepted, with nothing executed", async () => {
  const r = rig();
  const report = await r.useCase.accept({ ...INPUT, specs: [] });
  assert.equal(report.accepted, false);
  assert.equal(report.verdict, "skipped");
  assert.equal(r.executed.length, 0);
  assert.equal(r.validated.length, 0);
});

test("when a review is asked for, it must approve with no blocking correction", async () => {
  const approved = await rig({ review: { approved: true, corrections: [], blockingCount: 0, parsed: true } }).useCase.accept({ ...INPUT, reviewRequired: true });
  assert.equal(approved.accepted, true);
  assert.deepEqual(approved.reviewer, { approved: true, corrections: [], unavailable: false });

  const rejected = await rig({ review: { approved: true, corrections: ["assert the total"], blockingCount: 1, parsed: true } }).useCase.accept({ ...INPUT, reviewRequired: true });
  assert.equal(rejected.accepted, false, "an approving verdict with a blocking correction is a rejection");
  assert.deepEqual(rejected.decision, { verdict: "pass", sideEffect: "issue" });
});

test("a reviewer that could not be reached judged nothing, so nothing is accepted on its word", async () => {
  const report = await rig({ review: { approved: false, corrections: [], unavailable: true } }).useCase.accept({ ...INPUT, reviewRequired: true });
  assert.equal(report.accepted, false);
  assert.equal(report.reviewer?.unavailable, true);
});

test("a review that was asked for and has no reviewer wired is a refusal to accept, never an approval", async () => {
  const report = await rig({ review: "none" }).useCase.accept({ ...INPUT, reviewRequired: true });
  assert.equal(report.accepted, false);
  assert.equal(report.reviewer, null);
});

test("a review that was not asked for is not run even when a reviewer is wired", async () => {
  const r = rig({ review: { approved: false, corrections: ["x"], blockingCount: 1, parsed: true } });
  const report = await r.useCase.accept(INPUT);
  assert.equal(r.reviewed, 0);
  assert.equal(report.accepted, true);
});

test("the shadow switch changes where a decision would go, never whether the suite is accepted", async () => {
  const report = await rig().useCase.accept({ ...INPUT, shadow: true });
  assert.equal(report.accepted, true);
  assert.deepEqual(report.decision, { verdict: "pass", sideEffect: "shadow-log" });
});

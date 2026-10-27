/* The graders that answer "do the tests find bugs": mutation kill rate, coverage ratios, the review verdict, defects found, routed survivors, flaky triage, contradicted drops. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { PlanEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { evidence, signals } from "./evidence-fixtures.ts";

const grade = (e: ReturnType<typeof evidence>, name: string) => gradeEvidence(e, [name]).find((s) => s.name === name);
const withSignals = (over: Parameters<typeof signals>[0], rest: Partial<ReturnType<typeof evidence>> = {}) => evidence({ signals: signals(over), ...rest });

test("mutation_kill_rate is killed over judged bundle mutants, and says nothing when none was judged", () => {
  assert.equal(grade(withSignals({ bundleMutation: { applied: 3, killed: 1 } }), "mutation_kill_rate")?.value, 1 / 3);
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 0 } }), "mutation_kill_rate")?.value, 0, "a measured zero is a zero");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 0, killed: 0 } }), "mutation_kill_rate"), undefined);
  assert.equal(grade(withSignals({ bundleMutation: undefined }), "mutation_kill_rate"), undefined);
});

test("mutation_kill_rate leaves the response oracle's mutation_value as it was", () => {
  const s = signals({ mutantCount: 4, killedCount: 1, bundleMutation: { applied: 3, killed: 3 } });
  assert.equal(grade(evidence({ signals: s }), "mutation_value")?.value, 1 / 4);
  assert.equal(grade(evidence({ signals: s }), "mutation_kill_rate")?.value, 1);
});

test("change_coverage_ratio and branch_coverage_ratio are numbers, and nothing when the coverage is unknown", () => {
  const measured = withSignals({ coverageStatus: "pass", coverageRatio: 0.75, branchCoverage: { changed: 4, taken: 1 } });
  assert.equal(grade(measured, "change_coverage_ratio")?.value, 0.75);
  assert.equal(grade(measured, "branch_coverage_ratio")?.value, 1 / 4);
  const unknown = withSignals({ coverageStatus: "unknown", coverageRatio: 0, branchCoverage: { changed: 4, taken: 0 } });
  assert.equal(grade(unknown, "change_coverage_ratio"), undefined, "unknown is its own class, never a 0");
  assert.equal(grade(unknown, "branch_coverage_ratio"), undefined);
  assert.equal(grade(withSignals({ coverageStatus: "pass", coverageRatio: undefined }), "change_coverage_ratio"), undefined);
});

test("branch_coverage_ratio has no score without a decision on a changed line", () => {
  assert.equal(grade(withSignals({ coverageStatus: "pass", branchCoverage: { changed: 0, taken: 0 } }), "branch_coverage_ratio"), undefined);
  assert.equal(grade(withSignals({ coverageStatus: "pass", branchCoverage: undefined }), "branch_coverage_ratio"), undefined);
});

test("review_verdict tells the model's rejection the evidence filter overruled from a plain approval and a rejection", () => {
  const reviewer = (approved: boolean) => ({ approved, rounds: 2, modelRounds: 1 });
  assert.equal(grade(withSignals({ reviewer: reviewer(true) }), "review_verdict")?.value, "approved");
  assert.equal(grade(withSignals({ reviewer: reviewer(false) }), "review_verdict")?.value, "rejected");
  const overruled = grade(withSignals({ reviewer: reviewer(true), droppedRejections: { rounds: 1, reasons: { uncited: 2, unresolved: 1 } } }), "review_verdict");
  assert.equal(overruled?.value, "approved-over-model-rejection");
  assert.match(overruled?.comment ?? "", /uncited ×2, unresolved ×1/);
  assert.equal(grade(withSignals({ reviewer: undefined }), "review_verdict"), undefined, "no reviewer phase, no verdict");
});

test("defect_found counts the failing cases in the change's reach; a passing run found none; an unlabelled failure says nothing", () => {
  assert.equal(grade(evidence({ verdict: "pass" }), "defect_found")?.value, 0);
  const failed = withSignals({ causal: { inReach: 2, outOfReach: 1, unknown: 1 } }, { verdict: "fail", decision: "issue" });
  const s = grade(failed, "defect_found");
  assert.equal(s?.value, 2);
  assert.match(s?.comment ?? "", /1 out of reach/);
  assert.equal(grade(withSignals({ causal: { inReach: 0, outOfReach: 3, unknown: 0 } }, { verdict: "fail" }), "defect_found")?.value, 0, "failures the change does not reach are not defects it caused");
  assert.equal(grade(withSignals({ causal: undefined }, { verdict: "fail" }), "defect_found"), undefined);
});

test("survivors_routed is the share of surviving mutants a delivered spec reached, and nothing without survivors", () => {
  assert.equal(grade(withSignals({ survivors: { routed: 1, total: 3 } }), "survivors_routed")?.value, 1 / 3);
  assert.equal(grade(withSignals({ survivors: { routed: 0, total: 0 } }), "survivors_routed"), undefined);
  assert.equal(grade(withSignals({ survivors: undefined }), "survivors_routed"), undefined);
});

test("flaky_triage names the class mix of a flaky run and says nothing for a run that was not", () => {
  const triage = (dataInstability: number, timing: number) => withSignals({ flakyTriage: { cases: dataInstability + timing, dataInstability, timing, outcome: "accepted" } });
  assert.equal(grade(triage(2, 0), "flaky_triage")?.value, "data-instability");
  assert.equal(grade(triage(0, 1), "flaky_triage")?.value, "timing");
  assert.equal(grade(triage(1, 1), "flaky_triage")?.value, "mixed");
  assert.equal(grade(triage(0, 0), "flaky_triage")?.value, "unclassified");
  assert.match(grade(triage(1, 1), "flaky_triage")?.comment ?? "", /correction accepted/);
  assert.equal(grade(withSignals({ flakyTriage: undefined }), "flaky_triage"), undefined);
});

const plan = (candidates: PlanEvidence["candidates"]): PlanEvidence => ({ kind: "fanout", changeRoutes: ["/a"], candidates, flows: [{ id: "f", visits: ["/a"], candidates: [], passed: true }] });

test("drops_contradicted counts the dropped use cases the run's facts contradicted, 0 when none, nothing without a plan of flows", () => {
  const contradicted = { basis: "diff", why: "a code file with added lines" };
  const s = grade(evidence({ plan: plan([{ id: "uc-a", state: "dropped", reason: "cosmetic", contradicted }, { id: "uc-b", state: "dropped", reason: "log only" }, { id: "uc-c", state: "planned" }]) }), "drops_contradicted");
  assert.equal(s?.value, 1);
  assert.equal(s?.comment, "uc-a");
  assert.equal(grade(evidence({ plan: plan([{ id: "uc-c", state: "planned" }]) }), "drops_contradicted")?.value, 0);
  assert.equal(grade(evidence({ plan: undefined }), "drops_contradicted"), undefined);
});

test("none of the new graders grades a run that has not finished", () => {
  const e = withSignals({ coverageStatus: "pass", coverageRatio: 1, bundleMutation: { applied: 1, killed: 1 }, flakyTriage: { cases: 1, dataInstability: 1, timing: 0, outcome: "accepted" } }, { finished: false, verdict: null });
  const names = ["mutation_kill_rate", "change_coverage_ratio", "branch_coverage_ratio", "review_verdict", "defect_found", "survivors_routed", "flaky_triage", "drops_contradicted"];
  assert.deepEqual(gradeEvidence(e, names), []);
});

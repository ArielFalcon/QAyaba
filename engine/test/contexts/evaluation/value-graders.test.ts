/* The graders that answer "do the tests find bugs": mutation kill rate, coverage ratios, the review verdict, defects found, routed survivors, flaky triage, contradicted drops. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRunEvidence } from "@contexts/evaluation/application/index.ts";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { PlanEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { evidence, signals } from "./evidence-fixtures.ts";

const grade = (e: ReturnType<typeof evidence>, name: string) => gradeEvidence(e, [name]).find((s) => s.name === name);
const withSignals = (over: Parameters<typeof signals>[0], rest: Partial<ReturnType<typeof evidence>> = {}) => evidence({ signals: signals(over), ...rest });

/* The judged bundle mutants a run's outcome records, assembled into evidence and graded: what the record says of each survivor is what reaches the score. */
const scoredFromRecord = (bundleMutation: NonNullable<RunOutcome["gateSignals"]["bundleMutation"]>) => {
  const outcome = { errorClass: null, at: "2026-10-17T10:00:00.000Z", gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0, bundleMutation } };
  const sources = {
    runId: "run-1",
    record: { app: "app", sha: "abcdef1", mode: "diff", status: "done", verdict: "pass", cases: [], at: "2026-10-17T10:00:00.000Z" },
    phases: { furthestPhase: "execute" },
    facts: undefined,
    outcome,
    spans: [],
    turns: [],
    snapshots: [],
    plan: undefined,
  };
  return grade(assembleRunEvidence(sources, { references: [], reviewerAgent: "qa-reviewer" }), "mutation_kill_rate");
};

test("mutation_kill_rate is killed over judged bundle mutants, and says nothing when none was judged", () => {
  assert.equal(grade(withSignals({ bundleMutation: { applied: 3, killed: 1 } }), "mutation_kill_rate")?.value, 1 / 3, "a record without survivor detail keeps the judged count");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 0 } }), "mutation_kill_rate")?.value, 0, "a measured zero is a zero");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 0, killed: 0 } }), "mutation_kill_rate"), undefined);
  assert.equal(grade(withSignals({ bundleMutation: undefined }), "mutation_kill_rate"), undefined);
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 1, survivors: { moved: 1, unmoved: 0, unobserved: 0 } } }), "mutation_kill_rate")?.value, 1 / 2, "a survivor that moved an observable counts in the denominator and not the numerator");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 1, survivors: { moved: 0, unmoved: 1, unobserved: 0 } } }), "mutation_kill_rate")?.value, 1, "an equivalent mutant is left out of the denominator");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 1, survivors: { moved: 0, unmoved: 0, unobserved: 1 } } }), "mutation_kill_rate")?.value, 1, "a survivor with no observation is left out of the denominator");
  assert.equal(scoredFromRecord({ applied: 2, killed: 1, survived: [{ file: "src/a.ts", line: 1, operator: "negate condition" }] })?.value, 1, "a survivor whose observation is absent is left out of the denominator");
  assert.equal(grade(withSignals({ bundleMutation: { applied: 2, killed: 0, survivors: { moved: 0, unmoved: 1, unobserved: 1 } } }), "mutation_kill_rate"), undefined, "a denominator of nothing leaves no score");
  assert.match(grade(withSignals({ bundleMutation: { applied: 4, killed: 2, survivors: { moved: 1, unmoved: 1, unobserved: 1 } } }), "mutation_kill_rate")?.comment ?? "", /2 of 3.*1 equivalent.*1 unobserved/, "the comment states the counts it rests on");
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

test("defect_found counts the facts the run verified, the defects without a failing test and a failure the adjudicator classified as an app defect from a fact; a failing case in reach is no finding; a passing run found none; a run that recorded neither says nothing", () => {
  assert.equal(grade(evidence({ verdict: "pass" }), "defect_found")?.value, 0);
  const failedInReach = withSignals({ causal: { inReach: 2, outOfReach: 0, unknown: 0 } }, { verdict: "fail", decision: "issue" });
  assert.equal(grade(failedInReach, "defect_found"), undefined, "the shape of a failure in reach is a hint, not a fact");
  const verified = grade(withSignals({ defects: { found: 2 } }, { verdict: "fail", decision: "issue" }), "defect_found");
  assert.equal(verified?.value, 2, "a run that failed only on verified defects has no failing case and still found them");
  assert.match(verified?.comment ?? "", /2 defect\(s\) verified without a failing test/);
  const flaky = grade(withSignals({ defects: { found: 1 } }, { verdict: "flaky", decision: "issue" }), "defect_found");
  assert.equal(flaky?.value, 1, "a defect found beside a flaky verdict still counts");
  const fromFact = grade(evidence({ verdict: "fail", adjudication: { class: "app_defect", confidence: "high" } }), "defect_found");
  assert.equal(fromFact?.value, 1);
  assert.match(fromFact?.comment ?? "", /from a fact/);
  assert.equal(grade(evidence({ verdict: "fail", adjudication: { class: "app_defect", confidence: "low" } }), "defect_found")?.value, 0, "the adjudicator's hint from the shape of a failure is not a fact");
  assert.equal(grade(evidence({ verdict: "fail", adjudication: { class: "generated_test_defect", confidence: "medium" } }), "defect_found")?.value, 0, "a failure the adjudicator blamed on the test found no defect");
  assert.equal(grade(withSignals({ defects: { found: 2 } }, { verdict: "fail", adjudication: { class: "app_defect", confidence: "high" } }), "defect_found")?.value, 3, "a verified defect and an adjudicated failure are two findings");
});

test("survivors_routed is the share of surviving mutants a delivered spec reached, and nothing without survivors", () => {
  assert.equal(grade(withSignals({ survivors: { routed: 1, total: 3 } }), "survivors_routed")?.value, 1 / 3);
  assert.equal(grade(withSignals({ survivors: { routed: 0, total: 0 } }), "survivors_routed"), undefined);
  assert.equal(grade(withSignals({ survivors: undefined }), "survivors_routed"), undefined);
});

test("survivors_closed is the share of judged survivors a test now fails under, apart from the first pass's kill rate, and nothing when none was judged again", () => {
  const closure = withSignals({ bundleMutation: { applied: 3, killed: 1 }, survivorClosure: { judged: 2, closed: 1 } });
  assert.equal(grade(closure, "survivors_closed")?.value, 1 / 2);
  assert.equal(grade(closure, "mutation_kill_rate")?.value, 1 / 3, "the first pass's rate does not take the closure's kills");
  assert.equal(grade(withSignals({ survivorClosure: { judged: 0, closed: 0 } }), "survivors_closed"), undefined);
  assert.equal(grade(withSignals({ survivorClosure: undefined }), "survivors_closed"), undefined);
});

test("availability_regressions counts the possible regressions and availability_unexplained is the unsettled share, both silent without an unavailable route", () => {
  const classified = withSignals({ routeAvailability: { unavailable: 4, byClass: { "change-introduced": 1, "regression-candidate": 1, unexplained: 2 } } });
  assert.equal(grade(classified, "availability_regressions")?.value, 1);
  assert.equal(grade(classified, "availability_unexplained")?.value, 2 / 4);
  const settled = withSignals({ routeAvailability: { unavailable: 2, byClass: { "pre-existing": 2 } } });
  assert.deepEqual([grade(settled, "availability_regressions")?.value, grade(settled, "availability_unexplained")?.value], [0, 0], "a measured zero is a zero");
  for (const routeAvailability of [undefined, { unavailable: 0, byClass: {} }]) {
    assert.deepEqual(gradeEvidence(withSignals({ routeAvailability }), ["availability_regressions", "availability_unexplained"]), []);
  }
  assert.deepEqual(gradeEvidence(withSignals({ routeAvailability: { unavailable: 1, byClass: { unexplained: 1 } } }, { finished: false, verdict: null }), ["availability_regressions", "availability_unexplained"]), []);
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
  const names = ["mutation_kill_rate", "change_coverage_ratio", "branch_coverage_ratio", "review_verdict", "defect_found", "survivors_routed", "survivors_closed", "flaky_triage", "drops_contradicted"];
  assert.deepEqual(gradeEvidence(e, names), []);
});

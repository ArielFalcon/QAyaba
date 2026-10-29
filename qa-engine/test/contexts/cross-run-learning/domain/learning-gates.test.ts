import { test } from "node:test";
import assert from "node:assert/strict";
import { NON_LEARNING, OBSERVED_OPERATING, learningGates, observesOperatingSignal } from "@contexts/cross-run-learning/domain/learning-gates.ts";
import { ERROR_CLASS, ERROR_CLASSES, type ErrorClass } from "@kernel/error-class.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

/*
 * Whether a run that ended with each class teaches the engine anything. Typed over every class, so
 * adding one without deciding here fails the type check, and the loop below fails at run time.
 */
const CLASS_LEARNS: Record<ErrorClass, boolean> = {
  "E-STATIC": true,
  "E-EXEC-FAIL": true,
  "E-FLAKY": false,
  "E-COVERAGE-GAP": true,
  "E-FALSE-POSITIVE": true,
  "E-WRONG-OBJECTIVE": true,
  "E-FRAGILE-SELECTOR": true,
  "E-NO-CLEANUP": true,
  "E-REVIEWER-REJECTED": true,
  "E-VALUE-SURVIVED": true,
  "E-INFRA": false,
  "E-STEP-BUDGET": true,
  "E-NO-DECISION": false,
  "E-NO-AUTHOR": false,
  "E-PRECONDITION": false,
  "E-TIME-BUDGET": false,
  "E-REVIEWER-UNAVAILABLE": false,
  "E-REVIEW-DISPUTED": false,
  "E-SANDBOX": false,
  "internal-error": false,
  "security-refusal": false,
};

const VERDICTS: readonly RunVerdict[] = ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"];
const OPEN = { mode: "diff", adjudicationClass: undefined } as const;

test("every error class has a decision on whether it teaches the engine", () => {
  for (const cls of ERROR_CLASSES) {
    assert.ok(cls in CLASS_LEARNS, `${cls} has no decision`);
  }
});

test("the non-learning set is exactly the classes decided as not learning", () => {
  for (const cls of ERROR_CLASSES) {
    assert.equal(NON_LEARNING.has(cls), !CLASS_LEARNS[cls], cls);
  }
});

for (const cls of ERROR_CLASSES) {
  test(`the audit gate for ${cls} follows whether the class teaches, and a flaky run is never audited`, () => {
    for (const verdict of VERDICTS) {
      const expected = CLASS_LEARNS[cls] && verdict !== "flaky";
      for (const stage of ["mainline", "terminal"] as const) {
        assert.equal(learningGates({ stage, verdict, errorClass: cls, ...OPEN }).audit, expected, `${stage} ${verdict}`);
      }
    }
  });

  test(`the terminal fold gate for ${cls} follows whether the class teaches, and the mainline fold gate never depends on it`, () => {
    for (const verdict of VERDICTS) {
      assert.equal(learningGates({ stage: "terminal", verdict, errorClass: cls, ...OPEN }).fold, CLASS_LEARNS[cls], `terminal ${verdict}`);
      assert.equal(learningGates({ stage: "mainline", verdict, errorClass: cls, ...OPEN }).fold, true, `mainline ${verdict}`);
    }
  });
}

test("a step-budget exhaustion that ended the run folds and is audited", () => {
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.STEP_BUDGET, ...OPEN });
  assert.deepEqual(gates, { fold: true, audit: true });
});

test("an undecided generation never folds or is audited", () => {
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.NO_DECISION, ...OPEN });
  assert.deepEqual(gates, { fold: false, audit: false });
});

test("a precondition failure that ended the run never folds or is audited", () => {
  assert.ok(NON_LEARNING.has(ERROR_CLASS.PRECONDITION));
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.PRECONDITION, ...OPEN });
  assert.deepEqual(gates, { fold: false, audit: false });
});

test("an infrastructure failure and a flaky verdict class neither fold at a terminal nor audit", () => {
  for (const errorClass of [ERROR_CLASS.INFRA, ERROR_CLASS.FLAKY]) {
    assert.deepEqual(learningGates({ stage: "terminal", verdict: "infra-error", errorClass, ...OPEN }), { fold: false, audit: false }, errorClass);
  }
});

test("a green run with no error class still folds at the mainline but is not audited", () => {
  for (const errorClass of [null, undefined, ""]) {
    assert.deepEqual(learningGates({ stage: "mainline", verdict: "pass", errorClass, ...OPEN }), { fold: true, audit: false }, String(errorClass));
  }
});

test("a terminal outcome with no error class teaches nothing", () => {
  for (const errorClass of [null, undefined, ""]) {
    assert.deepEqual(learningGates({ stage: "terminal", verdict: "invalid", errorClass, ...OPEN }), { fold: false, audit: false }, String(errorClass));
  }
});

test("a failure the adjudicator classed as an app defect neither folds nor is audited", () => {
  for (const stage of ["mainline", "terminal"] as const) {
    const gates = learningGates({ stage, verdict: "fail", errorClass: "E-EXEC-FAIL", adjudicationClass: "app_defect", mode: "diff" });
    assert.deepEqual(gates, { fold: false, audit: false }, stage);
  }
  const other = learningGates({ stage: "mainline", verdict: "fail", errorClass: "E-EXEC-FAIL", adjudicationClass: "test_defect", mode: "diff" });
  assert.deepEqual(other, { fold: true, audit: true });
});

test("a context-mode run neither folds nor is audited, whatever its stage, verdict or class", () => {
  for (const cls of ERROR_CLASSES) {
    for (const verdict of VERDICTS) {
      for (const stage of ["mainline", "terminal"] as const) {
        const gates = learningGates({ stage, verdict, errorClass: cls, adjudicationClass: undefined, mode: "context" });
        assert.deepEqual(gates, { fold: false, audit: false }, `${stage} ${verdict} ${cls}`);
      }
    }
  }
});

test("the classes whose recurrence is observed are all classes that teach nothing: observing never smuggles a lesson in", () => {
  for (const cls of OBSERVED_OPERATING) assert.ok(NON_LEARNING.has(cls), cls);
});

test("a run that ended on its time budget, or with its reviewer unavailable, reaches the audit's operating signal alone: no fold, and the audit gate stays closed", () => {
  for (const errorClass of [ERROR_CLASS.TIME_BUDGET, ERROR_CLASS.REVIEWER_UNAVAILABLE]) {
    assert.equal(observesOperatingSignal({ mode: "diff", errorClass }), true, errorClass);
    assert.deepEqual(learningGates({ stage: "terminal", verdict: "infra-error", errorClass, ...OPEN }), { fold: false, audit: false }, errorClass);
  }
});

test("every other class, and a run with none, has no operating signal to observe", () => {
  for (const cls of ERROR_CLASSES) {
    if (OBSERVED_OPERATING.has(cls)) continue;
    assert.equal(observesOperatingSignal({ mode: "diff", errorClass: cls }), false, cls);
  }
  assert.equal(observesOperatingSignal({ mode: "diff", errorClass: null }), false);
  assert.equal(observesOperatingSignal({ mode: "diff", errorClass: undefined }), false);
});

test("a context run is never audited, whatever it ended on", () => {
  assert.equal(observesOperatingSignal({ mode: "context", errorClass: ERROR_CLASS.TIME_BUDGET }), false);
});

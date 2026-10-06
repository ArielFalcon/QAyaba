import { test } from "node:test";
import assert from "node:assert/strict";
import { NON_LEARNING, learningGates } from "@contexts/qa-run-orchestration/domain/helpers/learning-gates.ts";
import { ERROR_CLASS, ERROR_CLASSES, type ErrorClass } from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
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
  "E-PRECONDITION": false,
};

const VERDICTS: readonly RunVerdict[] = ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"];
const OPEN = { mode: "diff", isCode: false, adjudicationClass: undefined } as const;

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
  test(`the reflection gate for ${cls} follows whether the class teaches, and a flaky run never reflects`, () => {
    for (const verdict of VERDICTS) {
      const expected = CLASS_LEARNS[cls] && verdict !== "flaky";
      for (const stage of ["mainline", "terminal"] as const) {
        assert.equal(learningGates({ stage, verdict, errorClass: cls, ...OPEN }).reflect, expected, `${stage} ${verdict}`);
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

test("a step-budget exhaustion that ended the run folds and reflects", () => {
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.STEP_BUDGET, ...OPEN });
  assert.deepEqual(gates, { fold: true, reflect: true });
});

test("an undecided generation never folds or reflects", () => {
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.NO_DECISION, ...OPEN });
  assert.deepEqual(gates, { fold: false, reflect: false });
});

test("a precondition failure that ended the run never folds or reflects", () => {
  assert.ok(NON_LEARNING.has(ERROR_CLASS.PRECONDITION));
  const gates = learningGates({ stage: "terminal", verdict: "infra-error", errorClass: ERROR_CLASS.PRECONDITION, ...OPEN });
  assert.deepEqual(gates, { fold: false, reflect: false });
});

test("an infrastructure failure and a flaky verdict class neither fold at a terminal nor reflect", () => {
  for (const errorClass of [ERROR_CLASS.INFRA, ERROR_CLASS.FLAKY]) {
    assert.deepEqual(learningGates({ stage: "terminal", verdict: "infra-error", errorClass, ...OPEN }), { fold: false, reflect: false }, errorClass);
  }
});

test("a green run with no error class still folds at the mainline but does not reflect", () => {
  for (const errorClass of [null, undefined, ""]) {
    assert.deepEqual(learningGates({ stage: "mainline", verdict: "pass", errorClass, ...OPEN }), { fold: true, reflect: false }, String(errorClass));
  }
});

test("a terminal outcome with no error class teaches nothing", () => {
  for (const errorClass of [null, undefined, ""]) {
    assert.deepEqual(learningGates({ stage: "terminal", verdict: "invalid", errorClass, ...OPEN }), { fold: false, reflect: false }, String(errorClass));
  }
});

test("a code-mode failure, which correctly caught a bug, neither folds nor reflects", () => {
  for (const stage of ["mainline", "terminal"] as const) {
    const gates = learningGates({ stage, verdict: "fail", errorClass: "E-EXEC-FAIL", isCode: true, adjudicationClass: undefined, mode: "diff" });
    assert.deepEqual(gates, { fold: false, reflect: false }, stage);
  }
  assert.equal(learningGates({ stage: "mainline", verdict: "fail", errorClass: "E-EXEC-FAIL", isCode: false, adjudicationClass: undefined, mode: "diff" }).fold, true);
});

test("a failure the adjudicator classed as an app defect neither folds nor reflects, in any mode", () => {
  for (const isCode of [true, false]) {
    for (const stage of ["mainline", "terminal"] as const) {
      const gates = learningGates({ stage, verdict: "fail", errorClass: "E-EXEC-FAIL", isCode, adjudicationClass: "app_defect", mode: "diff" });
      assert.deepEqual(gates, { fold: false, reflect: false }, `${stage} isCode=${isCode}`);
    }
  }
  const other = learningGates({ stage: "mainline", verdict: "fail", errorClass: "E-EXEC-FAIL", isCode: false, adjudicationClass: "test_defect", mode: "diff" });
  assert.deepEqual(other, { fold: true, reflect: true });
});

test("a context-mode run neither folds nor reflects, whatever its stage, verdict or class", () => {
  for (const cls of ERROR_CLASSES) {
    for (const verdict of VERDICTS) {
      for (const stage of ["mainline", "terminal"] as const) {
        const gates = learningGates({ stage, verdict, errorClass: cls, isCode: false, adjudicationClass: undefined, mode: "context" });
        assert.deepEqual(gates, { fold: false, reflect: false }, `${stage} ${verdict} ${cls}`);
      }
    }
  }
});

/* The graders of the lesson slice: how many lessons a run was told, the data-state failures of its final execution and the run_spec calls its specs took to pass. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRADER_VERSION } from "@contexts/evaluation/domain/grader-catalog.ts";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { evidence, signals } from "./evidence-fixtures.ts";

const score = (name: string, over: Partial<RunEvaluationEvidence>) => gradeEvidence(evidence(over), [name]).find((s) => s.name === name);
const call = (path: string, outcome: string) => ({ path, sha256: "x", outcome, refusal: undefined });
const delivered = (path: string) => ({ path, sha256: "x", passed: true });

test("a run that recorded a lessons signal is graded on how many lessons it was told, 0 for one that was told none, and one with no signal on neither", () => {
  assert.equal(score("lessons_delivered", { signals: signals({ lessons: { delivered: 2, dataStateFailures: undefined } }) })?.value, 2);
  assert.equal(score("lessons_delivered", { signals: signals({ lessons: { delivered: 0, dataStateFailures: 1 } }) })?.value, 0);
  assert.equal(score("lessons_delivered", { signals: signals() }), undefined);
});

test("data_state_failures is the count of the final execution's failures that read DEV's data differently from the pack, 0 when it executed and had none, and silent when none was measured", () => {
  assert.equal(score("data_state_failures", { signals: signals({ lessons: { delivered: 0, dataStateFailures: 3 } }) })?.value, 3);
  assert.equal(score("data_state_failures", { signals: signals({ lessons: { delivered: 0, dataStateFailures: 0 } }) })?.value, 0);
  assert.equal(score("data_state_failures", { signals: signals({ lessons: { delivered: 1, dataStateFailures: undefined } }) }), undefined);
  assert.equal(score("data_state_failures", { signals: signals() }), undefined);
});

test("calls_to_green is the mean run_spec calls a delivered spec took up to its first pass: a refused call is no run and a spec no call passed is left out", () => {
  const s = score("calls_to_green", {
    deliveredSpecs: [delivered("flows/cart.spec.ts"), delivered("flows/shops.spec.ts"), delivered("flows/never.spec.ts")],
    runSpecCalls: [
      call("flows/cart.spec.ts", "failed"), call("flows/cart.spec.ts", "refused"), call("flows/cart.spec.ts", "failed"), call("flows/cart.spec.ts", "passed"),
      call("flows/shops.spec.ts", "passed"),
      call("flows/never.spec.ts", "failed"),
    ],
  });
  assert.equal(s?.value, 2, "(3 + 1) / 2");
  assert.match(s?.comment ?? "", /1 of 2 spec\(s\) needed more than one run_spec call/);
  assert.equal(score("calls_to_green", { deliveredSpecs: [delivered("flows/a.spec.ts")], runSpecCalls: [call("flows/a.spec.ts", "failed")] }), undefined);
  assert.equal(score("calls_to_green", { deliveredSpecs: [delivered("flows/a.spec.ts")], runSpecCalls: [] }), undefined);
});

test("the grader version moved with the new graders, and each new score is in the catalog under it", () => {
  assert.equal(GRADER_VERSION, "4");
  for (const name of ["lessons_delivered", "data_state_failures", "calls_to_green"]) {
    const s = gradeEvidence(evidence({ signals: signals({ lessons: { delivered: 1, dataStateFailures: 1 } }), deliveredSpecs: [delivered("flows/a.spec.ts")], runSpecCalls: [call("flows/a.spec.ts", "passed")] }), [name]).find((x) => x.name === name);
    assert.equal(s?.graderVersion, GRADER_VERSION, name);
  }
});

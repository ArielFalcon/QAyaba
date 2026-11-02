/* The graders of the lesson slice: how many lessons a run was told, the data-state failures of its final execution and the run_spec calls its specs took to pass. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRADER_VERSION } from "@contexts/evaluation/domain/grader-catalog.ts";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { RunEvaluationEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { LESSON_SLICE_SCORE, decodeLessonSlice } from "@contexts/evaluation/domain/lesson-slice.ts";
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
  assert.equal(GRADER_VERSION, "8");
  for (const name of ["lessons_delivered", "data_state_failures", "calls_to_green", LESSON_SLICE_SCORE]) {
    const s = gradeEvidence(evidence({ sha: "abc1234", signals: signals({ lessons: { delivered: 1, dataStateFailures: 1 } }), deliveredSpecs: [delivered("flows/a.spec.ts")], runSpecCalls: [call("flows/a.spec.ts", "passed")] }), [name]).find((x) => x.name === name);
    assert.equal(s?.graderVersion, GRADER_VERSION, name);
  }
});

test("lesson_slice carries the commit, the pages of the lessons told, the failures by page and, per spec that went green, its flow's pages and calls, as the cycle reads them", () => {
  const lessons = {
    delivered: 1, dataStateFailures: 3, scopes: ["/shops/:city"], failuresByPage: [{ path: "/shops/madrid", count: 2 }, { path: "/orders", count: 1 }],
    specPages: [{ spec: "e2e/flows/shops.spec.ts", routes: ["/shops/madrid"] }, { spec: "e2e/flows/cart.spec.ts", routes: ["/cart"] }],
  };
  const s = score(LESSON_SLICE_SCORE, {
    sha: "abc1234",
    signals: signals({ lessons }),
    deliveredSpecs: [delivered("flows/shops.spec.ts"), delivered("flows/cart.spec.ts"), delivered("flows/unplanned.spec.ts"), delivered("flows/never.spec.ts")],
    runSpecCalls: [
      call("flows/shops.spec.ts", "failed"), call("flows/shops.spec.ts", "refused"), call("flows/shops.spec.ts", "passed"),
      call("flows/cart.spec.ts", "passed"), call("flows/unplanned.spec.ts", "passed"), call("flows/never.spec.ts", "failed"),
    ],
  });
  assert.equal(s?.graderVersion, GRADER_VERSION);
  assert.deepEqual(decodeLessonSlice(s?.value), {
    commit: "abc1234", scopes: ["/shops/:city"], failures: [{ path: "/shops/madrid", count: 2 }, { path: "/orders", count: 1 }],
    specs: [{ routes: ["/shops/madrid"], calls: 2 }, { routes: ["/cart"], calls: 1 }, { routes: [], calls: 1 }],
  });
});

test("lesson_slice states a run that measured no failure as null and a run told none as no page, and is silent without a commit or a lessons signal", () => {
  const unmeasured = score(LESSON_SLICE_SCORE, { sha: "abc1234", signals: signals({ lessons: { delivered: 0, dataStateFailures: undefined } }) });
  assert.deepEqual(decodeLessonSlice(unmeasured?.value), { commit: "abc1234", scopes: [], failures: null, specs: [] });
  assert.equal(score(LESSON_SLICE_SCORE, { signals: signals({ lessons: { delivered: 0, dataStateFailures: 0 } }) }), undefined, "no commit, no pairing");
  assert.equal(score(LESSON_SLICE_SCORE, { sha: "abc1234", signals: signals() }), undefined);
  assert.equal(score(LESSON_SLICE_SCORE, { sha: "abc1234", finished: false, signals: signals({ lessons: { delivered: 0, dataStateFailures: 0 } }) }), undefined);
});

test("a value that is not a lesson slice decodes to nothing", () => {
  for (const value of [undefined, 3, "", "{", "null", JSON.stringify({ v: 2, commit: "c", scopes: [], failures: null, specs: [] }), JSON.stringify({ v: 1, commit: "c", scopes: [1], failures: null, specs: [] }), JSON.stringify({ v: 1, commit: "c", scopes: [], failures: [{ path: "/a" }], specs: [] }), JSON.stringify({ v: 1, commit: "c", scopes: [], failures: null, specs: [{ routes: [], calls: -1 }] })]) {
    assert.equal(decodeLessonSlice(value), undefined, String(value));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CLASS, ERROR_CLASSES, resolveErrorClass } from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";

const BASE = { coverageRatio: null, minCoverageRatio: 0.7, reviewerCorrections: [] as string[] };

test("the class list holds every named class exactly once, including the two a generation end can name", () => {
  assert.equal(new Set(ERROR_CLASSES).size, ERROR_CLASSES.length);
  for (const cls of Object.values(ERROR_CLASS)) {
    assert.ok((ERROR_CLASSES as readonly string[]).includes(cls), `${cls} is listed`);
  }
});

test("an exhausted generation resolves to the step-budget class, whatever the verdict-derived class would be", () => {
  assert.equal(resolveErrorClass({ ...BASE, verdict: "infra-error", generationEnd: GENERATION_END.EXHAUSTED }), ERROR_CLASS.STEP_BUDGET);
  assert.equal(resolveErrorClass({ ...BASE, verdict: "invalid", generationEnd: GENERATION_END.EXHAUSTED }), ERROR_CLASS.STEP_BUDGET);
});

test("an undecided generation resolves to the no-decision class, ahead of reviewer corrections", () => {
  assert.equal(resolveErrorClass({ ...BASE, verdict: "infra-error", generationEnd: GENERATION_END.UNDECIDED_EMPTY }), ERROR_CLASS.NO_DECISION);
  assert.equal(
    resolveErrorClass({ ...BASE, verdict: "infra-error", reviewerCorrections: ["[false-positive] asserts nothing"], generationEnd: GENERATION_END.UNDECIDED_EMPTY }),
    ERROR_CLASS.NO_DECISION,
  );
});

test("every other generation end leaves the verdict-derived class untouched", () => {
  for (const generationEnd of [GENERATION_END.DELIVERED, GENERATION_END.DECLARED_NOOP, GENERATION_END.NO_VERDICT, undefined]) {
    assert.equal(resolveErrorClass({ ...BASE, verdict: "infra-error", generationEnd }), ERROR_CLASS.INFRA, String(generationEnd));
    assert.equal(resolveErrorClass({ ...BASE, verdict: "invalid", generationEnd }), "E-STATIC", String(generationEnd));
    assert.equal(resolveErrorClass({ ...BASE, verdict: "skipped", generationEnd }), null, String(generationEnd));
  }
});

test("a precondition failure resolves to the precondition class, ahead of whatever the verdict or a reviewer would name", () => {
  for (const verdict of ["infra-error", "invalid", "fail", "flaky", "pass", "skipped"]) {
    assert.equal(resolveErrorClass({ ...BASE, verdict, preconditionFailed: true }), ERROR_CLASS.PRECONDITION, verdict);
  }
  assert.equal(
    resolveErrorClass({ ...BASE, verdict: "invalid", reviewerCorrections: ["[false-positive] asserts nothing"], preconditionFailed: true }),
    ERROR_CLASS.PRECONDITION,
  );
});

test("a run that did not fail a precondition keeps the class its verdict implies", () => {
  for (const preconditionFailed of [false, undefined]) {
    assert.equal(resolveErrorClass({ ...BASE, verdict: "infra-error", preconditionFailed }), ERROR_CLASS.INFRA, String(preconditionFailed));
    assert.equal(resolveErrorClass({ ...BASE, verdict: "invalid", preconditionFailed }), "E-STATIC", String(preconditionFailed));
  }
});

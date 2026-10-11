import { test } from "node:test";
import assert from "node:assert/strict";
import { engineSideCauseOf, terminalForGenerationEnd } from "@contexts/qa-run-orchestration/domain/helpers/generation-end-terminal.ts";
import { ERROR_CLASS, resolveErrorClass } from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";

test("an exhausted generation ends the run as a persisted infra-error with the step-budget class", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.EXHAUSTED), {
    action: "end",
    verdict: "infra-error",
    errorClass: ERROR_CLASS.STEP_BUDGET,
    persisted: true,
  });
});

test("a generation that ran out of time ends the run as a persisted infra-error with the time-budget class", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.TIME_BUDGET), {
    action: "end",
    verdict: "infra-error",
    errorClass: ERROR_CLASS.TIME_BUDGET,
    persisted: true,
  });
});

test("an undecided generation ends the run as a persisted infra-error with the no-decision class", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.UNDECIDED_EMPTY), {
    action: "end",
    verdict: "infra-error",
    errorClass: ERROR_CLASS.NO_DECISION,
    persisted: true,
  });
});

test("a generation that produced no readable verdict keeps the existing unpersisted infra failure", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.NO_VERDICT), {
    action: "end",
    verdict: "infra-error",
    errorClass: ERROR_CLASS.INFRA,
    persisted: false,
  });
});

test("a declared no-op skips the run", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.DECLARED_NOOP), { action: "skip" });
});

test("a generation that delivered specs lets the run continue", () => {
  assert.deepEqual(terminalForGenerationEnd(GENERATION_END.DELIVERED), { action: "continue" });
});

test("the class each ending run names is the class the persisted outcome resolves to", () => {
  for (const end of [GENERATION_END.EXHAUSTED, GENERATION_END.TIME_BUDGET, GENERATION_END.UNDECIDED_EMPTY, GENERATION_END.NO_VERDICT]) {
    const terminal = terminalForGenerationEnd(end);
    assert.equal(terminal.action, "end", end);
    if (terminal.action !== "end") continue;
    const resolved = resolveErrorClass({
      verdict: terminal.verdict,
      coverageRatio: null,
      minCoverageRatio: 0.7,
      reviewerCorrections: [],
      generationEnd: end,
    });
    assert.equal(resolved, terminal.errorClass, end);
  }
});

test("the log of a run a generation ended names the budget that ran out, apart for steps and for time, or else the missing decision", () => {
  const causes = [GENERATION_END.EXHAUSTED, GENERATION_END.TIME_BUDGET, GENERATION_END.UNDECIDED_EMPTY].map(engineSideCauseOf);
  assert.match(causes[0]!, /step/);
  assert.match(causes[1]!, /time/);
  assert.match(causes[2]!, /decision/);
  assert.equal(new Set(causes).size, 3);
});

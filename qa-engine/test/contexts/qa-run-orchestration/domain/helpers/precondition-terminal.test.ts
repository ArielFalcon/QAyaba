import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalForPrecondition } from "@contexts/qa-run-orchestration/domain/helpers/precondition-terminal.ts";
import { ERROR_CLASS, resolveErrorClass } from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import { RUN_MODES, type RunMode } from "@kernel/run-mode.ts";

const ENDING_MODES: readonly RunMode[] = RUN_MODES.filter((mode) => mode !== "context");

test("a precondition failure ends every run that generates tests as a persisted infra-error with the precondition class", () => {
  assert.ok(ENDING_MODES.includes("diff"), "the ordinary run mode is among the ending ones");
  for (const mode of ENDING_MODES) {
    const terminal = terminalForPrecondition(mode);
    assert.equal(terminal.action, "end", mode);
    if (terminal.action !== "end") continue;
    assert.equal(terminal.verdict, "infra-error", mode);
    assert.equal(terminal.errorClass, ERROR_CLASS.PRECONDITION, mode);
    assert.equal(terminal.persisted, true, mode);
  }
});

test("a context run, which builds a map and no tests, carries on past a precondition failure", () => {
  assert.equal(terminalForPrecondition("context").action, "continue");
});

test("the class the ending terminal names is the class the persisted outcome resolves to", () => {
  for (const mode of ENDING_MODES) {
    const terminal = terminalForPrecondition(mode);
    assert.equal(terminal.action, "end", mode);
    if (terminal.action !== "end") continue;
    const resolved = resolveErrorClass({
      verdict: terminal.verdict,
      coverageRatio: null,
      minCoverageRatio: 0.7,
      reviewerCorrections: [],
      preconditionFailed: true,
    });
    assert.equal(resolved, terminal.errorClass, mode);
  }
});

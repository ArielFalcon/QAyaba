import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalForPrecondition } from "@contexts/qa-run-orchestration/domain/helpers/precondition-terminal.ts";
import { RUN_MODES, type RunMode } from "@kernel/run-mode.ts";

const ENDING_MODES: readonly RunMode[] = RUN_MODES.filter((mode) => mode !== "context");

test("a precondition failure ends every run that generates tests as an infra-error", () => {
  assert.ok(ENDING_MODES.includes("diff"), "the ordinary run mode is among the ending ones");
  for (const mode of ENDING_MODES) {
    const terminal = terminalForPrecondition(mode);
    assert.equal(terminal.action, "end", mode);
    if (terminal.action !== "end") continue;
    assert.equal(terminal.verdict, "infra-error", mode);
  }
});

test("a context run, which builds a map and no tests, carries on past a precondition failure", () => {
  assert.equal(terminalForPrecondition("context").action, "continue");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { toolOutcome, toolOutcomeMessage, toolOutcomeStatus, type ToolOutcome } from "@contexts/generation/domain/tool-outcome.ts";

test("a call that is still running has no ending, whatever else the reading says", () => {
  assert.deepEqual(toolOutcome({ status: "running", refusedByRule: true, repaired: { attempted: "x" }, message: "m" }), { kind: "running" });
});

test("a repaired call is invalid whether the runtime called it completed or failed, and keeps only what the reading stated", () => {
  const repaired = { attempted: "readfile", message: "filePath is required" };
  assert.deepEqual(toolOutcome({ status: "completed", refusedByRule: false, repaired }), { kind: "invalid", ...repaired });
  assert.deepEqual(toolOutcome({ status: "error", refusedByRule: true, repaired }), { kind: "invalid", ...repaired });
  assert.deepEqual(toolOutcome({ status: "completed", refusedByRule: false, repaired: {} }), { kind: "invalid" });
});

test("a completed call carries no message; a failed one is denied only when a rule refused it, and carries the message it was given", () => {
  assert.deepEqual(toolOutcome({ status: "completed", refusedByRule: false, message: "ignored" }), { kind: "completed" });
  assert.deepEqual(toolOutcome({ status: "error", refusedByRule: false, message: "boom" }), { kind: "failed", message: "boom" });
  assert.deepEqual(toolOutcome({ status: "error", refusedByRule: true, message: "rule" }), { kind: "denied", message: "rule" });
  assert.deepEqual(toolOutcome({ status: "error", refusedByRule: false }), { kind: "failed" });
});

test("the message and the span status are read from the outcome's kind", () => {
  const outcomes: ToolOutcome[] = [{ kind: "completed" }, { kind: "running" }, { kind: "failed", message: "a" }, { kind: "denied", message: "b" }, { kind: "invalid", message: "c" }];
  assert.deepEqual(outcomes.map(toolOutcomeMessage), [undefined, undefined, "a", "b", "c"]);
  assert.deepEqual(outcomes.map(toolOutcomeStatus), ["completed", "running", "error", "denied", "error"]);
});

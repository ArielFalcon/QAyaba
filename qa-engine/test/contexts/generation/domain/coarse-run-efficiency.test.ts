import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRunEfficiency } from "@contexts/generation/domain/coarse-run-efficiency.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL, type RunStep } from "@kernel/run-step.ts";
import type { RunEventBody } from "@kernel/contract/events.ts";

function stepChanged(step: RunStep, detail?: string): RunEventBody {
  return { type: "step.changed", step, ...(detail ? { detail } : {}) };
}

function activity(
  callId: string | undefined,
  kind: "analyzing" | "writing" | "command" | "subagent",
  status: "running" | "completed" = "completed",
  target = "t",
): RunEventBody {
  return { type: "agent.activity", kind, target, status, ...(callId ? { callId } : {}) };
}

test("splits grounding from first-pass activity using the PRE_GENERATION_GROUNDING_STEP_DETAIL window", () => {
  const events: RunEventBody[] = [
    stepChanged("generate", PRE_GENERATION_GROUNDING_STEP_DETAIL),
    activity("c1", "analyzing"),
    activity("c2", "writing"),
    stepChanged("generate"),
    activity("c3", "analyzing"),
    activity("c4", "writing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.grounding.totalCalls, 2);
  assert.equal(result.grounding.writeCount, 1);
  assert.equal(result.firstPass.totalCalls, 2);
  assert.equal(result.firstPass.writeCount, 1);
});

test("wholeRunExcludingGrounding counts every agent.activity call except those inside the grounding window", () => {
  const events: RunEventBody[] = [
    stepChanged("generate", PRE_GENERATION_GROUNDING_STEP_DETAIL),
    activity("c1", "analyzing"),
    stepChanged("generate"),
    activity("c2", "analyzing"),
    stepChanged("retry"),
    activity("c3", "writing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.grounding.totalCalls, 1);
  assert.equal(result.wholeRunExcludingGrounding.totalCalls, 2);
});

test("a retry regeneration pass counts toward wholeRunExcludingGrounding but not firstPass (only the first generate window is firstPass)", () => {
  const events: RunEventBody[] = [
    stepChanged("generate"),
    activity("c1", "analyzing"),
    stepChanged("retry"),
    stepChanged("generate"),
    activity("c2", "writing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.firstPass.totalCalls, 1);
  assert.equal(result.wholeRunExcludingGrounding.totalCalls, 2);
});

test("agent.activity events with no callId are excluded from every window", () => {
  const events: RunEventBody[] = [
    stepChanged("generate"),
    activity(undefined, "analyzing"),
    activity("c1", "analyzing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.firstPass.totalCalls, 1);
});

test("a run with no grounding window at all yields an empty grounding summary and a normal firstPass", () => {
  const events: RunEventBody[] = [stepChanged("generate"), activity("c1", "writing")];
  const result = classifyRunEfficiency(events);
  assert.equal(result.grounding.totalCalls, 0);
  assert.equal(result.firstPass.totalCalls, 1);
});

test("commandCount and subagentCount reconcile with the coarse activity kinds", () => {
  const events: RunEventBody[] = [
    stepChanged("generate"),
    activity("c1", "command"),
    activity("c2", "subagent"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.firstPass.commandCount, 1);
  assert.equal(result.firstPass.subagentCount, 1);
});

test("a call repeats another only when it has the same kind and the same target", () => {
  const events: RunEventBody[] = [
    stepChanged("generate"),
    activity("c1", "analyzing", "completed", "src/a.ts"),
    activity("c2", "analyzing", "completed", "src/b.ts"),
    activity("c3", "writing", "completed", "src/a.ts"),
    activity("c4", "analyzing", "completed", "src/a.ts"),
  ];
  assert.equal(classifyRunEfficiency(events).firstPass.repeatedCallCount, 1, "only c4 repeats c1");
});

test("the grounding window belongs to the generate step only", () => {
  const events: RunEventBody[] = [
    stepChanged("retry", PRE_GENERATION_GROUNDING_STEP_DETAIL),
    activity("c1", "analyzing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.grounding.totalCalls, 0);
  assert.equal(result.wholeRunExcludingGrounding.totalCalls, 1);
});

test("a step before generate never opens the first-pass window", () => {
  const events: RunEventBody[] = [
    stepChanged("setup"),
    activity("c1", "analyzing"),
    stepChanged("generate"),
    activity("c2", "writing"),
  ];
  const result = classifyRunEfficiency(events);
  assert.equal(result.firstPass.totalCalls, 1);
  assert.equal(result.firstPass.writeCount, 1, "the first pass is the generate window's call, not the setup one");
  assert.equal(result.wholeRunExcludingGrounding.totalCalls, 2);
});

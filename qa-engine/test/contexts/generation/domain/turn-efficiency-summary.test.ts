import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tallyBuckets,
  buildTurnCallMetrics,
  buildTurnStepBudget,
} from "@contexts/generation/domain/turn-efficiency-summary.ts";
import { CALL_BUCKETS } from "@contexts/generation/domain/tool-call-taxonomy.ts";
import { summarizeCallSequence, type CallRecord } from "@contexts/generation/domain/call-sequence.ts";

test("tallyBuckets zero-fills every CallBucket key, not just the ones seen", () => {
  const tally = tallyBuckets([CALL_BUCKETS.WRITE, CALL_BUCKETS.WRITE, CALL_BUCKETS.CODE_READ]);
  assert.deepEqual(tally, {
    code_read: 1,
    browser: 0,
    write: 2,
    validate_run: 0,
    memory: 0,
    subagent: 0,
    other: 0,
  });
});

test("buildTurnCallMetrics assembles the pinned TurnCallMetrics shape from a call sequence and the extra fine-only counts", () => {
  const calls: CallRecord[] = [
    { callId: "c1", status: "completed", bucket: CALL_BUCKETS.CODE_READ, repeatKey: "read:/a.ts" },
    { callId: "c2", status: "completed", bucket: CALL_BUCKETS.WRITE, repeatKey: "write:/a.ts" },
  ];
  const sequence = summarizeCallSequence(calls);

  const metrics = buildTurnCallMetrics({
    sequence,
    buckets: [CALL_BUCKETS.CODE_READ, CALL_BUCKETS.WRITE],
    redundantReadCount: 1,
    promptProvidedReadCount: 1,
    stepsUsed: 4,
    observationComplete: true,
  });

  assert.equal(metrics.totalCalls, 2);
  assert.equal(metrics.stepsUsed, 4);
  assert.equal(metrics.observationComplete, true);
  assert.equal(metrics.callsBeforeFirstWrite, 1);
  assert.equal(metrics.writeCount, 1);
  assert.equal(metrics.redundantReadCount, 1);
  assert.equal(metrics.promptProvidedReadCount, 1);
  assert.equal(metrics.buckets.code_read, 1);
  assert.equal(metrics.buckets.write, 1);
});

test("buildTurnCallMetrics carries duplicateCallCount straight from the sequence's repeatedCallCount", () => {
  const calls: CallRecord[] = [
    { callId: "c1", status: "completed", bucket: CALL_BUCKETS.CODE_READ, repeatKey: "read:/a.ts" },
    { callId: "c2", status: "completed", bucket: CALL_BUCKETS.CODE_READ, repeatKey: "read:/a.ts" },
  ];
  const sequence = summarizeCallSequence(calls);
  const metrics = buildTurnCallMetrics({
    sequence,
    buckets: [CALL_BUCKETS.CODE_READ, CALL_BUCKETS.CODE_READ],
    redundantReadCount: 0,
    promptProvidedReadCount: 0,
    stepsUsed: null,
    observationComplete: false,
  });
  assert.equal(metrics.duplicateCallCount, 1);
  assert.equal(metrics.stepsUsed, null);
  assert.equal(metrics.observationComplete, false);
});

test("buildTurnStepBudget reads exhaustion from the final step's text and the observed step count, and passes maxSteps through", () => {
  const noticeText = "CRITICAL - MAXIMUM STEPS REACHED. The maximum number of steps allowed for this task has been reached.";
  const exhausted = buildTurnStepBudget({ maxSteps: 50, stepsUsed: null, finalStepText: noticeText });
  assert.equal(exhausted.maxSteps, 50);
  assert.equal(exhausted.exhausted, true);

  const byCount = buildTurnStepBudget({ maxSteps: 50, stepsUsed: 50, finalStepText: "Here is the summary." });
  assert.equal(byCount.exhausted, true);

  const notExhausted = buildTurnStepBudget({ maxSteps: 50, stepsUsed: 12, finalStepText: "Here is the summary of the work completed in this turn." });
  assert.equal(notExhausted.exhausted, false);
});

test("buildTurnStepBudget leaves exhaustion unknown when the count is unknown and there is no notice", () => {
  const budget = buildTurnStepBudget({ maxSteps: 50, stepsUsed: null, finalStepText: "Here is the summary." });
  assert.equal(budget.maxSteps, 50);
  assert.equal(budget.exhausted, null);
});

test("buildTurnStepBudget passes a null maxSteps through unchanged (Codex has no step limit) and stays unknown", () => {
  const budget = buildTurnStepBudget({ maxSteps: null, stepsUsed: null, finalStepText: "any output text" });
  assert.equal(budget.maxSteps, null);
  assert.equal(budget.exhausted, null);
});

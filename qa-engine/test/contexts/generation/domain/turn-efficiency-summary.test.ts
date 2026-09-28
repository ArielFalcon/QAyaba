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
  });

  assert.equal(metrics.totalCalls, 2);
  assert.equal(metrics.stepsUsed, 4);
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
  });
  assert.equal(metrics.duplicateCallCount, 1);
  assert.equal(metrics.stepsUsed, null);
});

test("buildTurnStepBudget detects exhaustion from the turn's own output text (D10) and passes maxSteps through", () => {
  const exhausted = buildTurnStepBudget(50, "CRITICAL - MAXIMUM STEPS REACHED. The maximum number of steps allowed for this task has been reached.");
  assert.equal(exhausted.maxSteps, 50);
  assert.equal(exhausted.exhausted, true);

  const notExhausted = buildTurnStepBudget(50, "Here is the summary of the work completed in this turn.");
  assert.equal(notExhausted.exhausted, false);
});

test("buildTurnStepBudget passes a null maxSteps through unchanged (Codex, D3)", () => {
  const budget = buildTurnStepBudget(null, "any output text");
  assert.equal(budget.maxSteps, null);
  assert.equal(budget.exhausted, false);
});

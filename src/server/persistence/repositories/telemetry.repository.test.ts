import { test } from "node:test";
import assert from "node:assert/strict";
import { getHistory } from "../index";
import type { AgentTurnEventInput, AgentTurnRecord } from "./telemetry.repository";


function makeTurn(overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    runId: "run-test-001",
    sessionId: "sess-abc",
    role: "qa-author",
    round: 0,
    isRepair: false,
    ts: new Date().toISOString(),
    objective: "test the login flow",
    promptText: "Write a Playwright test for the login feature.",
    outputText: "The test is written.",
    promptBytes: 43,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: 10,
    tokensCacheRead: 5,
    tokensCacheWrite: 2,
    cost: 0.001,
    ...overrides,
  };
}

test("saveAgentTurn round-trips to getAgentTurns with all fields", () => {
  const turn = makeTurn();
  getHistory().telemetry.saveAgentTurn(turn);
  const rows = getHistory().telemetry.getAgentTurns(turn.runId!);
  assert.ok(rows.length >= 1, "at least one row must be returned");
  const saved = rows.find((r) => r.sessionId === turn.sessionId && r.role === turn.role);
  assert.ok(saved, "the saved turn must be retrievable by runId");
  assert.equal(saved!.role, "qa-author");
  assert.equal(saved!.round, 0);
  assert.equal(saved!.isRepair, false);
  assert.equal(saved!.promptText, turn.promptText);
  assert.equal(saved!.outputText, turn.outputText);
  assert.equal(saved!.promptBytes, turn.promptBytes);
  assert.equal(saved!.tokensInput, 100);
  assert.equal(saved!.tokensOutput, 50);
  assert.equal(saved!.tokensReasoning, 10);
  assert.equal(saved!.tokensCacheRead, 5);
  assert.equal(saved!.tokensCacheWrite, 2);
  assert.ok(Math.abs((saved!.cost ?? 0) - 0.001) < 1e-9);
  assert.equal(saved!.objective, "test the login flow");
});

function makeTurnEvent(overrides: Partial<AgentTurnEventInput> = {}): AgentTurnEventInput {
  return {
    runId: "run-event-001",
    sessionId: "sess-event",
    role: "qa-author",
    objective: undefined,
    round: 0,
    isRepair: false,
    promptText: "Write a test.",
    promptBytes: 13,
    outputText: "Done.",
    tokensInput: 10,
    tokensOutput: 5,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: null,
    ts: new Date().toISOString(),
    sectionSizes: null,
    stepBudget: null,
    callMetrics: null,
    durationMs: null,
    ...overrides,
  };
}

test("saveAgentTurnEvent persists the step budget and the call metrics of a turn", () => {
  const runId = "run-event-metrics-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(
    makeTurnEvent({
      runId,
      stepBudget: { maxSteps: 50, exhausted: true },
      callMetrics: {
        totalCalls: 31,
        stepsUsed: 50,
        observationComplete: true,
        callsBeforeFirstWrite: 27,
        writeCount: 2,
        commandCount: 1,
        redundantReadCount: 6, sameFileReadCount: 6,
        duplicateCallCount: 4,
        promptProvidedReadCount: 3,
        pathProvidedReadCount: 2, graphProvidedReadCount: 5,
        buckets: { code_read: 20, code_graph: 3, browser: 6, write: 2, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 2 },
        timeToFirstCallMs: 1_800,
        timeToFirstWriteMs: 95_000,
        deniedCallCount: 2,
        toolSequence: [
          { tool: "read", target: "src/app/a.ts" },
          { tool: "grep", target: "createUser", scope: "src" },
          { tool: "bash", target: "rm -rf /", denied: true },
        ],
        usage: { input: 52_000, output: 1_900, reasoning: 400, cacheRead: 1_200_000, cacheWrite: 0, cost: 0.0421, steps: 50 },
      },
      durationMs: 361_500,
    }),
  );
  const [saved] = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(saved!.maxSteps, 50);
  assert.equal(saved!.exhausted, true);
  assert.equal(saved!.totalCalls, 31);
  assert.equal(saved!.stepsUsed, 50);
  assert.equal(saved!.callsBeforeFirstWrite, 27);
  assert.equal(saved!.writeCount, 2);
  assert.equal(saved!.redundantReadCount, 6);
  assert.equal(saved!.duplicateCallCount, 4);
  assert.equal(saved!.promptProvidedReadCount, 3);
  assert.equal(saved!.pathProvidedReadCount, 2, "the path-provided count is stored apart from the content-provided one");
  assert.equal(saved!.graphProvidedReadCount, 5, "the graph-provided count is stored apart from the prompt's two");
  assert.deepEqual(saved!.callBuckets, { code_read: 20, code_graph: 3, browser: 6, write: 2, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 2 });
  assert.equal(saved!.durationMs, 361_500);
  assert.equal(saved!.timeToFirstCallMs, 1_800);
  assert.equal(saved!.timeToFirstWriteMs, 95_000);
  assert.equal(saved!.deniedCallCount, 2);
  assert.deepEqual(saved!.usageTotal, { input: 52_000, output: 1_900, reasoning: 400, cacheRead: 1_200_000, cacheWrite: 0, cost: 0.0421, steps: 50 }, "the usage of every step is kept apart from the last message's tokens");
  assert.deepEqual(saved!.toolSequence, [
    { tool: "read", target: "src/app/a.ts" },
    { tool: "grep", target: "createUser", scope: "src" },
    { tool: "bash", target: "rm -rf /", denied: true },
  ]);
});

test("saveAgentTurnEvent keeps the model asked for and the one that answered, the attempt, the error class, the prompt's hashes and the limits", () => {
  const runId = "run-event-trace-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({
    runId,
    sessionId: "s-traced",
    sectionSizes: { task: 120, "working-rules": 4_000 },
    modelRequested: "prov/asked",
    modelAnswered: "answered-model",
    provider: "prov",
    attempt: 2,
    fallbackUsed: true,
    errorType: "socket_closed",
    sectionHashes: { task: "a".repeat(64), "working-rules": "b".repeat(64) },
    promptHash: "c".repeat(64),
    limitApplied: "tier-budget",
    limitFired: "step-cap",
  }));
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-untraced" }));
  const turns = getHistory().telemetry.getAgentTurnTraces(runId);
  assert.equal(getHistory().telemetry.getAgentTurns(runId).length, 2, "the public turn view still lists both rows");
  const traced = turns.find((t) => t.sessionId === "s-traced")!;
  assert.deepEqual(
    [traced.modelRequested, traced.modelAnswered, traced.provider, traced.attempt, traced.fallbackUsed, traced.errorType, traced.limitApplied, traced.limitFired],
    ["prov/asked", "answered-model", "prov", 2, true, "socket_closed", "tier-budget", "step-cap"],
  );
  assert.deepEqual(traced.sectionSizes, { task: 120, "working-rules": 4_000 });
  assert.deepEqual(traced.sectionHashes, { task: "a".repeat(64), "working-rules": "b".repeat(64) });
  assert.equal(traced.promptHash, "c".repeat(64));
  const untraced = turns.find((t) => t.sessionId === "s-untraced")!;
  assert.deepEqual(
    [untraced.modelRequested, untraced.modelAnswered, untraced.provider, untraced.attempt, untraced.fallbackUsed, untraced.errorType, untraced.sectionSizes, untraced.sectionHashes, untraced.promptHash, untraced.limitApplied, untraced.limitFired],
    [null, null, null, null, null, null, null, null, null, null, null],
    "a turn that carries none of it reads back as unknown, never as an empty value",
  );
});

test("saveAgentTurnEvent keeps how a turn ended, and a turn that never answered reads back with its partial calls and empty output", () => {
  const runId = "run-event-ended-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, round: 0, ended: "completed" }));
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({
    runId,
    round: 1,
    outputText: "",
    ended: "timeout",
    stepBudget: { maxSteps: 50, exhausted: false },
    callMetrics: {
      totalCalls: 31, stepsUsed: 12, observationComplete: true, callsBeforeFirstWrite: 31, writeCount: 0, commandCount: 0, redundantReadCount: 0, sameFileReadCount: 0,
      duplicateCallCount: 0, promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0,
      buckets: { code_read: 20, code_graph: 0, browser: 6, write: 0, validate_run: 1, script_run: 4, memory: 0, subagent: 0, other: 0 },
      timeToFirstCallMs: 70_000, timeToFirstWriteMs: null, deniedCallCount: 0, toolSequence: [], usage: null,
    },
  }));
  const [answered, timedOut] = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(answered!.ended, "completed");
  assert.equal(timedOut!.ended, "timeout");
  assert.equal(timedOut!.outputText, "");
  assert.equal(timedOut!.totalCalls, 31);
  assert.equal(timedOut!.callBuckets?.script_run, 4);
});

test("saveAgentTurnEvent leaves the end null, never a guess, when the transport does not say how the turn ended", () => {
  const runId = "run-event-ended-null-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId }));
  assert.equal(getHistory().telemetry.getAgentTurns(runId)[0]!.ended, null);
});

test("saveAgentTurnEvent stores nulls, never zero or false, when a runtime reports no step budget or call metrics", () => {
  const runId = "run-event-null-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, stepBudget: null, callMetrics: null }));
  const [saved] = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(saved!.maxSteps, null);
  assert.equal(saved!.exhausted, null);
  assert.equal(saved!.totalCalls, null);
  assert.equal(saved!.stepsUsed, null);
  assert.equal(saved!.callBuckets, null);
});

test("saveAgentTurnEvent keeps an unknown step limit (null) apart from a known exhaustion flag and an unknown steps-used", () => {
  const runId = "run-event-partial-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, stepBudget: { maxSteps: null, exhausted: false } }));
  const [saved] = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(saved!.maxSteps, null);
  assert.equal(saved!.exhausted, false);
  assert.equal(saved!.stepsUsed, null);
});

test("saveAgentTurnEvent keeps a turn whose exhaustion is unknown apart from one known not exhausted, and reads it back as unknown", () => {
  const runId = "run-event-unknown-exhaustion-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-unknown", stepBudget: { maxSteps: 50, exhausted: null } }));
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-known", stepBudget: { maxSteps: 50, exhausted: false } }));
  const turns = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(turns.find((t) => t.sessionId === "s-unknown")!.exhausted, null);
  assert.equal(turns.find((t) => t.sessionId === "s-known")!.exhausted, false);
  assert.equal(turns.find((t) => t.sessionId === "s-unknown")!.maxSteps, 50);
});

test("saveAgentTurn stores null-runId turns (sessions with no parent run)", () => {
  const turn = makeTurn({ runId: null, sessionId: "sess-no-run" });
  /* Should not throw — null runId is explicitly valid (e.g. maintainer, chat sessions). */
  assert.doesNotThrow(() => getHistory().telemetry.saveAgentTurn(turn));
});

test("getAgentTurns returns multiple turns in chronological order", () => {
  const runId = "run-order-test-" + Date.now();
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 0, role: "qa-author", promptText: "first" }));
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 1, role: "qa-author", promptText: "second" }));
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, sessionId: "s2", round: 0, role: "qa-reviewer", promptText: "review" }));
  const rows = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.promptText, "first");
  assert.equal(rows[1]!.promptText, "second");
  assert.equal(rows[2]!.role, "qa-reviewer");
});

test("saveAgentTurn accepts null token fields (a runtime that reports no tokens)", () => {
  const runId = "run-null-tokens-" + Date.now();
  const turn = makeTurn({
    runId,
    sessionId: "sess-null-tokens",
    tokensInput: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: null,
  });
  getHistory().telemetry.saveAgentTurn(turn);
  const rows = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokensInput, null);
  assert.equal(rows[0]!.tokensOutput, null);
  assert.equal(rows[0]!.cost, null);
});

test("saveAgentTurn stores sanitized output — caller must pre-sanitize (contract)", () => {
  /* The store accepts whatever it receives; the DI contract requires the caller (defaultAgentDeps
     funnel) to sanitize before calling saveAgentTurn. We test that round-trip is faithful.
   */
  const runId = "run-sanitize-rt-" + Date.now();
  const sanitizedText = "[REDACTED] was in the output";
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, outputText: sanitizedText }));
  const rows = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(rows[0]!.outputText, sanitizedText);
});

test("two turns of one run from different sessions are both stored and read back in order", () => {
  const runId = "run-migrate-" + Date.now();
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, sessionId: "sess-a" }));
  getHistory().telemetry.saveAgentTurn(makeTurn({ runId, sessionId: "sess-b", role: "qa-reviewer" }));
  const rows = getHistory().telemetry.getAgentTurns(runId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, "sess-a");
  assert.equal(rows[1]!.role, "qa-reviewer");
});

test("a turn that wrote nothing keeps its unknown time to first write and an empty tool sequence apart from a turn that was not measured", () => {
  const runId = "run-event-sequence-" + Date.now();
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({
    runId,
    sessionId: "s-measured",
    callMetrics: {
      totalCalls: 0, stepsUsed: 1, observationComplete: true, callsBeforeFirstWrite: 0, writeCount: 0, commandCount: 0, redundantReadCount: 0, sameFileReadCount: 0,
      duplicateCallCount: 0, promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0,
      buckets: { code_read: 0, code_graph: 0, browser: 0, write: 0, validate_run: 0, script_run: 0, memory: 0, subagent: 0, other: 0 },
      timeToFirstCallMs: null, timeToFirstWriteMs: null, deniedCallCount: 0, toolSequence: [], usage: null,
    },
  }));
  getHistory().telemetry.saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-unmeasured", callMetrics: null }));
  const turns = getHistory().telemetry.getAgentTurns(runId);
  const measured = turns.find((t) => t.sessionId === "s-measured")!;
  assert.equal(measured.deniedCallCount, 0);
  assert.deepEqual(measured.toolSequence, []);
  assert.equal(measured.usageTotal, null, "a measured turn with no finished step has no usage, not a zero one");
  assert.equal(measured.timeToFirstWriteMs, null);
  const unmeasured = turns.find((t) => t.sessionId === "s-unmeasured")!;
  assert.equal(unmeasured.deniedCallCount, null, "no measurement is not zero denials");
  assert.equal(unmeasured.toolSequence, null);
  assert.equal(unmeasured.usageTotal, null);
  assert.equal(unmeasured.durationMs, null);
});

/* Drift guard: what history.ts really returns for agent turns and app telemetry must be
   exactly what the published contract documents — a column added to a turn or an aggregate
   added to the telemetry without a matching schema change fails here, not in a client. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTurnViewSchema, AppTelemetryViewSchema } from "../contract/commands";
import { computeTelemetryAnalysis, getAgentTurns, saveAgentTurnEvent, saveRunOutcome } from "./history";
import type { AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";
import type { RunOutcome } from "../types";

function turnEvent(runId: string, overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
  return {
    runId,
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    role: "qa-generator",
    objective: undefined,
    round: 0,
    isRepair: false,
    promptText: "the prompt",
    promptBytes: 10,
    outputText: "the output",
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: 0.001,
    ts: new Date().toISOString(),
    sectionSizes: null,
    stepBudget: null,
    callMetrics: null,
    ...overrides,
  };
}

const measuredMetrics = {
  totalCalls: 12,
  stepsUsed: 9,
  callsBeforeFirstWrite: 10,
  writeCount: 1,
  redundantReadCount: 2,
  duplicateCallCount: 1,
  promptProvidedReadCount: 1,
  buckets: { code_read: 8, browser: 2, write: 1, validate_run: 1, memory: 0, subagent: 0, other: 0 },
};

function outcome(runId: string, app: string): RunOutcome {
  return {
    runId, app, sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: new Date().toISOString(),
  };
}

test("every stored turn, measured or not, validates against the documented turn schema with no undocumented field", () => {
  const runId = `run-contract-turns-${Date.now()}`;
  saveAgentTurnEvent(turnEvent(runId, { stepBudget: { maxSteps: 50, exhausted: false }, callMetrics: measuredMetrics }));
  saveAgentTurnEvent(turnEvent(runId));

  const turns = getAgentTurns(runId);
  assert.equal(turns.length, 2);
  for (const turn of turns) assert.doesNotThrow(() => AgentTurnViewSchema.strict().parse(turn));
});

test("the app telemetry, with measured and unmeasured turns, validates against the documented telemetry schema with no undocumented aggregate", () => {
  const app = `contract-app-${Date.now()}`;
  const runId = `run-contract-telemetry-${Date.now()}`;
  saveRunOutcome(outcome(runId, app));
  saveAgentTurnEvent(turnEvent(runId, { stepBudget: { maxSteps: 50, exhausted: true }, callMetrics: measuredMetrics }));
  saveAgentTurnEvent(turnEvent(runId));

  const analysis = computeTelemetryAnalysis(app);
  assert.doesNotThrow(() => AppTelemetryViewSchema.strict().parse(analysis));
  assert.doesNotThrow(() => AppTelemetryViewSchema.shape.efficiency.strict().parse(analysis.efficiency));
  assert.equal(analysis.efficiency.turnsMeasured, 1);
});

test("the telemetry of an app with no turns still validates against the documented schema", () => {
  const analysis = computeTelemetryAnalysis(`contract-empty-${Date.now()}`);
  assert.doesNotThrow(() => AppTelemetryViewSchema.strict().parse(analysis));
});

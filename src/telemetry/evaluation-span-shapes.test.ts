/* The evaluation evidence read from spans produced by the real agent-turn tracing (transport policy, tracker, turn decorator, telemetry adapter), not from hand-written names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createAgentDeps, withStallWatchdog, type RawAgentTransport, type RawPromptResult } from "@contexts/generation/infrastructure/agent-transport-policy";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker";
import { CallEfficiencyTracker, type StreamToken } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker";
import type { RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper";
import { withTurnTelemetry } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { AgentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/application/index";
import { gradeEvidence } from "@contexts/evaluation/application/index";
import { HistoryEvidenceAdapter, defaultEvidenceDeps, type LedgerSpan } from "../server/evaluation-evidence";
import { createRecord, updateRecord } from "../server/history";
import { traceHarness } from "./trace-harness";

const CWD = "/mirrors/org__app";
const SESSION = "ses_shapes";
const INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: ["e2e/auth.setup.ts"], loginUrls: [], authOnlyOrigins: [], reviewAgents: ["qa-reviewer"] };

const stepStart = (id: string): RawOpencodeEvent => ({ type: "message.part.updated", properties: { part: { id, sessionID: SESSION, messageID: "m1", type: "step-start" } } });
const stepFinish = (id: string, reason: string): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id, sessionID: SESSION, messageID: "m1", type: "step-finish", reason, tokens: { total: 0, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 } },
});
const tool = (callID: string, name: string, input: Record<string, unknown>): RawOpencodeEvent[] => [
  { type: "message.part.updated", properties: { part: { id: `prt_${callID}`, sessionID: SESSION, messageID: "m1", type: "tool", callID, tool: name, state: { status: "running", input, time: { start: 5_000 } } } } },
  { type: "message.part.updated", properties: { part: { id: `prt_${callID}`, sessionID: SESSION, messageID: "m1", type: "tool", callID, tool: name, state: { status: "completed", input, time: { start: 5_000, end: 5_040 }, output: "ok" } } } },
];

/* One generator turn with the given steps, traced end to end; returns its spans as the ledger stores them. */
async function tracedTurn(steps: Array<{ tools: RawOpencodeEvent[] }>, stepLimit: number, text = "done"): Promise<LedgerSpan[]> {
  resetCircuit();
  const h = traceHarness();
  const tracker = new CallEfficiencyTracker({ now: () => h.clock.now() });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.streamConnected(CWD, token);
  tracker.attach(SESSION, CWD);
  const traces = new AgentTurnTraces();
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: SESSION }),
    promptSession: async (): Promise<RawPromptResult> => {
      steps.forEach((step, i) => {
        h.clock.advance(100);
        tracker.record(stepStart(`s${i}`));
        step.tools.forEach((e) => tracker.record(e));
        h.clock.advance(100);
        tracker.record(stepFinish(`f${i}`, i === steps.length - 1 ? "stop" : "tool-calls"));
      });
      return { parts: [{ type: "text", text }], tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, answered: { modelId: "m-answer", providerId: "p", finish: "stop", createdAt: 1, completedAt: 2 } };
    },
    abortSession: async () => {},
    deleteSession: async () => {},
  };
  const base = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5_000,
    getFallbackModel: () => undefined,
    persistTurn: () => {},
    takeTurnCalls: (sessionId, promptText, provided) => tracker.take(sessionId, promptText, provided),
    prepareAttempt: (sessionId, attempt) => tracker.prepareAttempt(sessionId, attempt),
    now: () => h.clock.now(),
    onAttempt: (sessionId, event) => traces.attempt(sessionId, event),
    outerLimit: (sessionId, prompt) => traces.firedBy(sessionId, prompt),
  });
  const deps = withTurnTelemetry(withStallWatchdog(base, { stallMs: 60_000, onStall: (sessionId) => traces.fired(sessionId, "stall") }), { telemetry: h.telemetry, clock: h.clock, intent: INTENT, traces });
  const session = await deps.open("qa-generator", CWD, { descriptor: { runId: "run-1", role: "qa-generator" } });
  await session.prompt("write the spec", { stepLimit });
  await session.dispose();
  return h.spans().map((s: ReadableSpan) => ({
    name: s.name,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId ?? null,
    attrs: JSON.stringify(s.attributes),
  }));
}

function evidenceFor(spans: LedgerSpan[], facts: { limitFired?: string; limitRole?: string }) {
  const r = createRecord({ app: "shapes-app", sha: "abcdef1234", target: "e2e", mode: "diff" });
  updateRecord(r.id, { status: "done", verdict: "infra-error", phases: { furthestPhase: "generate", phaseTimings: { generate: 1 } }, facts: { decision: "none", ...(facts.limitFired ? { limitFired: facts.limitFired, limitRole: facts.limitRole ?? null } : {}) } });
  return new HistoryEvidenceAdapter({ ...defaultEvidenceDeps, runSpans: () => spans }).assemble(r.id)!;
}

test("step intents are counted from the chat steps of a real traced turn, and the graders turn them into a mix and an auth overhead", async () => {
  const spans = await tracedTurn([{ tools: tool("c1", "read", { filePath: `${CWD}/src/cart.ts` }) }, { tools: tool("c2", "write", { filePath: `${CWD}/e2e/cart.spec.ts` }) }], 25);
  assert.ok(spans.some((s) => s.name === "qayaba.agent.attempt"), "the turn has attempt spans, as the evidence must expect");
  const e = evidenceFor(spans, {});
  assert.deepEqual(e.stepIntents, { explore: 1, write_spec: 1 });
  const scores = gradeEvidence(e);
  assert.equal(scores.find((s) => s.name === "step_intent_mix.write_spec")?.value, 0.5);
  assert.equal(scores.find((s) => s.name === "auth_overhead")?.value, 0);
});

test("the limit's intent is the last step of the limiting turn, found under its attempt span", async () => {
  const spans = await tracedTurn([{ tools: tool("c1", "read", { filePath: `${CWD}/src/cart.ts` }) }, { tools: tool("c2", "write", { filePath: `${CWD}/e2e/cart.spec.ts` }) }], 25);
  const e = evidenceFor(spans, { limitFired: "step-cap", limitRole: "qa-generator" });
  assert.deepEqual(e.limit, { fired: "step-cap", role: "qa-generator", intent: "write_spec" });
  const budget = gradeEvidence(e).find((s) => s.name === "budget_exhaustion");
  assert.equal(budget?.value, "step-cap@generate/qa-generator/write_spec");
});

test("a turn that was cut by the step cap names its last step's intent", async () => {
  const spans = await tracedTurn([{ tools: tool("c1", "read", { filePath: `${CWD}/src/cart.ts` }) }], 1, "CRITICAL - MAXIMUM STEPS REACHED");
  const turn = spans.find((s) => s.name === "invoke_agent qa-generator")!;
  assert.equal(JSON.parse(turn.attrs)["qayaba.limit.fired"], "step-cap");
  assert.equal(evidenceFor(spans, { limitFired: "step-cap", limitRole: "qa-generator" }).limit?.intent, "explore");
});

test("the limit's role is matched by the turn's qayaba.agent.role too, and a role with no turn leaves the intent unknown", async () => {
  const spans = await tracedTurn([{ tools: tool("c1", "read", { filePath: `${CWD}/src/cart.ts` }) }], 25);
  const role = JSON.parse(spans.find((s) => s.name === "invoke_agent qa-generator")!.attrs)["qayaba.agent.role"] as string;
  assert.equal(evidenceFor(spans, { limitFired: "step-cap", limitRole: role }).limit?.intent, "explore");
  assert.equal(evidenceFor(spans, { limitFired: "step-cap", limitRole: "qa-reviewer" }).limit?.intent, undefined);
});

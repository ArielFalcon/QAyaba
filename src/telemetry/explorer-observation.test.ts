/* The explorer's session observed without being watched: the same agent stack with tracking on and off, and what must not differ between the two. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentDeps, withSessionRegistration, withStallWatchdog, type AgentDeps, type AgentTurnEvent, type RawAgentTransport, type RawPromptResult } from "@contexts/generation/infrastructure/agent-transport-policy";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker";
import { CallEfficiencyTracker, type StreamToken, type TrackerTimer } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker";
import type { RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper";
import { withTurnTelemetry } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { AgentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/domain/step-intent";
import { traceHarness } from "./trace-harness";

const CWD = "/mirrors/org__app";
const SESSION = "ses_explorer";
const INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: [], loginUrls: [], authOnlyOrigins: [], reviewAgents: [] };

const toolEvent = (status: "running" | "completed"): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id: "prt_1", sessionID: SESSION, messageID: "m1", type: "tool", callID: "c1", tool: "read", state: { status, input: { filePath: `${CWD}/src/a.ts` }, time: { start: 1_000, ...(status === "completed" ? { end: 1_020 } : {}) }, ...(status === "completed" ? { output: "const a = 1" } : {}) } } },
});

/* A timer that records what the tracker arms and never fires it. */
class RecordingTimer implements TrackerTimer {
  armed = 0;
  setTimeout(): number {
    this.armed += 1;
    return this.armed;
  }
  clearTimeout(): void {}
}

interface Outcome {
  output?: string;
  error?: string;
  rawPrompts: number;
  rows: Array<Pick<AgentTurnEvent, "role" | "runId" | "outputText" | "ended" | "round" | "isRepair">>;
  armedTimers: number;
  callsTracked: number | undefined;
  spanCalls: unknown;
}

async function explorerTurn(opts: { observe: boolean; stallMs?: number; fail?: boolean; promptMs?: number }): Promise<Outcome> {
  resetCircuit();
  const h = traceHarness();
  const timer = new RecordingTimer();
  const tracker = new CallEfficiencyTracker({ timer, now: () => h.clock.now() });
  /* The directory's stream is still opening and never connects: an attempt that waited for it would wait for ever. */
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  const traces = new AgentTurnTraces();
  const rows: AgentTurnEvent[] = [];
  let rawPrompts = 0;
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: SESSION }),
    promptSession: async () => {
      rawPrompts += 1;
      tracker.record(toolEvent("running"));
      tracker.record(toolEvent("completed"));
      await new Promise((resolve) => setTimeout(resolve, opts.promptMs ?? 0));
      if (opts.fail) throw new Error("the model said no");
      return { parts: [{ type: "text", text: "the brief" }], tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, answered: { modelId: "m", providerId: "p", finish: "stop", createdAt: 1, completedAt: 2 } } satisfies RawPromptResult;
    },
    abortSession: async () => {},
    deleteSession: async () => {},
  };
  const base = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5_000,
    getFallbackModel: () => undefined,
    persistTurn: (t) => rows.push(t),
    takeTurnCalls: (sessionId, promptText, provided) => tracker.take(sessionId, promptText, provided),
    prepareAttempt: (sessionId, attempt) => tracker.prepareAttempt(sessionId, attempt),
    now: () => h.clock.now(),
    onAttempt: (sessionId, event) => traces.attempt(sessionId, event),
    outerLimit: (sessionId, prompt) => traces.firedBy(sessionId, prompt),
  });
  const watched = withStallWatchdog(base, { stallMs: opts.stallMs ?? 60_000, onStall: (sessionId) => traces.fired(sessionId, "stall") });
  const registered = withSessionRegistration(watched, {
    register: () => assert.fail("the explorer is never registered for live observation"),
    unregister: () => {},
    observe: (sessionId, cwd) => tracker.attachUnwatched(sessionId, cwd),
    unobserve: (sessionId) => tracker.clear(sessionId),
  });
  const deps: AgentDeps = withTurnTelemetry(registered, { telemetry: h.telemetry, clock: h.clock, intent: INTENT, traces });

  const session = await deps.open("qa-explorer", CWD, { timeoutMs: 4_000, descriptor: { runId: "run-1", role: "qa-explorer", liveObservation: false, ...(opts.observe ? { observeUnwatched: true } : {}) } });
  const outcome: Partial<Outcome> = {};
  try {
    outcome.output = await session.prompt("map the change", { textOnly: true });
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  const metrics = rows[0]?.callMetrics;
  await session.dispose();
  return {
    ...outcome,
    rawPrompts,
    rows: rows.map((t) => ({ role: t.role, runId: t.runId, outputText: t.outputText, ended: t.ended, round: t.round, isRepair: t.isRepair })),
    armedTimers: timer.armed,
    callsTracked: metrics?.totalCalls,
    spanCalls: h.spans().find((s) => s.name === "invoke_agent qa-explorer")?.attributes["qayaba.agent.calls.total"],
  } as Outcome;
}

test("the explorer's turn ends the same way with its calls tracked as without: same answer, same prompts to the model, same row", async () => {
  const off = await explorerTurn({ observe: false });
  const on = await explorerTurn({ observe: true });
  assert.equal(on.output, off.output);
  assert.equal(on.error, off.error);
  assert.equal(on.rawPrompts, off.rawPrompts);
  assert.deepEqual(on.rows, off.rows);
});

test("a failing explorer turn fails the same way with its calls tracked as without", async () => {
  const off = await explorerTurn({ observe: false, fail: true });
  const on = await explorerTurn({ observe: true, fail: true });
  assert.ok(off.error);
  assert.equal(on.error, off.error);
  assert.equal(on.rawPrompts, off.rawPrompts);
});

test("observing the explorer arms no timer and waits for no stream, so it is as quick as before", async () => {
  const on = await explorerTurn({ observe: true });
  assert.equal(on.armedTimers, 0);
  assert.equal(on.output, "the brief");
});

test("observing the explorer does not arm a liveness watchdog on it: a turn longer than the stall window still completes", async () => {
  const on = await explorerTurn({ observe: true, stallMs: 15, promptMs: 80 });
  const off = await explorerTurn({ observe: false, stallMs: 15, promptMs: 80 });
  assert.equal(off.output, "the brief");
  assert.equal(on.output, off.output);
});

test("what observing adds is the explorer's calls, on its row and its span, and nothing else", async () => {
  const off = await explorerTurn({ observe: false });
  const on = await explorerTurn({ observe: true });
  assert.equal(off.callsTracked, undefined);
  assert.equal(off.spanCalls, undefined);
  assert.equal(on.callsTracked, 1);
  assert.equal(on.spanCalls, 1);
});

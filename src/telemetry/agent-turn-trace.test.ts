/* An agent prompt as a trace: the real transport policy over a fake raw transport that feeds the real event tracker, the real turn decorator and the real telemetry adapter over an in-memory exporter, on a fake clock. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import { createAgentDeps, withStallWatchdog, type AgentDeps, type AgentTurnEvent, type RawAgentTransport, type RawPromptResult } from "@contexts/generation/infrastructure/agent-transport-policy";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker";
import { createStallWatchdog } from "@contexts/generation/infrastructure/resilience/stall-watchdog";
import { CallEfficiencyTracker, type StreamToken } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker";
import type { RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper";
import { withTurnTelemetry, type TurnTelemetryDeps } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { AgentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/application/index";
import { INSTRUMENTS, checkInstrumentTable } from "./instrument-table";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-kernel/run-secret-redaction";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { traceHarness, type FakeClock } from "./trace-harness";
import { HostListeners, watchSpanForHost } from "./host-listeners";

const CWD = "/mirrors/org__app";
const SESSION = "ses_trace";
const INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: ["e2e/auth.setup.ts"], loginUrls: ["https://app.example/signin"], authOnlyOrigins: [], reviewAgents: ["qa-reviewer"] };

const hrMs = (t: [number, number]): number => t[0] * 1000 + t[1] / 1e6;
const attr = (span: ReadableSpan, key: string): unknown => span.attributes[key];

/* What the event stream shows while a prompt runs. */
const stepStart = (id: string): RawOpencodeEvent => ({ type: "message.part.updated", properties: { part: { id, sessionID: SESSION, messageID: "m1", type: "step-start" } } });
const stepFinish = (id: string, reason: string, tokens: { input: number; output: number; reasoning?: number; read?: number; write?: number }, cost: number): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id, sessionID: SESSION, messageID: "m1", type: "step-finish", reason, tokens: { total: 0, input: tokens.input, output: tokens.output, reasoning: tokens.reasoning ?? 0, cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 } }, cost } },
});
const tool = (callID: string, name: string, status: "running" | "completed" | "error", time: { start: number; end?: number }, input: Record<string, unknown>, output?: string): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id: `prt_${callID}`, sessionID: SESSION, messageID: "m1", type: "tool", callID, tool: name, state: { status, input, time, ...(output !== undefined ? { output } : {}) } } },
});

interface Rig {
  deps: AgentDeps;
  h: ReturnType<typeof traceHarness>;
  clock: FakeClock;
  tracker: CallEfficiencyTracker;
  traces: AgentTurnTraces;
  rows: AgentTurnEvent[];
  stream(...events: RawOpencodeEvent[]): void;
}

interface RigOptions {
  telemetry?: TelemetryPort;
  promptSession: (rig: { stream(...events: RawOpencodeEvent[]): void; clock: FakeClock; call: number; args: Parameters<RawAgentTransport["promptSession"]>[0] }) => Promise<RawPromptResult>;
  fallback?: string;
  stallMs?: number;
  stallFactory?: (onStall: () => void) => ReturnType<typeof createStallWatchdog>;
  turn?: Partial<TurnTelemetryDeps>;
}

function rig(options: RigOptions): Rig {
  resetCircuit();
  const h = traceHarness();
  const clock = h.clock;
  const tracker = new CallEfficiencyTracker({ now: () => clock.now() });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.streamConnected(CWD, token);
  tracker.attach(SESSION, CWD);
  const traces = new AgentTurnTraces();
  const rows: AgentTurnEvent[] = [];
  const stream = (...events: RawOpencodeEvent[]): void => events.forEach((e) => tracker.record(e));
  let call = 0;
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: SESSION }),
    promptSession: (args) => options.promptSession({ stream, clock, call: (call += 1), args }),
    abortSession: async () => {},
    deleteSession: async () => {},
  };
  const base = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5_000,
    getFallbackModel: () => options.fallback,
    persistTurn: (t) => rows.push(t),
    takeTurnCalls: (sessionId, promptText, provided) => tracker.take(sessionId, promptText, provided),
    prepareAttempt: (sessionId, attempt) => tracker.prepareAttempt(sessionId, attempt),
    now: () => clock.now(),
    onAttempt: (sessionId, event) => traces.attempt(sessionId, event),
    outerLimit: (sessionId, prompt) => traces.firedBy(sessionId, prompt),
  });
  const guarded = withStallWatchdog(base, {
    stallMs: options.stallMs ?? 60_000,
    ...(options.stallFactory ? { watchdogFactory: options.stallFactory } : {}),
    onStall: (sessionId) => traces.fired(sessionId, "stall"),
  });
  const deps = withTurnTelemetry(guarded, { telemetry: options.telemetry ?? h.telemetry, clock, intent: INTENT, traces, ...options.turn });
  return { deps, h, clock, tracker, traces, rows, stream };
}

const answered = (extra: Partial<RawPromptResult> = {}): RawPromptResult => ({
  parts: [{ type: "text", text: "done" }],
  tokens: { input: 150, output: 20, reasoning: 6, cacheRead: 9_000, cacheWrite: 30 },
  cost: 0.05,
  answered: { modelId: "m-answer", providerId: "p-answer", finish: "stop", createdAt: 1, completedAt: 2 },
  ...extra,
});

/* A two-step turn: step 1 reads a source file, step 2 writes a spec. */
async function twoStepTurn(r: Rig, prompt = "write the spec") {
  const session = await r.deps.open("qa-author", CWD, { model: "prov/asked-model", descriptor: { runId: "run-1", role: "qa-author" } });
  const out = await session.prompt(prompt, {
    stepLimit: 25,
    round: 0,
    sectionSizes: { task: 10, "working-rules": 40 },
    sectionHashes: { task: "h-task", "working-rules": "h-rules" },
    sectionsDropped: 1,
    promptBudgetBytes: 90_000,
  });
  await session.dispose();
  return out;
}

const twoSteps: RigOptions["promptSession"] = async ({ stream, clock }) => {
  clock.advance(100);
  stream(stepStart("a"));
  clock.advance(50);
  stream(tool("c1", "read", "running", { start: 5_000 }, { filePath: `${CWD}/src/cart.ts` }));
  stream(tool("c1", "read", "completed", { start: 5_000, end: 5_040 }, { filePath: `${CWD}/src/cart.ts` }, "const cart = 1"));
  clock.advance(250);
  stream(stepFinish("fa", "tool-calls", { input: 100, output: 10, reasoning: 4, read: 5_000, write: 10 }, 0.02));
  clock.advance(10);
  stream(stepStart("b"));
  stream(tool("c2", "write", "running", { start: 6_000 }, { filePath: `${CWD}/e2e/cart.spec.ts` }));
  stream(tool("c2", "write", "completed", { start: 6_000, end: 6_700 }, { filePath: `${CWD}/e2e/cart.spec.ts` }, "ok"));
  clock.advance(700);
  stream(stepFinish("fb", "stop", { input: 50, output: 10, reasoning: 2, read: 4_000, write: 20 }, 0.03));
  clock.advance(20);
  return answered();
};

test("a full-capture turn puts no prompt or output body on any span (bodies go to Loki, see prompt-body-logs.ts)", async () => {
  const body = "PROMPT-BODY-NEVER-ON-A-SPAN";
  const answer = "OUTPUT-BODY-NEVER-ON-A-SPAN";
  const full = traceHarness({ captureMode: "full" });
  const fullRig = rig({ promptSession: async () => answered({ parts: [{ type: "text", text: answer }] }), telemetry: full.telemetry });
  const session = await fullRig.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt(body, { sectionSizes: { task: body.length }, sectionHashes: { task: "h" } });
  await session.dispose();
  const everything = JSON.stringify(full.spans().map((s) => [s.attributes, s.events.map((e) => e.attributes)]));
  assert.ok(full.spans().length > 0);
  assert.ok(!everything.includes(body) && !everything.includes(answer));
});

test("a turn is invoke_agent -> attempt -> chat and execute_tool, with the calls' own times and the steps' receive times marked", async () => {
  const r = rig({ promptSession: twoSteps });
  await twoStepTurn(r);

  const turn = r.h.only("invoke_agent qa-author");
  const attempt = r.h.only("qayaba.agent.attempt");
  assert.equal(attempt.parentSpanContext?.spanId, turn.spanContext().spanId);
  const chats = r.h.named("chat m-answer");
  const tools = r.h.spans().filter((s) => s.name.startsWith("execute_tool "));
  assert.equal(chats.length, 2);
  assert.equal(tools.length, 2);
  for (const child of [...chats, ...tools]) {
    assert.equal(child.parentSpanContext?.spanId, attempt.spanContext().spanId, child.name);
    assert.equal(attr(child, "qayaba.span.synthesized"), true, child.name);
  }
  assert.deepEqual(r.h.unended(), []);

  const [first, second] = chats.sort((a, b) => Number(attr(a, "qayaba.agent.step")) - Number(attr(b, "qayaba.agent.step")));
  assert.equal(attr(first!, "qayaba.time.source"), "receive");
  assert.deepEqual([attr(first!, "qayaba.agent.step"), attr(first!, "qayaba.step.intent"), attr(first!, "qayaba.agent.step_budget.remaining")], [1, "explore", 24]);
  assert.deepEqual([attr(second!, "qayaba.agent.step"), attr(second!, "qayaba.step.intent"), attr(second!, "qayaba.agent.step_budget.remaining")], [2, "write_spec", 23]);
  assert.equal(attr(first!, "langfuse.observation.type"), "generation");
  assert.equal(hrMs(first!.endTime) - hrMs(first!.startTime), 300, "the step runs from its start event to its finish event");
  assert.deepEqual(attr(first!, "gen_ai.response.finish_reasons"), ["tool-calls"]);

  const read = tools.find((s) => s.name === "execute_tool read")!;
  assert.equal(attr(read, "qayaba.time.source"), "state");
  assert.equal(hrMs(read.startTime), 5_000);
  assert.equal(hrMs(read.endTime), 5_040);
  assert.deepEqual([attr(read, "gen_ai.tool.name"), attr(read, "gen_ai.tool.call.id"), attr(read, "qayaba.tool.bucket"), attr(read, "qayaba.tool.status"), attr(read, "qayaba.tool.target")], ["read", "c1", "code_read", "completed", "src/cart.ts"]);
});

test("the turn span records the window, the fit and the working room its prompt was judged by, and says when the window was unknown", async () => {
  const fits = rig({ promptSession: twoSteps });
  const session = await fits.deps.open("qa-author", CWD, { model: "prov/asked-model", descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("write the spec", { stepLimit: 25, contextFit: { outcome: "fits", promptTokens: 4, windowTokens: 200_000, workingRoomTokens: 50_000, roomBasis: "history" } });
  await session.dispose();
  const known = fits.h.only("invoke_agent qa-author");
  assert.deepEqual(
    ["qayaba.prompt.context.fit", "qayaba.prompt.context.window_tokens", "qayaba.prompt.context.working_room_tokens", "qayaba.prompt.context.room_basis", "qayaba.prompt.context.window_unknown"].map((k) => attr(known, k)),
    ["fits", 200_000, 50_000, "history", false],
  );

  const unknown = rig({ promptSession: twoSteps });
  const second = await unknown.deps.open("qa-author", CWD, { model: "prov/asked-model", descriptor: { runId: "run-1", role: "qa-author" } });
  await second.prompt("write the spec", { stepLimit: 25, contextFit: { outcome: "unknown", promptTokens: 4 } });
  await second.dispose();
  const none = unknown.h.only("invoke_agent qa-author");
  assert.deepEqual([attr(none, "qayaba.prompt.context.fit"), attr(none, "qayaba.prompt.context.window_unknown"), attr(none, "qayaba.prompt.context.window_tokens")], ["unknown", true, undefined]);
});

test("the turn names its agent, session, role, prompt and the models, and sums its steps' usage under qayaba.usage.*", async () => {
  const r = rig({ promptSession: twoSteps });
  await twoStepTurn(r);
  const turn = r.h.only("invoke_agent qa-author");
  const a = (k: string) => attr(turn, k);
  assert.deepEqual([a("gen_ai.operation.name"), a("gen_ai.agent.name"), a("gen_ai.conversation.id"), a("qayaba.agent.role"), a("qayaba.agent.round"), a("qayaba.agent.repair")], ["invoke_agent", "qa-author", SESSION, "qa-author", 0, false]);
  assert.deepEqual([a("gen_ai.request.model"), a("gen_ai.provider.name"), a("gen_ai.response.model")], ["asked-model", "p-answer", "m-answer"]);
  assert.equal(a("langfuse.observation.type"), "agent");
  assert.equal(a("qayaba.agent.steps.limit"), 25);
  assert.deepEqual([a("qayaba.prompt.bytes"), a("qayaba.prompt.sections.dropped"), a("qayaba.prompt.budget_bytes")], [14, 1, 90_000]);
  assert.equal(a("qayaba.prompt.hash"), r.rows[0]!.promptHash, "the span mirrors the record: one hash, of the bytes sent");
  assert.match(String(a("qayaba.prompt.hash")), /^[0-9a-f]{64}$/);
  assert.deepEqual([a("qayaba.prompt.section.task.bytes"), a("qayaba.prompt.section.task.hash"), a("qayaba.prompt.section.working-rules.hash")], [10, "h-task", "h-rules"]);
  /* OpenCode's input excludes the cache; the conventions' input includes it. Sums live under qayaba.usage.* so a viewer does not count the chat spans' usage twice. */
  assert.equal(a("qayaba.usage.source"), "steps");
  assert.deepEqual([a("qayaba.usage.input_tokens"), a("qayaba.usage.output_tokens"), a("qayaba.usage.cache_read_tokens"), a("qayaba.usage.cache_write_tokens"), a("qayaba.usage.reasoning_tokens"), a("qayaba.usage.cost")], [150 + 9_000 + 30, 20, 9_000, 30, 6, 0.05]);
  assert.equal(a("gen_ai.usage.input_tokens"), undefined);
  const chat = r.h.named("chat m-answer").find((s) => attr(s, "qayaba.agent.step") === 1)!;
  assert.deepEqual([attr(chat, "gen_ai.usage.input_tokens"), attr(chat, "gen_ai.usage.cache_read.input_tokens"), attr(chat, "gen_ai.usage.output_tokens"), attr(chat, "gen_ai.usage.reasoning.output_tokens")], [100 + 5_000 + 10, 5_000, 10, 4]);
  assert.deepEqual([a("qayaba.agent.end"), a("qayaba.limit.fired"), a("qayaba.limit.applied"), a("qayaba.limit.applied_ms")], ["completed", "none", "host-cap", 5_000]);
  assert.deepEqual([a("qayaba.agent.calls.code_read"), a("qayaba.agent.calls.write"), a("qayaba.agent.writes"), a("qayaba.agent.steps.used"), a("qayaba.agent.observation_complete")], [1, 1, 1, 2, true]);
  assert.deepEqual([a("qayaba.agent.ms_to_first_step"), a("qayaba.agent.ms_to_first_call"), a("qayaba.agent.ms_to_first_write")], [100, 150, 150 + 250 + 10]);
  assert.equal(a("qayaba.agent.reasoning_tokens_before_first_call"), 4, "the reasoning of the step that made the first call counts");
});

test("a fallback is two attempts and an event, and the answering one is marked", async () => {
  const r = rig({
    fallback: "prov/fallback-model",
    promptSession: async ({ call, clock }) => {
      clock.advance(10);
      if (call === 1) throw Object.assign(new Error("closed"), { code: "ECONNRESET" });
      return answered({ answered: { modelId: "fb-answer", providerId: "p-fb" } });
    },
  });
  const session = await r.deps.open("qa-author", CWD, { model: "prov/primary", descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("hello");
  await session.dispose();

  const attempts = r.h.named("qayaba.agent.attempt").sort((a, b) => Number(attr(a, "qayaba.attempt")) - Number(attr(b, "qayaba.attempt")));
  assert.deepEqual(attempts.map((s) => attr(s, "qayaba.attempt")), [1, 2]);
  assert.equal(attempts[0]!.status.code, SpanStatusCode.ERROR);
  assert.equal(attr(attempts[0]!, "error.type"), "socket_closed");
  assert.equal(attr(attempts[1]!, "gen_ai.request.model"), "fallback-model");
  assert.equal(attr(attempts[1]!, "gen_ai.response.model"), "fb-answer");
  assert.equal(attr(attempts[1]!, "gen_ai.provider.name"), "p-fb");
  const turn = r.h.only("invoke_agent qa-author");
  assert.deepEqual(turn.events.map((e) => e.name), ["fallback_model_used"]);
  assert.equal(attr(turn, "qayaba.agent.fallback_used"), true);
  assert.deepEqual(r.h.unended(), []);
  const errors = r.h.measurements.filter((m) => m.name === "qayaba.provider.errors");
  assert.deepEqual(errors.map((m) => m.attrs["error.type"]), ["socket_closed"]);
});

test("a prompt cut by its time limit records which limit, ends as a timeout, and every span ends", async () => {
  const r = rig({ promptSession: () => new Promise(() => {}) });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await assert.rejects(session.prompt("hello", { timeoutMs: 5, timeLimit: "tier-budget" }), /timed out/);
  await session.dispose();
  const turn = r.h.only("invoke_agent qa-author");
  assert.deepEqual([attr(turn, "qayaba.limit.fired"), attr(turn, "qayaba.limit.applied"), attr(turn, "qayaba.agent.end"), attr(turn, "error.type")], ["tier-budget", "tier-budget", "timeout", "timeout"]);
  assert.equal(turn.status.code, SpanStatusCode.ERROR);
  const attempt = r.h.only("qayaba.agent.attempt");
  assert.equal(attr(attempt, "qayaba.agent.abandoned"), true);
  assert.deepEqual(r.h.unended(), []);
});

test("the run's deadline, the repair cap, the session's timeout and the host cap are each named by the layer that fired them", async () => {
  for (const [promptOpts, openOpts, expected] of [
    [{ timeoutMs: 5, timeLimit: "run-deadline" as const }, {}, "run-deadline"],
    [{ timeoutMs: 5, timeLimit: "repair-cap" as const }, {}, "repair-cap"],
    [{ timeoutMs: 5 }, { timeoutMs: 9_000, timeLimit: "session-timeout" as const }, "prompt-budget"],
    [{}, { timeoutMs: 5, timeLimit: "session-timeout" as const }, "session-timeout"],
  ] as const) {
    const r = rig({ promptSession: () => new Promise(() => {}) });
    const session = await r.deps.open("qa-author", CWD, { ...openOpts, descriptor: { runId: "run-1", role: "qa-author" } });
    await assert.rejects(session.prompt("hello", promptOpts));
    await session.dispose();
    assert.equal(attr(r.h.only("invoke_agent qa-author"), "qayaba.limit.fired"), expected);
    assert.deepEqual(r.h.unended(), []);
  }
  const hostCap = rig({ promptSession: () => new Promise(() => {}) });
  const session = await hostCap.deps.open("qa-author", CWD, { timeoutMs: 5, descriptor: { runId: "run-1", role: "qa-author" } });
  await assert.rejects(session.prompt("hello"));
  assert.equal(attr(hostCap.h.only("invoke_agent qa-author"), "qayaba.limit.fired"), "session-timeout");
});

test("a stall abort rejects the outer promise only: the turn ends stalled, the attempt keeps going until its own timeout and ends abandoned", async () => {
  let fireStall: () => void = () => {};
  const r = rig({
    promptSession: ({ stream }) => {
      stream(stepStart("a"));
      stream(tool("c1", "read", "completed", { start: 5_000, end: 5_040 }, { filePath: `${CWD}/src/a.ts` }, "x"));
      stream(stepFinish("fa", "tool-calls", { input: 10, output: 2 }, 0.01));
      return new Promise(() => {});
    },
    stallFactory: (onStall) => {
      fireStall = onStall;
      return createStallWatchdog({ stallMs: 10 ** 9, onStall });
    },
  });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  const pending = session.prompt("hello", { timeoutMs: 40 });
  await new Promise((resolve) => setImmediate(resolve));
  fireStall();
  await assert.rejects(pending, /stalled/);

  const turn = r.h.only("invoke_agent qa-author");
  assert.deepEqual([attr(turn, "qayaba.limit.fired"), attr(turn, "qayaba.agent.end")], ["stall", "aborted"]);
  assert.equal(r.h.named("qayaba.agent.attempt").length, 0, "the attempt below has not ended yet");
  assert.ok(r.h.unended().includes("qayaba.agent.attempt"));

  await new Promise((resolve) => setTimeout(resolve, 80));
  const attempt = r.h.only("qayaba.agent.attempt");
  assert.equal(attr(attempt, "qayaba.agent.abandoned"), true);
  assert.deepEqual(r.h.unended(), []);
  assert.equal(r.rows[0]?.limitFired, "stall", "the record names the limit that fired first");
  /* The turn span ended before the late turn record: its figures land on the attempt, which was still open, and the metrics are not lost. */
  assert.equal(attr(attempt, "qayaba.usage.source"), "steps");
  assert.equal(attr(attempt, "qayaba.agent.end"), "timeout");
  assert.equal(attr(attempt, "qayaba.agent.calls.code_read"), 1);
  assert.ok(r.h.measurements.some((m) => m.name === "gen_ai.invoke_agent.duration"));
  assert.ok(r.h.spans().some((s) => s.name === "chat" || s.name.startsWith("chat ")), "the late turn still gets its step children");
});

test("a turn that used every step it had is cut by the step cap, with an event", async () => {
  const r = rig({
    promptSession: async ({ stream }) => {
      stream(stepStart("a"));
      stream(stepFinish("fa", "tool-calls", { input: 1, output: 1 }, 0.01));
      return answered({ parts: [{ type: "text", text: "CRITICAL - MAXIMUM STEPS REACHED" }] });
    },
  });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("hello", { stepLimit: 1 });
  const turn = r.h.only("invoke_agent qa-author");
  assert.deepEqual([attr(turn, "qayaba.agent.end"), attr(turn, "qayaba.limit.fired")], ["exhausted", "step-cap"]);
  assert.deepEqual(turn.events.map((e) => e.name), ["step_budget_exhausted"]);
});

test("the turn hangs under the phase the run has open, and a turn outside a run hangs under the active context", async () => {
  const r = rig({ promptSession: twoSteps });
  const phase = r.h.telemetry.startSpan("qayaba.phase.generate");
  const scope: RunScope = { runId: "run-1", workDir: "", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => phase.context() } };
  await withExecScope(scope, () => twoStepTurn(r));
  phase.end();
  assert.equal(r.h.only("invoke_agent qa-author").parentSpanContext?.spanId, phase.context().spanId);
  assert.deepEqual(r.h.orphans(), []);
});

test("a suspend or a blocked loop while the turn is open lands on the turn too", async () => {
  const listeners = new HostListeners();
  let release: (value: RawPromptResult) => void = () => {};
  const r = rig({ promptSession: () => new Promise((resolve) => { release = resolve; }), turn: { watchHost: (span) => watchSpanForHost(span, listeners) } });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  const pending = session.prompt("hello");
  await new Promise((resolve) => setImmediate(resolve));
  listeners.notify((l) => l.hostSuspended(61_000, r.clock.now()));
  listeners.notify((l) => l.eventLoopBlocked(2_500, r.clock.now()));
  release(answered());
  await pending;
  await session.dispose();
  assert.deepEqual(r.h.only("invoke_agent qa-author").events.map((e) => e.name), ["host_suspended", "event_loop_blocked"]);
  assert.equal(listeners.size(), 0, "the turn stops listening when it ends");
});

test("a navigation's outcome is recorded from its answer, and a login page reads as the auth step", async () => {
  const r = rig({
    promptSession: async ({ stream }) => {
      stream(stepStart("a"));
      stream(tool("n1", "playwright_browser_navigate", "completed", { start: 1, end: 2 }, { url: "https://app.example/signin" }, "### Page state\n- Page URL: https://app.example/signin\n- Page Title: Sign in"));
      stream(tool("n2", "playwright_browser_navigate", "completed", { start: 3, end: 4 }, { url: "https://app.example/admin" }, "### Page state\n- Page URL: https://app.example/signin?next=/admin"));
      stream(tool("n3", "playwright_browser_navigate", "completed", { start: 5, end: 6 }, { url: "https://app.example/gone" }, "### Page state\n- Page Title: 404 Not Found"));
      stream(stepFinish("fa", "stop", { input: 1, output: 1 }, 0.01));
      return answered();
    },
  });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("hello");
  const outcomes = Object.fromEntries(r.h.named("execute_tool playwright_browser_navigate").map((s) => [attr(s, "gen_ai.tool.call.id"), attr(s, "qayaba.nav.outcome")]));
  assert.deepEqual(outcomes, { n1: "ok", n2: "auth_challenge", n3: "http_error" });
  assert.equal(attr(r.h.only("chat m-answer"), "qayaba.step.intent"), "auth");
});

test("a seeded secret in the prompt, a target or an error never reaches a span, and the prompt text is never an attribute", async () => {
  const secrets = createRunSecretScope();
  secrets.addAccountSecrets(["hunter2-pass"]);
  const r = rig({
    promptSession: async ({ stream }) => {
      stream(stepStart("a"));
      stream(tool("c1", "bash", "running", { start: 1 }, { command: "echo hunter2-pass" }));
      stream(tool("c1", "bash", "completed", { start: 1, end: 2 }, { command: "echo hunter2-pass" }, "hunter2-pass"));
      stream(stepFinish("fa", "stop", { input: 1, output: 1 }, 0.01));
      throw new Error("provider rejected hunter2-pass");
    },
  });
  await withRunSecretScope(secrets, async () => {
    const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
    await assert.rejects(session.prompt("log in as hunter2-pass and write the cart spec"));
    await session.dispose();
  });
  const everything = JSON.stringify(r.h.spans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status })));
  assert.ok(!everything.includes("hunter2"), "no secret in any span");
  assert.ok(!everything.includes("write the cart spec"), "no prompt text in any span");
  assert.ok(Number(attr(r.h.only("invoke_agent qa-author"), "qayaba.prompt.bytes")) > 0);
});

test("in off capture mode no hash or size of the prompt leaves; structure still does", async () => {
  const off = (await import("./trace-harness")).traceHarness({ captureMode: "off" });
  const r = rig({ promptSession: twoSteps, telemetry: off.telemetry });
  await twoStepTurn(r);
  const turn = off.only("invoke_agent qa-author");
  assert.equal(attr(turn, "qayaba.prompt.hash"), undefined);
  assert.equal(attr(turn, "qayaba.prompt.section.task.hash"), undefined);
  assert.equal(attr(turn, "qayaba.prompt.bytes"), undefined);
  assert.equal(attr(turn, "gen_ai.agent.name"), "qa-author");
  assert.equal(attr(off.named("execute_tool read")[0]!, "qayaba.tool.target"), undefined, "a tool's target is text, not structure");
});

test("every metric the turn records is a declared instrument with declared, low-cardinality attributes only", async () => {
  assert.deepEqual(checkInstrumentTable(INSTRUMENTS), []);
  const r = rig({ promptSession: twoSteps });
  await twoStepTurn(r);
  const recorded = new Set(r.h.measurements.map((m) => m.name));
  for (const name of ["gen_ai.client.inference.duration", "gen_ai.client.inference.usage.input_tokens", "gen_ai.client.inference.usage.output_tokens", "gen_ai.client.inference.usage.cache_read.input_tokens", "gen_ai.client.inference.usage.cache_write.input_tokens", "gen_ai.client.inference.usage.reasoning.output_tokens", "gen_ai.invoke_agent.duration", "gen_ai.invoke_agent.tool_calls", "gen_ai.invoke_agent.inference_calls", "qayaba.agent.steps", "qayaba.agent.cost"]) {
    assert.ok(recorded.has(name), `${name} was recorded`);
  }
  for (const m of r.h.measurements) {
    const declared = INSTRUMENTS[m.name as keyof typeof INSTRUMENTS];
    assert.ok(declared, `${m.name} is declared`);
    for (const key of Object.keys(m.attrs)) assert.ok((declared.attrs as readonly string[]).includes(key), `${m.name} carries only declared keys (${key})`);
  }
  const input = r.h.measurements.filter((m) => m.name === "gen_ai.client.inference.usage.input_tokens");
  assert.deepEqual(input.map((m) => m.value), [100 + 5_000 + 10, 50 + 4_000 + 20]);
  assert.deepEqual(r.h.measurements.find((m) => m.name === "gen_ai.invoke_agent.inference_calls")!.value, 2);
  assert.deepEqual(r.h.measurements.find((m) => m.name === "qayaba.agent.steps")!.attrs, { "qayaba.agent.role": "qa-author" });
});

/* A scripted day of three prompts: an answer, a provider fault the fallback recovers, and a hang the time limit cuts. */
async function scriptedDay(telemetry: TelemetryPort | undefined) {
  const r = rig({
    ...(telemetry ? { telemetry } : {}),
    fallback: "prov/fb",
    promptSession: async (ctx) => {
      if (ctx.args.text === "answer") return twoSteps(ctx);
      if (ctx.args.text === "fault") {
        if (ctx.args.model === undefined) throw new Error("transient");
        return answered();
      }
      return new Promise(() => {});
    },
  });
  const outcomes: string[] = [];
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  for (const [text, opts] of [["answer", {}], ["fault", {}], ["hang", { timeoutMs: 5 }]] as const) {
    try {
      outcomes.push(await session.prompt(text, { ...opts }));
    } catch (err) {
      outcomes.push(`${(err as Error).name}`);
    }
  }
  await session.dispose();
  const rows = r.rows.map(({ ts: _ts, durationMs: _d, ...rest }) => rest);
  return { outcomes, rows };
}

test("turn outcomes and agent_turns rows are identical with telemetry absent, throwing and real", async () => {
  const noop = await scriptedDay(new NoopTelemetry());
  const throwing = await scriptedDay(new ThrowingTelemetry());
  const real = await scriptedDay(undefined);
  assert.deepEqual(noop.outcomes, ["done", "done", "AgentTimeoutError"]);
  assert.deepEqual(throwing.outcomes, noop.outcomes);
  assert.deepEqual(real.outcomes, noop.outcomes);
  assert.deepEqual(throwing.rows, noop.rows);
  assert.deepEqual(real.rows, noop.rows);
});

test("a prompt that names no model records no requested model, and the configured facts are labelled as the repository copy; the step limit is only the one the prompt stated", async () => {
  const r = rig({
    promptSession: async () => answered(),
    turn: { agentConfig: () => ({ model: "cfg/configured-model", reasoningEffort: "low" }), stepLimitFor: () => 40 },
  });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("hello");
  const turn = r.h.only("invoke_agent qa-author");
  assert.equal(attr(turn, "gen_ai.request.model"), undefined);
  assert.equal(attr(r.h.only("qayaba.agent.attempt"), "gen_ai.request.model"), undefined);
  assert.equal(r.rows[0]!.modelRequested, null, "the row says the same");
  assert.deepEqual([attr(turn, "qayaba.config.source"), attr(turn, "qayaba.config.model"), attr(turn, "qayaba.config.reasoning_effort"), attr(turn, "qayaba.config.steps_limit")], ["repo-copy", "cfg/configured-model", "low", 40]);
  assert.equal(attr(turn, "gen_ai.request.reasoning.level"), undefined);
  assert.equal(attr(turn, "qayaba.agent.steps.limit"), undefined, "a limit the repo copy declares is not a limit the prompt stated");
});

test("the children of an attempt end before it and inside it, in the normal ordering", async () => {
  const r = rig({ promptSession: twoSteps });
  await twoStepTurn(r);
  const attempt = r.h.only("qayaba.agent.attempt");
  const order = r.h.spans().map((s) => s.name);
  const attemptAt = order.indexOf("qayaba.agent.attempt");
  for (const child of r.h.spans().filter((s) => s.parentSpanContext?.spanId === attempt.spanContext().spanId)) {
    assert.ok(order.indexOf(child.name) < attemptAt || child.name === "qayaba.agent.attempt", `${child.name} ends before its parent`);
    assert.ok(hrMs(child.endTime) <= hrMs(attempt.endTime), `${child.name} ends inside its parent`);
    assert.ok(hrMs(child.startTime) <= hrMs(attempt.endTime), `${child.name} starts inside its parent`);
  }
});

test("a step still open when the turn ends is clamped to the attempt's end", async () => {
  const r = rig({
    promptSession: async ({ stream, clock }) => {
      stream(stepStart("a"));
      clock.advance(10);
      return answered();
    },
  });
  const session = await r.deps.open("qa-author", CWD, { descriptor: { runId: "run-1", role: "qa-author" } });
  await session.prompt("hello");
  const attempt = r.h.only("qayaba.agent.attempt");
  const chat = r.h.spans().find((s) => s.name.startsWith("chat "))!;
  assert.ok(hrMs(chat.endTime) <= hrMs(attempt.endTime));
  assert.deepEqual(r.h.unended(), []);
});

test("a chat span carries Langfuse's exclusive usage buckets and the provider's cost; a tool span is a tool observation", async () => {
  const r = rig({ promptSession: twoSteps });
  await twoStepTurn(r);
  const [first, second] = r.h.named("chat m-answer").sort((a, b) => Number(attr(a, "qayaba.agent.step")) - Number(attr(b, "qayaba.agent.step")));
  /* Step 1 reported input 100, output 10 (4 of them reasoning), cache read 5000 and write 10: the conventions' input is 5110, Langfuse's is 100 plus the two cache buckets. */
  assert.deepEqual(JSON.parse(String(attr(first!, "langfuse.observation.usage_details"))), { input: 100, output: 6, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 10, output_reasoning_tokens: 4 });
  assert.deepEqual(JSON.parse(String(attr(first!, "langfuse.observation.cost_details"))), { total: 0.02 });
  assert.deepEqual(JSON.parse(String(attr(second!, "langfuse.observation.cost_details"))), { total: 0.03 });
  for (const tool of r.h.spans().filter((s) => s.name.startsWith("execute_tool "))) assert.equal(attr(tool, "langfuse.observation.type"), "tool", tool.name);
  /* Usage and cost sit on generations only: the turn's span keeps its sums under qayaba.usage.*, so Langfuse cannot count a step twice. */
  const turn = r.h.only("invoke_agent qa-author");
  assert.equal(attr(turn, "langfuse.observation.usage_details"), undefined);
  assert.equal(attr(turn, "langfuse.observation.cost_details"), undefined);
});

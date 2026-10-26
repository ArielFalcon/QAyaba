/* A run_spec or authenticated-browser call as a trace: the real port adapters over fakes at the process boundary, the real launcher over a fake spawn, the real turn decorator and the real telemetry adapter over an in-memory exporter, on a fake clock. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createAgentDeps, withStallWatchdog, type AgentDeps, type RawAgentTransport, type RawPromptResult } from "@contexts/generation/infrastructure/agent-transport-policy";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker";
import { CallEfficiencyTracker, type StreamToken } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker";
import type { RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper";
import { withTurnTelemetry } from "@contexts/generation/infrastructure/telemetry/with-turn-telemetry";
import { AgentTurnTraces } from "@contexts/generation/infrastructure/telemetry/turn-trace-registry";
import type { StepIntentContext } from "@contexts/generation/application/index";
import { ClosedLoopPortAdapter } from "@contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter";
import { AgentBrowserPortAdapter } from "@contexts/agent-tools/infrastructure/adapters/agent-browser-port.adapter";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry";
import { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry";
import type { ToolTraceWiring } from "@contexts/agent-tools/infrastructure/adapters/tool-call-trace";
import { AccountLock } from "@contexts/test-execution/application/index";
import type { AgentBrowserHostPort, PageState } from "@contexts/test-execution/application/index.ts";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { createExecSandbox, resetExecSandboxWarnings } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { activeExecScope, newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { openRunWorkDir } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir";
import { synthesizeReportSpans } from "../../qa-engine/src/contexts/test-execution/infrastructure/report-spans";
import { noteSuiteAuth, suiteAuthNotes } from "../../qa-engine/src/shared-infrastructure/telemetry/run-auth-notes";
import { traceHarness, T0, type FakeClock } from "./trace-harness";

const CWD = "/mirrors/org__app";
const SESSION = "ses_tool";
const BASE = "https://dev.example.com";
const INTENT: StepIntentContext = { specTargets: { kind: "dir", relDir: "e2e" }, authFiles: [], loginUrls: [], authOnlyOrigins: [], reviewAgents: [] };
const SPEC = 'import { test } from "../fixtures";\ntest("loads", async () => {});\n';
const SANDBOX = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: "/home/sandbox" };
const PAGE: PageState = { url: `${BASE}/orders`, title: "Orders", snapshot: "- heading [ref=e1]", passwordFieldVisible: false, requestedPath: "/orders", blocked: [], notes: [] };

const toolEvent = (callID: string, name: string, status: "running" | "completed", time: { start: number; end?: number }, messageID = "m1"): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { id: `prt_${callID}`, sessionID: SESSION, messageID, type: "tool", callID, tool: name, state: { status, input: {}, time, ...(status === "completed" ? { output: "ok" } : {}) } } },
});
const stepStart = (id: string): RawOpencodeEvent => ({ type: "message.part.updated", properties: { part: { id, sessionID: SESSION, messageID: "m1", type: "step-start" } } });

const parentOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;
const idOf = (span: ReadableSpan): string => span.spanContext().spanId;

interface Rig {
  h: ReturnType<typeof traceHarness>;
  clock: FakeClock;
  traces: AgentTurnTraces;
  deps: AgentDeps;
  wiring: ToolTraceWiring;
  lock: AccountLock;
  specDir: string;
  children: Array<ChildProcess & EventEmitter>;
  /* Runs `fn` as the body of one agent prompt on the generator session, with the event stream open. */
  turn(fn: (stream: (...events: RawOpencodeEvent[]) => void) => Promise<void>): Promise<void>;
  /* A scope as the run opens it: its trace stands on a phase that has since ended. */
  scope: RunScope;
  spawnInScope(): void;
}

function rig(t: TestContext, over: { telemetry?: TelemetryPort } = {}): Rig {
  resetCircuit();
  resetExecSandboxWarnings();
  const root = mkdtempSync(join(tmpdir(), "tool-trace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specDir = join(root, "mirror", "e2e");
  mkdirSync(join(specDir, "flows"), { recursive: true });
  writeFileSync(join(specDir, "flows", "a.spec.ts"), SPEC);

  const h = traceHarness();
  const clock = h.clock;
  const tracker = new CallEfficiencyTracker({ now: () => clock.now() });
  const token: StreamToken = Symbol("stream");
  tracker.streamOpening(CWD, token);
  tracker.streamConnected(CWD, token);
  tracker.attach(SESSION, CWD);
  const traces = new AgentTurnTraces();
  const stream = (...events: RawOpencodeEvent[]): void => events.forEach((e) => tracker.record(e));
  let inTurn: ((s: typeof stream) => Promise<void>) | undefined;
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: SESSION }),
    promptSession: async () => {
      clock.advance(10);
      await inTurn?.(stream);
      const answer: RawPromptResult = { parts: [{ type: "text", text: "done" }], tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, answered: { modelId: "m", providerId: "p", finish: "stop", createdAt: 1, completedAt: 2 } };
      return answer;
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
    now: () => clock.now(),
    onAttempt: (sessionId, event) => traces.attempt(sessionId, event),
    outerLimit: (sessionId, prompt) => traces.firedBy(sessionId, prompt),
  });
  const guarded = withStallWatchdog(base, { stallMs: 60_000, onStall: (sessionId) => traces.fired(sessionId, "stall") });
  const deps = withTurnTelemetry(guarded, { telemetry: h.telemetry, clock, intent: INTENT, traces });

  const children: Array<ChildProcess & EventEmitter> = [];
  const spawnFn = ((_cmd: string, _args: string[], _options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    (child as { pid?: number }).pid = 50_000 + children.length;
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const sandbox = createExecSandbox({ sandbox: SANDBOX, mode: "required", baseEnv: { PATH: "/usr/bin" }, spawnFn, warn: () => {}, telemetry: h.telemetry });
  const setup = h.telemetry.startSpan("qayaba.phase.setup");
  const scope: RunScope = { runId: "run-9", workDir: openRunWorkDir(join(root, "exec"), "run-9", null), egress: { dev: [BASE], install: [] }, report: newSandboxReport(), telemetry: { parent: () => setup.context() } };
  setup.end();

  const wiring: ToolTraceWiring = { telemetry: over.telemetry ?? h.telemetry, clock, attempts: traces };
  return {
    h, clock, traces, deps, wiring, lock: new AccountLock(), specDir, children, scope,
    spawnInScope: () => {
      const active = activeExecScope();
      assert.ok(active, "the call runs inside a run scope");
      sandbox.spawn("npx", ["playwright", "test"], { cwd: "/m/e2e", profile: "suite", commandClass: "playwright-test", scope: active });
      clock.advance(200);
      children.at(-1)!.emit("close", 0, null);
    },
    turn: async (fn) => {
      inTurn = fn;
      const session = await deps.open("qa-generator", CWD, { model: "prov/asked", descriptor: { runId: "run-9", role: "qa-generator" } });
      await session.prompt("write the spec", { stepLimit: 25 });
      await session.dispose();
    },
  };
}

async function openLoop(r: Rig, over: { execute?: () => Promise<void>; trace?: ToolTraceWiring | undefined; devWrites?: number } = {}) {
  const registry = new ClosedLoopRegistry();
  const adapter = new ClosedLoopPortAdapter({
    registry,
    setting: { enabled: true, limits: { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 10 } },
    generatorRuntimeCanCall: () => true,
    execution: {
      execute: async () => {
        await over.execute?.();
        r.spawnInScope();
        return { verdict: "pass", cases: [{ name: "loads", status: "pass" }], logs: "", devWrites: over.devWrites ?? 0 };
      },
    },
    specRelDir: "e2e",
    account: "demo/user",
    lock: r.lock,
    redact: (text) => text,
    now: () => r.clock.now(),
    ...("trace" in over ? (over.trace ? { trace: over.trace } : {}) : { trace: r.wiring }),
  });
  /* The loop opens inside the run, as the use case does; a call comes in later from outside it. */
  await withExecScope(r.scope, async () => {
    const run = await adapter.open({ runId: "run-9", app: "demo", mode: "diff", mirrorDir: join(r.specDir, ".."), specDir: r.specDir });
    run!.openFlow({ delegationId: "run-9-flow-a", flowId: "a", limits: { maxCalls: 8, maxDevWrites: 10 }, workspace: { dir: join(r.specDir, ".."), specDir: r.specDir }, specFile: "flows/a.spec.ts", stage: async () => "flows/a.spec.ts" });
  });
  registry.bindSession({ sessionId: SESSION, runId: "run-9", agent: "qa-sidekick", delegationId: "run-9-flow-a" });
  return registry;
}

test("a sandboxed child of a run_spec call is a grandchild of the attempt that made the call, not a child of the ended setup phase", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r);
  await r.turn(async (stream) => {
    stream(stepStart("a"), toolEvent("c1", "run_spec", "running", { start: r.clock.now() }));
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts", messageId: "m1" });
    stream(toolEvent("c1", "run_spec", "completed", { start: T0 + 10, end: r.clock.now() }));
  });

  const attempt = r.h.only("qayaba.agent.attempt");
  const tool = r.h.only("qayaba.tool.run_spec");
  const exec = r.h.only("qayaba.exec");
  assert.equal(parentOf(tool), idOf(attempt));
  assert.equal(parentOf(exec), idOf(tool));
  assert.equal(tool.kind, SpanKind.SERVER);
  assert.equal(tool.spanContext().traceId, attempt.spanContext().traceId);
  assert.equal(tool.attributes["qayaba.tool.outcome"], "passed");
  assert.equal(tool.attributes["qayaba.spec.path"], "flows/a.spec.ts");
  assert.match(String(tool.attributes["qayaba.spec.sha256"]), /^[0-9a-f]{64}$/);
  assert.equal(tool.attributes["qayaba.namespace"], "run-9-a-rs1");
  assert.equal(tool.attributes["gen_ai.conversation.id"], SESSION);
  assert.deepEqual(r.h.unended(), []);
  assert.deepEqual(r.h.orphans(), []);
});

test("the wait for the test account's lease is recorded on the call", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = r.lock.withLock("demo/user", () => held);
  await r.turn(async () => {
    const pending = registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
    r.clock.advance(400);
    release();
    await pending;
  });
  await holder;
  assert.equal(r.h.only("qayaba.tool.run_spec").attributes["qayaba.lease.wait_ms"], 400);
});

test("a call refused because another is still running says DEV was busy", async (t) => {
  const r = rig(t);
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  const registry = await openLoop(r, { execute: () => running });
  await r.turn(async () => {
    const first = registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
    const second = await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
    assert.equal(second.ok, false);
    release();
    await first;
  });
  const refused = r.h.named("qayaba.tool.run_spec").find((s) => s.attributes["qayaba.tool.outcome"] === "refused");
  assert.ok(refused);
  assert.equal(refused.attributes["qayaba.lease.refused"], true);
  assert.equal(refused.attributes["qayaba.tool.refusal"], "busy");
});

test("the hosts the egress filter refused while the call ran are recorded as co-temporal, not causal", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r, {
    execute: async () => {
      for (const watcher of activeExecScope()!.report.watchers ?? []) watcher("tracker.example");
    },
  });
  await r.turn(async () => {
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
  });
  assert.deepEqual(r.h.only("qayaba.tool.run_spec").attributes["qayaba.egress.denied_cotemporal"], ["tracker.example"]);
});

test("the agent's own execute_tool span links to the server span of the same call, matched by message and time, and not to another's", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r);
  await r.turn(async (stream) => {
    stream(stepStart("a"));
    const start = r.clock.now();
    stream(toolEvent("c1", "run_spec", "running", { start }, "m1"));
    stream(toolEvent("c9", "read", "running", { start }, "m1"));
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts", messageId: "m1" });
    stream(toolEvent("c1", "run_spec", "completed", { start, end: r.clock.now() }, "m1"));
    stream(toolEvent("c9", "read", "completed", { start, end: start + 5 }, "m1"));
  });
  const server = r.h.only("qayaba.tool.run_spec");
  const runSpecTool = r.h.only("execute_tool run_spec");
  assert.equal(runSpecTool.links.length, 1);
  assert.equal(runSpecTool.links[0]!.context.spanId, idOf(server));
  assert.equal(runSpecTool.links[0]!.context.traceId, server.spanContext().traceId);
  assert.equal(r.h.only("execute_tool read").links.length, 0);
  assert.equal(server.attributes["qayaba.tool.message_id"], "m1");
});

test("a call of another message does not link to the synthesized span", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r);
  await r.turn(async (stream) => {
    stream(stepStart("a"));
    const start = r.clock.now();
    stream(toolEvent("c1", "run_spec", "running", { start }, "m1"));
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts", messageId: "m2" });
    stream(toolEvent("c1", "run_spec", "completed", { start, end: r.clock.now() }, "m1"));
  });
  assert.equal(r.h.only("execute_tool run_spec").links.length, 0);
});

test("a telemetry port that throws changes nothing a caller can see of the call", async (t) => {
  const traced = rig(t);
  const bare = rig(t);
  const answer = async (r: Rig, trace: ToolTraceWiring | undefined) => {
    const registry = await openLoop(r, { trace });
    let response: unknown;
    await r.turn(async () => {
      response = await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
    });
    return JSON.stringify(response);
  };
  const withThrowing = await answer(traced, { telemetry: new ThrowingTelemetry(), clock: traced.clock, attempts: traced.traces });
  const without = await answer(bare, undefined);
  assert.equal(withThrowing, without);
});

/* --- the authenticated browser --- */

class FakeHost implements AgentBrowserHostPort {
  page: () => PageState = () => PAGE;
  async perform(): Promise<PageState> { return this.page(); }
  async reset(): Promise<void> {}
  async close(): Promise<void> {}
}

async function openBrowser(r: Rig, host: FakeHost, renew?: boolean) {
  const registry = new AgentBrowserRegistry();
  const adapter = new AgentBrowserPortAdapter({
    registry,
    setting: { enabled: true, denyRoutes: ["/admin/**"], allowMutating: [] },
    generatorRuntimeCanCall: () => true,
    baseUrl: BASE,
    material: () => ({ storageState: { cookies: [{ name: "sid" }], origins: [] } }),
    launcher: { launch: async () => { throw new Error("the fake host never launches"); } },
    createHost: () => host,
    account: "demo/user",
    lock: r.lock,
    redact: (text) => text,
    now: () => r.clock.now(),
    trace: r.wiring,
    ...(renew !== undefined ? { authSession: { prepare: async () => ({ unauthored: false }) }, authContext: { baseUrl: BASE } } : {}),
  });
  await withExecScope(r.scope, async () => {
    await adapter.open({ runId: "run-9", app: "demo", mode: "diff", specDir: r.specDir });
  });
  registry.bindSession({ sessionId: SESSION, runId: "run-9", agent: "qa-generator" });
  return registry;
}

test("a browser call is a server span under the attempt, with its action, the guard's block reasons and the document status", async (t) => {
  const r = rig(t);
  const host = new FakeHost();
  host.page = () => ({ ...PAGE, documentStatus: 200, blocked: [{ reason: "method", detail: "POST /api/orders" }] });
  const registry = await openBrowser(r, host);
  await r.turn(async (stream) => {
    stream(stepStart("a"), toolEvent("b1", "authbrowser_navigate", "running", { start: r.clock.now() }, "m1"));
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-generator", action: "navigate", url: "/orders", messageId: "m1" });
    stream(toolEvent("b1", "authbrowser_navigate", "completed", { start: T0 + 10, end: r.clock.now() }, "m1"));
  });
  const tool = r.h.only("qayaba.tool.authbrowser");
  assert.equal(parentOf(tool), idOf(r.h.only("qayaba.agent.attempt")));
  assert.equal(tool.kind, SpanKind.SERVER);
  assert.equal(tool.attributes["qayaba.browser.action"], "navigate");
  assert.equal(tool.attributes["http.response.status_code"], 200);
  assert.deepEqual(tool.attributes["qayaba.browser.block_reasons"], ["method"]);
  assert.equal(tool.attributes["qayaba.tool.outcome"], "ok");
  assert.equal(r.h.only("execute_tool authbrowser_navigate").links[0]?.context.spanId, idOf(tool));
});

test("a browser call that found the session gone says so, and carries the page of no one", async (t) => {
  const r = rig(t);
  const host = new FakeHost();
  host.page = () => ({ ...PAGE, url: `${BASE}/login`, requestedPath: "/orders", passwordFieldVisible: true });
  const registry = await openBrowser(r, host);
  await r.turn(async () => {
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-generator", action: "navigate", url: "/orders" });
  });
  const tool = r.h.only("qayaba.tool.authbrowser");
  assert.equal(tool.attributes["qayaba.auth.invalidated"], true);
  assert.equal(tool.attributes["qayaba.tool.outcome"], "refused");
  assert.equal(tool.attributes["qayaba.tool.refusal"], "session-invalidated");
});

test("a browser call refused for the guard before it reaches the lease still has its action and block reason", async (t) => {
  const r = rig(t);
  const registry = await openBrowser(r, new FakeHost());
  await r.turn(async () => {
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-generator", action: "navigate", url: "/admin/users" });
  });
  const tool = r.h.only("qayaba.tool.authbrowser");
  assert.equal(tool.attributes["qayaba.browser.action"], "navigate");
  assert.equal(tool.attributes["qayaba.browser.blocks"], 1);
  assert.equal(tool.attributes["qayaba.tool.refusal"], "blocked");
});

test("a call that arrives after its attempt and session are over hangs under the phase that is open, and links to nothing", async (t) => {
  const r = rig(t);
  const registry = await openLoop(r);
  await r.turn(async () => {});
  const response = await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts", messageId: "m1" });
  assert.equal(response.ok, true);
  const tool = r.h.only("qayaba.tool.run_spec");
  assert.equal(parentOf(tool), r.scope.telemetry!.parent()!.spanId);
  assert.equal(r.h.named("execute_tool run_spec").length, 0);
  assert.deepEqual(r.h.unended(), []);
});

test("inside a run_spec call the report's spans hang under the call, and what is kept per run is still the run's", async (t) => {
  const r = rig(t);
  const report = { suites: [{ title: "a.spec.ts", file: "flows/a.spec.ts", specs: [{ title: "loads", tests: [{ status: "expected", results: [{ status: "passed", duration: 100, retry: 0, startTime: new Date(T0 + 50).toISOString() }] }] }], suites: [] }] };
  const registry = await openLoop(r, {
    execute: async () => {
      synthesizeReportSpans({ telemetry: r.h.telemetry, now: () => T0 + 1_000 }, report);
      noteSuiteAuth((notes) => { notes.restored = true; });
    },
  });
  await r.turn(async () => {
    await registry.find(SESSION)!.call({ sessionId: SESSION, agent: "qa-sidekick", path: "flows/a.spec.ts" });
  });
  const tool = r.h.only("qayaba.tool.run_spec");
  assert.equal(parentOf(r.h.only("qayaba.spec.execute")), idOf(tool));
  assert.equal(withExecScope(r.scope, () => suiteAuthNotes())?.restored, true);
});

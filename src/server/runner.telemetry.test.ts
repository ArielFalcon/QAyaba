/* The run's root span and the trace's link to its enqueue: enqueueTrackedRun over the real telemetry adapter and an in-memory exporter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun, enqueueContextMapRun, enqueueLoginBootstrapRun, cancelTrackedRun, type RunnerDeps, type RunRequest } from "./runner";
import { getRecord, listRunSpans } from "./history";
import type { AppConfig } from "../orchestrator/config-loader";
import type { RunPipelinePort, RunInput } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { RunOutcome } from "@kernel/run-outcome";
import { attachTraceFacts, type RunTraceFacts } from "@kernel/run-trace-facts";
import { AgentTimeoutError } from "@kernel/domain-error";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { INSTRUMENTS } from "@kernel/telemetry/instrument-table";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { SpanStatusCode, traceHarness } from "../telemetry/trace-harness";
import { createTelemetry } from "../telemetry/bootstrap";

const cfg = (name: string): AppConfig => ({
  name,
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
});

let appCounter = 0;
const uniqueApp = (): string => `trace-app-${(appCounter += 1)}-${Math.random().toString(36).slice(2, 7)}`;

function outcomeOf(input: RunInput, patch: Partial<RunOutcome> = {}, facts?: RunTraceFacts): RunOutcome {
  const outcome: RunOutcome = {
    runId: input.runId,
    app: input.app,
    sha: input.sha.value,
    mode: input.mode,
    target: input.target,
    verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [],
    at: new Date(0).toISOString(),
    ...patch,
  };
  return facts ? attachTraceFacts(outcome, facts) : outcome;
}

const portReturning = (patch: Partial<RunOutcome> = {}, facts?: RunTraceFacts): RunPipelinePort => ({ run: async (input) => outcomeOf(input, patch, facts) });

function request(app: string, extra: Partial<RunRequest> = {}): RunRequest {
  return { app, sha: "abc1234", target: "e2e", mode: "diff", source: "manual", trigger: "api", ...extra };
}

function deps(h: ReturnType<typeof traceHarness>, port: RunPipelinePort, extra: Partial<RunnerDeps> = {}): RunnerDeps {
  return { loadApp: cfg, engineFactory: () => port, telemetry: h.telemetry, clock: h.clock, ...extra };
}

const attr = (span: { attributes: Record<string, unknown> }, key: string): unknown => span.attributes[key];

test("a run is a root span on a trace of its own, with a link to the enqueue span and the identity of the run", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  const id = enqueueTrackedRun(queue, request(app, { trigger: "webhook", triggerRepo: undefined, parentRunId: undefined }), deps(h, portReturning()));
  await queue.drain();

  const root = h.only("qayaba.run");
  const enqueue = h.only("qayaba.run.enqueue");
  assert.equal(root.parentSpanContext, undefined);
  assert.notEqual(root.spanContext().traceId, enqueue.spanContext().traceId);
  assert.deepEqual(root.links.map((l) => l.context.spanId), [enqueue.spanContext().spanId]);
  assert.deepEqual(root.links.map((l) => l.context.traceId), [enqueue.spanContext().traceId]);
  assert.equal(attr(root, "qayaba.run.id"), id);
  assert.equal(attr(root, "qayaba.app"), app);
  assert.equal(attr(root, "qayaba.commit.sha"), "abc1234");
  assert.equal(attr(root, "qayaba.mode"), "diff");
  assert.equal(attr(root, "qayaba.target"), "e2e");
  assert.equal(attr(root, "qayaba.trigger"), "webhook");
  assert.equal(attr(root, "qayaba.shadow"), true);
  assert.equal(attr(root, "langfuse.trace.name"), "qayaba.run");
  assert.equal(attr(root, "langfuse.session.id"), app);
  assert.deepEqual(attr(root, "langfuse.trace.tags"), [app, "diff"]);
  assert.deepEqual(h.unended(), []);
});

test("the run root is a new trace even when the enqueue happens inside an active span", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const request_ = h.telemetry.startSpan("http.request", { kind: "server" });
  h.telemetry.withParent(request_, () => {
    enqueueTrackedRun(queue, request(uniqueApp()), deps(h, portReturning()));
  });
  await queue.drain();
  request_.end();

  const root = h.only("qayaba.run");
  const enqueue = h.only("qayaba.run.enqueue");
  assert.equal(root.parentSpanContext, undefined);
  assert.notEqual(root.spanContext().traceId, request_.context().traceId);
  assert.equal(enqueue.parentSpanContext?.spanId, request_.context().spanId);
  assert.equal(root.links[0]?.context.spanId, enqueue.spanContext().spanId);
});

test("the engine runs under the root, so what it starts is a child of the run", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const port: RunPipelinePort = {
    run: async (input) => {
      h.telemetry.startSpan("qayaba.phase.gate").end();
      return outcomeOf(input);
    },
  };
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await queue.drain();
  assert.equal(h.only("qayaba.phase.gate").parentSpanContext?.spanId, h.only("qayaba.run").spanContext().spanId);
});

test("the wait in the queue is an attribute of the root, not time before it", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const firstRunning = new Promise<void>((resolve) => { started = resolve; });
  const first: RunPipelinePort = { run: async (input) => { started(); await held; return outcomeOf(input); } };
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, first));
  await firstRunning;
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, portReturning()));
  h.clock.advance(4_000);
  release();
  await queue.drain();

  const waits = h.named("qayaba.run").map((s) => attr(s, "qayaba.queue.wait_ms"));
  assert.deepEqual(waits.sort((a, b) => Number(a) - Number(b)), [0, 4_000]);
});

test("the time a run parked for onboarding is on the root", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let polls = 0;
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, portReturning(), {
    isOnboardingActive: () => (polls += 1) <= 2,
    sleep: async () => { h.clock.advance(5_000); },
  }));
  await queue.drain();
  assert.equal(attr(h.only("qayaba.run"), "qayaba.onboarding.wait_ms"), 10_000);
});

test("a finished run records what it came to on the root and counts as one run", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  const port = portReturning(
    {
      verdict: "fail",
      errorClass: "E-EXEC-FAIL",
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, furthestPhase: "decide" },
    },
    { decision: "issue", generationEnd: "delivered" },
  );
  enqueueTrackedRun(queue, request(app), deps(h, port));
  await queue.drain();

  const root = h.only("qayaba.run");
  assert.equal(attr(root, "qayaba.verdict"), "fail");
  assert.equal(attr(root, "qayaba.error_class"), "E-EXEC-FAIL");
  assert.equal(attr(root, "qayaba.decision"), "issue");
  assert.equal(attr(root, "qayaba.generation.end"), "delivered");
  assert.equal(attr(root, "qayaba.furthest_phase"), "decide");
  assert.equal(root.status.code, SpanStatusCode.UNSET);
  const runs = h.measurements.filter((m) => m.name === "qayaba.runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.value, 1);
  assert.equal(runs[0]!.attrs["qayaba.app"], app);
  assert.equal(runs[0]!.attrs["qayaba.verdict"], "fail");
  assert.equal(runs[0]!.attrs["qayaba.furthest_phase"], "decide");
});

test("a pass verdict is not an error, and the shadow-log decision is named shadow", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, portReturning({}, { decision: "shadow-log" })));
  await queue.drain();
  const root = h.only("qayaba.run");
  assert.equal(root.status.code, SpanStatusCode.UNSET);
  assert.equal(attr(root, "qayaba.decision"), "shadow");
});

test("run duration is recorded in seconds, and only with allowed keys", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const port: RunPipelinePort = { run: async (input) => { h.clock.advance(90_000); return outcomeOf(input); } };
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await queue.drain();

  const duration = h.measurements.find((m) => m.name === "qayaba.run.duration");
  assert.equal(duration?.value, 90);
  for (const m of h.measurements) {
    const allowed = new Set<string>(INSTRUMENTS[m.name as keyof typeof INSTRUMENTS].attrs);
    for (const key of Object.keys(m.attrs)) assert.ok(allowed.has(key), `${m.name}: ${key}`);
  }
});

test("an infra-error verdict marks the root as an error and counts as an infra error of its class", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const app = uniqueApp();
  enqueueTrackedRun(queue, request(app), deps(h, portReturning({ verdict: "infra-error", errorClass: "E-STEP-BUDGET" }, { decision: "none", generationEnd: "exhausted", limitFired: "step-cap", limitRole: "qa-generator" })));
  await queue.drain();

  const root = h.only("qayaba.run");
  assert.equal(root.status.code, SpanStatusCode.ERROR);
  assert.equal(attr(root, "error.type"), "E-STEP-BUDGET");
  const infra = h.measurements.find((m) => m.name === "qayaba.infra_errors");
  assert.equal(infra?.attrs["qayaba.error_class"], "E-STEP-BUDGET");
  assert.equal(infra?.attrs["qayaba.app"], app);
  const budget = h.measurements.find((m) => m.name === "qayaba.budget.exhausted");
  assert.equal(budget?.attrs["qayaba.limit.fired"], "step-cap");
  assert.equal(budget?.attrs["qayaba.agent.role"], "qa-generator");
  assert.equal(attr(root, "qayaba.limit.fired"), "step-cap");
});

test("an exception out of the engine ends the root as an error, finalizes the record, and still ends every span", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const port: RunPipelinePort = { run: async () => { throw new AgentTimeoutError("generate: timed out"); } };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await queue.drain();

  const root = h.only("qayaba.run");
  assert.equal(root.status.code, SpanStatusCode.ERROR);
  assert.equal(getRecord(id)?.verdict, "infra-error");
  assert.deepEqual(h.unended(), []);
  assert.ok(h.flushCount() >= 1);
});

test("an unexpected internal error is an error root too, not a benign outcome", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async () => { throw new TypeError("x is not a function"); } }));
  await queue.drain();
  assert.equal(h.only("qayaba.run").status.code, SpanStatusCode.ERROR);
  assert.deepEqual(h.unended(), []);
});

test("a missing engine factory still ends the root", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  enqueueTrackedRun(queue, request(uniqueApp()), { loadApp: cfg, telemetry: h.telemetry, clock: h.clock });
  await queue.drain();
  assert.equal(h.only("qayaba.run").status.code, SpanStatusCode.ERROR);
  assert.deepEqual(h.unended(), []);
});

test("an operator cancel ends the root as cancelled, never as an error", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const port: RunPipelinePort = {
    run: (_input, signal) => new Promise((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await running;
  assert.equal(cancelTrackedRun(queue, id), true);
  await queue.drain();

  const root = h.only("qayaba.run");
  assert.equal(attr(root, "qayaba.run.cancelled"), true);
  assert.notEqual(root.status.code, SpanStatusCode.ERROR);
  assert.deepEqual(h.unended(), []);
  assert.equal(h.measurements.filter((m) => m.name === "qayaba.infra_errors").length, 0);
});

test("a run that resolves after it was cancelled is a cancelled root, not a finished one", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const late = new Promise<void>((resolve) => { finish = resolve; });
  const port: RunPipelinePort = { run: async (input) => { started(); await late; return outcomeOf(input); } };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await running;
  cancelTrackedRun(queue, id);
  finish();
  await queue.drain();

  const root = h.only("qayaba.run");
  assert.equal(attr(root, "qayaba.run.cancelled"), true);
  assert.equal(attr(root, "qayaba.verdict"), undefined);
});

test("a run cancelled while it was still queued opens a cancelled root and runs nothing", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async (input) => { await held; return outcomeOf(input); } }));
  let ran = 0;
  const waiting = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, { run: async (input) => { ran += 1; return outcomeOf(input); } }));
  cancelTrackedRun(queue, waiting);
  release();
  await queue.drain();

  assert.equal(ran, 0);
  assert.equal(h.named("qayaba.run").filter((s) => attr(s, "qayaba.run.cancelled") === true).length, 1);
  assert.deepEqual(h.unended(), []);
});

test("each entry point stamps its own trigger on the root", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const d = deps(h, portReturning());
  const app = uniqueApp();
  enqueueTrackedRun(queue, request(app, { trigger: "webhook" }), d);
  enqueueTrackedRun(queue, request(app, { trigger: "cli" }), d);
  enqueueTrackedRun(queue, request(app, { trigger: "continuation", parentRunId: "run-parent-1" }), d);
  enqueueContextMapRun(queue, app, "abc1234", d);
  enqueueLoginBootstrapRun(queue, app, "abc1234", d);
  await queue.drain();

  const triggers = h.named("qayaba.run").map((s) => attr(s, "qayaba.trigger")).sort();
  assert.deepEqual(triggers, ["cli", "context", "continuation", "login-bootstrap", "webhook"]);
  const continuation = h.named("qayaba.run").find((s) => attr(s, "qayaba.trigger") === "continuation");
  assert.equal(attr(continuation!, "qayaba.parent_run.id"), "run-parent-1");
});

test("a request that names no trigger is told apart by its source", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const d = deps(h, portReturning());
  const app = uniqueApp();
  const { trigger: _t, ...bare } = request(app);
  enqueueTrackedRun(queue, { ...bare, source: "webhook" }, d);
  enqueueTrackedRun(queue, { ...bare, source: "manual" }, d);
  await queue.drain();
  assert.deepEqual(h.named("qayaba.run").map((s) => attr(s, "qayaba.trigger")).sort(), ["api", "webhook"]);
});

/* Everything of a run's record that does not depend on when or under which id it was made. */
function recordShape(id: string): Record<string, unknown> {
  const { id: _id, at: _at, stepStartedAt: _started, activity, cases, ...rest } = getRecord(id)!;
  /* An activity row or a case row is stamped with its own id, run id and time. */
  return { ...rest, cases: cases.map(({ name, status, detail }) => ({ name, status, detail })), activity: activity?.map(({ kind, text, status }) => ({ kind, text, status })) };
}

test("a telemetry port that throws on every method leaves the whole run record as it is without telemetry", async () => {
  const app = uniqueApp();
  const run = async (telemetry: TelemetryPort | undefined) => {
    const queue = new JobQueue();
    const h = traceHarness();
    const port = portReturning({ verdict: "fail", errorClass: "E-EXEC-FAIL", cases: [{ name: "a case", status: "fail", detail: "boom" }] } as Partial<RunOutcome>);
    const id = enqueueTrackedRun(queue, request(app), { loadApp: cfg, engineFactory: () => port, ...(telemetry ? { telemetry, clock: h.clock } : {}) });
    await queue.drain();
    return recordShape(id);
  };
  assert.deepEqual(await run(new ThrowingTelemetry()), await run(undefined));
});

test("a throwing telemetry port does not change how an engine error is recorded", async () => {
  const app = uniqueApp();
  const run = async (telemetry: TelemetryPort | undefined) => {
    const queue = new JobQueue();
    const id = enqueueTrackedRun(queue, request(app), { loadApp: cfg, engineFactory: () => ({ run: async () => { throw new AgentTimeoutError("generate: timed out"); } }), ...(telemetry ? { telemetry } : {}) });
    await queue.drain();
    return recordShape(id);
  };
  assert.deepEqual(await run(new ThrowingTelemetry()), await run(undefined));
});

test("the trace and the record agree when recording the verdict fails after the engine answered", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const events = { publish: (_id: string, body: { type: string }) => { if (body.type === "run.verdict") throw new Error("event store down"); return {} as never; }, replay: () => [], subscribe: () => () => {} };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, portReturning(), { runEvents: events as never }));
  await queue.drain();

  assert.equal(getRecord(id)?.verdict, "infra-error");
  const root = h.only("qayaba.run");
  assert.equal(attr(root, "qayaba.verdict"), "infra-error");
  assert.equal(root.status.code, SpanStatusCode.ERROR);
  assert.equal(h.measurements.filter((m) => m.name === "qayaba.runs").map((m) => m.attrs["qayaba.verdict"]).join(), "infra-error");
});

test("a cancel is its own verdict label on the run counter, and still not an error", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const port: RunPipelinePort = { run: (_i, signal) => new Promise((_r, reject) => { started(); signal?.addEventListener("abort", () => reject(new Error("aborted"))); }) };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), deps(h, port));
  await running;
  cancelTrackedRun(queue, id);
  await queue.drain();
  const runs = h.measurements.filter((m) => m.name === "qayaba.runs");
  assert.deepEqual(runs.map((m) => m.attrs["qayaba.verdict"]), ["cancelled"]);
  assert.equal(runs[0]!.attrs["qayaba.error_class"], undefined);
  assert.notEqual(h.only("qayaba.run").status.code, SpanStatusCode.ERROR);
});

test("with the real bootstrap in local mode, the ledger holds the run's spans under its run id", async () => {
  const handle = createTelemetry({ env: {}, campaignFreeze: false });
  const queue = new JobQueue();
  const port: RunPipelinePort = {
    run: async (input) => {
      handle.telemetry.startSpan("qayaba.phase.gate").end();
      return outcomeOf(input);
    },
  };
  const id = enqueueTrackedRun(queue, request(uniqueApp()), { loadApp: cfg, engineFactory: () => port, telemetry: handle.telemetry });
  await queue.drain();
  await handle.shutdown(1000);

  const rows = listRunSpans(id);
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, ["qayaba.phase.gate", "qayaba.run", "qayaba.run.enqueue"]);
  assert.ok(rows.every((r) => r.endNs !== null));
});

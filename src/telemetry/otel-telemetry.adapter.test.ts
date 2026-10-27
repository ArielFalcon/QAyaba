import { test } from "node:test";
import assert from "node:assert/strict";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { SpanKind, SpanStatusCode, type Tracer, type Meter } from "@opentelemetry/api";
import { ARRAY_CAP, OtelTelemetry, type CaptureMode } from "./otel-telemetry.adapter";
import { createRunSecretScope } from "../../qa-engine/src/shared-kernel/run-secret-redaction";
import type { TelemetryClock } from "@kernel/telemetry/telemetry.port";
import { GENAI } from "@kernel/telemetry/genai-semconv";
import { attrKey, lookupAttribute } from "@kernel/telemetry/attribute-registry";
import { LedgerSpanProcessor } from "./ledger";
import type { RunSpanRow } from "../server/persistence/repositories/telemetry.repository";

const T0 = 1_760_000_000_000;

/* An attribute whose key the registry does not know, past the compile-time check. */
const unknownKey = (key: string, value: string): Record<string, string> => ({ [key]: value });

class FakeClock implements TelemetryClock {
  constructor(public t = T0) {}
  now(): number {
    return this.t;
  }
}

const hrMs = (t: [number, number]): number => t[0] * 1000 + t[1] / 1e6;

function harness(opts: { captureMode?: CaptureMode; maxCaptureMode?: CaptureMode; meter?: Meter; tracer?: Tracer } = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const clock = new FakeClock();
  const telemetry = new OtelTelemetry({ tracer: opts.tracer ?? provider.getTracer("t"), contextManager, clock, captureMode: opts.captureMode, maxCaptureMode: opts.maxCaptureMode, meter: opts.meter });
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
  const byName = (name: string): ReadableSpan => {
    const span = spans().find((s) => s.name === name);
    assert.ok(span, `no span named ${name}`);
    return span;
  };
  return { telemetry, clock, spans, byName, exporter };
}

test("a log record is placed in the ambient span and redacted through its run scope", () => {
  const { telemetry } = harness();
  assert.equal(telemetry.logTarget(), undefined);
  telemetry.withSpan("run", { captureMode: "metadata", secrets: { redact: (text) => text.replace("hunter2", "[redacted]") } }, () => {
    const target = telemetry.logTarget();
    assert.equal(target?.mode, "metadata");
    assert.equal(telemetry.redactIn(target?.context, "value hunter2", 1024), "value [redacted]");
    assert.equal(telemetry.redactIn(target?.context, "word ".repeat(500), 10), "word word ");
  });
  assert.equal(telemetry.logTarget(), undefined);
});

test("with no ambient span a log record joins the single open root, and none once it ends or a second root is open", () => {
  const { telemetry } = harness();
  const root = telemetry.startSpan("qayaba.run", { root: true, captureMode: "metadata" });
  assert.equal(telemetry.logTarget()?.mode, "metadata");
  const other = telemetry.startSpan("other", { root: true });
  assert.equal(telemetry.logTarget(), undefined);
  other.end();
  assert.ok(telemetry.logTarget());
  root.end();
  assert.equal(telemetry.logTarget(), undefined);
});

test("every span takes its start and end from the injected clock, so a clock jump lands exactly", () => {
  const { telemetry, clock, byName } = harness();
  const span = telemetry.startSpan("run");
  clock.t = T0 + 90 * 60 * 1000 + 250;
  span.end();
  assert.equal(hrMs(byName("run").startTime as [number, number]), T0);
  assert.equal(hrMs(byName("run").endTime as [number, number]), T0 + 90 * 60 * 1000 + 250);
});

test("explicit start and end times win over the clock, and a small epoch-like value is still wall-clock", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("synth", { startTime: 5_000 }).end(6_500);
  assert.equal(hrMs(byName("synth").startTime as [number, number]), 5_000);
  assert.equal(hrMs(byName("synth").endTime as [number, number]), 6_500);
});

test("ending a span twice keeps the first end", () => {
  const { telemetry, clock, byName } = harness();
  const span = telemetry.startSpan("once");
  span.end(T0 + 1);
  clock.t = T0 + 999;
  span.end();
  assert.equal(hrMs(byName("once").endTime as [number, number]), T0 + 1);
});

test("span kind maps from the string union", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("c", { kind: "client" }).end();
  telemetry.startSpan("d").end();
  assert.equal(byName("c").kind, SpanKind.CLIENT);
  assert.equal(byName("d").kind, SpanKind.INTERNAL);
});

test("withSpan returns the callback's result and ends the span", () => {
  const { telemetry, byName } = harness();
  assert.equal(telemetry.withSpan("ok", {}, () => 42), 42);
  assert.equal(byName("ok").ended, true);
});

test("withSpan ends the span and rethrows when the callback throws", () => {
  const { telemetry, byName } = harness();
  assert.throws(() => telemetry.withSpan("boom", {}, () => { throw new Error("kaput"); }), /kaput/);
  const span = byName("boom");
  assert.equal(span.ended, true);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.ok(span.events.some((e) => e.name === "exception"));
});

test("withSpan ends the span when the promise settles, on resolve and on reject", async () => {
  const { telemetry, spans, byName } = harness();
  let release!: () => void;
  const pending = telemetry.withSpan("async-ok", {}, () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
  assert.equal(spans().length, 0, "still open while pending");
  release();
  assert.equal(await pending, "done");
  assert.equal(byName("async-ok").ended, true);
  await assert.rejects(telemetry.withSpan("async-bad", {}, async () => { throw new Error("later"); }), /later/);
  assert.equal(byName("async-bad").status.code, SpanStatusCode.ERROR);
});

test("a span started inside withSpan is its child, also after an await", async () => {
  const { telemetry, byName } = harness();
  await telemetry.withSpan("parent", {}, async () => {
    await Promise.resolve();
    telemetry.startSpan("child").end();
  });
  assert.equal(byName("child").parentSpanContext?.spanId, byName("parent").spanContext().spanId);
  assert.equal(byName("child").spanContext().traceId, byName("parent").spanContext().traceId);
});

test("activeContext reports the span active inside withSpan and nothing outside", () => {
  const { telemetry } = harness();
  assert.equal(telemetry.activeContext(), undefined);
  telemetry.withSpan("a", {}, (span) => {
    assert.deepEqual(telemetry.activeContext(), span.context());
  });
});

test("withParent parents spans under an explicit handle, and a grandchild under that child", () => {
  const { telemetry, byName } = harness();
  const parent = telemetry.startSpan("snapshot-parent");
  telemetry.withParent(parent, () => {
    telemetry.withSpan("child", {}, () => {
      telemetry.startSpan("grandchild").end();
    });
  });
  parent.end();
  assert.equal(byName("child").parentSpanContext?.spanId, parent.context().spanId);
  assert.equal(byName("grandchild").parentSpanContext?.spanId, byName("child").spanContext().spanId);
});

test("an explicit parent option beats the active context, and a bare context parents too", () => {
  const { telemetry, byName } = harness();
  const other = telemetry.startSpan("other");
  const ctx = other.context();
  other.end();
  telemetry.withSpan("active", {}, () => {
    telemetry.startSpan("by-handle", { parent: other }).end();
    telemetry.startSpan("by-context", { parent: ctx }).end();
  });
  assert.equal(byName("by-handle").parentSpanContext?.spanId, ctx.spanId);
  assert.equal(byName("by-context").parentSpanContext?.spanId, ctx.spanId);
});

test("root: true starts a new trace even inside an active span, and a link points back", () => {
  const { telemetry, byName } = harness();
  const enqueue = telemetry.startSpan("enqueue");
  telemetry.withParent(enqueue, () => {
    telemetry.startSpan("run", { root: true, links: [{ context: enqueue.context(), attrs: { "qayaba.queue.wait_ms": 5 } }] }).end();
  });
  enqueue.end();
  const run = byName("run");
  assert.equal(run.parentSpanContext, undefined);
  assert.notEqual(run.spanContext().traceId, enqueue.context().traceId);
  assert.equal(run.links[0]?.context.spanId, enqueue.context().spanId);
});

test("an attribute key that is not in the registry is dropped and counted, registered ones are kept", () => {
  const { telemetry, byName } = harness();
  const span = telemetry.startSpan("a", { attrs: { "qayaba.app": "shop", ...unknownKey("qayaba.invented", "x") } });
  span.setAttrs({ "qayaba.verdict": "pass", ...unknownKey("also.invented", "y") });
  span.end();
  assert.deepEqual({ ...byName("a").attributes }, { "qayaba.app": "shop", "qayaba.verdict": "pass" });
  assert.equal(telemetry.stats().droppedAttributes, 2);
});

test("template keys and gen_ai keys pass the registry", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("t", { attrs: { "qayaba.prompt.section.grounding.bytes": 10, [GENAI.attrs.requestModel]: "m" } }).end();
  assert.equal(byName("t").attributes["qayaba.prompt.section.grounding.bytes"], 10);
  assert.equal(byName("t").attributes[GENAI.attrs.requestModel], "m");
  assert.equal(telemetry.stats().droppedAttributes, 0);
});

test("undefined values are skipped without counting as drops", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("u", { attrs: { "qayaba.app": undefined } }).end();
  assert.deepEqual({ ...byName("u").attributes }, {});
  assert.equal(telemetry.stats().droppedAttributes, 0);
});

test("a key classed none is not run through the text sanitizer", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("n", { attrs: { "qayaba.app": "owner@example.com" } }).end();
  assert.equal(byName("n").attributes["qayaba.app"], "owner@example.com");
});

const PASSWORD = "hunter2-correct-horse";
const COOKIE = "sess=abc123def456ghi789";

function seededScope() {
  const scope = createRunSecretScope();
  scope.addAccountSecrets([PASSWORD]);
  scope.addSessionValues([COOKIE]);
  return scope;
}

test("a text attribute passes through the bound scope and then the outbound sanitizer", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("r", { secrets: seededScope(), attrs: { "qayaba.tool.target": `login with ${PASSWORD} as ops@example.com` } }).end();
  const value = String(byName("r").attributes["qayaba.tool.target"]);
  assert.ok(!value.includes(PASSWORD));
  assert.ok(!value.includes("ops@example.com"));
});

test("seeded secrets are absent from every attribute, event, status, exception and link of the exported spans", () => {
  const { telemetry, spans } = harness({ captureMode: "full" });
  const scope = seededScope();
  const leak = `token ${PASSWORD} and ${COOKIE}`;
  const root = telemetry.startSpan("root", { secrets: scope, attrs: { "qayaba.tool.target": leak, [GENAI.attrs.inputMessages]: leak, "qayaba.egress.denied_cotemporal": [leak] } });
  root.setAttrs({ "qayaba.error.message": leak });
  root.addEvent("note", { "qayaba.tool.target": leak });
  root.recordError(new Error(`failed with ${leak}`), { "qayaba.error.message": leak });
  const child = telemetry.startSpan("child", { parent: root, links: [{ context: root.context(), attrs: { "qayaba.tool.target": leak } }], attrs: { "qayaba.tool.target": leak } });
  try {
    telemetry.withParent(child, () => telemetry.withSpan("grand", {}, () => { throw new Error(`grand failed ${leak}`); }));
  } catch {
    /* the callback's own failure is rethrown by contract */
  }
  child.end();
  root.end();
  const dump = JSON.stringify(spans().map((s) => ({ name: s.name, attrs: s.attributes, events: s.events, status: s.status, links: s.links })));
  assert.ok(!dump.includes(PASSWORD), "password leaked");
  assert.ok(!dump.includes(COOKIE), "cookie leaked");
});

test("a child span inherits its parent's redaction scope when it is given none", () => {
  const { telemetry, byName } = harness();
  const parent = telemetry.startSpan("p", { secrets: seededScope() });
  telemetry.withParent(parent, () => telemetry.startSpan("c", { attrs: { "qayaba.tool.target": PASSWORD } }).end());
  telemetry.startSpan("d", { parent, attrs: { "qayaba.tool.target": PASSWORD } }).end();
  parent.end();
  assert.ok(!String(byName("c").attributes["qayaba.tool.target"]).includes(PASSWORD));
  assert.ok(!String(byName("d").attributes["qayaba.tool.target"]).includes(PASSWORD));
});

test("recordError marks the span ERROR with a redacted, capped message and no stack", () => {
  const { telemetry, byName } = harness();
  const span = telemetry.startSpan("e", { secrets: seededScope() });
  const error = new Error(`${PASSWORD} ${"x".repeat(5000)}`);
  span.recordError(error);
  span.end();
  const s = byName("e");
  assert.equal(s.status.code, SpanStatusCode.ERROR);
  assert.ok(!(s.status.message ?? "").includes(PASSWORD));
  assert.ok((s.status.message ?? "").length <= 1024);
  const exception = s.events.find((e) => e.name === "exception");
  assert.ok(exception);
  assert.equal(exception.attributes?.["exception.stacktrace"], undefined);
  assert.equal(exception.attributes?.["exception.type"], "Error");
  assert.ok(!String(exception.attributes?.["exception.message"]).includes(PASSWORD));
  assert.equal(s.attributes["error.type"], "Error");
});

test("a non-Error thrown value is recorded as text", () => {
  const { telemetry, byName } = harness();
  const span = telemetry.startSpan("s");
  span.recordError("plain string failure");
  span.end();
  assert.match(String(byName("s").status.message), /plain string failure/);
});

test("content keys are dropped in metadata mode and kept, capped, in full mode", () => {
  const meta = harness({ captureMode: "metadata" });
  meta.telemetry.startSpan("m", { attrs: { [GENAI.attrs.inputMessages]: "hello" } }).end();
  assert.equal(meta.byName("m").attributes[GENAI.attrs.inputMessages], undefined);
  assert.equal(meta.telemetry.stats().droppedAttributes, 1);

  const full = harness({ captureMode: "full" });
  full.telemetry.startSpan("f", { attrs: { [GENAI.attrs.inputMessages]: "y".repeat(40_000) } }).end();
  const kept = String(full.byName("f").attributes[GENAI.attrs.inputMessages]);
  assert.ok(kept.length > 0 && kept.length <= 32 * 1024);
});

test("a run's root can ask for its own capture mode and every span under it inherits it, whatever the process default", () => {
  const { telemetry, byName } = harness({ captureMode: "metadata", maxCaptureMode: "full" });
  const root = telemetry.startSpan("full-run", { root: true, captureMode: "full" });
  telemetry.withParent(root, () => telemetry.startSpan("full-child", { attrs: { [GENAI.attrs.inputMessages]: "hello" } }).end());
  root.setAttrs({ [GENAI.attrs.inputMessages]: "root body" });
  root.end();
  const other = telemetry.startSpan("plain-run", { root: true });
  telemetry.withParent(other, () => telemetry.startSpan("plain-child", { attrs: { [GENAI.attrs.inputMessages]: "hello" } }).end());
  other.end();
  assert.equal(byName("full-child").attributes[GENAI.attrs.inputMessages], "hello");
  assert.equal(byName("full-run").attributes[GENAI.attrs.inputMessages], "root body");
  assert.equal(byName("plain-child").attributes[GENAI.attrs.inputMessages], undefined);
});

test("a run cannot ask for more content than the server's ceiling allows, even in its own root", () => {
  const { telemetry, byName } = harness({ maxCaptureMode: "metadata" });
  const root = telemetry.startSpan("greedy", { root: true, captureMode: "full", attrs: { [GENAI.attrs.inputMessages]: "x" } });
  telemetry.withParent(root, () => telemetry.startSpan("greedy-child", { attrs: { [GENAI.attrs.inputMessages]: "x" } }).end());
  root.end();
  assert.equal(byName("greedy").attributes[GENAI.attrs.inputMessages], undefined);
  assert.equal(byName("greedy-child").attributes[GENAI.attrs.inputMessages], undefined);
});

test("a run that asks for off drops text keys under it while another run keeps them", () => {
  const { telemetry, byName } = harness();
  const quiet = telemetry.startSpan("quiet", { root: true, captureMode: "off" });
  telemetry.withParent(quiet, () => telemetry.startSpan("quiet-child", { attrs: { "qayaba.tool.target": "x", "qayaba.app": "a" } }).end());
  quiet.end();
  assert.deepEqual({ ...byName("quiet-child").attributes }, { "qayaba.app": "a" });
});

test("the default capture mode is metadata", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const t = new OtelTelemetry({ tracer: provider.getTracer("t"), contextManager: new AsyncLocalStorageContextManager().enable(), clock: new FakeClock() });
  t.startSpan("d", { attrs: { [GENAI.attrs.outputMessages]: "x" } }).end();
  assert.equal(exporter.getFinishedSpans()[0]!.attributes[GENAI.attrs.outputMessages], undefined);
});

test("in off capture mode text keys are dropped too, structure stays", () => {
  const { telemetry, byName } = harness({ captureMode: "off" });
  telemetry.startSpan("o", { attrs: { "qayaba.tool.target": "x", "qayaba.app": "a" } }).end();
  assert.deepEqual({ ...byName("o").attributes }, { "qayaba.app": "a" });
});

test("hashes and sizes of content are exported in metadata and full mode and never in off mode", () => {
  const attrs = { "qayaba.prompt.hash": "abc", "qayaba.prompt.bytes": 12, [attrKey.promptSectionHash("task")]: "def", [attrKey.promptSectionBytes("task")]: 5, "qayaba.app": "a" };
  for (const mode of ["metadata", "full"] as const) {
    const h = harness({ captureMode: mode });
    h.telemetry.startSpan("m", { attrs }).end();
    assert.deepEqual({ ...h.byName("m").attributes }, attrs, mode);
  }
  const off = harness({ captureMode: "off" });
  off.telemetry.startSpan("m", { attrs }).end();
  assert.deepEqual({ ...off.byName("m").attributes }, { "qayaba.app": "a" });
});

test("events are filtered like attributes and take explicit time", () => {
  const { telemetry, byName } = harness();
  const span = telemetry.startSpan("ev");
  span.addEvent("retry", { "qayaba.app": "a", ...unknownKey("nope", "b") }, T0 + 77);
  span.end();
  const event = byName("ev").events[0]!;
  assert.deepEqual({ ...event.attributes }, { "qayaba.app": "a" });
  assert.equal(hrMs(event.time as [number, number]), T0 + 77);
});

/* A tracer whose every call fails, to prove totality. */
function throwingTracer(): Tracer {
  const boom = (): never => {
    throw new Error("sdk exploded");
  };
  return { startSpan: boom, startActiveSpan: boom } as unknown as Tracer;
}

test("every port method is total when the SDK throws, and the callback still runs", async () => {
  const { telemetry } = harness({ tracer: throwingTracer() });
  const span = telemetry.startSpan("x", { attrs: { "qayaba.app": "a" } });
  assert.doesNotThrow(() => {
    span.setAttrs({ "qayaba.verdict": "pass" });
    span.addEvent("e");
    span.recordError(new Error("e"));
    span.end();
    span.context();
    telemetry.activeContext();
    telemetry.counter("qayaba.runs")(1);
    telemetry.histogram("qayaba.run.duration")(1);
  });
  assert.equal(telemetry.withSpan("w", {}, () => 5), 5);
  assert.equal(await telemetry.withSpan("w", {}, async () => 6), 6);
  assert.equal(telemetry.withParent(span, () => 7), 7);
  assert.throws(() => telemetry.withSpan("w", {}, () => { throw new Error("callback's own"); }), /callback's own/);
  assert.ok(telemetry.stats().faults > 0);
});

test("every span method is total when the span itself throws", () => {
  const exploding = new Proxy({}, { get: () => () => { throw new Error("span exploded"); } });
  const tracer = { startSpan: () => exploding, startActiveSpan: () => exploding } as unknown as Tracer;
  const { telemetry } = harness({ tracer });
  const span = telemetry.startSpan("x");
  assert.doesNotThrow(() => {
    span.setAttrs({ "qayaba.app": "a" });
    span.addEvent("e", { "qayaba.app": "a" });
    span.recordError(new Error("e"));
    span.end(T0);
    span.context();
  });
  assert.equal(telemetry.withSpan("w", {}, () => 1), 1);
  assert.ok(telemetry.stats().faults > 0);
});

test("a redaction scope that throws never leaks the unredacted text", () => {
  const { telemetry, byName } = harness();
  const scope = { redact: (): string => { throw new Error("scope broke"); } };
  telemetry.startSpan("leaky", { secrets: scope, attrs: { "qayaba.tool.target": PASSWORD } }).end();
  /* The name fails redaction too, so it is replaced by a placeholder, and the attribute is dropped. */
  assert.equal(byName("unnamed").attributes["qayaba.tool.target"], undefined);
  assert.ok(telemetry.stats().faults > 0);
});

interface Recorded { kind: "counter" | "histogram" | "gauge"; name: string; value: number; attrs: Record<string, unknown> | undefined }
function fakeMeter(recorded: Recorded[]): Meter {
  const make = (kind: Recorded["kind"]) => (name: string) => ({ [kind === "counter" ? "add" : "record"]: (value: number, attrs?: Record<string, unknown>) => recorded.push({ kind, name, value, attrs }) });
  return { createCounter: make("counter"), createHistogram: make("histogram"), createGauge: make("gauge") } as unknown as Meter;
}

test("a declared instrument records with its declared attribute keys only", () => {
  const recorded: Recorded[] = [];
  const { telemetry } = harness({ meter: fakeMeter(recorded) });
  telemetry.counter("qayaba.runs")(1, { "qayaba.app": "shop", "qayaba.verdict": "pass", ...unknownKey("qayaba.run.id", "r1") });
  telemetry.histogram("qayaba.run.duration")(12.5, { "qayaba.app": "shop" });
  assert.deepEqual(recorded[0], { kind: "counter", name: "qayaba.runs", value: 1, attrs: { "qayaba.app": "shop", "qayaba.verdict": "pass" } });
  assert.equal(recorded[1]!.value, 12.5);
  assert.equal(telemetry.stats().droppedAttributes, 1);
});

test("an undeclared instrument, a wrong-type instrument and a non-finite value record nothing", () => {
  const recorded: Recorded[] = [];
  const { telemetry } = harness({ meter: fakeMeter(recorded) });
  telemetry.counter("qayaba.nope")(1);
  telemetry.histogram("qayaba.runs")(1);
  telemetry.counter("qayaba.runs")(Number.NaN);
  telemetry.counter("qayaba.runs")(-1);
  assert.deepEqual(recorded, []);
});

test("a gauge records its latest value and accepts zero; a non-finite value or a gauge name used as another type records nothing", () => {
  const recorded: Recorded[] = [];
  const { telemetry } = harness({ meter: fakeMeter(recorded) });
  telemetry.gauge("qayaba.sandbox.zombies")(0);
  telemetry.gauge("qayaba.sandbox.zombies")(3);
  telemetry.gauge("qayaba.sandbox.zombies")(Number.NaN);
  telemetry.counter("qayaba.sandbox.zombies")(1);
  assert.deepEqual(recorded.map((r) => [r.kind, r.name, r.value]), [["gauge", "qayaba.sandbox.zombies", 0], ["gauge", "qayaba.sandbox.zombies", 3]]);
});

test("without a meter instruments are silent", () => {
  const { telemetry } = harness();
  assert.doesNotThrow(() => telemetry.counter("qayaba.runs")(1));
});

test("flush calls the injected flusher and never throws", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  let flushed = 0;
  const t = new OtelTelemetry({ tracer: provider.getTracer("t"), contextManager: new AsyncLocalStorageContextManager().enable(), clock: new FakeClock(), flush: () => { flushed++; } });
  t.flush();
  assert.equal(flushed, 1);
  const bad = new OtelTelemetry({ tracer: provider.getTracer("t"), contextManager: new AsyncLocalStorageContextManager().enable(), clock: new FakeClock(), flush: () => { throw new Error("x"); } });
  assert.doesNotThrow(() => bad.flush());
});

test("every key the adapter itself emits is registered", () => {
  for (const key of ["exception.type", "exception.message", "error.type"]) assert.ok(lookupAttribute(key), key);
});

test("string attributes of every class, array lengths, span names and event names are capped", () => {
  const { telemetry, byName } = harness({ captureMode: "full" });
  const span = telemetry.startSpan("op ".repeat(200), {
    attrs: { "qayaba.app": "a".repeat(1000), "qayaba.tool.target": "word ".repeat(1000), "qayaba.egress.denied_cotemporal": Array.from({ length: 500 }, (_, i) => `h${i}`) },
  });
  span.addEvent("ev ".repeat(200));
  span.end();
  const s = byName("op ".repeat(200).slice(0, 128));
  assert.equal(String(s.attributes["qayaba.app"]).length, 256);
  assert.equal(String(s.attributes["qayaba.tool.target"]).length, 1024);
  assert.equal((s.attributes["qayaba.egress.denied_cotemporal"] as string[]).length, ARRAY_CAP);
  assert.equal(s.events[0]!.name.length, 128);
});

test("an array key keeps its own cap: item ids export 200 while every other array keeps the default", () => {
  assert.equal(ARRAY_CAP, 64);
  const { telemetry, byName } = harness();
  const span = telemetry.startSpan("caps", {
    attrs: { "qayaba.context.item_ids": Array.from({ length: 300 }, (_, i) => `rule:${i}`), "qayaba.egress.denied_cotemporal": Array.from({ length: 300 }, (_, i) => `h${i}`) },
  });
  span.end();
  const s = byName("caps");
  assert.equal((s.attributes["qayaba.context.item_ids"] as string[]).length, 200);
  assert.equal((s.attributes["qayaba.egress.denied_cotemporal"] as string[]).length, ARRAY_CAP);
});

test("span and event names pass the sanitizer and the bound scope", () => {
  const { telemetry, spans } = harness();
  const span = telemetry.startSpan(`op ${PASSWORD} ops@example.com`, { secrets: seededScope() });
  span.addEvent(`ev ${PASSWORD}`);
  span.end();
  const dump = JSON.stringify(spans().map((s) => ({ n: s.name, e: s.events.map((e) => e.name) })));
  assert.ok(!dump.includes(PASSWORD));
  assert.ok(!dump.includes("ops@example.com"));
});

test("error.type is sanitized and capped", () => {
  const { telemetry, byName } = harness();
  class Weird extends Error {}
  const error = new Weird("m");
  error.name = `Bad ${PASSWORD} ${"x".repeat(500)}`;
  const span = telemetry.startSpan("e", { secrets: seededScope() });
  span.recordError(error);
  span.end();
  const type = String(byName("e").attributes["error.type"]);
  assert.ok(!type.includes(PASSWORD));
  assert.ok(type.length <= 128);
});

test("metric attribute values are capped at 64 characters", () => {
  const recorded: Recorded[] = [];
  const { telemetry } = harness({ meter: fakeMeter(recorded) });
  telemetry.counter("qayaba.runs")(1, { "qayaba.app": "m".repeat(200) });
  assert.equal(String(recorded[0]!.attrs!["qayaba.app"]).length, 64);
});

test("a non-finite time falls back to the clock", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("nan", { startTime: Number.NaN }).end(Number.POSITIVE_INFINITY);
  assert.equal(hrMs(byName("nan").startTime as [number, number]), T0);
  assert.equal(hrMs(byName("nan").endTime as [number, number]), T0);
});

test("a secret in a none-class key is replaced by value through the bound scope", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("none", { secrets: seededScope(), attrs: { "qayaba.app": `app-${PASSWORD}`, "qayaba.egress.denied_cotemporal": [] } }).end();
  assert.ok(!String(byName("none").attributes["qayaba.app"]).includes(PASSWORD));
});

test("a pattern-shaped secret in a none-class key is NOT pattern-sanitized (ids and enums must not be corrupted); only the run's known values are removed", () => {
  const { telemetry, byName } = harness();
  telemetry.startSpan("pat", { secrets: seededScope(), attrs: { "qayaba.app": "owner@example.com" } }).end();
  assert.equal(byName("pat").attributes["qayaba.app"], "owner@example.com");
});

test("with the ledger as a second processor, neither sink holds a seeded secret", () => {
  const exporter = new InMemorySpanExporter();
  const rows: RunSpanRow[] = [];
  const ledger = new LedgerSpanProcessor({ commit: (batch) => { rows.push(...batch); } });
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter), ledger] });
  const telemetry = new OtelTelemetry({ tracer: provider.getTracer("t"), contextManager: new AsyncLocalStorageContextManager().enable(), clock: new FakeClock(), captureMode: "full" });
  const scope = seededScope();
  const leak = `token ${PASSWORD} and ${COOKIE}`;
  const root = telemetry.startSpan(`root ${leak}`, { secrets: scope, attrs: { "qayaba.app": leak, "qayaba.tool.target": leak } });
  root.addEvent(`ev ${leak}`, { "qayaba.tool.target": leak });
  root.recordError(new Error(`failed ${leak}`));
  telemetry.startSpan("child", { parent: root, links: [{ context: root.context(), attrs: { "qayaba.tool.target": leak } }] }).end();
  root.end();
  ledger.flush();
  const dumped = JSON.stringify(rows.map((r) => ({ n: r.name, a: r.attrs, e: r.events, l: r.links, s: r.statusMessage })));
  assert.ok(rows.length >= 2);
  assert.ok(!dumped.includes(PASSWORD), "ledger leaked the password");
  assert.ok(!dumped.includes(COOKIE), "ledger leaked the cookie");
  const exception = JSON.parse(rows.find((r) => r.name.startsWith("root"))!.events).find((e: { name: string }) => e.name === "exception");
  assert.ok(!String(exception.attrs["exception.message"]).includes(PASSWORD));
  assert.ok(!JSON.stringify(exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.events, s.status])).includes(PASSWORD));
});

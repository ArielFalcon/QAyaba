import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter, type SpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { createTelemetry, type BootstrapDeps } from "./bootstrap";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { RunSpanRow } from "../server/persistence/repositories/telemetry.repository";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";

const T0 = 1_760_000_000_000;

function deps(env: Record<string, string | undefined>, extra: Partial<BootstrapDeps> = {}) {
  const commits: RunSpanRow[][] = [];
  const base: BootstrapDeps = {
    env,
    clock: { now: () => T0 },
    store: { commit: (rows) => { commits.push([...rows]); } },
    campaignFreeze: false,
    ...extra,
  };
  return { base, commits };
}

test("off returns the null object, builds nothing and writes no ledger rows", async () => {
  let built = 0;
  const { base, commits } = deps({ QA_TELEMETRY: "off", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1" }, { traceExporterFactory: () => { built++; return new InMemorySpanExporter(); } });
  const handle = createTelemetry(base);
  assert.ok(handle.telemetry instanceof NoopTelemetry);
  handle.telemetry.withSpan("x", {}, () => {});
  handle.telemetry.flush();
  await handle.shutdown(50);
  assert.equal(built, 0);
  assert.deepEqual(commits, []);
  const health = handle.health();
  assert.equal(health.mode, "off");
  assert.equal(health.otlp.configured, false);
  assert.equal(health.ledger.spans, 0);
});

test("OTEL_SDK_DISABLED is honored as off", () => {
  const { base } = deps({ OTEL_SDK_DISABLED: "true" });
  assert.ok(createTelemetry(base).telemetry instanceof NoopTelemetry);
});

test("local without an endpoint writes the ledger only and builds no exporter", async () => {
  let built = 0;
  const { base, commits } = deps({}, { traceExporterFactory: () => { built++; return new InMemorySpanExporter(); } });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("qayaba.run", { attrs: { "qayaba.run.id": "r1" } }, () => {});
  handle.telemetry.flush();
  assert.equal(built, 0);
  const rows = commits.flat();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runId, "r1");
  assert.notEqual(rows[0]!.endNs, null);
  assert.equal(handle.health().otlp.configured, false);
  assert.equal(handle.health().ledger.spans, 1);
  await handle.shutdown(50);
});

test("an endpoint adds one OTLP exporter fed the same spans, with the configured url", async () => {
  const exported: ReadableSpan[] = [];
  const collecting: SpanExporter = {
    export: (spans, cb) => { exported.push(...spans); cb({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  };
  const seen: string[] = [];
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SERVICE_NAME: "svc-x" }, { traceExporterFactory: (url) => { seen.push(url); return collecting; } });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("qayaba.run", {}, () => {});
  await handle.shutdown(1000);
  assert.deepEqual(seen, ["http://collector:4318/v1/traces"]);
  assert.equal(exported.length, 1);
  assert.equal(exported[0]!.resource.attributes["service.name"], "svc-x");
  assert.equal(handle.health().otlp.configured, true);
});

test("a successful export is reported with its time, a failed one counts dropped spans and the error", async () => {
  const failing: SpanExporter = {
    export: (_spans: ReadableSpan[], cb: (r: ExportResult) => void) => cb({ code: ExportResultCode.FAILED, error: new Error("connect ECONNREFUSED http://collector:4318") }),
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, { traceExporterFactory: () => failing });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("a", {}, () => {});
  handle.telemetry.withSpan("b", {}, () => {});
  await handle.shutdown(1000);
  const health = handle.health();
  assert.equal(health.otlp.dropped, 2);
  assert.match(health.otlp.lastError ?? "", /ECONNREFUSED/);
  assert.equal(health.otlp.lastExportAt, undefined);

  const ok = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, { traceExporterFactory: () => new InMemorySpanExporter() });
  const okHandle = createTelemetry(ok.base);
  okHandle.telemetry.withSpan("a", {}, () => {});
  await okHandle.shutdown(1000);
  assert.equal(okHandle.health().otlp.lastExportAt, new Date(T0).toISOString());
  assert.equal(okHandle.health().otlp.dropped, 0);
});

test("an exporter that throws on export is counted and never reaches the caller", async () => {
  const throwing: SpanExporter = { export: () => { throw new Error("sync boom"); }, shutdown: async () => {}, forceFlush: async () => {} };
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1" }, { traceExporterFactory: () => throwing });
  const handle = createTelemetry(base);
  assert.doesNotThrow(() => handle.telemetry.withSpan("a", {}, () => {}));
  await handle.shutdown(1000);
  assert.equal(handle.health().otlp.dropped, 1);
});

/* An exporter whose callback the test holds, standing for a collector that never answers (retrying behind the scenes). */
function silentExporter(): { exporter: SpanExporter; answerLate: () => void } {
  const pending: Array<(r: ExportResult) => void> = [];
  const exporter: SpanExporter = {
    export: (_spans: ReadableSpan[], cb: (r: ExportResult) => void) => { pending.push(cb); },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  return { exporter, answerLate: () => pending.forEach((cb) => cb({ code: ExportResultCode.FAILED, error: new Error("late failure") })) };
}

test("an export the exporter never answers is counted as dropped once the export timeout passes, and only once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { exporter, answerLate } = silentExporter();
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_BSP_EXPORT_TIMEOUT: "4000" }, { traceExporterFactory: () => exporter });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("a", {}, () => {});
  handle.telemetry.withSpan("b", {}, () => {});
  const done = handle.shutdown(60_000);
  await Promise.resolve();
  assert.equal(handle.health().otlp.dropped, 0, "nothing is counted before the timeout");
  t.mock.timers.tick(4000);
  await done;
  assert.equal(handle.health().otlp.dropped, 2);
  assert.equal(handle.health().otlp.lastError, "export timed out after 4000 ms");
  answerLate();
  assert.equal(handle.health().otlp.dropped, 2, "a late answer does not count the batch again");
  assert.equal(handle.health().otlp.lastError, "export timed out after 4000 ms");
});

test("an answer inside the export timeout is not also counted as a timeout", async () => {
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_BSP_EXPORT_TIMEOUT: "4000" }, { traceExporterFactory: () => new InMemorySpanExporter() });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("a", {}, () => {});
  await handle.shutdown(60_000);
  assert.equal(handle.health().otlp.dropped, 0);
  assert.equal(handle.health().otlp.lastError, undefined);
});

test("a collector that never answers does not break the run: the span path completes, the ledger keeps the span and health counts the loss", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { exporter } = silentExporter();
  const { base, commits } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, { traceExporterFactory: () => exporter });
  const handle = createTelemetry(base);
  const outcome = handle.telemetry.withSpan("run", {}, () => "run completed");
  assert.equal(outcome, "run completed");
  const done = handle.shutdown(120_000);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await done;
  const health = handle.health();
  assert.equal(health.otlp.configured, true);
  assert.equal(health.otlp.dropped, 1);
  assert.match(health.otlp.lastError ?? "", /timed out/);
  assert.equal(health.otlp.lastExportAt, undefined);
  assert.equal(commits.flat().length, 1, "the local ledger still holds the span");
});

test("an invalid QA_TELEMETRY stops the composition", () => {
  assert.throws(() => createTelemetry(deps({ QA_TELEMETRY: "verbose" }).base), /QA_TELEMETRY/);
});

test("shutdown with an exporter that never answers resolves within its timeout and never throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hanging: SpanExporter = { export: () => {}, shutdown: () => new Promise<void>(() => {}), forceFlush: () => new Promise<void>(() => {}) };
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1" }, { traceExporterFactory: () => hanging });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("a", {}, () => {});
  let settled = false;
  const done = handle.shutdown(200).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(250);
  await done;
  assert.equal(settled, true);
});

test("shutdown flushes buffered ledger rows even when the exporter hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hanging: SpanExporter = { export: () => {}, shutdown: () => new Promise<void>(() => {}), forceFlush: () => new Promise<void>(() => {}) };
  const { base, commits } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1" }, { traceExporterFactory: () => hanging });
  const handle = createTelemetry(base);
  handle.telemetry.withSpan("a", {}, () => {});
  const done = handle.shutdown(100);
  t.mock.timers.tick(150);
  await done;
  assert.equal(commits.flat().length, 1);
});

test("health reports the campaign freeze it was given and no score sink", () => {
  const handle = createTelemetry(deps({}, { campaignFreeze: true }).base);
  assert.equal(handle.health().campaignFreeze, true);
  assert.deepEqual(handle.health().scoreSink, { configured: false });
});

test("the campaign freeze comes from QA_CAMPAIGN_FREEZE when not injected", () => {
  const { base } = deps({ QA_CAMPAIGN_FREEZE: "1" });
  const { campaignFreeze: _drop, ...rest } = base;
  assert.equal(createTelemetry(rest).health().campaignFreeze, true);
  assert.throws(() => createTelemetry({ ...rest, env: { QA_CAMPAIGN_FREEZE: "maybe" } }), /QA_CAMPAIGN_FREEZE/);
});

test("health counts attributes the registry dropped", () => {
  const handle = createTelemetry(deps({}).base);
  handle.telemetry.startSpan("x", { attrs: { ...({ nope: "v" } as Record<string, string>) } }).end();
  assert.equal(handle.health().droppedAttributes, 1);
});

test("the handle exposes the clock the telemetry was built on, in both modes, so the engine and the runner share it", () => {
  const injected = { now: () => T0 + 5 };
  const { base } = deps({}, { clock: injected });
  assert.equal(createTelemetry(base).clock, injected);
  const off = createTelemetry(deps({ QA_TELEMETRY: "off" }).base);
  assert.equal(typeof off.clock.now(), "number");
});

test("an endpoint configures a log exporter, and the console tap exports a line only inside a span", async () => {
  const exported: ReadableLogRecord[] = [];
  const logExporter: LogRecordExporter = {
    export: (records, cb) => { exported.push(...records); cb({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const seen: string[] = [];
  const { base } = deps({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, {
    traceExporterFactory: () => new InMemorySpanExporter(),
    logExporterFactory: (url) => { seen.push(url); return logExporter; },
    captureConsole: true,
  });
  const handle = createTelemetry(base);
  try {
    console.log("outside a span");
    handle.telemetry.withSpan("run", { captureMode: "metadata" }, () => { console.log("inside a span"); });
  } finally {
    await handle.shutdown(1000);
  }
  assert.deepEqual(seen, ["http://collector:4318/v1/logs"]);
  assert.deepEqual(exported.map((record) => record.body), ["inside a span"]);
  assert.match(exported[0]!.spanContext?.traceId ?? "", /^[0-9a-f]{32}$/);
});

test("the ledger prune hands the campaign retention window to every prune", async () => {
  const { retentionPrune } = await import("./bootstrap");
  const calls: unknown[][] = [];
  retentionPrune({ retentionDays: 30, campaignRetentionDays: 180 }, {
    pruneRunSpans: (...a: unknown[]) => { calls.push(["spans", ...a]); return 0; },
    pruneSpecSnapshots: (...a: unknown[]) => { calls.push(["snapshots", ...a]); return 0; },
    pruneRunPlans: (...a: unknown[]) => { calls.push(["plans", ...a]); return 0; },
  } as never)(1234);
  assert.deepEqual(calls, [["spans", 30, 1234, undefined, 180], ["snapshots", 30, 1234, undefined, 180], ["plans", 30, 1234, undefined, 180]]);
});

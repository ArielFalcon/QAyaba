import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { createRedactingLogger, installLogShipper } from "../integrations/redacting-logger";
import { createLogShipper, LOG_BODY_CAP_CHARS } from "./log-shipper";
import { traceHarness } from "./trace-harness";
import type { CaptureMode } from "./otel-telemetry.adapter";

afterEach(() => installLogShipper(undefined));

interface Rig {
  readonly records: LogRecord[];
  readonly telemetry: ReturnType<typeof traceHarness>["telemetry"];
  readonly log: ReturnType<typeof createRedactingLogger>;
  readonly lines: string[];
}

function rig(options: { captureMode?: CaptureMode; redact?: (text: string) => string } = {}): Rig {
  const h = traceHarness(options.captureMode ? { captureMode: options.captureMode } : {});
  const records: LogRecord[] = [];
  const lines: string[] = [];
  installLogShipper(
    createLogShipper({
      logger: { emit: (record) => records.push(record) },
      target: () => h.telemetry.logTarget(),
      processMode: () => h.telemetry.processCaptureMode,
      redact: (context, text, cap) => h.telemetry.redactIn(context, text, cap),
    }),
  );
  const log = createRedactingLogger({ sink: (_level, message) => lines.push(message), redactor: () => ({ redact: options.redact ?? ((text: string) => text) }) });
  return { records, telemetry: h.telemetry, log, lines };
}

const traceIdOf = (record: LogRecord): string | undefined => (record.context ? trace.getSpanContext(record.context)?.traceId : undefined);

test("a warning written inside a run but outside any ambient span is exported with the run's trace id", () => {
  const { records, telemetry, log } = rig({ captureMode: "metadata" });
  const root = telemetry.startSpan("qayaba.run", { root: true, captureMode: "metadata" });
  log.warn("[qa] WARNING: the capture degraded", { route: "/a" });
  root.end();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.severityText, "WARN");
  assert.match(String(records[0]!.body), /the capture degraded/);
  assert.equal(traceIdOf(records[0]!), root.context().traceId);
});

test("an info line is not exported unless its call site says it explains how something went", () => {
  const { records, telemetry, log, lines } = rig({ captureMode: "metadata" });
  const root = telemetry.startSpan("qayaba.run", { root: true });
  log.info("[qa] enqueued app@sha");
  log.info("[qa] a fallback was taken", { ship: true });
  log.warn("[qa] restates a span fact", { ship: false });
  root.end();
  assert.deepEqual(records.map((record) => record.severityText), ["INFO"]);
  assert.match(String(records[0]!.body), /a fallback was taken/);
  assert.doesNotMatch(String(records[0]!.body), /ship/);
  /* The console and file view keeps every line. */
  assert.equal(lines.length, 3);
});

test("a line that fails redaction is dropped from the store and from the file", () => {
  const { records, telemetry, log, lines } = rig({
    captureMode: "metadata",
    redact: () => {
      throw new Error("boom");
    },
  });
  const root = telemetry.startSpan("qayaba.run", { root: true });
  log.warn("secret hunter2");
  root.end();
  assert.equal(records.length, 0);
  assert.deepEqual(lines, ["[logger] redaction failed; a log line was dropped"]);
});

test("the capture mode caps the body and off exports nothing", () => {
  const long = "word ".repeat(2000);
  for (const [mode, expected] of [["metadata", LOG_BODY_CAP_CHARS.metadata], ["full", LOG_BODY_CAP_CHARS.full], ["off", 0]] as const) {
    const { records, telemetry, log } = rig({ captureMode: mode });
    const root = telemetry.startSpan("qayaba.run", { root: true });
    log.warn(long);
    root.end();
    assert.equal(records.length, mode === "off" ? 0 : 1, mode);
    if (expected > 0) assert.equal(String(records[0]!.body).length, expected, mode);
  }
});

test("a warning with no run is exported without a trace, and a shipper fault never reaches the caller", () => {
  const { records, log } = rig({ captureMode: "metadata" });
  log.warn("at boot");
  assert.equal(records.length, 1);
  assert.equal(traceIdOf(records[0]!), undefined);
  installLogShipper(() => {
    throw new Error("exporter down");
  });
  assert.doesNotThrow(() => log.error("still logged"));
});

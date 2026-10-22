import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";
import { installConsoleLogTap, LOG_BODY_CAP_CHARS } from "./console-log-tap";
import type { CaptureMode } from "./otel-telemetry.adapter";

interface TapOptions {
  readonly mode?: CaptureMode;
  readonly redact?: (text: string, cap: number) => string | undefined;
  readonly emit?: (record: LogRecord) => void;
}

function tap(options: TapOptions = {}): { records: LogRecord[]; uninstall: () => void } {
  const records: LogRecord[] = [];
  const uninstall = installConsoleLogTap({
    logger: { emit: (record) => (options.emit ?? ((r) => records.push(r)))(record) },
    activeSpan: () => {
      const mode = "mode" in options ? options.mode : "metadata";
      return mode === undefined ? undefined : { mode, context: {} as Context };
    },
    redact: options.redact ?? ((text, cap) => text.slice(0, cap)),
    format: (...args) => args.map(String).join(" "),
  });
  return { records, uninstall };
}

test("a console line is exported with its severity only while a span is active", () => {
  const outside = tap({ mode: undefined });
  try {
    console.log("outside a span");
    assert.equal(outside.records.length, 0);
  } finally {
    outside.uninstall();
  }

  const inside = tap();
  try {
    console.log("hello", 1);
    console.warn("careful");
    console.error("broken");
    assert.deepEqual(inside.records.map((record) => [record.severityText, record.body]), [["INFO", "hello 1"], ["WARN", "careful"], ["ERROR", "broken"]]);
    assert.ok(inside.records.every((record) => record.timestamp instanceof Date));
  } finally {
    inside.uninstall();
  }
});

test("the capture mode caps the body and off exports nothing", () => {
  const long = "x".repeat(5000);
  const cases: Array<[CaptureMode, number]> = [["metadata", LOG_BODY_CAP_CHARS.metadata], ["full", LOG_BODY_CAP_CHARS.full], ["off", 0]];
  for (const [mode, expected] of cases) {
    const { records, uninstall } = tap({ mode });
    try {
      console.log(long);
      assert.equal(records.length, mode === "off" ? 0 : 1, mode);
      if (expected > 0) assert.equal(String(records[0]!.body).length, expected, mode);
    } finally {
      uninstall();
    }
  }
});

test("a line whose redaction fails is not exported", () => {
  const { records, uninstall } = tap({ redact: () => undefined });
  try {
    console.error("secret that could not be redacted");
    assert.equal(records.length, 0);
  } finally {
    uninstall();
  }
});

test("a failing logger never breaks the caller", () => {
  const { uninstall } = tap({ emit: () => { throw new Error("exporter down"); } });
  try {
    assert.doesNotThrow(() => console.log("still prints"));
  } finally {
    uninstall();
  }
});

test("a console line the logger itself prints is not exported again", () => {
  const seen: string[] = [];
  const { uninstall } = tap({
    emit: (record) => {
      seen.push(String(record.body));
      console.error("inside the exporter");
    },
  });
  try {
    console.log("outer");
    assert.deepEqual(seen, ["outer"]);
  } finally {
    uninstall();
  }
});

test("uninstall restores the original console methods", () => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const { uninstall } = tap();
  assert.notEqual(console.log, original.log);
  uninstall();
  assert.equal(console.log, original.log);
  assert.equal(console.warn, original.warn);
  assert.equal(console.error, original.error);
});

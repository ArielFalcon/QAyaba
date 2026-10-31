/* Each kind of dump a harvest handled is a span of its own under the open phase, with what it was given and how it ended. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harvestSpanObserver } from "@contexts/test-execution/infrastructure/harvest-spans.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { lookupAttribute } from "@kernel/telemetry/attribute-registry.ts";

class Recorder extends NoopTelemetry {
  readonly spans: Array<{ name: string; opts?: StartSpanOptions; ended?: number }> = [];
  override startSpan(name = "", opts?: StartSpanOptions): SpanHandle {
    const entry: { name: string; opts?: StartSpanOptions; ended?: number } = { name, ...(opts ? { opts } : {}) };
    this.spans.push(entry);
    return { setAttrs: () => {}, addEvent: () => {}, recordError: () => {}, end: (t) => { if (t !== undefined) entry.ended = t; }, context: () => ({ traceId: "t", spanId: "s" }) };
  }
}

test("a harvest is a span from when it began for as long as it took, with the files, bytes, worker times and outcome, all registered", () => {
  const telemetry = new Recorder();
  harvestSpanObserver(telemetry)({ kind: "coverage", namespace: "run-7", startedAt: 5_000, durationMs: 2_400.4, dumps: 9, bytes: 123_456, outcome: "aborted", startMs: 1_800.2, workMs: 10_000 });

  const span = telemetry.spans[0]!;
  assert.equal(span.name, "qayaba.dumps.harvest");
  assert.equal(span.opts?.startTime, 5_000);
  assert.equal(span.ended, 7_400);
  assert.deepEqual(span.opts?.attrs, { "qayaba.dumps.kind": "coverage", "qayaba.dumps.namespace": "run-7", "qayaba.dumps.count": 9, "qayaba.dumps.bytes": 123_456, "qayaba.dumps.outcome": "aborted", "qayaba.dumps.start_ms": 1_800, "qayaba.dumps.work_ms": 10_000 });
  for (const key of Object.keys(span.opts?.attrs ?? {})) assert.ok(lookupAttribute(key), `${key} is registered, or the exporter drops it`);
});

test("a kind rebuilt in place has no worker times", () => {
  const telemetry = new Recorder();
  harvestSpanObserver(telemetry)({ kind: "fault-injection", namespace: "run-7", startedAt: 1, durationMs: 3, dumps: 0, bytes: 0, outcome: "absent" });
  assert.deepEqual(Object.keys(telemetry.spans[0]!.opts?.attrs ?? {}).sort(), ["qayaba.dumps.bytes", "qayaba.dumps.count", "qayaba.dumps.kind", "qayaba.dumps.namespace", "qayaba.dumps.outcome"]);
});

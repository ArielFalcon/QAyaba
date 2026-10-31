/* Every read of dumps a measurement made is a span under the measurement's own, with what it read and how it ended; a measurement that stands without evidence says so on its span. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TracedObjectiveSignalPort } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-trace.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/ports/objective-signal.port.ts";
import type { CoverageRead } from "@contexts/objective-signal/domain/coverage-collector.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { lookupAttribute } from "@kernel/telemetry/attribute-registry.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

interface Started { name: string; opts?: StartSpanOptions; handle: SpanHandle; attrs: Record<string, unknown>; ended?: number | "now" }

class Recorder extends NoopTelemetry {
  readonly spans: Started[] = [];
  override startSpan(name = "", opts?: StartSpanOptions): SpanHandle {
    const entry: Started = { name, opts, attrs: { ...(opts?.attrs ?? {}) }, handle: undefined as unknown as SpanHandle };
    entry.handle = { setAttrs: (a) => Object.assign(entry.attrs, a), addEvent: () => {}, recordError: () => {}, end: (t) => { entry.ended = t ?? "now"; }, context: () => ({ traceId: "t", spanId: `s${this.spans.length}` }) };
    this.spans.push(entry);
    return entry.handle;
  }
}

const READ: CoverageRead = { namespace: "run-7", startedAt: 1_000, durationMs: 250, dumps: 12, bytes: 4_096, outcome: "aborted", startMs: 1_900, workMs: 10_000 };
const br = BlastRadius.of(Sha.of("abc1234"), []);

test("a read is a span from when it began for as long as it took, under the measurement's span, with the dumps, bytes, time and outcome", async () => {
  const inner: ObjectiveSignalPort = {
    measure: async (_br, _dir, _diff, _cases, opts) => (opts?.onRead?.(READ), { status: "unknown", ratio: null, measurement: { changedLines: 2, coveredChanged: 0, changedFiles: 1, mappedFiles: 0, unmeasured: "decode-aborted" } }),
    blocks: () => false,
  };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(br, "/e2e");

  const measure = telemetry.spans.find((s) => s.name === "qayaba.coverage.measure")!;
  const decode = telemetry.spans.find((s) => s.name === "qayaba.coverage.decode")!;
  assert.equal(decode.opts?.parent, measure.handle);
  assert.equal(decode.opts?.startTime, 1_000);
  assert.equal(decode.ended, 1_250);
  assert.deepEqual(
    [decode.attrs["qayaba.dumps.namespace"], decode.attrs["qayaba.dumps.count"], decode.attrs["qayaba.dumps.bytes"], decode.attrs["qayaba.dumps.outcome"], decode.attrs["qayaba.dumps.start_ms"], decode.attrs["qayaba.dumps.work_ms"]],
    ["run-7", 12, 4_096, "aborted", 1_900, 10_000],
  );
  for (const key of Object.keys(decode.attrs)) assert.ok(lookupAttribute(key), `${key} is registered, or the exporter drops it`);
  assert.equal(measure.attrs["qayaba.coverage.unmeasured"], "decode-aborted");
});

test("a recount tells its reads the same way, under its own span", async () => {
  const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 1 }), blocks: () => false, recount: async (_br, _dir, _diff, _reruns, opts) => (opts?.onRead?.(READ), null) };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).recount!(br, "/e2e", undefined, []);

  const recount = telemetry.spans.find((s) => s.name === "qayaba.coverage.recount")!;
  assert.equal(telemetry.spans.find((s) => s.name === "qayaba.coverage.decode")?.opts?.parent, recount.handle);
});

test("a measurement that stands without the evidence of a read says which way the read ended", async () => {
  const inner: ObjectiveSignalPort = { measure: async () => ({ status: "pass", ratio: 0.5, measurement: { changedLines: 2, coveredChanged: 1, changedFiles: 1, mappedFiles: 1, evidenceLeftOut: ["decode-aborted", "dumps-over-cap"] } }), blocks: () => false };
  const telemetry = new Recorder();
  await new TracedObjectiveSignalPort(inner, telemetry).measure(br, "/e2e");

  const attrs = telemetry.spans.find((s) => s.name === "qayaba.coverage.measure")!.attrs;
  assert.deepEqual(attrs["qayaba.coverage.evidence_left_out"], ["decode-aborted", "dumps-over-cap"]);
  assert.ok(lookupAttribute("qayaba.coverage.evidence_left_out"));
});

test("an observer's span that cannot be made changes nothing about the measurement", async () => {
  const inner: ObjectiveSignalPort = { measure: async (_b, _d, _f, _c, opts) => (opts?.onRead?.(READ), { status: "pass", ratio: 1 }), blocks: () => false };
  const telemetry = new Recorder();
  const original = telemetry.startSpan.bind(telemetry);
  telemetry.startSpan = (name, opts) => { if (name === "qayaba.coverage.decode") throw new Error("exporter down"); return original(name, opts); };

  const result = await new TracedObjectiveSignalPort(inner, telemetry).measure(br, "/e2e");
  assert.equal(result.status, "pass");
});

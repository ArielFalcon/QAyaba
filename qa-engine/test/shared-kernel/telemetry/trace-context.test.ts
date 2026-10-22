import { test } from "node:test";
import assert from "node:assert/strict";
import { traceparentOf } from "@kernel/telemetry/trace-context.ts";

test("a real span is a version 00 sampled traceparent of its trace and span ids", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  assert.equal(traceparentOf({ traceId, spanId }), `00-${traceId}-${spanId}-01`);
});

test("a context that is not a real span names no trace", () => {
  assert.equal(traceparentOf({ traceId: "0".repeat(32), spanId: "0".repeat(16) }), undefined);
  assert.equal(traceparentOf({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "0".repeat(16) }), undefined);
  assert.equal(traceparentOf({ traceId: "short", spanId: "00f067aa0ba902b7" }), undefined);
  assert.equal(traceparentOf({ traceId: "4BF92F3577B34DA6A3CE929D0E0E4736", spanId: "00f067aa0ba902b7" }), undefined);
});

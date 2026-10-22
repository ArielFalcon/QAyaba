import { test } from "node:test";
import assert from "node:assert/strict";
import { guardTelemetry, ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry.ts";

test("a port that throws on every method still lets the callback run and return its value", () => {
  const port = guardTelemetry(new ThrowingTelemetry());
  assert.equal(port.withSpan("x", {}, () => 7), 7);
  assert.equal(port.withParent({ traceId: "a", spanId: "b" }, () => "ran"), "ran");
});

test("a span handle from a throwing port accepts every call and hands back a context", () => {
  const port = guardTelemetry(new ThrowingTelemetry());
  const span = port.startSpan("x", { attrs: { "qayaba.app": "demo" } });
  span.setAttrs({ "qayaba.app": "demo" });
  span.addEvent("e");
  span.recordError(new Error("boom"));
  span.end();
  assert.equal(typeof span.context().traceId, "string");
  port.flush();
  port.counter("qayaba.runs")(1);
  port.histogram("qayaba.run.duration")(1);
  port.gauge("qayaba.sandbox.zombies")(1);
  assert.equal(port.activeContext(), undefined);
});

test("the callback's own exception still propagates through a guarded withSpan", () => {
  const port = guardTelemetry(new ThrowingTelemetry());
  assert.throws(() => port.withSpan("x", {}, () => { throw new Error("mine"); }), /mine/);
});

test("a guarded port is the same object when guarded twice", () => {
  const port = guardTelemetry(new ThrowingTelemetry());
  assert.equal(guardTelemetry(port), port);
});

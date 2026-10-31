import { test } from "node:test";
import assert from "node:assert/strict";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";

test("the null object runs the callback, returns its result and records nothing", async () => {
  const t = new NoopTelemetry();
  assert.equal(t.withSpan("x", {}, () => 7), 7);
  assert.equal(await t.withSpan("x", {}, async () => 8), 8);
  assert.equal(t.withParent(t.startSpan("p"), () => 9), 9);
  assert.equal(t.activeContext(), undefined);
  assert.doesNotThrow(() => t.flush());
});

test("the null object lets the callback's own exception through", () => {
  assert.throws(() => new NoopTelemetry().withSpan("x", {}, () => { throw new Error("boom"); }), /boom/);
});

test("the null object's handles and instruments accept every call", () => {
  const t = new NoopTelemetry();
  const span = t.startSpan("x", { attrs: { "qayaba.app": "a" } });
  span.setAttrs({ "qayaba.verdict": "pass" });
  span.addEvent("e");
  span.recordError(new Error("e"));
  span.end();
  t.counter("qayaba.runs")(1);
  t.histogram("qayaba.run.duration")(1);
  t.gauge("qayaba.sandbox.zombies")(1);
  assert.ok(span.context());
});

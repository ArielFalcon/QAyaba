import { test } from "node:test";
import assert from "node:assert/strict";
import { processTelemetry, resetProcessTelemetryForTests } from "./process-telemetry";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";

test("the process builds its telemetry once and hands every caller the same handle", () => {
  resetProcessTelemetryForTests();
  const env = { QA_TELEMETRY: "off" };
  const first = processTelemetry(env);
  const second = processTelemetry({ QA_TELEMETRY: "local" });
  assert.equal(first, second);
  assert.ok(first.telemetry instanceof NoopTelemetry);
  resetProcessTelemetryForTests();
});

test("a mistyped QA_TELEMETRY stops the process composition", () => {
  resetProcessTelemetryForTests();
  assert.throws(() => processTelemetry({ QA_TELEMETRY: "loud" }), /QA_TELEMETRY/);
  resetProcessTelemetryForTests();
});

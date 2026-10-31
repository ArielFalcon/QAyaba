import { test } from "node:test";
import assert from "node:assert/strict";
import { deployGateTiming } from "@contexts/run-orchestration/domain/deploy-gate-timing.ts";

test("the app's own gate polls every 2 s for 60 s unless its dev block sets either", () => {
  assert.deepEqual(deployGateTiming({}, "app"), { intervalMs: 2000, timeoutMs: 60_000 });
  assert.deepEqual(deployGateTiming({ pollIntervalMs: 500 }, "app"), { intervalMs: 500, timeoutMs: 60_000 });
  assert.deepEqual(deployGateTiming({ deployTimeoutMs: 5000, pollIntervalMs: 500 }, "app"), { intervalMs: 500, timeoutMs: 5000 });
});

test("a service's gate polls every 10 s for 10 min unless the service sets either", () => {
  assert.deepEqual(deployGateTiming({}, "service"), { intervalMs: 10_000, timeoutMs: 600_000 });
  assert.deepEqual(deployGateTiming({ pollIntervalMs: 1500 }, "service"), { intervalMs: 1500, timeoutMs: 600_000 });
  assert.deepEqual(deployGateTiming({ deployTimeoutMs: 30_000 }, "service"), { intervalMs: 10_000, timeoutMs: 30_000 });
});

/* test/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.test.ts
   The gate's health wait and its no-source twin, over an injected reader so the test needs no real network. The served-version decision has its own file (deploy-gate-served-version.test.ts).
   NullDeployGateAdapter always resolves ready immediately, for apps that declare no version source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployGatePortAdapter, NullDeployGateAdapter } from "@contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts";
import type { ServedVersionRead } from "@kernel/served-version.ts";
import { isOk } from "@kernel/result.ts";

test("waitUntilHealthy() resolves ok(true) once the reader reports DEV healthy", async () => {
  let calls = 0;
  const reader = { read: async (): Promise<ServedVersionRead> => ({ kind: "read", commit: "abc1234", healthy: ++calls >= 2 }) }; /* not yet on the first read, healthy on the second */
  const adapter = new DeployGatePortAdapter(reader, undefined, { versionUrl: "https://dev.example.com/version", intervalMs: 0, timeoutMs: 5000 });

  const result = await adapter.waitUntilHealthy();

  assert.ok(isOk(result));
  assert.ok(calls >= 2, "must read until healthy, not just once");
});

test("waitUntilHealthy() resolves an InfraError when the timeout elapses before DEV reports healthy", async () => {
  const reader = { read: async (): Promise<ServedVersionRead> => ({ kind: "read", commit: "abc1234", healthy: false }) };
  const adapter = new DeployGatePortAdapter(reader, undefined, { versionUrl: "https://dev.example.com/version", intervalMs: 0, timeoutMs: 20 });

  const result = await adapter.waitUntilHealthy();

  assert.ok(!isOk(result));
});

test("NullDeployGateAdapter.waitUntilHealthy() resolves ok(true) IMMEDIATELY — no source declared", async () => {
  const result = await new NullDeployGateAdapter().waitUntilHealthy();

  assert.ok(isOk(result));
});

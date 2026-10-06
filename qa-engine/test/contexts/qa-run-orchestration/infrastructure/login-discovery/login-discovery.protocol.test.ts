import { test } from "node:test";
import assert from "node:assert/strict";
import { FORM_STATE } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { createDiscoverLogin } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner.ts";
import { SUBMITTED_MARKER } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import type { SandboxedBinaryRunner } from "../../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { STUB_PASS, loginForm, loginRequest, runLoginDiscovery, stayingSite, type DiscoveryRun } from "../../../../support/login-discovery-harness.ts";

/* The real parser, fed what the real script printed under real node. */
async function parsedFrom(run: DiscoveryRun) {
  const runner: SandboxedBinaryRunner = { run: async () => ({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, timedOut: false }) };
  return createDiscoverLogin({ runner, log: () => {} })({
    specDir: "/mirror/e2e",
    baseUrl: "https://app.stub.test",
    routes: [],
    storageStatePath: "/mirror/e2e/state.json",
    env: { DEV_TEST_PASS: STUB_PASS },
  });
}

test("the evidence line the real script prints is the evidence the real parser returns", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest()] }) });
  const result = await parsedFrom(run);
  assert.ok(!("crashed" in result), "the parser trusted the script's evidence");
  assert.equal(result.form, FORM_STATE.FOUND);
  assert.equal(result.submitted, true);
  assert.equal(result.requests[0]?.status, 401);
});

test("a script that submitted and then died is read by the parser as a crash after an attempt", async () => {
  const run = await runLoginDiscovery({ site: stayingSite(), env: { STUB_PRESS_ERROR: "press failed" } });
  assert.deepEqual(run.markers, [SUBMITTED_MARKER]);
  assert.deepEqual(await parsedFrom(run), { crashed: true, attempted: true });
});

test("a script that died before it submitted is read by the parser as a crash before any attempt", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm() } }, env: { STUB_LAUNCH_ERROR: "browser did not start" } });
  assert.deepEqual(run.markers, []);
  assert.deepEqual(await parsedFrom(run), { crashed: true, attempted: false });
});

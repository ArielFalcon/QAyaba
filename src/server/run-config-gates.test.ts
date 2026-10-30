import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../orchestrator/config-loader";
import { agentBrowserEnabled, closedLoopEnabled, serviceTopologyWired } from "./run-config-gates";
import { resolveRunConfig, type RunConfigEnvironment } from "./effective-config";

const app = (over: Record<string, unknown> = {}, qa: Record<string, unknown> = {}): AppConfig =>
  ({ name: "a", repo: "o/a", dev: { baseUrl: "https://dev" }, qa: { needsReview: true, testDataPrefix: "qa", ...qa }, report: { onFailure: "x" }, ...over }) as AppConfig;
const env: RunConfigEnvironment = { runtime: () => null, staticPromptHash: () => null, toolsGranted: true, campaignFrozen: false, maxCapture: "metadata" };

test("the run_spec loop and the authenticated browser are on for every app unless the app turns them off", () => {
  assert.equal(closedLoopEnabled(app()), true);
  assert.equal(agentBrowserEnabled(app()), true);
  assert.equal(closedLoopEnabled(app({}, { closedLoop: { maxCalls: 4 } })), true);
  assert.equal(agentBrowserEnabled(app({}, { agentBrowser: { denyRoutes: ["/admin/**"] } })), true);
  assert.equal(closedLoopEnabled(app({}, { closedLoop: { enabled: false } })), false);
  assert.equal(agentBrowserEnabled(app({}, { agentBrowser: { enabled: false } })), false);
  const silent = resolveRunConfig(app(), {}, "metadata", env).levers;
  assert.deepEqual([silent.closedLoop, silent.agentBrowser], [true, true]);
  const optedOut = resolveRunConfig(app({}, { closedLoop: { enabled: false }, agentBrowser: { enabled: false } }), {}, "metadata", env).levers;
  assert.deepEqual([optedOut.closedLoop, optedOut.agentBrowser], [false, false]);
});

test("the service topology is wired only with services and boundaries", () => {
  const wired = { services: [{ repo: "o/s" }], boundaries: [{}] };
  assert.equal(serviceTopologyWired(app(wired)), true);
  assert.equal(serviceTopologyWired(app({ services: wired.services })), false);
  assert.equal(serviceTopologyWired(app({ boundaries: wired.boundaries })), false);
});

test("effectiveConfig reports exactly what the predicates wire, for every combination", () => {
  for (const boundaries of [true, false]) {
    const a = app({ services: [{ repo: "o/s" }], ...(boundaries ? { boundaries: [{}] } : {}) });
    const c = resolveRunConfig(a, { closedLoop: true, agentBrowser: true }, "metadata", env);
    assert.equal(c.grounding.stitcher !== null, serviceTopologyWired(a));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBrowserEnabled, closedLoopEnabled, serviceTopologyWired } from "@contexts/run-orchestration/domain/run-config-gates.ts";

const app = (qa: Record<string, unknown> = {}) => ({ qa });

test("the run_spec loop and the authenticated browser are on for every app unless the app turns them off", () => {
  assert.equal(closedLoopEnabled(app()), true);
  assert.equal(agentBrowserEnabled(app()), true);
  assert.equal(closedLoopEnabled(app({ closedLoop: { maxCalls: 4 } })), true);
  assert.equal(agentBrowserEnabled(app({ agentBrowser: { denyRoutes: ["/admin/**"] } })), true);
  assert.equal(closedLoopEnabled(app({ closedLoop: { enabled: false } })), false);
  assert.equal(agentBrowserEnabled(app({ agentBrowser: { enabled: false } })), false);
});

test("the service topology is wired only with services and boundaries", () => {
  const wired = { services: [{ repo: "o/s" }], boundaries: [{}] };
  assert.equal(serviceTopologyWired(wired), true);
  assert.equal(serviceTopologyWired({ services: wired.services }), false);
  assert.equal(serviceTopologyWired({ boundaries: wired.boundaries }), false);
  assert.equal(serviceTopologyWired({ services: [], boundaries: [{}] }), false);
  assert.equal(serviceTopologyWired({}), false);
});

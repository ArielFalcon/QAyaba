/* The run's composition records whether the reviewer runs the generator's own model, read from the live runtime assignment of THAT run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompositionConfig, type RunEngineFactoryDeps } from "./run-engine-factory";
import type { AgentDeps } from "../integrations/opencode-client";
import type { AgentFacade, RoleAssignment } from "../agent-runtime/types";
import type { AppConfig } from "../orchestrator/config-loader";

const APP: AppConfig = {
  name: "independence-app",
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
};

const unusableAgentDeps = (): AgentDeps => ({ open: async () => { throw new Error("no agent session in this test"); } });

function facadeWith(primary: RoleAssignment, reviewer: RoleAssignment): AgentFacade {
  return {
    config: { assignments: { primary, reviewer, chat: primary } },
    deps: unusableAgentDeps,
    getStatus: async () => ({ providers: [] }),
    listModels: async () => [],
    stepLimits: async () => ({}),
  };
}

function compose(getAgentFacade?: RunEngineFactoryDeps["getAgentFacade"]) {
  return buildCompositionConfig(APP, { getAgentDeps: unusableAgentDeps, ...(getAgentFacade ? { getAgentFacade } : {}) }, "qa-bot-abc1234-run1", { mode: "diff" });
}

const A: RoleAssignment = { provider: "opencode", model: "provider/model-a" };
const B: RoleAssignment = { provider: "opencode", model: "provider/model-b" };

test("a run whose reviewer is assigned the generator's model records shared-model", () => {
  assert.equal(compose(() => facadeWith(A, { ...A })).reviewerIndependence?.(), "shared-model");
});

test("a run whose reviewer is assigned another model records distinct-model", () => {
  assert.equal(compose(() => facadeWith(A, B)).reviewerIndependence?.(), "distinct-model");
});

test("the assignment is read per run, so a reconfiguration between two runs shows in the second", () => {
  let live = facadeWith(A, { ...A });
  const getAgentFacade = () => live;
  assert.equal(compose(getAgentFacade).reviewerIndependence?.(), "shared-model");
  live = facadeWith(A, B);
  assert.equal(compose(getAgentFacade).reviewerIndependence?.(), "distinct-model");
});

test("a host with no runtime facade records nothing", () => {
  assert.equal("reviewerIndependence" in compose(), false);
});

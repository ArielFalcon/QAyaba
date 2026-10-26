import { test } from "node:test";
import assert from "node:assert/strict";
import { GeolocationRegistry, type LiveGeolocation } from "@contexts/agent-tools/infrastructure/geolocation-registry.ts";
import { RunGeolocation } from "@contexts/agent-tools/domain/run-geolocation.ts";

const MADRID = { latitude: 40.4168, longitude: -3.7038 };
const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };

function live(runId = "run-1"): LiveGeolocation {
  const state = new RunGeolocation({ default: MADRID, places: { barcelona: BARCELONA } });
  return { runId, state, set: (delegationId, change) => state.set(delegationId, change) };
}

test("a sidekick's session moves only its own flow's location, never the run's", () => {
  const registry = new GeolocationRegistry();
  const run = live();
  run.state.openFlow("run-1-flow-a");
  registry.register(run);
  registry.bindSession({ sessionId: "ses-flow", runId: "run-1", agent: "qa-sidekick", delegationId: "run-1-flow-a" });

  const flow = registry.find("ses-flow");
  assert.equal(flow?.delegationId, "run-1-flow-a");
  assert.equal(flow?.agent, "qa-sidekick");

  flow!.live.set(flow!.delegationId, { latitude: 0, longitude: 0 });
  assert.deepEqual(run.state.currentFor("run-1-flow-a"), { latitude: 0, longitude: 0 });
  assert.deepEqual(run.state.facts().current, MADRID);
});

test("a role that does not author, a sidekick with no flow, the run-level generator, a generator naming a flow, and a run with no location are not bound", () => {
  const registry = new GeolocationRegistry();
  registry.register(live());
  registry.bindSession({ sessionId: "ses-reviewer", runId: "run-1", agent: "qa-reviewer" });
  registry.bindSession({ sessionId: "ses-sidekick", runId: "run-1", agent: "qa-sidekick" });
  registry.bindSession({ sessionId: "ses-odd", runId: "run-1", agent: "qa-generator", delegationId: "run-1-flow-a" });
  registry.bindSession({ sessionId: "ses-lead", runId: "run-1", agent: "qa-generator" });
  registry.bindSession({ sessionId: "ses-other-run", runId: "run-2", agent: "qa-sidekick", delegationId: "run-2-flow-a" });
  assert.equal(registry.find("ses-lead"), undefined);
  assert.equal(registry.find("ses-reviewer"), undefined);
  assert.equal(registry.find("ses-sidekick"), undefined);
  assert.equal(registry.find("ses-odd"), undefined);
  assert.equal(registry.find("ses-other-run"), undefined);
});

test("unbinding a session and unregistering the run forget the right", () => {
  const registry = new GeolocationRegistry();
  registry.register(live());
  registry.bindSession({ sessionId: "ses-flow", runId: "run-1", agent: "qa-sidekick", delegationId: "run-1-flow-a" });
  assert.ok(registry.find("ses-flow"));
  registry.unbindSession("ses-flow");
  assert.equal(registry.find("ses-flow"), undefined);

  registry.bindSession({ sessionId: "ses-flow-2", runId: "run-1", agent: "qa-sidekick", delegationId: "run-1-flow-a" });
  registry.unregister("run-1");
  assert.equal(registry.find("ses-flow-2"), undefined);
  assert.equal(registry.size, 0);
});

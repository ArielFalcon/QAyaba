import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosedLoopRegistry, type LiveLoop } from "@contexts/agent-tools/infrastructure/closed-loop-registry.ts";
import { RUN_SPEC_AGENT, RUN_SPEC_FLOW_AGENT, RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability.ts";

const LIMITS = { maxCalls: 4, perCallMs: 60_000, maxDevWrites: 4 };

function loop(runId: string, delegationId?: string): { loop: LiveLoop; cancelled: string[] } {
  const cancelled: string[] = [];
  const capability = new RunSpecCapability({
    runId,
    limits: LIMITS,
    expiresAtMs: 1_000_000,
    now: () => 0,
    ...(delegationId !== undefined ? { agents: new Set([RUN_SPEC_FLOW_AGENT]) } : {}),
  });
  return {
    loop: { runId, ...(delegationId !== undefined ? { delegationId } : {}), capability, call: async () => ({ ok: true, report: { status: "passed", tests: [], passedTests: 0, budget: { callsLeft: 1, msLeft: undefined, devWritesLeft: 1 } } }), cancel: (id) => void cancelled.push(id) },
    cancelled,
  };
}

test("no session of the run itself is given the run's loop: an author with no flow has no run_spec", () => {
  const registry = new ClosedLoopRegistry();
  registry.register(loop("r1").loop);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: RUN_SPEC_AGENT });
  registry.bindSession({ sessionId: "author", runId: "r1", agent: RUN_SPEC_FLOW_AGENT });
  assert.equal(registry.find("gen"), undefined);
  assert.equal(registry.find("author"), undefined);
});

test("a sidekick's session finds the loop of its own flow, and neither the run's loop nor a sibling's", () => {
  const registry = new ClosedLoopRegistry();
  const run = loop("r1");
  const a = loop("r1", "flow-a");
  const b = loop("r1", "flow-b");
  for (const l of [run, a, b]) registry.register(l.loop);
  registry.bindSession({ sessionId: "side-a", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-a" });
  registry.bindSession({ sessionId: "side-b", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-b" });
  assert.equal(registry.find("side-a"), a.loop);
  assert.equal(registry.find("side-b"), b.loop);
  assert.equal(a.loop.capability.authorize("side-a", RUN_SPEC_FLOW_AGENT), undefined);
  assert.ok(a.loop.capability.authorize("side-b", RUN_SPEC_FLOW_AGENT), "a sibling's session is not known to this flow's capability");
  assert.ok(run.loop.capability.authorize("side-a", RUN_SPEC_FLOW_AGENT), "nor to the run's");
});

test("a sidekick's session with no flow, a flow that has no loop, and a role that is neither authoring role find nothing", () => {
  const registry = new ClosedLoopRegistry();
  registry.register(loop("r1").loop);
  registry.register(loop("r1", "flow-a").loop);
  registry.bindSession({ sessionId: "no-flow", runId: "r1", agent: RUN_SPEC_FLOW_AGENT });
  registry.bindSession({ sessionId: "other-flow", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-z" });
  registry.bindSession({ sessionId: "reviewer", runId: "r1", agent: "qa-reviewer", delegationId: "flow-a" });
  registry.bindSession({ sessionId: "other-run", runId: "r2", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-a" });
  for (const id of ["no-flow", "other-flow", "reviewer", "other-run"]) assert.equal(registry.find(id), undefined, id);
});

test("the generator is never given a flow's loop, and a generator session that names a flow is given nothing", () => {
  const registry = new ClosedLoopRegistry();
  registry.register(loop("r1", "flow-a").loop);
  registry.register(loop("r1").loop);
  registry.bindSession({ sessionId: "gen-flow", runId: "r1", agent: RUN_SPEC_AGENT, delegationId: "flow-a" });
  assert.equal(registry.find("gen-flow"), undefined);
});

test("a run keeps its loop and its flows' loops side by side, and a flow cannot be opened twice", () => {
  const registry = new ClosedLoopRegistry();
  registry.register(loop("r1").loop);
  registry.register(loop("r1", "flow-a").loop);
  assert.equal(registry.size, 2);
  assert.throws(() => registry.register(loop("r1", "flow-a").loop));
  assert.throws(() => registry.register(loop("r1").loop));
});

test("ending a flow forgets that flow's loop and sessions and leaves the run's and the siblings'", () => {
  const registry = new ClosedLoopRegistry();
  const run = loop("r1");
  const a = loop("r1", "flow-a");
  const b = loop("r1", "flow-b");
  for (const l of [run, a, b]) registry.register(l.loop);
  registry.bindSession({ sessionId: "side-a", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-a" });
  registry.bindSession({ sessionId: "side-b", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-b" });
  registry.unregisterFlow("r1", "flow-a");
  assert.equal(registry.find("side-a"), undefined);
  assert.equal(registry.find("side-b"), b.loop);
  assert.equal(registry.size, 2, "the run's loop stays for its limits and totals");
  void run;
});

test("ending a run forgets its loop, its flows' loops and every session of them", () => {
  const registry = new ClosedLoopRegistry();
  registry.register(loop("r1").loop);
  registry.register(loop("r1", "flow-a").loop);
  registry.register(loop("r2").loop);
  registry.register(loop("r2", "flow-b").loop);
  registry.bindSession({ sessionId: "side", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-a" });
  registry.bindSession({ sessionId: "side2", runId: "r2", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-b" });
  registry.unregister("r1");
  assert.equal(registry.find("side"), undefined);
  assert.ok(registry.find("side2"), "another run's flow loop is untouched");
  assert.equal(registry.size, 2);
});

test("a session that ends loses its right and the call it left running is stopped", () => {
  const registry = new ClosedLoopRegistry();
  const a = loop("r1", "flow-a");
  registry.register(a.loop);
  registry.bindSession({ sessionId: "side", runId: "r1", agent: RUN_SPEC_FLOW_AGENT, delegationId: "flow-a" });
  registry.unbindSession("side");
  assert.equal(registry.find("side"), undefined);
  assert.deepEqual(a.cancelled, ["side"]);
  assert.ok(a.loop.capability.authorize("side", RUN_SPEC_FLOW_AGENT), "the capability no longer knows it");
});

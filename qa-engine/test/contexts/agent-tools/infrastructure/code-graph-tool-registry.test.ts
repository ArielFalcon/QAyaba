import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeGraphToolRegistry, type LiveCodeGraph } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry.ts";

const live = (runId: string): LiveCodeGraph => ({ runId, call: async () => ({ ok: true, result: "", truncated: false, indexedSha: "abc1234", callsLeft: 1 }) });

test("only the lead's own sessions of a run find its code graph: not a sidekick, not the lead's session for a flow, not any other role", () => {
  const registry = new CodeGraphToolRegistry();
  const graph = live("r1");
  registry.register(graph);
  registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-lead" });
  registry.bindSession({ sessionId: "lead-flow", runId: "r1", agent: "qa-lead", delegationId: "r1-flow-cart" });
  for (const agent of ["qa-sidekick", "qa-reviewer", "qa-worker", "qa-assistant", "qa-reflector", "qa-maintainer"]) {
    registry.bindSession({ sessionId: `x-${agent}`, runId: "r1", agent });
    assert.equal(registry.find(`x-${agent}`), undefined, agent);
  }
  assert.equal(registry.find("lead"), graph);
  assert.equal(registry.find("lead-flow"), undefined);
});

test("a session of a run without a code graph, or of another run, finds nothing", () => {
  const registry = new CodeGraphToolRegistry();
  registry.register(live("r1"));
  registry.bindSession({ sessionId: "a", runId: "r2", agent: "qa-lead" });
  assert.equal(registry.find("a"), undefined);
});

test("an ended session, or a run that ended, loses the right", () => {
  const registry = new CodeGraphToolRegistry();
  registry.register(live("r1"));
  registry.bindSession({ sessionId: "a", runId: "r1", agent: "qa-lead" });
  registry.bindSession({ sessionId: "b", runId: "r1", agent: "qa-lead" });
  registry.unbindSession("a");
  assert.equal(registry.find("a"), undefined);
  assert.ok(registry.find("b"));
  registry.unregister("r1");
  assert.equal(registry.find("b"), undefined);
  assert.equal(registry.size, 0);
});

test("a run holds one code graph at a time", () => {
  const registry = new CodeGraphToolRegistry();
  registry.register(live("r1"));
  assert.throws(() => registry.register(live("r1")), /already/);
});

test("an explore session is bound only with a delegation id, and says which", () => {
  const registry = new CodeGraphToolRegistry();
  const graph = live("r1");
  registry.register(graph);
  registry.bindSession({ sessionId: "no-id", runId: "r1", agent: "qa-explore" });
  registry.bindSession({ sessionId: "e1", runId: "r1", agent: "qa-explore", delegationId: "r1-explore-0" });
  registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-lead" });
  assert.equal(registry.find("no-id"), undefined);
  assert.equal(registry.find("e1"), graph);
  assert.equal(registry.delegationOf("e1"), "r1-explore-0");
  assert.equal(registry.delegationOf("lead"), undefined);
  registry.unbindSession("e1");
  assert.equal(registry.delegationOf("e1"), undefined);
});

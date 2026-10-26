import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBrowserRegistry, type LiveBrowser } from "@contexts/agent-tools/infrastructure/agent-browser-registry.ts";
import { AgentBrowserCapability } from "@contexts/test-execution/domain/agent-browser-capability.ts";

function live(runId: string) {
  const ended: string[] = [];
  let closed = 0;
  const browser: LiveBrowser = {
    runId,
    capability: new AgentBrowserCapability({ runId, expiresAtMs: 1_000, now: () => 0 }),
    call: async () => ({ ok: true, page: { url: "", title: "", snapshot: "" }, blocked: [], notes: [], budget: { callsLeft: 1 } }),
    endSession: (id) => void ended.push(id),
    close: async () => { closed += 1; },
  };
  return { browser, ended, closed: () => closed };
}

test("the two authoring roles of a run find its browser and no other role does", () => {
  const registry = new AgentBrowserRegistry();
  const { browser } = live("r1");
  registry.register(browser);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: "qa-generator" });
  registry.bindSession({ sessionId: "side", runId: "r1", agent: "qa-sidekick" });
  for (const agent of ["qa-reviewer", "qa-worker", "qa-assistant", "qa-reflector", "qa-maintainer", "qa-proposer", "qa-worker-code"]) {
    registry.bindSession({ sessionId: `x-${agent}`, runId: "r1", agent });
    assert.equal(registry.find(`x-${agent}`), undefined, agent);
  }
  assert.equal(registry.find("gen"), browser);
  assert.equal(registry.find("side"), browser);
});

test("a session of a run without a browser, or of another run, finds nothing", () => {
  const registry = new AgentBrowserRegistry();
  registry.register(live("r1").browser);
  registry.bindSession({ sessionId: "a", runId: "r2", agent: "qa-generator" });
  assert.equal(registry.find("a"), undefined);
});

test("an ended session loses the right and its call and page are stopped", () => {
  const registry = new AgentBrowserRegistry();
  const { browser, ended } = live("r1");
  registry.register(browser);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: "qa-generator" });
  registry.unbindSession("gen");
  assert.equal(registry.find("gen"), undefined);
  assert.deepEqual(ended, ["gen"]);
  assert.ok(browser.capability.authorize("gen", "qa-generator"), "the capability no longer knows the session");
});

test("unregistering a run forgets its sessions", () => {
  const registry = new AgentBrowserRegistry();
  registry.register(live("r1").browser);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: "qa-generator" });
  registry.unregister("r1");
  assert.equal(registry.find("gen"), undefined);
  assert.equal(registry.size, 0);
});

test("a run cannot open two browsers", () => {
  const registry = new AgentBrowserRegistry();
  registry.register(live("r1").browser);
  assert.throws(() => registry.register(live("r1").browser));
});

test("a sweep closes every browser that is still open and forgets it", async () => {
  const registry = new AgentBrowserRegistry();
  const a = live("r1");
  const b = live("r2");
  registry.register(a.browser);
  registry.register(b.browser);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: "qa-generator" });
  assert.equal(await registry.sweepAll(), 2);
  assert.equal(a.closed() + b.closed(), 2);
  assert.equal(registry.size, 0);
  assert.equal(registry.find("gen"), undefined);
  assert.equal(await registry.sweepAll(), 0);
});

test("a sidekick session opened for a flow spends from that flow's share of the browser's calls", () => {
  const registry = new AgentBrowserRegistry();
  const { browser } = live("r1");
  registry.register(browser);
  browser.capability.setShare("flow-a", 1);
  registry.bindSession({ sessionId: "side", runId: "r1", agent: "qa-sidekick", delegationId: "flow-a" });
  assert.equal(registry.find("side"), browser);
  assert.equal(browser.capability.reserve("side").ok, true);
  assert.equal(browser.capability.reserve("side").ok, false, "the flow's one call is spent");
});

test("the generator's session has no flow and no share", () => {
  const registry = new AgentBrowserRegistry();
  const { browser } = live("r1");
  registry.register(browser);
  registry.bindSession({ sessionId: "gen", runId: "r1", agent: "qa-generator" });
  assert.equal(browser.capability.reserve("gen").ok, true);
});


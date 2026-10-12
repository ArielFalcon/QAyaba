import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_BROWSER_AGENTS, AGENT_BROWSER_REFUSAL, AgentBrowserCapability, MAX_RENEWALS } from "@contexts/test-execution/domain/agent-browser-capability.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";

function capability(over: { now?: () => number; expiresAtMs?: number; maxCalls?: number } = {}) {
  const c = new AgentBrowserCapability({
    runId: "r1",
    expiresAtMs: over.expiresAtMs ?? 1_000,
    now: over.now ?? (() => 0),
    ...(over.maxCalls !== undefined ? { limits: { ...DEFAULT_AGENT_BROWSER_LIMITS, maxCalls: over.maxCalls } } : {}),
  });
  c.bindSession("s1");
  return c;
}

test("only the authoring roles are named as holders, and nothing else is", () => {
  assert.deepEqual([...AGENT_BROWSER_AGENTS].sort(), ["qa-generator", "qa-sidekick"]);
});

test("a bound session of an authoring role is authorized, and each reason to refuse has its own code", () => {
  const c = capability();
  assert.equal(c.authorize("s1", "qa-generator"), undefined);
  assert.equal(c.authorize("s1", "qa-sidekick"), undefined);
  assert.equal(c.authorize("other", "qa-generator")?.code, AGENT_BROWSER_REFUSAL.UNKNOWN_SESSION);
  assert.equal(c.authorize("s1", "qa-reviewer")?.code, AGENT_BROWSER_REFUSAL.WRONG_AGENT);
  c.unbindSession("s1");
  assert.equal(c.authorize("s1", "qa-generator")?.code, AGENT_BROWSER_REFUSAL.UNKNOWN_SESSION);
});

test("a revoked capability refuses before it looks at the session, and an expired one does at its expiry instant", () => {
  const revoked = capability();
  revoked.revoke();
  assert.equal(revoked.authorize("other", "qa-reviewer")?.code, AGENT_BROWSER_REFUSAL.REVOKED, "revocation outranks every other reason");
  assert.equal(revoked.reserve().ok, false);
  let clock = 999;
  const expiring = capability({ now: () => clock, expiresAtMs: 1_000 });
  assert.equal(expiring.authorize("s1", "qa-generator"), undefined, "one tick before");
  clock = 1_000;
  assert.equal(expiring.authorize("s1", "qa-generator")?.code, AGENT_BROWSER_REFUSAL.EXPIRED);
});

test("calls are counted as they are reserved and the last one is the cap", () => {
  const c = capability({ maxCalls: 2 });
  assert.equal(c.callsLeft(), 2);
  assert.deepEqual(c.reserve(), { ok: true, callNumber: 1 });
  assert.deepEqual(c.reserve(), { ok: true, callNumber: 2 });
  assert.equal(c.callsLeft(), 0);
  const spent = c.reserve();
  assert.equal(spent.ok === false && spent.code, AGENT_BROWSER_REFUSAL.NO_CALLS);
  assert.equal(c.signal.calls, 2, "a refused call is not counted");
});

test("what a run records follows what happened: blocks add up, invalidations count, and only a renewed session counts as renewed", () => {
  const c = capability();
  c.recordBlocks(2);
  c.recordBlocks(3);
  c.recordInvalidation(true);
  c.recordInvalidation(false);
  c.recordInvalidation(undefined);
  assert.deepEqual(c.signal, { calls: 0, blocks: 5, invalidations: 3, renewals: 1 });
});

test("another sign-in is allowed until the renewals of a run, successful or not, reach the limit", () => {
  const c = capability();
  for (let i = 0; i < MAX_RENEWALS; i++) {
    assert.equal(c.canRenew(), true, `attempt ${i + 1}`);
    c.recordInvalidation(i % 2 === 0);
  }
  assert.equal(c.canRenew(), false);
  const fresh = capability();
  fresh.recordInvalidation(undefined);
  fresh.recordInvalidation(undefined);
  assert.equal(fresh.canRenew(), true, "an invalidation nobody tried to renew uses no attempt");
});

test("a flow's share caps the calls of the sessions opened for that flow, and a call of a session spends from its flow's share and from the run's", () => {
  const c = capability({ maxCalls: 10 });
  c.setShare("flow-a", 2);
  c.bindSession("side-a", "flow-a");
  assert.equal(c.authorize("side-a", "qa-sidekick"), undefined);
  assert.equal(c.reserve("side-a").ok, true);
  assert.equal(c.reserve("side-a").ok, true);
  const spent = c.reserve("side-a");
  assert.equal(spent.ok === false && spent.code, AGENT_BROWSER_REFUSAL.NO_CALLS);
  assert.equal(c.callsLeft(), 8, "the two calls were also the run's");
});

test("a flow's share is the flow's: another flow, the run's own sessions and a session with no flow are not held to it", () => {
  const c = capability({ maxCalls: 10 });
  c.setShare("flow-a", 1);
  c.setShare("flow-b", 3);
  c.bindSession("side-a", "flow-a");
  c.bindSession("side-b", "flow-b");
  assert.equal(c.reserve("side-a").ok, true);
  assert.equal(c.reserve("side-a").ok, false);
  for (let i = 0; i < 3; i++) assert.equal(c.reserve("side-b").ok, true);
  assert.equal(c.reserve("side-b").ok, false);
  for (let i = 0; i < 3; i++) assert.equal(c.reserve("s1").ok, true, "the generator's session has no share");
});

test("several sessions of one flow draw on its one share", () => {
  const c = capability({ maxCalls: 10 });
  c.setShare("flow-a", 2);
  c.bindSession("first", "flow-a");
  c.bindSession("second", "flow-a");
  assert.equal(c.reserve("first").ok, true);
  assert.equal(c.reserve("second").ok, true);
  assert.equal(c.reserve("first").ok, false);
});

test("a flow's share never lets the flow past the run's own cap", () => {
  const c = capability({ maxCalls: 2 });
  c.setShare("flow-a", 5);
  c.bindSession("side-a", "flow-a");
  assert.equal(c.reserve("side-a").ok, true);
  assert.equal(c.reserve("side-a").ok, true);
  const third = c.reserve("side-a");
  assert.equal(third.ok === false && third.code, AGENT_BROWSER_REFUSAL.NO_CALLS);
});

test("a session bound for a flow that was given no share is refused, not left unlimited", () => {
  const c = capability({ maxCalls: 10 });
  c.bindSession("side-x", "flow-x");
  const refused = c.reserve("side-x");
  assert.equal(refused.ok === false && refused.code, AGENT_BROWSER_REFUSAL.NO_CALLS);
});


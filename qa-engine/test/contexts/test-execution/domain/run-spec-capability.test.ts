import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSED_LOOP_REFUSAL,
  DEFAULT_CLOSED_LOOP_LIMITS,
  MIN_CALL_MS,
  RUN_SPEC_AGENT,
  RUN_SPEC_FLOW_AGENT,
  RunSpecCapability,
  loopClosed,
  type LedgerEntry,
} from "@contexts/test-execution/domain/run-spec-capability.ts";

const LIMITS = { maxCalls: 3, perCallMs: 60_000, maxDevWrites: 5 };

function grant(overrides: { expiresAtMs?: number; now?: () => number } = {}): RunSpecCapability {
  const now = overrides.now ?? (() => 1_000);
  const capability = new RunSpecCapability({ runId: "run-1", limits: LIMITS, expiresAtMs: overrides.expiresAtMs ?? 10_000_000, now });
  capability.bindSession("ses-1");
  return capability;
}

function entry(overrides: Partial<LedgerEntry> = {}): Omit<LedgerEntry, "namespace"> {
  return { path: "flows/a.spec.ts", sha256: "aa", status: "passed", ms: 100, devWrites: 0, ...overrides };
}

test("the shipped defaults keep the loop off its limits until an operator turns it on", () => {
  assert.deepEqual(DEFAULT_CLOSED_LOOP_LIMITS, { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 });
});

test("only the generator's own session may call, in a run whose capability is live", () => {
  const capability = grant();
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT), undefined);
  assert.equal(capability.authorize("ses-2", RUN_SPEC_AGENT)?.code, CLOSED_LOOP_REFUSAL.UNKNOWN_SESSION);
  assert.equal(capability.authorize("ses-1", "qa-reviewer")?.code, CLOSED_LOOP_REFUSAL.WRONG_AGENT);
  capability.unbindSession("ses-1");
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT)?.code, CLOSED_LOOP_REFUSAL.UNKNOWN_SESSION);
});

test("a capability made for a flow's sidekick is held by that agent's sessions and never by the generator's", () => {
  const capability = new RunSpecCapability({ runId: "run-1-cart", limits: LIMITS, expiresAtMs: 10_000_000, now: () => 1_000, agents: new Set([RUN_SPEC_FLOW_AGENT]) });
  capability.bindSession("side-1");
  assert.equal(capability.authorize("side-1", RUN_SPEC_FLOW_AGENT), undefined);
  assert.equal(capability.authorize("side-1", RUN_SPEC_AGENT)?.code, CLOSED_LOOP_REFUSAL.WRONG_AGENT);
  assert.equal(capability.authorize("side-1", "qa-reviewer")?.code, CLOSED_LOOP_REFUSAL.WRONG_AGENT);
});

test("a revoked capability refuses everything, and revoking twice changes nothing", () => {
  const capability = grant();
  capability.revoke();
  capability.revoke();
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT)?.code, CLOSED_LOOP_REFUSAL.REVOKED);
  assert.equal(capability.reserve(undefined).ok, false);
});

test("a capability expires at its time, whatever its counters say", () => {
  let clock = 1_000;
  const capability = grant({ expiresAtMs: 5_000, now: () => clock });
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT), undefined);
  clock = 5_000;
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT)?.code, CLOSED_LOOP_REFUSAL.EXPIRED);
});

test("each call gets its own namespace and the number of calls is capped", () => {
  const capability = grant();
  const first = capability.reserve(undefined);
  assert.ok(first.ok);
  assert.equal(first.namespace, "run-1-rs1");
  capability.settle(entry());
  const second = capability.reserve(undefined);
  assert.ok(second.ok);
  assert.equal(second.namespace, "run-1-rs2");
  capability.settle(entry());
  const third = capability.reserve(undefined);
  assert.ok(third.ok);
  capability.settle(entry());
  const fourth = capability.reserve(undefined);
  assert.equal(fourth.ok, false);
  assert.equal(!fourth.ok && fourth.code, CLOSED_LOOP_REFUSAL.NO_CALLS);
});

test("one call at a time: a second reservation waits for the first to settle", () => {
  const capability = grant();
  assert.ok(capability.reserve(undefined).ok);
  const second = capability.reserve(undefined);
  assert.equal(!second.ok && second.code, CLOSED_LOOP_REFUSAL.BUSY);
  capability.settle(entry());
  assert.ok(capability.reserve(undefined).ok);
});

test("a call is bounded by its own cap and by what the run's deadline has left", () => {
  const capability = grant();
  const roomy = capability.reserve(10 * 60_000);
  assert.ok(roomy.ok);
  assert.equal(roomy.timeoutMs, LIMITS.perCallMs);
  capability.settle(entry());
  const tight = capability.reserve(MIN_CALL_MS + 20_000);
  assert.ok(tight.ok);
  assert.ok(tight.timeoutMs <= MIN_CALL_MS + 20_000 - 1, "the deadline's last moments are kept for cleanup");
  assert.ok(tight.timeoutMs >= MIN_CALL_MS);
});

test("a call is refused when the deadline leaves no time worth running a browser for", () => {
  const capability = grant();
  const refused = capability.reserve(MIN_CALL_MS - 1);
  assert.equal(!refused.ok && refused.code, CLOSED_LOOP_REFUSAL.NO_TIME);
  assert.equal(capability.budget(MIN_CALL_MS - 1).callsLeft, LIMITS.maxCalls, "a refused call is not a spent call");
});

test("writes to DEV are counted per call and, once the cap is spent, the next call is refused", () => {
  const capability = grant();
  assert.ok(capability.reserve(undefined).ok);
  capability.settle(entry({ devWrites: 4 }));
  assert.equal(capability.budget(undefined).devWritesLeft, 1);
  assert.ok(capability.reserve(undefined).ok);
  capability.settle(entry({ devWrites: 3 }));
  assert.equal(capability.budget(undefined).devWritesLeft, 0, "an overshoot is recorded, never negative");
  const refused = capability.reserve(undefined);
  assert.equal(!refused.ok && refused.code, CLOSED_LOOP_REFUSAL.NO_WRITES);
  assert.equal(capability.devWrites, 7);
});

test("the ledger keeps every call in order with the namespace it ran under", () => {
  const capability = grant();
  capability.reserve(undefined);
  capability.settle(entry({ path: "a.spec.ts", sha256: "s1", status: "failed" }));
  capability.reserve(undefined);
  capability.settle(entry({ path: "a.spec.ts", sha256: "s2", status: "passed" }));
  assert.deepEqual(capability.ledger.map((e) => [e.path, e.sha256, e.status, e.namespace]), [
    ["a.spec.ts", "s1", "failed", "run-1-rs1"],
    ["a.spec.ts", "s2", "passed", "run-1-rs2"],
  ]);
  assert.equal(capability.calls, 2);
});

test("settling without a reservation is a programming error, not a silent ledger line", () => {
  assert.throws(() => grant().settle(entry()), /no call is in flight/);
});

test("a spec's loop is closed only when its current bytes are the ones whose last call passed", () => {
  const ledger: LedgerEntry[] = [
    { path: "flows/a.spec.ts", sha256: "old", status: "failed", namespace: "r-rs1", ms: 1, devWrites: 0 },
    { path: "flows/a.spec.ts", sha256: "new", status: "passed", namespace: "r-rs2", ms: 1, devWrites: 0 },
    { path: "flows/b.spec.ts", sha256: "b1", status: "passed", namespace: "r-rs3", ms: 1, devWrites: 0 },
  ];
  assert.equal(loopClosed(ledger, new Map([["flows/a.spec.ts", "new"], ["flows/b.spec.ts", "b1"]])), true);
  assert.equal(loopClosed(ledger, new Map([["flows/a.spec.ts", "new"], ["flows/b.spec.ts", "b2"]])), false, "b changed after its last run");
  assert.equal(loopClosed(ledger, new Map([["flows/a.spec.ts", "old"]])), false, "the last entry for a is not the one that matches");
  assert.equal(loopClosed(ledger, new Map([["flows/c.spec.ts", "c1"]])), false, "a delivered spec that never ran is not closed");
  assert.equal(loopClosed(ledger, new Map([["flows/a.spec.ts", undefined]])), false, "a delivered spec that is gone is not closed");
});

test("a run that delivered nothing, or whose last call failed, is never closed", () => {
  const failed: LedgerEntry[] = [{ path: "a.spec.ts", sha256: "x", status: "failed", namespace: "r-rs1", ms: 1, devWrites: 0 }];
  assert.equal(loopClosed(failed, new Map()), false);
  assert.equal(loopClosed(failed, new Map([["a.spec.ts", "x"]])), false);
  assert.equal(loopClosed([], new Map([["a.spec.ts", "x"]])), false);
});

test("spec paths are compared in their canonical form", () => {
  const ledger: LedgerEntry[] = [{ path: "flows/a.spec.ts", sha256: "x", status: "passed", namespace: "r-rs1", ms: 1, devWrites: 0 }];
  assert.equal(loopClosed(ledger, new Map([["./flows//a.spec.ts", "x"]])), true);
});

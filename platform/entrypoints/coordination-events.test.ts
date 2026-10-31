import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoordinationLedgerEvent } from "../../engine/src/contexts/coordination/application/index";
import { toCoordinationSignals } from "./coordination-events";

/* The events a ledger of these lines holds once the reader has read it. */
const eventsOf = (lines: readonly string[]): CoordinationLedgerEvent[] => lines.map((l) => JSON.parse(l) as CoordinationLedgerEvent);
const line = (o: Record<string, unknown>) => JSON.stringify(o);

const ledgerEvents = eventsOf([
  { runId: "r1", kind: "proposal", action: "delegate", sidekickKind: "author", reason: "big", at: 1 },
  { runId: "r1", kind: "delegation", action: "delegate", sidekickKind: "author", reason: "sidekick status=failed", failureClass: "failed", delegationId: "d1", attempt: 1, durationMs: 1000, at: 2 },
  { runId: "r1", kind: "delegation", reason: "sidekick status=completed-with-concerns", delegationId: "d2", attempt: 2, durationMs: 2000, at: 3 },
  { runId: "r1", kind: "escalation", reason: "no progress", at: 4 },
  { runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", reviewOutcome: "approved", coverageRatio: 0.9, durationMs: 42000, at: 5 },
  { runId: "r2", kind: "outcome", action: "direct", reason: "pipeline verdict=fail", finalOutcome: "fail", reviewOutcome: "rejected", at: 6 },
].map(line));

test("toCoordinationSignals: delegate share, contract failures, delegation cost, and no escalation rate", () => {
  const s = toCoordinationSignals(ledgerEvents);
  assert.deepEqual(Object.keys(s).sort(), ["avgDelegationMs", "contractFailureRate", "delegateRuns", "measured", "totalRuns"]);
  assert.equal(s.measured, true);
  assert.equal(s.totalRuns, 2);
  assert.equal(s.delegateRuns, 1);
  assert.equal(s.contractFailureRate, 0.5); /* 1 failed of 2 delegations */
  assert.equal(s.avgDelegationMs, 1500);
});

test("toCoordinationSignals counts a typed failureClass even when the reason prose looks innocuous — the old regex silently missed this", () => {
  const events = eventsOf([
    JSON.stringify({ runId: "r9", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 1 }),
    /* Reason reads like a clean completion — no "failed"/"violat"/"outside scope"/"claimed"
       substring anywhere — yet failureClass says the claimed files never verified on disk. A
       prose regex over `reason` would have missed this false-positive success entirely. */
    JSON.stringify({ runId: "r9", kind: "delegation", reason: "sidekick status=completed-with-concerns", failureClass: "claimed-files-missing", delegationId: "d9", at: 2 }),
  ]);
  const s = toCoordinationSignals(events);
  assert.equal(s.contractFailureRate, 1, "the typed failureClass must be trusted over the prose reason");
});

/* Older ledgers recorded every fix-loop delegation with failureClass "fail", including successful
   ones. Only a delegation contract failure class may count against the contract. */
test("toCoordinationSignals ignores an older ledger's failureClass that is not a delegation failure class", () => {
  const events = eventsOf([
    JSON.stringify({ runId: "r1", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "fix-loop-regen sidekick status=completed", delegationId: "r1-fix-loop-regen", attempt: 1, durationMs: 1000, failureClass: "fail", at: 1 }),
    JSON.stringify({ runId: "r2", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=blocked", delegationId: "r2-pre-generate", attempt: 1, durationMs: 1000, failureClass: "blocked", at: 2 }),
    JSON.stringify({ runId: "r3", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=completed", delegationId: "r3-pre-generate", attempt: 1, durationMs: 1000, failureClass: "timeout", at: 5 }),
    JSON.stringify({ runId: "r4", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=completed", delegationId: "r4-pre-generate", attempt: 1, durationMs: 1000, failureClass: "claimed-files-missing", at: 6 }),
    JSON.stringify({ runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 3 }),
    JSON.stringify({ runId: "r2", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 4 }),
  ]);
  const s = toCoordinationSignals(events);
  assert.equal(s.contractFailureRate, 0.5, "only the blocked and claimed-files-missing delegations are contract failures");
});

test("toCoordinationSignals with an empty ledger reports unmeasured, not zero-painted", () => {
  const signals = toCoordinationSignals([]);
  assert.equal(signals.measured, false);
  assert.equal(signals.avgDelegationMs, null);
});

test("toCoordinationSignals counts only runs with an outcome; a ledger without one is unmeasured", () => {
  const inProgress = [
    { runId: "r1", kind: "delegation" as const, reason: "x", at: 1, durationMs: 10 },
    { runId: "r1", kind: "escalation" as const, reason: "x", at: 2 },
  ];
  const s = toCoordinationSignals(inProgress);
  assert.equal(s.measured, false);
  assert.equal(s.totalRuns, 0);
  const withOutcome = toCoordinationSignals([...inProgress, { runId: "r2", kind: "outcome" as const, action: "direct", reason: "x", at: 3 }]);
  assert.equal(withOutcome.totalRuns, 1);
});

test("toCoordinationSignals: delegate runs are the distinct runs whose outcome delegated, and a direct run is a run but not a delegating one", () => {
  const events = eventsOf([
    line({ runId: "A", kind: "outcome", action: "delegate", reason: "x", at: 1 }),
    line({ runId: "A", kind: "delegation", action: "delegate", reason: "x", at: 2 }),
    line({ runId: "B", kind: "outcome", action: "delegate", reason: "x", at: 3 }),
    line({ runId: "C", kind: "outcome", action: "direct", reason: "x", at: 4 }),
    line({ runId: "D", kind: "delegation", action: "delegate", reason: "x", at: 5 }),
  ]);
  const s = toCoordinationSignals(events);
  assert.equal(s.totalRuns, 3, "A, B and C have an outcome; D has none");
  assert.equal(s.delegateRuns, 2, "A and B delegated; C went direct");
});

test("toCoordinationSignals: average delegation cost only counts delegations that recorded a duration", () => {
  const s = toCoordinationSignals([
    { runId: "r1", kind: "delegation", reason: "x", at: 1, durationMs: 1000 },
    { runId: "r1", kind: "delegation", reason: "x", at: 2 },
  ]);
  assert.equal(s.avgDelegationMs, 1000);
});

test("toCoordinationSignals: with outcomes but no delegation, the contract failure rate is unmeasured", () => {
  const s = toCoordinationSignals([{ runId: "r1", kind: "outcome", action: "direct", reason: "x", at: 1 }]);
  assert.equal(s.contractFailureRate, null);
});

/* The signals served from the ledgers the reader's sweep reads (coordination-ledger-reader.adapter.test.ts). */
const outcome = (runId: string, at: number, action: string): CoordinationLedgerEvent => ({ runId, kind: "outcome", action, reason: "pipeline verdict=pass", finalOutcome: "pass", at });

test("toCoordinationSignals over the events of a ledger rotated at the writer's cap: the newest thousand runs", () => {
  const events = Array.from({ length: 1000 }, (_, i) => outcome(`r${4001 + i}`, 4001 + i, (4001 + i) % 2 === 0 ? "delegate" : "direct"));
  assert.deepEqual(toCoordinationSignals(events), { measured: true, totalRuns: 1000, delegateRuns: 500, contractFailureRate: null, avgDelegationMs: null });
});

test("toCoordinationSignals over the events a ledger with malformed lines still holds", () => {
  const events: CoordinationLedgerEvent[] = [
    outcome("a", 1, "delegate"),
    { runId: "b", kind: "proposal", reason: "x", at: 2 },
    { runId: "e", kind: "delegation", reason: "kept", attempt: 2, at: 4 },
    outcome("f", 5, "direct"),
  ];
  assert.deepEqual(toCoordinationSignals(events), { measured: true, totalRuns: 2, delegateRuns: 1, contractFailureRate: 0, avgDelegationMs: null });
});

test("toCoordinationSignals over the events of a ledger with lines past the first read window", () => {
  const events = [outcome("small-before", 1, "delegate"), outcome("huge", 2, "delegate"), outcome("small-after", 3, "direct")];
  assert.deepEqual(toCoordinationSignals(events), { measured: true, totalRuns: 3, delegateRuns: 2, contractFailureRate: null, avgDelegationMs: null });
});

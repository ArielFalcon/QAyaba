import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinationLedger,
  readCoordinationLedger,
  toCoordinationSignals,
} from "./coordination-events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const raw = [
  JSON.stringify({ runId: "r1", kind: "proposal", action: "delegate", capability: "sidekick-standard", reason: "big", at: 1 }),
  JSON.stringify({ runId: "r1", kind: "delegation", action: "delegate", capability: "sidekick-standard", reason: "sidekick status=failed", delegationId: "d1", attempt: 1, durationMs: 1000, at: 2 }),
  JSON.stringify({ runId: "r1", kind: "delegation", reason: "sidekick status=completed-with-concerns", delegationId: "d2", attempt: 2, durationMs: 2000, at: 3 }),
  JSON.stringify({ runId: "r1", kind: "escalation", reason: "no progress", escalations: 1, at: 4 }),
  JSON.stringify({ runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", reviewOutcome: "approved", escalations: 1, valueScore: 0.75, coverageRatio: 0.9, durationMs: 42000, at: 5 }),
  // Non-JSON noise must be skipped, malformed kinds dropped — never 500 the audit read.
  "{ line corrupt",
  JSON.stringify({ runId: "r0", kind: "bogus-kind", reason: "x", at: 9 }),
  JSON.stringify({ runId: "r2", kind: "outcome", action: "direct", reason: "pipeline verdict=fail", finalOutcome: "fail", reviewOutcome: "rejected", at: 6 }),
].join("\n");

test("parseCoordinationLedger: tail + filter + truncation flag", () => {
  const all = parseCoordinationLedger(raw);
  assert.equal(all.events.length, 6);
  assert.equal(all.truncated, false);
  const r1 = parseCoordinationLedger(raw, { runId: "r1" });
  assert.equal(r1.events.length, 5);
  assert.equal(r1.truncated, false);
  const limited = parseCoordinationLedger(raw, { limit: 2 });
  assert.equal(limited.events.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.events[0].kind, "outcome");
});

test("readCoordinationLedger: missing file = empty ledger (fresh install), never throws", () => {
  const dir = join(tmpdir(), "coord-read-", String(process.pid), "-missing");
  const view = readCoordinationLedger({}, join(dir, "coordination-events.jsonl"));
  assert.deepEqual(view.events, []);
  assert.equal(view.truncated, false);
});

test("readCoordinationLedger: real file tail with run filter + limit", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    writeFileSync(path, raw + "\n", "utf8");
    const view = readCoordinationLedger({ runId: "r1", limit: 3 }, path);
    assert.equal(view.truncated, true);
    assert.equal(view.events.length, 3);
    const last = view.events.at(-1);
    assert.ok(last, "expected the tail to include the outcome event");
    assert.equal(last.valueScore, 0.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toCoordinationSignals: delegate share, escalation rate, contract failures, delegation cost", () => {
  const s = toCoordinationSignals(parseCoordinationLedger(raw).events);
  assert.equal(s.measured, true);
  assert.equal(s.totalRuns, 2);
  assert.equal(s.delegateRuns, 1);
  assert.equal(s.escalationRate, 1);
  assert.equal(s.contractFailureRate, 0.5); // 1 failed of 2 delegations
  assert.equal(s.avgDelegationMs, 1500);
});

test("toCoordinationSignals with an empty ledger reports unmeasured, not zero-painted", () => {
  const signals = toCoordinationSignals([]);
  assert.equal(signals.measured, false);
  assert.equal(signals.avgDelegationMs, null);
  assert.equal(signals.escalationRate, null);
});

function mkdtemp(): string {
  const dir = join(tmpdir(), `coord-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinationLedger,
  readCoordinationLedger,
  toCoordinationSignals,
} from "./coordination-events";
import { mkdirSync, rmSync, writeFileSync, openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";

const raw = [
  JSON.stringify({ runId: "r1", kind: "proposal", action: "delegate", capability: "sidekick-standard", reason: "big", at: 1 }),
  JSON.stringify({ runId: "r1", kind: "delegation", action: "delegate", capability: "sidekick-standard", reason: "sidekick status=failed", failureClass: "failed", delegationId: "d1", attempt: 1, durationMs: 1000, at: 2 }),
  JSON.stringify({ runId: "r1", kind: "delegation", reason: "sidekick status=completed-with-concerns", delegationId: "d2", attempt: 2, durationMs: 2000, at: 3 }),
  JSON.stringify({ runId: "r1", kind: "escalation", reason: "no progress", escalations: 1, at: 4 }),
  JSON.stringify({ runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", reviewOutcome: "approved", escalations: 1, valueScore: 0.75, coverageRatio: 0.9, durationMs: 42000, at: 5 }),
  /* Non-JSON noise must be skipped, malformed kinds dropped — never 500 the audit read. */
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
  const firstTail = limited.events[0];
  assert.ok(firstTail, "expected the tail to be non-empty");
  assert.equal(firstTail.kind, "outcome");
});

test("readCoordinationLedger: missing file = empty ledger (fresh install), never throws", () => {
  const dir = join(tmpdir(), "coord-read-", String(process.pid), "-missing");
  const view = readCoordinationLedger({}, join(dir, "coordination-events.jsonl"));
  assert.deepEqual(view.events, []);
  assert.equal(view.truncated, false);
});

test("readCoordinationLedger: a non-ENOENT read failure is logged loudly and rethrown, never silently treated as an empty ledger", () => {
  const errorMock = mock.method(console, "error", () => {});
  try {
    const boom = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fakeFs = {
      openSync: () => {
        throw boom;
      },
      fstatSync,
      readSync,
      closeSync,
    };
    assert.throws(() => readCoordinationLedger({}, "/some/path/coordination-events.jsonl", fakeFs), /permission denied/);
    assert.equal(errorMock.mock.calls.length, 1, "a non-ENOENT failure must be logged, not swallowed");
  } finally {
    errorMock.mock.restore();
  }
});

test("readCoordinationLedger: reads only a bounded tail, not the whole file, for a recent unfiltered poll", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    /* A large ledger: 3000 small events, each a distinct runId so a naive full-file parse would be
       the only way to correctly count them all — but the poll here only wants the last 5. */
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(JSON.stringify({ runId: `r${i}`, kind: "outcome", reason: "pipeline verdict=pass", finalOutcome: "pass", at: i }));
    }
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const fullSize = statSync(path).size;

    let bytesRead = 0;
    const countingFs = {
      openSync,
      fstatSync,
      readSync: ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => {
        bytesRead += length;
        return readSync(fd, buffer as Buffer, offset, length, position);
      }) as typeof readSync,
      closeSync,
    };
    const view = readCoordinationLedger({ limit: 5 }, path, countingFs);
    assert.equal(view.events.length, 5);
    assert.equal(view.truncated, true);
    assert.equal(view.events.at(-1)?.runId, "r2999", "the tail must be the MOST RECENT events");
    assert.ok(bytesRead > 0, "the injected byte-range reader must actually be exercised (proves the read goes through the tail path, not readFileSync)");
    assert.ok(bytesRead < fullSize / 10, `expected a bounded tail read (<${Math.round(fullSize / 10)}B), got ${bytesRead}B out of a ${fullSize}B file`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(s.contractFailureRate, 0.5); /* 1 failed of 2 delegations */
  assert.equal(s.avgDelegationMs, 1500);
});

test("toCoordinationSignals counts a typed failureClass even when the reason prose looks innocuous — the old regex silently missed this", () => {
  const events = parseCoordinationLedger(
    [
      JSON.stringify({ runId: "r9", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 1 }),
      /* Reason reads like a clean completion — no "failed"/"violat"/"outside scope"/"claimed"
         substring anywhere — yet failureClass says the claimed files never verified on disk. A
         prose regex over `reason` would have missed this false-positive success entirely. */
      JSON.stringify({ runId: "r9", kind: "delegation", reason: "sidekick status=completed-with-concerns", failureClass: "claimed-files-missing", delegationId: "d9", at: 2 }),
    ].join("\n"),
  ).events;
  const s = toCoordinationSignals(events);
  assert.equal(s.contractFailureRate, 1, "the typed failureClass must be trusted over the prose reason");
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

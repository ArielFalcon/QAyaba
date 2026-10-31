import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinationLedger,
  readCoordinationLedger,
  toCoordinationSignals,
} from "./coordination-events";
import { mkdirSync, rmSync, writeFileSync, openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import type { CoordinationLedgerFsDeps } from "./coordination-events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";

const raw = [
  JSON.stringify({ runId: "r1", kind: "proposal", action: "delegate", sidekickKind: "author", tier: "standard", reason: "big", at: 1 }),
  JSON.stringify({ runId: "r1", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=failed", failureClass: "failed", delegationId: "d1", attempt: 1, durationMs: 1000, at: 2 }),
  JSON.stringify({ runId: "r1", kind: "delegation", reason: "sidekick status=completed-with-concerns", delegationId: "d2", attempt: 2, durationMs: 2000, at: 3 }),
  JSON.stringify({ runId: "r1", kind: "escalation", reason: "no progress", at: 4 }),
  JSON.stringify({ runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", reviewOutcome: "approved", coverageRatio: 0.9, durationMs: 42000, at: 5 }),
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
  const view = readCoordinationLedger(join(dir, "coordination-events.jsonl"), {});
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
    assert.throws(() => readCoordinationLedger("/some/path/coordination-events.jsonl", {}, fakeFs), /permission denied/);
    assert.equal(errorMock.mock.calls.length, 1, "a non-ENOENT failure must be logged, not swallowed");
    const logged = String(errorMock.mock.calls[0]?.arguments[0]);
    assert.match(logged, /\/some\/path\/coordination-events\.jsonl/, "the log names the ledger path");
    assert.match(logged, /permission denied/, "the log names the cause");
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
    const view = readCoordinationLedger(path, { limit: 5 }, countingFs);
    assert.equal(view.events.length, 5);
    assert.equal(view.truncated, true);
    assert.equal(view.events.at(-1)?.runId, "r2999", "the tail must be the MOST RECENT events");
    assert.ok(bytesRead > 0, "the injected byte-range reader must actually be exercised (proves the read goes through the tail path, not readFileSync)");
    assert.ok(bytesRead < fullSize / 10, `expected a bounded tail read (<${Math.round(fullSize / 10)}B), got ${bytesRead}B out of a ${fullSize}B file`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* readSync may return fewer bytes than asked for; the tail reader must keep reading until the window
   is full instead of parsing the unfilled part of its buffer. */
test("readCoordinationLedger: a reader that returns short reads still yields every event", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ runId: `r${i}`, kind: "outcome", reason: "pipeline verdict=pass", finalOutcome: "pass", at: i }));
    }
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const shortReadFs = {
      openSync,
      fstatSync,
      readSync: ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) =>
        readSync(fd, buffer as Buffer, offset, Math.min(length, 7), position)) as typeof readSync,
      closeSync,
    };

    const view = readCoordinationLedger(path, { limit: 100 }, shortReadFs);

    assert.deepEqual(view.events.map((e) => e.runId), lines.map((_, i) => `r${i}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A ledger has a single writer (the long-lived service), but that still does not make one run's
   own events a contiguous block within the file — other runs' events land in between as they are
   appended over time. A runId-scoped read must match a full-file parse exactly regardless of that
   interleaving; it must never assume contiguity to stop early. */
test("readCoordinationLedger: a runId filter reads a run's events exactly, even when interleaved with other runs' events", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    const lines: string[] = [];
    /* The target run's OWN early event, appended first. */
    lines.push(JSON.stringify({ runId: "target", kind: "proposal", action: "delegate", sidekickKind: "author", tier: "standard", reason: "big", at: 1 }));
    /* A large block of other runs' events interleaved in between — this run's events are no
       longer a contiguous block in the ledger. */
    for (let i = 0; i < 3000; i++) {
      lines.push(JSON.stringify({ runId: `other-${i}`, kind: "outcome", reason: "pipeline verdict=pass", finalOutcome: "pass", at: i + 2 }));
    }
    /* The target run's remaining events, appended later. */
    lines.push(JSON.stringify({ runId: "target", kind: "delegation", reason: "sidekick status=completed", delegationId: "d1", attempt: 1, durationMs: 500, at: 4002 }));
    lines.push(JSON.stringify({ runId: "target", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 4003 }));
    const text = `${lines.join("\n")}\n`;
    writeFileSync(path, text, "utf8");

    const fullParse = parseCoordinationLedger(text, { runId: "target" });
    assert.equal(fullParse.events.length, 3, "sanity: a full-file parse must see all 3 of the target run's events");

    const view = readCoordinationLedger(path, { runId: "target" });
    assert.deepEqual(view.events, fullParse.events, "a runId-filtered read must match a full-file parse exactly, even when interleaved with other runs' events");
    assert.equal(view.truncated, fullParse.truncated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCoordinationLedger: real file tail with run filter + limit", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    writeFileSync(path, raw + "\n", "utf8");
    const view = readCoordinationLedger(path, { runId: "r1", limit: 3 });
    assert.equal(view.truncated, true);
    assert.equal(view.events.length, 3);
    const last = view.events.at(-1);
    assert.ok(last, "expected the tail to include the outcome event");
    assert.equal(last.coverageRatio, 0.9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toCoordinationSignals: delegate share, contract failures, delegation cost, and no escalation rate", () => {
  const s = toCoordinationSignals(parseCoordinationLedger(raw).events);
  assert.deepEqual(Object.keys(s).sort(), ["avgDelegationMs", "contractFailureRate", "delegateRuns", "measured", "totalRuns"]);
  assert.equal(s.measured, true);
  assert.equal(s.totalRuns, 2);
  assert.equal(s.delegateRuns, 1);
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

/* Older ledgers recorded every fix-loop delegation with failureClass "fail", including successful
   ones. Only a delegation contract failure class may count against the contract. */
test("toCoordinationSignals ignores an older ledger's failureClass that is not a delegation failure class", () => {
  const events = parseCoordinationLedger(
    [
      JSON.stringify({ runId: "r1", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "fix-loop-regen sidekick status=completed", delegationId: "r1-fix-loop-regen", attempt: 1, durationMs: 1000, failureClass: "fail", at: 1 }),
      JSON.stringify({ runId: "r2", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=blocked", delegationId: "r2-pre-generate", attempt: 1, durationMs: 1000, failureClass: "blocked", at: 2 }),
      JSON.stringify({ runId: "r3", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=completed", delegationId: "r3-pre-generate", attempt: 1, durationMs: 1000, failureClass: "timeout", at: 5 }),
      JSON.stringify({ runId: "r4", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "sidekick status=completed", delegationId: "r4-pre-generate", attempt: 1, durationMs: 1000, failureClass: "claimed-files-missing", at: 6 }),
      JSON.stringify({ runId: "r1", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 3 }),
      JSON.stringify({ runId: "r2", kind: "outcome", action: "delegate", reason: "pipeline verdict=pass", finalOutcome: "pass", at: 4 }),
    ].join("\n"),
  ).events;
  const s = toCoordinationSignals(events);
  assert.equal(s.contractFailureRate, 0.5, "only the blocked and claimed-files-missing delegations are contract failures");
});

test("toCoordinationSignals with an empty ledger reports unmeasured, not zero-painted", () => {
  const signals = toCoordinationSignals([]);
  assert.equal(signals.measured, false);
  assert.equal(signals.avgDelegationMs, null);
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);

test("a ledger line recorded with the retired escalations count reads without it", () => {
  const [event] = parseCoordinationLedger(line({ runId: "r1", kind: "outcome", action: "delegate", reason: "x", escalations: 2, at: 1 })).events;
  assert.equal(event?.runId, "r1");
  assert.equal("escalations" in (event ?? {}), false);
});

test("a ledger line recorded with the retired tier field reads without it", () => {
  const [event] = parseCoordinationLedger(line({ runId: "r1", kind: "delegation", action: "delegate", sidekickKind: "author", tier: "standard", reason: "x", at: 1 })).events;
  assert.equal(event?.sidekickKind, "author");
  assert.equal("tier" in (event ?? {}), false);
});

test("a ledger line with the lead-decision kind is returned, with the pushback kind beside it", () => {
  const { events } = parseCoordinationLedger(
    [line({ runId: "r1", kind: "lead-decision", reason: "route", at: 1 }), line({ runId: "r1", kind: "pushback", reason: "out of scope", at: 2 })].join("\n"),
  );
  assert.deepEqual(events.map((e) => e.kind), ["lead-decision", "pushback"]);
});

test("parseCoordinationLedger drops a line whose runId, reason or at has the wrong type", () => {
  const { events } = parseCoordinationLedger(
    [
      line({ runId: 7, kind: "outcome", reason: "x", at: 1 }),
      line({ runId: "r1", kind: "outcome", reason: 7, at: 2 }),
      line({ runId: "r1", kind: "outcome", reason: "x", at: "3" }),
      line({ runId: "r1", kind: "outcome", reason: "kept", at: 4 }),
    ].join("\n"),
  );
  assert.deepEqual(events.map((e) => e.reason), ["kept"]);
});

test("parseCoordinationLedger drops JSON lines that are not objects (null, a number, an array) without failing the read", () => {
  const { events } = parseCoordinationLedger(["null", "5", "[1,2]", line({ runId: "r1", kind: "outcome", reason: "kept", at: 1 })].join("\n"));
  assert.deepEqual(events.map((e) => e.reason), ["kept"]);
});

test("parseCoordinationLedger: exactly `limit` matching events is the whole ledger, not a truncated tail", () => {
  const all = parseCoordinationLedger(raw).events.length;
  const view = parseCoordinationLedger(raw, { limit: all });
  assert.equal(view.events.length, all);
  assert.equal(view.truncated, false);
});

test("parseCoordinationLedger: a zero or negative limit falls back to the default page", () => {
  const all = parseCoordinationLedger(raw).events.length;
  for (const limit of [0, -5]) {
    const view = parseCoordinationLedger(raw, { limit });
    assert.equal(view.events.length, all, `limit ${limit}`);
    assert.equal(view.truncated, false, `limit ${limit}`);
  }
});

test("parseCoordinationLedger surfaces every recorded optional field of an event", () => {
  const [event] = parseCoordinationLedger(
    line({
      runId: "r1",
      kind: "delegation",
      reason: "sidekick status=completed",
      at: 1,
      action: "delegate",
      sidekickKind: "author",
      delegationId: "d1",
      attempt: 2,
      failureClass: "blocked",
      progressFingerprint: "fp-1",
      finalOutcome: "pass",
      reviewOutcome: "approved",
      coverageRatio: 0.9,
    }),
  ).events;
  assert.ok(event);
  assert.equal(event.sidekickKind, "author");
  assert.equal(event.delegationId, "d1");
  assert.equal(event.attempt, 2);
  assert.equal(event.progressFingerprint, "fp-1");
  assert.equal(event.finalOutcome, "pass");
  assert.equal(event.reviewOutcome, "approved");
  assert.equal(event.coverageRatio, 0.9);
});

test("parseCoordinationLedger: a zero count is kept, a negative one is dropped", () => {
  const [zero, negative] = parseCoordinationLedger(
    [line({ runId: "r1", kind: "delegation", reason: "x", at: 1, durationMs: 0, attempt: 0 }), line({ runId: "r1", kind: "delegation", reason: "x", at: 2, durationMs: -1, attempt: -1 })].join("\n"),
  ).events;
  assert.equal(zero?.durationMs, 0);
  assert.equal(zero?.attempt, 0);
  assert.equal(negative?.durationMs, undefined);
  assert.equal(negative?.attempt, undefined);
});

test("parseCoordinationLedger keeps a numeric or null coverageRatio and drops any other value", () => {
  const events = parseCoordinationLedger(
    [
      line({ runId: "r1", kind: "outcome", reason: "x", at: 1, coverageRatio: 0.5 }),
      line({ runId: "r1", kind: "outcome", reason: "x", at: 2, coverageRatio: null }),
      line({ runId: "r1", kind: "outcome", reason: "x", at: 3, coverageRatio: "0.5" }),
    ].join("\n"),
  ).events;
  assert.equal(events[0]?.coverageRatio, 0.5);
  assert.equal(events[1]?.coverageRatio, null);
  assert.equal(events[2]?.coverageRatio, undefined);
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
  const events = parseCoordinationLedger(
    [
      line({ runId: "A", kind: "outcome", action: "delegate", reason: "x", at: 1 }),
      line({ runId: "A", kind: "delegation", action: "delegate", reason: "x", at: 2 }),
      line({ runId: "B", kind: "outcome", action: "delegate", reason: "x", at: 3 }),
      line({ runId: "C", kind: "outcome", action: "direct", reason: "x", at: 4 }),
      line({ runId: "D", kind: "delegation", action: "delegate", reason: "x", at: 5 }),
    ].join("\n"),
  ).events;
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

test("readCoordinationLedger rethrows whatever the reader threw, even a non-Error value", () => {
  const errorMock = mock.method(console, "error", () => {});
  try {
    for (const thrown of ["disk gone", null]) {
      const fakeFs: CoordinationLedgerFsDeps = {
        openSync: () => {
          throw thrown;
        },
        fstatSync,
        readSync,
        closeSync,
      };
      assert.throws(() => readCoordinationLedger("/x/coordination-events.jsonl", {}, fakeFs), (err: unknown) => err === thrown);
    }
  } finally {
    errorMock.mock.restore();
  }
});

test("readCoordinationLedger: a filtered read of a ledger larger than one window but smaller than the next still finds the run's first event", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    const lines = [line({ runId: "target", kind: "proposal", reason: "first", at: 0 })];
    for (let i = 1; i <= 500; i++) lines.push(line({ runId: `other-${i}`, kind: "outcome", reason: "pipeline verdict=pass", finalOutcome: "pass", at: i }));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const size = statSync(path).size;
    assert.ok(size > 16 * 1024 && size < 128 * 1024, `fixture size ${size}B must sit between the first and second window`);

    const view = readCoordinationLedger(path, { runId: "target" });
    assert.deepEqual(view.events.map((e) => e.reason), ["first"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCoordinationLedger closes the ledger file it opened, whether the read succeeds or fails", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    writeFileSync(path, `${raw}\n`, "utf8");
    const opened: number[] = [];
    const closed: number[] = [];
    const tracking = (read: typeof readSync): CoordinationLedgerFsDeps => ({
      openSync: ((p: string, flags: string) => {
        const fd = openSync(p, flags);
        opened.push(fd);
        return fd;
      }) as typeof openSync,
      fstatSync,
      readSync: read,
      closeSync: (fd: number) => {
        closed.push(fd);
        closeSync(fd);
      },
    });
    readCoordinationLedger(path, {}, tracking(readSync));
    const failing = (() => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    }) as typeof readSync;
    const errorMock = mock.method(console, "error", () => {});
    try {
      assert.throws(() => readCoordinationLedger(path, {}, tracking(failing)), /i\/o error/);
    } finally {
      errorMock.mock.restore();
    }
    assert.equal(opened.length, 2);
    assert.deepEqual(closed, opened);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCoordinationLedger: a ledger that shrinks under the read (rotation) returns the bytes it got instead of spinning", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    writeFileSync(path, `${raw}\n`, "utf8");
    const realSize = statSync(path).size;
    const shrinking: CoordinationLedgerFsDeps = {
      openSync,
      /* fstat still reports the pre-rotation size, twice the bytes actually left on disk */
      fstatSync: ((fd: number) => ({ ...fstatSync(fd), size: realSize * 2 })) as unknown as typeof fstatSync,
      readSync,
      closeSync,
    };
    const view = readCoordinationLedger(path, {}, shrinking);
    assert.deepEqual(view.events, parseCoordinationLedger(raw).events);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkdtemp(): string {
  const dir = join(tmpdir(), `coord-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ── Ledger sweep: what the reader returns and the signals served from it, over the ledgers a process meets ── */

const outcome = (runId: string, at: number, action = "delegate") =>
  line({ runId, kind: "outcome", action, reason: "pipeline verdict=pass", finalOutcome: "pass", at });

test("ledger sweep: an absent or empty ledger is an empty view with unmeasured signals", () => {
  const dir = mkdtemp();
  try {
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "", "utf8");
    for (const path of [join(dir, "absent.jsonl"), empty]) {
      const view = readCoordinationLedger(path, {});
      assert.deepEqual(view, { events: [], truncated: false });
      assert.deepEqual(toCoordinationSignals(view.events), { measured: false, totalRuns: 0, delegateRuns: 0, contractFailureRate: null, avgDelegationMs: null });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger sweep: a ledger rotated at the writer's cap reads as its newest events", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    /* The writer rotates a ledger of 5001 events down to its newest 4000: events 1001..5000. */
    const first = 1001;
    const last = 5000;
    const lines: string[] = [];
    for (let i = first; i <= last; i++) lines.push(outcome(`r${i}`, i, i % 2 === 0 ? "delegate" : "direct"));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const page = readCoordinationLedger(path, {});
    assert.equal(page.truncated, true);
    assert.deepEqual(page.events.map((e) => e.runId), Array.from({ length: 200 }, (_, i) => `r${last - 199 + i}`));

    const widest = readCoordinationLedger(path, { limit: 5000 });
    assert.equal(widest.truncated, true, "the limit is clamped to 1000");
    assert.equal(widest.events.length, 1000);
    assert.equal(widest.events[0]?.runId, `r${last - 999}`);
    assert.equal(widest.events.at(-1)?.runId, `r${last}`);
    assert.deepEqual(toCoordinationSignals(widest.events), { measured: true, totalRuns: 1000, delegateRuns: 500, contractFailureRate: null, avgDelegationMs: null });

    const oldest = readCoordinationLedger(path, { runId: `r${first}` });
    assert.deepEqual(oldest.events.map((e) => e.runId), [`r${first}`], "a filtered read reaches the oldest event the rotation kept");
    assert.deepEqual(readCoordinationLedger(path, { runId: `r${first - 1}` }), { events: [], truncated: false }, "and none the rotation dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger sweep: malformed lines, unknown kinds and a partial last line are skipped, never fatal", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    const text = [
      outcome("a", 1),
      "",
      "not json at all",
      "[1,2,3]",
      "null",
      "42",
      line({ runId: "b", kind: "proposal", reason: "x", at: 2 }) + "\r",
      line({ runId: "c", kind: "future-kind", reason: "x", at: 3 }),
      line({ runId: "d", kind: "outcome", reason: "x" }),
      line({ runId: "e", kind: "delegation", reason: "kept", durationMs: -1, attempt: 2.7, coverageRatio: "high", at: 4 }),
      outcome("f", 5, "direct"),
    ].join("\n") + "\n" + `{"runId":"g","kind":"outcome","reason":"cut mid-wr`;
    writeFileSync(path, text, "utf8");

    const view = readCoordinationLedger(path, {});
    assert.deepEqual(view.events.map((e) => e.runId), ["a", "b", "e", "f"]);
    assert.equal(view.truncated, false);
    const delegation = view.events[2];
    assert.equal(delegation?.durationMs, undefined);
    assert.equal(delegation?.attempt, 2);
    assert.equal("coverageRatio" in (delegation ?? {}), false);
    assert.deepEqual(toCoordinationSignals(view.events), { measured: true, totalRuns: 2, delegateRuns: 1, contractFailureRate: 0, avgDelegationMs: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger sweep: lines far larger than the first read window keep their neighbours and their own content", () => {
  const dir = mkdtemp();
  try {
    const path = join(dir, "coordination-events.jsonl");
    const hugeReason = "x".repeat(300_000);
    const text = [
      outcome("small-before", 1),
      line({ runId: "huge", kind: "outcome", action: "delegate", reason: hugeReason, at: 2 }),
      "y".repeat(200_000),
      outcome("small-after", 3, "direct"),
    ].join("\n") + "\n";
    writeFileSync(path, text, "utf8");

    const all = readCoordinationLedger(path, {});
    assert.deepEqual(all.events.map((e) => e.runId), ["small-before", "huge", "small-after"]);
    assert.equal(all.events[1]?.reason, hugeReason);
    assert.deepEqual(toCoordinationSignals(all.events), { measured: true, totalRuns: 3, delegateRuns: 2, contractFailureRate: null, avgDelegationMs: null });

    const tail = readCoordinationLedger(path, { limit: 1 });
    assert.deepEqual(tail.events.map((e) => e.runId), ["small-after"]);
    assert.equal(tail.truncated, true);

    const filtered = readCoordinationLedger(path, { runId: "small-before" });
    assert.deepEqual(filtered.events.map((e) => e.runId), ["small-before"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

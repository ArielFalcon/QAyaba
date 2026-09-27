/* FileCoordinationTelemetryAdapter (infrastructure) persists coordination events to a durable JSONL
   sink and RELOADS them on a fresh instance so adaptive thresholds and the audit ledger survive
   process restarts. Memory-only remains available (absent path = same contract as the pure
   CoordinationTelemetryRecorder it wraps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileCoordinationTelemetryAdapter,
  MAX_LEDGER_EVENTS,
  ROTATE_TO_EVENTS,
  type CoordinationTelemetryFsDeps,
} from "@contexts/qa-run-orchestration/infrastructure/bridges/coordination-telemetry-port.adapter.ts";
import { deriveAdaptiveSignals, type CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";

function event(overrides: Partial<CoordinationTelemetryEvent>): CoordinationTelemetryEvent {
  return {
    runId: "r1",
    kind: "delegation",
    reason: "test",
    at: 1700000000000,
    ...overrides,
  };
}

test("with persistPath, events append to the JSONL file AND reload on a fresh instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-tel-"));
  const path = join(dir, "coordination-events.jsonl");
  const first = new FileCoordinationTelemetryAdapter(path);
  first.record(event({}));
  first.record(event({})); /* 2 delegations = adaptive sample reaches minSamples(2) */

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(JSON.parse(line) as CoordinationTelemetryEvent);

  const second = new FileCoordinationTelemetryAdapter(path);
  assert.equal(second.events.length, 2);
  const signals = deriveAdaptiveSignals(second.events, 2);
  assert.ok(signals, "reloaded events must feed adaptive signals");
  assert.equal(signals.recentEscalateRate, 0);
  second.record(event({ kind: "escalation", reason: "escalate-sidekick" }));
  const linesAfter = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(linesAfter.length, 3);
});

test("absent persistPath keeps the memory-only contract (no file writes)", () => {
  const store = new FileCoordinationTelemetryAdapter();
  store.record(event({}));
  assert.equal(store.events.length, 1);
});

test("the ledger is bounded — oldest entries rotate out of memory AND the file once the cap is crossed", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-tel-rotate-"));
  const path = join(dir, "coordination-events.jsonl");
  const adapter = new FileCoordinationTelemetryAdapter(path);
  const overflow = 37;
  for (let i = 0; i < MAX_LEDGER_EVENTS + overflow; i++) {
    adapter.record(event({ runId: `r${i}`, at: i }));
  }
  /* J2: rotation trims down to the lower ROTATE_TO_EVENTS watermark (not exactly the cap), and it
     triggers the instant the cap is crossed (consuming 1 of the overflow), so the ledger settles
     at ROTATE_TO_EVENTS + (overflow - 1) once that single rotation has fired. */
  const expected = ROTATE_TO_EVENTS + (overflow - 1);
  assert.equal(adapter.events.length, expected, "in-memory ledger must settle at the watermark plus events recorded since");
  assert.ok(adapter.events.length <= MAX_LEDGER_EVENTS, "the ledger must never exceed the cap after a rotation");

  const linesOnDisk = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(linesOnDisk.length, expected, "rotation must compact the FILE too, not just memory");

  const reloaded = new FileCoordinationTelemetryAdapter(path);
  assert.equal(reloaded.events.length, expected, "a fresh boot must reload the bounded (not unbounded) file");
});

/* J2: rotateIfOverCap used to trim to exactly MAX_LEDGER_EVENTS, so every record() past the cap
   re-triggered a full synchronous file rewrite (writeFileSync + renameSync). Trimming down to a
   lower watermark (ROTATE_TO_EVENTS) means the next (MAX_LEDGER_EVENTS - ROTATE_TO_EVENTS) records
   grow the ledger organically (plain appendFileSync) without another full rewrite. */
test("J2: after crossing the cap, the next records within the slack window do not re-rewrite the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-tel-slack-"));
  const path = join(dir, "coordination-events.jsonl");
  let rewriteCount = 0;
  const countingFs: CoordinationTelemetryFsDeps = {
    appendFileSync: ((...args: Parameters<typeof appendFileSync>) => appendFileSync(...args)) as typeof appendFileSync,
    readFileSync: ((...args: Parameters<typeof readFileSync>) => readFileSync(...args)) as typeof readFileSync,
    writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
      rewriteCount++;
      return writeFileSync(...args);
    }) as typeof writeFileSync,
    renameSync: ((...args: Parameters<typeof renameSync>) => renameSync(...args)) as typeof renameSync,
  };
  const adapter = new FileCoordinationTelemetryAdapter(path, countingFs);
  for (let i = 0; i < MAX_LEDGER_EVENTS; i++) adapter.record(event({ runId: `r${i}`, at: i }));
  assert.equal(rewriteCount, 0, "no rotation must have happened yet — the ledger has not exceeded the cap");

  /* Crossing the cap by exactly one event triggers the single rotation down to the watermark. */
  adapter.record(event({ runId: "cross", at: MAX_LEDGER_EVENTS }));
  assert.equal(rewriteCount, 1, "crossing the cap must trigger exactly one rotation/rewrite");

  const slack = MAX_LEDGER_EVENTS - ROTATE_TO_EVENTS;
  for (let i = 0; i < slack - 1; i++) {
    adapter.record(event({ runId: `slack${i}`, at: i }));
  }
  assert.equal(rewriteCount, 1, "records within the slack window after a rotation must not re-rewrite the file");
});

test("a corrupt tail line is skipped, earlier valid lines survive reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-tel-"));
  const path = join(dir, "coordination-events.jsonl");
  writeFileSync(path, `${JSON.stringify(event({}))}\n{"kind":"trunc\n`);
  const reloaded = new FileCoordinationTelemetryAdapter(path);
  assert.equal(reloaded.events.length, 1);
  writeFileSync(path, `${JSON.stringify(event({ kind: "outcome" }))}\n`, { flag: "a" });
  const survival = reloaded.events[0];
  assert.ok(survival, "expected the valid event to survive the corrupt tail");
  assert.equal(survival.kind, "delegation");
});

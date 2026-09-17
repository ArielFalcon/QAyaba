/* and RELOADS them on a fresh instance so shadow-divergence evidence and adaptive thresholds
   survive process restarts. Memory-only remains the default (absent path = old behavior).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCoordinationTelemetry, type CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";
import { deriveAdaptiveSignals } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";

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
  const first = new InMemoryCoordinationTelemetry(path);
  first.record(event({}));
  first.record(event({})); /* 2 delegations = adaptive sample reaches minSamples(2) */

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(JSON.parse(line) as CoordinationTelemetryEvent);

  const second = new InMemoryCoordinationTelemetry(path);
  assert.equal(second.events.length, 2);
  const signals = deriveAdaptiveSignals(second.events, 2);
  assert.ok(signals, "reloaded events must feed adaptive signals");
  assert.equal(signals.recentEscalateRate, 0);
  second.record(event({ kind: "escalation", reason: "escalate-sidekick" }));
  const linesAfter = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(linesAfter.length, 3);
});

test("absent persistPath keeps the memory-only contract (no file writes)", () => {
  const store = new InMemoryCoordinationTelemetry();
  store.record(event({}));
  assert.equal(store.events.length, 1);
});

test("a corrupt tail line is skipped, earlier valid lines survive reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-tel-"));
  const path = join(dir, "coordination-events.jsonl");
  writeFileSync(path, `${JSON.stringify(event({}))}\n{"kind":"trunc\n`);
  const reloaded = new InMemoryCoordinationTelemetry(path);
  assert.equal(reloaded.events.length, 1);
  writeFileSync(path, `${JSON.stringify(event({ kind: "outcome" }))}\n`, { flag: "a" });
  const survival = reloaded.events[0];
  assert.ok(survival, "expected the valid event to survive the corrupt tail");
  assert.equal(survival.kind, "delegation");
});

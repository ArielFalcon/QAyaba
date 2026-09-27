/* Reproducible benchmark cases. Measured verdict, latency, and delegation counts
   come from coordination telemetry JSONL. The case list does not store those numbers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareTelemetrySamples,
  loadCoordinationBenchmarkCases,
  sampleFromTelemetry,
} from "./coordination-benchmark.ts";
import type { CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";

const EXAMPLE_CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "benchmarks", "coordination-cases.example.json");

test("loadCoordinationBenchmarkCases: the tracked example set is a well-formed benchmark (covers at least two apps, three cases each)", () => {
  const cases = loadCoordinationBenchmarkCases(EXAMPLE_CASES_PATH);
  const byApp = new Map<string, number>();
  for (const c of cases) {
    assert.match(c.sha, /^[0-9a-f]{7,40}$/);
    assert.ok(c.app.length > 0);
    assert.ok(c.repo.includes("/"));
    assert.ok(c.change.length > 0);
    assert.ok(c.expectedBehavior.length > 0);
    assert.ok(c.expectedRegression.length > 0);
    assert.ok(Array.isArray(c.relevantFiles));
    byApp.set(c.app, (byApp.get(c.app) ?? 0) + 1);
  }
  assert.ok(byApp.size >= 2);
  for (const count of byApp.values()) assert.ok(count >= 3);
});

test("loadCoordinationBenchmarkCases: a missing cases file throws a loud, actionable error (never a silent empty benchmark)", () => {
  assert.throws(
    () => loadCoordinationBenchmarkCases("/nonexistent/coordination-cases.json"),
    /coordination benchmark cases not found at .*coordination-cases\.example\.json/,
  );
});

test("loadCoordinationBenchmarkCases: a malformed cases file (not an array of well-formed cases) throws loudly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coordination-benchmark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "coordination-cases.json");
  writeFileSync(badPath, JSON.stringify([{ id: "missing-fields" }]));
  assert.throws(() => loadCoordinationBenchmarkCases(badPath), /must be a JSON array of CoordinationBenchmarkCase objects/);
});

test("two telemetry samples compare verdict and latency without a hand-written narrative", () => {
  const baseline: CoordinationTelemetryEvent[] = [
    {
      runId: "base-1",
      kind: "outcome",
      reason: "pipeline verdict=pass",
      finalOutcome: "pass",
      reviewOutcome: "approved",
      durationMs: 400,
      at: 1,
    },
  ];
  const candidate: CoordinationTelemetryEvent[] = [
    {
      runId: "cand-1",
      kind: "proposal",
      action: "delegate",
      reason: "change analysis suggests sidekick",
      at: 1,
    },
    {
      runId: "cand-1",
      kind: "delegation",
      reason: "sidekick status=completed",
      durationMs: 110,
      at: 2,
    },
    {
      runId: "cand-1",
      kind: "outcome",
      reason: "pipeline verdict=pass",
      finalOutcome: "pass",
      reviewOutcome: "approved",
      durationMs: 160,
      at: 3,
    },
  ];
  const comparison = compareTelemetrySamples(
    sampleFromTelemetry(candidate),
    sampleFromTelemetry(baseline),
  );
  assert.equal(comparison.sameVerdict, true);
  assert.equal(comparison.candidateDelegated, true);
  assert.equal(comparison.latencyDeltaMs, 160 - 400);
});

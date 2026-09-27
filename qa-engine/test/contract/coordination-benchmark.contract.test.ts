/* Reproducible benchmark cases. Measured verdict, latency, and delegation counts
   come from coordination telemetry JSONL. The case list does not store those numbers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COORDINATION_BENCHMARK_CASES,
  compareTelemetrySamples,
  sampleFromTelemetry,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";
import type { CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";

test("the benchmark set covers at least two apps and three diffs each", () => {
  const byApp = new Map<string, number>();
  for (const c of COORDINATION_BENCHMARK_CASES) {
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
  const bio = COORDINATION_BENCHMARK_CASES.find((c) => c.id === "portfolio-bio");
  assert.ok(bio);
  assert.ok(bio.relevantFiles.includes("src/data/cv.json") || bio.relevantFiles.some((f) => f.endsWith("cv.json")));
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

/*
 * Reproducible coordination benchmark. A case names a real commit of a real watched repo — that
 * is USER DATA (CLAUDE.md: "App-specificity lives only in config/"), never engine code, so cases
 * are loaded from config/benchmarks/coordination-cases.json (gitignored) rather than hardcoded
 * here. config/benchmarks/coordination-cases.example.json ships tracked, with neutral placeholder
 * values, as the onboarding template (same pattern as config/apps/example.yaml).
 *
 * Verdict, latency, and delegation counts are read from coordination telemetry JSONL via
 * sampleFromTelemetry — they are not stored on the case.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoordinationTelemetryEvent } from "@contexts/qa-run-orchestration/application/coordination/coordination-telemetry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultCoordinationBenchmarkCasesPath(): string {
  return join(ROOT, "config", "benchmarks", "coordination-cases.json");
}

export interface CoordinationBenchmarkCase {
  readonly id: string;
  readonly app: string;
  readonly repo: string;
  readonly sha: string;
  readonly change: string;
  readonly expectedBehavior: string;
  readonly relevantFiles: readonly string[];
  readonly expectedRegression: string;
}

function isCoordinationBenchmarkCase(raw: unknown): raw is CoordinationBenchmarkCase {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Partial<CoordinationBenchmarkCase>;
  return (
    typeof c.id === "string" &&
    typeof c.app === "string" &&
    typeof c.repo === "string" &&
    typeof c.sha === "string" &&
    typeof c.change === "string" &&
    typeof c.expectedBehavior === "string" &&
    typeof c.expectedRegression === "string" &&
    Array.isArray(c.relevantFiles) &&
    c.relevantFiles.every((f) => typeof f === "string")
  );
}

/**
 * Loads and form-validates the benchmark case set from a JSON file (defaults to the gitignored
 * config/benchmarks/coordination-cases.json). Throws loudly — a malformed or missing case file is
 * a setup error the caller should see, never a silent empty benchmark.
 */
export function loadCoordinationBenchmarkCases(path: string = defaultCoordinationBenchmarkCasesPath()): readonly CoordinationBenchmarkCase[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `coordination benchmark cases not found at ${path} — copy config/benchmarks/coordination-cases.example.json to config/benchmarks/coordination-cases.json and fill in real cases (repo/sha/expected behavior) to run the benchmark: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isCoordinationBenchmarkCase)) {
    throw new Error(`${path} must be a JSON array of CoordinationBenchmarkCase objects (id/app/repo/sha/change/expectedBehavior/relevantFiles/expectedRegression)`);
  }
  return parsed;
}

export interface CoordinationRunSample {
  readonly finalOutcome?: string;
  readonly reviewOutcome?: string;
  readonly latencyMs?: number;
  readonly delegations: number;
  readonly escalations: number;
}

export function sampleFromTelemetry(events: readonly CoordinationTelemetryEvent[]): CoordinationRunSample {
  const outcome = [...events].reverse().find((event) => event.kind === "outcome");
  return {
    ...(outcome?.finalOutcome !== undefined ? { finalOutcome: outcome.finalOutcome } : {}),
    ...(outcome?.reviewOutcome !== undefined ? { reviewOutcome: outcome.reviewOutcome } : {}),
    ...(typeof outcome?.durationMs === "number" ? { latencyMs: outcome.durationMs } : {}),
    delegations: events.filter((event) => event.kind === "delegation").length,
    escalations: events.filter((event) => event.kind === "escalation").length,
  };
}

export interface TelemetrySampleComparison {
  readonly sameVerdict: boolean;
  /** Candidate latency minus baseline latency. Null when either sample has no outcome duration. */
  readonly latencyDeltaMs: number | null;
  readonly candidateDelegated: boolean;
}

export function compareTelemetrySamples(
  candidate: CoordinationRunSample,
  baseline: CoordinationRunSample,
): TelemetrySampleComparison {
  const latencyDeltaMs =
    typeof candidate.latencyMs === "number" && typeof baseline.latencyMs === "number"
      ? candidate.latencyMs - baseline.latencyMs
      : null;
  return {
    sameVerdict:
      candidate.finalOutcome !== undefined && candidate.finalOutcome === baseline.finalOutcome,
    latencyDeltaMs,
    candidateDelegated: candidate.delegations > 0,
  };
}

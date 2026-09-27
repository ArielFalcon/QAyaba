/* Reproducible coordination benchmark. Cases name real commits. Verdict, latency,
   and delegation counts are read from coordination telemetry JSONL via
   sampleFromTelemetry — they are not stored on the case. */
import type { CoordinationTelemetryEvent } from "./coordination-telemetry.ts";

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

/* File names for portfolio-bio are the ones the 2026-09-16 probe recorded.
   Other cases leave relevantFiles empty until a run records the diff. */
export const COORDINATION_BENCHMARK_CASES: readonly CoordinationBenchmarkCase[] = [
  {
    id: "portfolio-bio",
    app: "portfolio",
    repo: "ArielFalcon/portfolio",
    sha: "8d703ca290ab68eefb7faf7a9c408d4f3cf00939",
    change: "chore: updated bio",
    expectedBehavior: "Featured project card, highlight items as icon plus text, removed project absent, hero width holds.",
    relevantFiles: [
      "cv.json",
      "Projects.astro",
      "Hero.astro",
      "Layout.astro",
      "index.astro",
      "cv.d.ts",
      "neovim/projects.astro",
    ],
    expectedRegression: "A removed project still renders, or a highlight object renders as [object Object].",
  },
  {
    id: "portfolio-printed-cv",
    app: "portfolio",
    repo: "ArielFalcon/portfolio",
    sha: "26614bdc309a",
    change: "fix: improved printed cv",
    expectedBehavior: "The printed CV reflects the fix.",
    relevantFiles: [],
    expectedRegression: "Print layout or on-screen CV content regresses.",
  },
  {
    id: "portfolio-cv-update",
    app: "portfolio",
    repo: "ArielFalcon/portfolio",
    sha: "2478e975917e",
    change: "chore: updated cv",
    expectedBehavior: "CV content matches the update.",
    relevantFiles: [],
    expectedRegression: "A stale CV section still renders.",
  },
  {
    id: "petclinic-vector-store",
    app: "petclinic",
    repo: "spring-petclinic/spring-petclinic-microservices",
    sha: "aefaf7fa9eb0",
    change: "Fix GenAI vector store loading from JAR",
    expectedBehavior: "The vector store loads when the service runs from a JAR.",
    relevantFiles: [],
    expectedRegression: "Startup fails or retrieval is empty once the app is packaged.",
  },
  {
    id: "petclinic-gateway-405",
    app: "petclinic",
    repo: "spring-petclinic/spring-petclinic-microservices",
    sha: "295fa8d5ee10",
    change: "Fix 405 errors from api-gateway",
    expectedBehavior: "Gateway routes that returned 405 succeed.",
    relevantFiles: [],
    expectedRegression: "Another gateway route starts failing.",
  },
  {
    id: "petclinic-pet-not-found",
    app: "petclinic",
    repo: "spring-petclinic/spring-petclinic-microservices",
    sha: "3858f9c630cf",
    change: "Add missing pet not found web test",
    expectedBehavior: "The missing-pet page is covered by a web test.",
    relevantFiles: [],
    expectedRegression: "The new test fails against the live UI, or a real 404 gap stays hidden.",
  },
];

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

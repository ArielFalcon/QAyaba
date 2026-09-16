// Process-lifetime coordination telemetry so adaptive thresholds and cross-run signals
// survive composition-per-run rebuilds while COORDINATION_MODE is on. With a persistPath the
// store also survives process restarts (JSONL reload) — the shadow-divergence evidence base.
import { InMemoryCoordinationTelemetry } from "./coordination-telemetry.ts";

let shared: InMemoryCoordinationTelemetry | undefined;

export function getSharedCoordinationTelemetry(persistPath?: string): InMemoryCoordinationTelemetry {
  if (!shared) shared = new InMemoryCoordinationTelemetry(persistPath);
  return shared;
}

/** Test-only: reset shared store between suites. */
export function resetSharedCoordinationTelemetryForTests(): void {
  shared = undefined;
}

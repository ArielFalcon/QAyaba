import type { CoordinationPort } from "../ports/coordination.port.ts";
import {
  DEFAULT_ADAPTIVE_POLICY,
  type AdaptiveRoutingPolicy,
} from "./adaptive-routing.ts";
import {
  deriveAdaptiveSignals,
  type CoordinationTelemetryEvent,
} from "./coordination-telemetry.ts";
import { ProposingCoordinationAdapter } from "./proposing-coordination.adapter.ts";

export interface CreateCoordinationPortOpts {
  /** When set, proposer reads adaptive signals from recent events (Fase 14). */
  readonly telemetry?: { readonly events: readonly CoordinationTelemetryEvent[] };
  readonly policy?: AdaptiveRoutingPolicy;
  /** Minimum telemetry samples before adaptive thresholds apply (default 5). */
  readonly adaptiveMinSamples?: number;
}

// Coordination is the single operating mode (granular modes were removed with probe
// evidence 2026-09-16: complete E2E chain validated against a live app). The adaptive
// policy only raises the file threshold — it never bypasses budgets, gates, reviewer,
// FixLoop, or authority; fail-open paths inside RunQaUseCase remain the real safety net.
export function createCoordinationPort(
  opts: CreateCoordinationPortOpts = {},
): CoordinationPort {
  const telemetry = opts.telemetry;
  const policy = opts.policy ?? DEFAULT_ADAPTIVE_POLICY;
  const minSamples = opts.adaptiveMinSamples ?? 5;
  return new ProposingCoordinationAdapter({
    policy,
    signals: telemetry
      ? () => deriveAdaptiveSignals(telemetry.events, minSamples)
      : undefined,
  });
}

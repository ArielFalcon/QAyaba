import type { CoordinationPort } from "../ports/coordination.port.ts";
import {
  DEFAULT_ADAPTIVE_POLICY,
  type AdaptiveRoutingPolicy,
} from "./adaptive-routing.ts";
import type { CoordinationMode } from "./coordination-mode.ts";
import {
  deriveAdaptiveSignals,
  type CoordinationTelemetryEvent,
} from "./coordination-telemetry.ts";
import { OffCoordinationAdapter } from "./off-coordination.adapter.ts";
import { ProposingCoordinationAdapter } from "./proposing-coordination.adapter.ts";

export interface CreateCoordinationPortOpts {
  /** When set, proposer reads adaptive signals from recent events (Fase 14). */
  readonly telemetry?: { readonly events: readonly CoordinationTelemetryEvent[] };
  readonly policy?: AdaptiveRoutingPolicy;
  /** Minimum telemetry samples before adaptive thresholds apply (default 5). */
  readonly adaptiveMinSamples?: number;
}

export function createCoordinationPort(
  mode: CoordinationMode = "off",
  opts: CreateCoordinationPortOpts = {},
): CoordinationPort {
  if (mode === "off") return new OffCoordinationAdapter();
  // shadow + active share the deterministic proposer; RunQaUseCase treats shadow as advisory-only
  // and only honors active at explicitly enabled points (Fase 13). Adaptive policy only raises
  // the file threshold — it never bypasses budgets, gates, reviewer, FixLoop, or authority.
  const telemetry = opts.telemetry;
  const policy = opts.policy ?? DEFAULT_ADAPTIVE_POLICY;
  const minSamples = opts.adaptiveMinSamples ?? 5;
  return new ProposingCoordinationAdapter(mode, {
    policy,
    signals: telemetry
      ? () => deriveAdaptiveSignals(telemetry.events, minSamples)
      : undefined,
  });
}

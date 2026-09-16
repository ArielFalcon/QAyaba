// Coordination telemetry (Fase 11). Records cost/decision signals without owning pipeline verdicts.
// Token/cost aggregation stays on AgentRuntimePort (onUsage/onTurn) — this port never double-counts.
import type { AgentCapability } from "./agent-capability.ts";
import type { CoordinationAction } from "./coordination-decision.ts";
import type { CoordinationMode } from "./coordination-mode.ts";
import type { AdaptiveRoutingSignals } from "./adaptive-routing.ts";
import type { OrchestrationAction } from "./orchestration-router.ts";

export type CoordinationTelemetryKind =
  | "proposal"
  | "delegation"
  | "escalation"
  | "router"
  | "pushback"
  | "outcome";

export interface CoordinationTelemetryEvent {
  readonly runId: string;
  readonly mode: CoordinationMode;
  readonly kind: CoordinationTelemetryKind;
  readonly action?: CoordinationAction | OrchestrationAction;
  readonly capability?: AgentCapability;
  readonly reason: string;
  readonly durationMs?: number;
  readonly at: number;
  /** DelegationBrief.id when kind is delegation/escalation. */
  readonly delegationId?: string;
  /** 1-based attempt within the run for this capability/point. */
  readonly attempt?: number;
  readonly failureClass?: string;
  readonly progressFingerprint?: string;
  /** Pipeline verdict when kind is outcome. */
  readonly finalOutcome?: string;
  /** Reviewer approved/rejected/skipped when kind is outcome. */
  readonly reviewOutcome?: "approved" | "rejected" | "skipped" | "n/a";
  /** Escalation events observed in this process window before this record. */
  readonly escalations?: number;
}

export interface CoordinationTelemetryPort {
  record(event: CoordinationTelemetryEvent): void;
}

export class InMemoryCoordinationTelemetry implements CoordinationTelemetryPort {
  readonly events: CoordinationTelemetryEvent[] = [];
  record(event: CoordinationTelemetryEvent): void {
    this.events.push(event);
  }
}

/** Derive adaptive signals from recent telemetry. Undefined when sample is too small. */
export function deriveAdaptiveSignals(
  events: readonly CoordinationTelemetryEvent[],
  minSamples = 5,
): AdaptiveRoutingSignals | undefined {
  const delegations = events.filter((e) => e.kind === "delegation");
  const escalations = events.filter((e) => e.kind === "escalation");
  const outcomes = events.filter((e) => e.kind === "outcome");
  const sample = Math.max(delegations.length, outcomes.length, escalations.length);
  if (sample < minSamples) return undefined;

  const denom = Math.max(delegations.length, 1);
  const recentEscalateRate = escalations.length / denom;
  const noProgress = escalations.filter((e) => /no progress/i.test(e.reason)).length;
  const recentNoProgressRate = noProgress / Math.max(escalations.length, 1);
  const timed = delegations.filter((e) => typeof e.durationMs === "number");
  const avgDelegationMs = timed.length
    ? timed.reduce((s, e) => s + (e.durationMs ?? 0), 0) / timed.length
    : 0;
  return { recentEscalateRate, recentNoProgressRate, avgDelegationMs };
}

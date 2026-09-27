/* Coordination telemetry. Records cost/decision signals without owning pipeline verdicts. Token/cost aggregation stays on AgentRuntimePort (onUsage/onTurn) — this port never double-counts.
Pure in-memory here by design: durable (JSONL) persistence is an infrastructure concern and lives
in FileCoordinationTelemetryAdapter (infrastructure/bridges/coordination-telemetry-port.adapter.ts),
which wraps CoordinationTelemetryRecorder below and implements the SAME CoordinationTelemetryPort. */
import type { AgentCapability } from "./agent-capability.ts";
import type { CoordinationAction } from "./coordination-decision.ts";
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
  /** Watched app this event belongs to — lets adaptive signals and audits scope per app instead of mixing the whole fleet. Optional for backward compatibility with ledger lines recorded before this field existed. */
  readonly app?: string;

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
  /** Quality sampled at outcome time (deterministic ports — never invented). */
  readonly valueScore?: number;
  readonly coverageRatio?: number | null;
  /** Escalation events observed in this process window before this record. */
  readonly escalations?: number;
}

export interface CoordinationTelemetryPort {
  record(event: CoordinationTelemetryEvent): void;
}

/* Pure, process-lifetime, memory-only recorder — no fs, no sanitization side effects of its own.
   Any redaction/persistence policy is the caller's (or a wrapping adapter's) responsibility, so this
   class does exactly one thing: record. */
export class CoordinationTelemetryRecorder implements CoordinationTelemetryPort {
  readonly events: CoordinationTelemetryEvent[] = [];

  record(event: CoordinationTelemetryEvent): void {
    this.events.push(event);
  }
}

export interface DeriveAdaptiveSignalsOptions {
  /** Scope derivation to one app's own events. Absent = fleet-wide (legacy, all apps mixed). */
  readonly app?: string;
  /** Bounded recent window (last N events, applied AFTER app scoping) — keeps the "recent*" fields
   * about recent events rather than the whole all-time events array, and bounds the cost of a
   * long-lived process's telemetry sample. */
  readonly windowSize?: number;
}

/** Last-N-events default window for adaptive signal derivation — see DeriveAdaptiveSignalsOptions. */
export const DEFAULT_ADAPTIVE_WINDOW_SIZE = 200;

/** Derive adaptive signals from a bounded recent window of telemetry. Undefined when sample is too small. */
export function deriveAdaptiveSignals(
  events: readonly CoordinationTelemetryEvent[],
  minSamples = 5,
  opts: DeriveAdaptiveSignalsOptions = {},
): AdaptiveRoutingSignals | undefined {
  const { app, windowSize = DEFAULT_ADAPTIVE_WINDOW_SIZE } = opts;
  const scoped = app ? events.filter((e) => e.app === app) : events;
  const windowed = scoped.slice(-windowSize);

  const delegations = windowed.filter((e) => e.kind === "delegation");
  const escalations = windowed.filter((e) => e.kind === "escalation");
  const outcomes = windowed.filter((e) => e.kind === "outcome");
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

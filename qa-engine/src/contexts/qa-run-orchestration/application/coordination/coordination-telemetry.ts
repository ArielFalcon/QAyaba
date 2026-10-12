/* Coordination telemetry. Records the decisions of the lead/sidekick mode and what became of them, without owning pipeline verdicts. Token/cost aggregation stays on AgentRuntimePort (onUsage/onTurn) — this port never double-counts.
Pure in-memory here by design: durable (JSONL) persistence is an infrastructure concern and lives
in FileCoordinationTelemetryAdapter (infrastructure/bridges/coordination-telemetry-port.adapter.ts),
which wraps CoordinationTelemetryRecorder below and implements the SAME CoordinationTelemetryPort. */
import type { AgentCapability } from "./agent-capability.ts";
import type { CoordinationAction } from "./coordination-decision.ts";
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

/* Coordination telemetry. Records the decisions of the lead/sidekick mode and what became of them, without owning pipeline verdicts. Token/cost aggregation stays on AgentRuntimePort (onUsage/onTurn) — this port never double-counts.
Pure in-memory here by design: durable (JSONL) persistence is an infrastructure concern and lives
in FileCoordinationTelemetryAdapter (infrastructure/adapters/coordination-telemetry-port.adapter.ts),
which wraps CoordinationTelemetryRecorder below and implements the SAME CoordinationTelemetryPort. */
import type { SidekickKind, SidekickTier } from "./sidekick-kinds.ts";
import type { CoordinationAction } from "./coordination-decision.ts";
import type { ContextFit } from "@kernel/context-budget.ts";

/* The actions an event of the lead names: a sidekick's escalation, a stop for a human; ledger lines recorded earlier also hold accept, retry-sidekick and continue-fix-loop. */
export type LeadDecisionAction = "accept" | "retry-sidekick" | "escalate-sidekick" | "abort-human" | "continue-fix-loop";

export type CoordinationTelemetryKind =
  | "proposal"
  | "delegation"
  | "escalation"
  | "lead-decision"
  | "pushback"
  | "outcome";

/* How a correction turn's findings were routed, one count per route; the counts add up to at most the turn's findings (a rebutted finding is in none). */
export interface CoordinationRouteCounts {
  readonly spec: number;
  readonly candidate: number;
  readonly lead: number;
  readonly candidateFlow: number;
  readonly unrouted: number;
}

export interface CoordinationTelemetryEvent {
  readonly runId: string;
  /** Watched app this event belongs to — lets adaptive signals and audits scope per app instead of mixing the whole fleet. Optional for backward compatibility with ledger lines recorded before this field existed. */
  readonly app?: string;

  readonly kind: CoordinationTelemetryKind;
  readonly action?: CoordinationAction | LeadDecisionAction;
  /** The kind of sidekick the event is about, and the capacity it ran at. */
  readonly sidekickKind?: SidekickKind;
  readonly tier?: SidekickTier;
  readonly reason: string;
  readonly durationMs?: number;
  readonly at: number;
  /** DelegationBrief.id when kind is delegation/escalation. */
  readonly delegationId?: string;
  /** 1-based attempt within the run for this kind/point. */
  readonly attempt?: number;
  readonly failureClass?: string;
  readonly progressFingerprint?: string;
  /** What the sidekick reported its turn came to (its DelegationStatus), when kind is delegation. */
  readonly sidekickStatus?: string;
  /** How the flow's last run_spec call ended when the sidekick reported, when kind is delegation and the flow called it. */
  readonly lastRunSpec?: string;
  /** The flow the event is about, and the ids of the use cases it covers (bounded by the exporter). */
  readonly flowId?: string;
  readonly candidateIds?: readonly string[];
  /** What produced the correction the event is about (a `CorrectionOrigin`). */
  readonly origin?: string;
  /** A correction turn's findings and how each was routed: by the spec it names, by the changed file that seeds a use case, by the lead's order, by a flow opened for a use case, or not at all. */
  readonly findings?: number;
  readonly routes?: CoordinationRouteCounts;
  /** Why findings stayed unrouted, as distinct codes. */
  readonly unroutedReasons?: readonly string[];
  /** The bases of the plan's drops, and whether the run's facts contradicted them. */
  readonly dropBases?: readonly string[];
  readonly dropContradicted?: boolean;
  /** The flows the run could author when its plan was admitted, the flows past it that were not admitted, and the admitted flows too large for one author's window, by id. */
  readonly capacity?: number;
  readonly notAdmitted?: readonly string[];
  readonly oversize?: readonly string[];
  /** The flows not sent because their minimal brief was over the author's known window, by id, and the fit that brief was judged by (prompt tokens, window, working room). */
  readonly overWindow?: readonly string[];
  readonly contextFit?: ContextFit;
  /** What the lead decided about a flow (accept, revise, replace, drop), whether the orchestrator did not take it as given, and the code of why. */
  readonly decision?: string;
  readonly overridden?: boolean;
  readonly overrideReason?: string;
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

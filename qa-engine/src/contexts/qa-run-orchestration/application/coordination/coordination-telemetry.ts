/* Coordination telemetry. Records cost/decision signals without owning pipeline verdicts. Token/cost aggregation stays on AgentRuntimePort (onUsage/onTurn) — this port never double-counts. */
import { appendFileSync, readFileSync } from "node:fs";
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

export class InMemoryCoordinationTelemetry implements CoordinationTelemetryPort {
  readonly events: CoordinationTelemetryEvent[] = [];
  private readonly persistPath: string | undefined;
  private warnedPersistFailure = false;

  /* persistPath: optional durable sink (JSONL, one event per line). Without it the store is process-lifetime only. When present, events are appended live and reloaded at construction so adaptive thresholds survive process restarts. */
  constructor(persistPath?: string) {
    this.persistPath = persistPath ? this.normalize(persistPath) : undefined;
    if (this.persistPath) this.rehydrate();
  }
  record(event: CoordinationTelemetryEvent): void {
    this.events.push(event);
    if (this.persistPath) this.persist(event);
  }
  private normalize(path: string): string {
    return path.replace(/\\/g, "/");
  }
  private rehydrate(): void {
    try {
      const raw = readFileSync(this.persistPath!, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.events.push(JSON.parse(trimmed) as CoordinationTelemetryEvent);
        } catch {
          /* Corrupt/partial tail line: skip it, never fail startup or previous runs' data. */
        }
      }
    } catch {
      /* Absent file on first boot is the normal cold-start case — not an error. */
    }
  }
  private persist(event: CoordinationTelemetryEvent): void {
    try {
      appendFileSync(this.persistPath!, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
      this.warnedPersistFailure = false;
    } catch (err) {
      /* Telemetry is observational: a sink failure must never break the QA run, but it must not stay silent (surface integration errors loudly). Warn once per burst, reset on the next success. */
      if (!this.warnedPersistFailure) {
        this.warnedPersistFailure = true;
        console.error(
          `[qa] coordination telemetry persist failed (events kept in memory only): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

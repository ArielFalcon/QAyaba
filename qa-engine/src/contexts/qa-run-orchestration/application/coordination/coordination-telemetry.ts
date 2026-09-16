// Coordination telemetry (Fase 11). Records cost/decision signals without owning pipeline verdicts.
import type { AgentCapability } from "./agent-capability.ts";
import type { CoordinationAction } from "./coordination-decision.ts";
import type { CoordinationMode } from "./coordination-mode.ts";
import type { OrchestrationAction } from "./orchestration-router.ts";

export interface CoordinationTelemetryEvent {
  readonly runId: string;
  readonly mode: CoordinationMode;
  readonly kind: "proposal" | "delegation" | "escalation" | "router" | "pushback";
  readonly action?: CoordinationAction | OrchestrationAction;
  readonly capability?: AgentCapability;
  readonly reason: string;
  readonly durationMs?: number;
  readonly at: number;
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

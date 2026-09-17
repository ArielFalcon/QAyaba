/* The orchestrator reads time only through this port; tests inject a fixed clock so RunOutcome.at is deterministic. */

export interface ClockPort {
  nowMs(): number;
  nowIso(): string;
}

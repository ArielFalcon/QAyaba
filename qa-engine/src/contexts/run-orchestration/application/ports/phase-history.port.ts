import type { RunMode } from "@kernel/run-mode.ts";
import type { PhaseRecord } from "../../domain/run-deadline.ts";

/**
 * The phases of an app's recent finished runs: how far each got and how long it spent in every phase it entered. The run deadline
 * reads it once, when it is armed, to know what the phases after the one asking will need. Newest first.
 */
export interface PhaseHistoryPort {
  recentPhaseRecords(query: { app: string; mode: RunMode; limit: number }): Promise<readonly PhaseRecord[]>;
}

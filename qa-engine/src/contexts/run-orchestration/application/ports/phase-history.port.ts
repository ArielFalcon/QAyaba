import type { RunTimeBudgetKey } from "../../domain/run-time-budget.ts";
import type { PhaseRecord } from "../../domain/run-deadline.ts";

/**
 * The phases of an app's recent finished runs of one kind (the row of the run time budget they were bounded as: a tiny change's runs are
 * not a broad one's): how far each got, how long it spent in every phase it entered and the purposes its deadline cut. The run deadline
 * reads it once, when it is armed, to know what the phases after the one asking will need. Newest first.
 */
export interface PhaseHistoryPort {
  recentPhaseRecords(query: { app: string; budget: RunTimeBudgetKey; limit: number }): Promise<readonly PhaseRecord[]>;
}

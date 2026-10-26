import type { RunOutcome } from "@kernel/run-outcome.ts";

/** Persistence seam for the completed RunOutcome. */
export interface RunHistoryPort {
  save(outcome: RunOutcome): Promise<void>;
}

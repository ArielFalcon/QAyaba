/* The shell's side of PlanSnapshotPort: a run's plan goes into the run history's run_plans table. Total: a fault is logged and the run goes on. */

import type { PlanSnapshot, PlanSnapshotPort } from "@kernel/ports/plan-snapshot.port";
import { getHistory } from "./persistence/index";

export class SqlitePlanSnapshotAdapter implements PlanSnapshotPort {
  constructor(private readonly commit: (runId: string, plan: string, recordedAt: number) => void = (runId, plan, recordedAt) => getHistory().runs.commitRunPlan(runId, plan, recordedAt)) {}

  record(snapshot: PlanSnapshot): void {
    try {
      this.commit(snapshot.runId, JSON.stringify(snapshot), snapshot.recordedAt);
    } catch (err) {
      console.error(`[qa] the run's plan could not be stored (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

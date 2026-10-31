import type { RunOutcome } from "@kernel/run-outcome.ts";

/** Off-path, fault-isolated. Absent means the audit never runs. This context never imports src/. */
export interface ProcessAuditPort {
  audit(outcome: RunOutcome): Promise<void>;
}

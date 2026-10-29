import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { FaultAim } from "../../domain/fault-injection-score.ts";
import type { ValueOracleResult } from "../../domain/coverage-collector.ts";

/** Signal-only: a null valueScore never gates publish. The oracle injects faults into the responses the change reaches. */
export interface ValueOraclePort {
  /** `aim` names the operations a corrupting oracle may touch and the use cases they belong to; an oracle that corrupts gives no score without it. */
  measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[], aim?: FaultAim): Promise<ValueOracleResult>;
}

/* Signal-only by contract: a null valueScore never gates publish. */
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

export class NullValueOracleAdapter implements ValueOraclePort {
  async measure(_br: BlastRadius, _repoDir: string, _namespace: string, _baselineCases?: string[]): Promise<ValueOracleResult> {
    return {
      valueScore: null,
      mutantCount: 0,
      killedCount: 0,
      details: "valueOracle is off — no fault-injection or mutation scoring this run",
    };
  }
}

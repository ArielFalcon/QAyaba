import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ValueOracleResult } from "../../domain/coverage-collector.ts";

/** Signal-only: a null valueScore never gates publish. Mutation (code) vs fault-injection (e2e). */
export interface ValueOraclePort {
  measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult>;
}

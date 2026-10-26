import type { CoverageReport } from "../../domain/coverage-collector.ts";

export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport>;
}

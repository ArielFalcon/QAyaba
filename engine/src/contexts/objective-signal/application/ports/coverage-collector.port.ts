import type { CoverageReport, DumpSource } from "../../domain/coverage-collector.ts";

export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport>;
  /* One report over the dumps of several namespaces, as a collection of them all would be; absent for a collector that reads reports a run writes whole. */
  recollect?(specDir: string, sources: readonly DumpSource[], changedFiles?: string[]): Promise<CoverageReport>;
}

import type { BundleMutationResult, MutantRun } from "../../domain/coverage-collector.ts";

/** Signal-only, never a gate: re-runs the tests that reached each mutant of the changed code in the served script. Null when no mutant reached a page and was judged — never a fabricated zero. */
export interface BundleMutationPort {
  /** `observe` has each mutant's re-run record the pages of its tests and compares the survivors with one unmutated re-run (`moved` on each survivor); unasked, nothing is recorded and no re-run is added. */
  measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[], opts?: { observe?: boolean }): Promise<BundleMutationResult | null>;
}

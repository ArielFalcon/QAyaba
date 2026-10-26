import type { BundleMutationResult, MutantRun } from "../../domain/coverage-collector.ts";

/** Signal-only, never a gate: re-runs the tests that reached each mutant of the changed code in the served script. Null when no mutant reached a page and was judged — never a fabricated zero. */
export interface BundleMutationPort {
  measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[]): Promise<BundleMutationResult | null>;
}

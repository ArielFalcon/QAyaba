/* Whether a regeneration a surviving mutant drove made a test notice it. Pure; no I/O. A survivor routed to an author is a fault the
   suite reached and checked nothing of; the regeneration that answers it stands only as text until that same mutant is applied to the
   specs it changed and a test that passed on the unmutated script fails. A survivor re-run that reached no page is not judged: it is
   neither closed nor open. A signal, never a gate. */
import type { BundleMutationResult, MutantRun } from "./coverage-collector.ts";

export interface SurvivorClosure {
  /** Survivors routed to the regeneration. */
  routed: number;
  /** Re-applied, reached a page and ran tests that passed before. */
  judged: number;
  /** Judged and noticed by a test. */
  closed: number;
  /** Judged and still noticed by no test. */
  open: { file: string; line: number; operator: string }[];
}

/* Each routed survivor re-run against the specs the regeneration changed: the test that answers it may live in any of them. */
export function survivorRechecks(routed: readonly MutantRun[], changedSpecFiles: readonly string[]): MutantRun[] {
  const specFiles = [...new Set(changedSpecFiles)].sort();
  return routed.map(({ site }) => ({ site, specFiles }));
}

export function survivorClosureOf(routed: number, result: BundleMutationResult | null): SurvivorClosure {
  if (!result) return { routed, judged: 0, closed: 0, open: [] };
  return { routed, judged: result.applied, closed: result.killed, open: result.survived.map(({ file, line, operator }) => ({ file, line, operator })) };
}

/* Whether a regeneration a surviving mutant drove made a test notice it. Pure; no I/O. A survivor routed to an author is a fault the
   suite reached and checked nothing of; the regeneration that answers it stands only as text until that same mutant is applied to the
   specs it changed and a test that passed on the unmutated script fails. A survivor re-run that reached no page, or whose counters could not be read, is not judged: it is
   neither closed nor open (the unreadable ones are counted apart, and so are those the time left could not re-run). A signal, never a gate. */
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { BundleMutationResult, MutantRun, SurvivedMutant } from "./coverage-collector.ts";
import type { RerunsLeftOut } from "./rerun-budget.ts";
import { survivorIsRouted, survivorRoutes } from "./render-coverage-gap.ts";

export interface SurvivorClosure {
  /** Survivors routed to the regeneration. */
  routed: number;
  /** Re-applied, reached a page and ran tests that passed before. */
  judged: number;
  /** Judged and noticed by a test. */
  closed: number;
  /** Judged and still noticed by no test. */
  open: { file: string; line: number; operator: string }[];
  /** Re-applied but not judged because the counters of the re-run could not be read: neither closed nor open, and apart from one that reached no page. Absent when none was. */
  unreadable?: number;
  /** Not re-applied because the time left could not hold the re-run: neither judged, closed nor open. Absent when none was. */
  leftOut?: RerunsLeftOut;
}

/*
 * Each routed survivor (`survivorIsRouted`; one the runs found unmoved or could not compare is recorded and never re-run) re-run against the specs the regeneration changed among those its finding was routed to (`survivorRoutes`, by
 * the survivor at the same place of `survived`): the test that answers it was written there. A survivor routed to no spec was told to
 * the lead as it is, so the test that answers it may live in any changed spec. A survivor none of whose routed specs changed is not
 * re-run: nothing was written for it. Every test of those specs runs, since a regenerated test is not among the tests that reached it.
 */
export function survivorRechecks(routed: readonly MutantRun[], survived: readonly SurvivedMutant[], changedSpecFiles: readonly string[]): MutantRun[] {
  const changed = [...new Set(changedSpecFiles)].sort();
  return routed.flatMap(({ site, specFiles: ran }, i) => {
    if (survived[i] && !survivorIsRouted(survived[i])) return [];
    const routes = new Set((survived[i] ? survivorRoutes(survived[i]) : ran).map(normalizeSpecPath));
    const specFiles = routes.size === 0 ? changed : changed.filter((file) => routes.has(normalizeSpecPath(file)));
    return specFiles.length > 0 ? [{ site, specFiles }] : [];
  });
}

export function survivorClosureOf(routed: number, result: BundleMutationResult | null): SurvivorClosure {
  if (!result) return { routed, judged: 0, closed: 0, open: [] };
  return { routed, judged: result.applied, closed: result.killed, open: result.survived.map(({ file, line, operator }) => ({ file, line, operator })), ...(result.unreadable ? { unreadable: result.unreadable } : {}), ...(result.leftOut ? { leftOut: result.leftOut } : {}) };
}

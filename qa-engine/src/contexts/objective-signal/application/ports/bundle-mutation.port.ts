import type { BundleMutationResult, MutantRun, SESSION_LOST_IN_RERUN } from "../../domain/coverage-collector.ts";
import type { RerunBudget } from "../../domain/rerun-budget.ts";
import type { MeasuredPages, ObservedPage } from "../../domain/observed-page.ts";
import type { QaCase } from "@kernel/qa-case.ts";

/**
 * One re-run of the mutation pass: `specFiles` with `mutant` applied (a mutant's edit, or, for an unmutated observation, nothing or a
 * selection of the tests to run that edits no script); `observe` has the fixtures record the pages of its tests. In a run it is an
 * execution of the run's suite and goes through the run's execution port, which records it and guards the session of a mutant's: a
 * re-run whose session the app ended and the run could not bring back for it comes back `notJudged` and is judged by no one.
 */
export type MutantRerun = (args: { dir: string; baseUrl: string; namespace: string; mutant?: string; specFiles: string[]; observe?: boolean }) => Promise<{ verdict: string; cases: QaCase[]; observations?: ObservedPage[]; notJudged?: typeof SESSION_LOST_IN_RERUN }>;

/** Signal-only, never a gate: re-runs the tests that reached each mutant of the changed code in the served script. Null when no mutant reached a page and was judged — never a fabricated zero. */
export interface BundleMutationPort {
  /**
   * `observe` has each mutant's re-run record the pages of its tests and compares the survivors with one unmutated re-run (`moved` on each survivor); unasked, nothing is recorded and no re-run is added.
   * `budget` holds every re-run (an observation, a mutant) to the time left: one whose estimate the allowance cannot hold is not started and is counted in `leftOut`; unasked, every re-run starts.
   * `before` is the measurement execution the mutants are judged against, observed: it is the first unmutated observation, and none is re-run before the mutants.
   * `notGreen` names the tests (as the coverage fixture names a test's dumps) that failed under that measurement: a mutant only they reached is not judged (`notJudged`).
   * `rerun` runs each re-run (the run's execution port); absent, the runner the oracle was built with, and a pass with neither throws.
   */
  measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[], opts?: { observe?: boolean; budget?: RerunBudget; before?: MeasuredPages; notGreen?: readonly string[]; rerun?: MutantRerun }): Promise<BundleMutationResult | null>;
}

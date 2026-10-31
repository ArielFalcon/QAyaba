import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { BundleMutationOutcome, CoverageMeasurement, CoverageRecount, CoverageSource, FileRanBy, MutantSelectionRecord, UntakenArm } from "../../domain/objective-signal.ts";
import type { BundleMutationResult, CoverageRead, MutantProof, MutantRun } from "../../domain/coverage-collector.ts";
import type { CoverageExclusions } from "../../domain/coverage-exclusions.ts";
import type { RerunBudget } from "../../domain/rerun-budget.ts";
import type { MutationPass } from "../../domain/mutation-pass.ts";
import type { MeasuredPages } from "../../domain/observed-page.ts";
import type { MutantRerun } from "./bundle-mutation.port.ts";

/** What a measurement decides and records. */
export type CoverageSignal = { status: "pass" | "fail" | "unknown"; ratio: number | null; mutationPass?: MutationPass; uncovered?: { file: string; lines: number[] }[]; untakenArms?: UntakenArm[]; bundleMutation?: BundleMutationOutcome; mutantSelection?: MutantSelectionRecord; mutantProofs?: MutantProof[]; survivorRuns?: MutantRun[]; measurement?: CoverageMeasurement; ranBy?: FileRanBy[] };

export interface ObjectiveSignalPort {
  /**
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.candidates` are the use cases the change makes testable: the measurement then carries `perCandidate`, a signal that
   * never gates. `opts.crossRepo` says the diff was withheld because the changed lines live in another repo.
   * `opts.caseFiles` are the spec files of this run's passing cases: a bundle mutant re-runs the ones whose tests reached it.
   * `opts.exclusions` are the changed files that are not a gap of the suite (reached only through routes the change made unavailable,
   * or imported only by tests): they leave the diff before anything is collected, counted or mutated, and the measurement records them apart.
   * `opts.namespace` is the measurement execution whose dumps are read; absent, the composition-time namespace.
   * The coverage counts what the passing tests ran and what a mutant a test killed made run (the verified coverage);
   * `mutantProofs` names those mutants' re-runs, so a recount can count them again, and is absent when none added a line.
   * `survivorRuns` are the mutants no test noticed, in the order of `bundleMutation.survived`, as they were run, so a regeneration
   * they drove can apply them again; they name the served script and its edit, so they never reach an agent.
   * `mutantSelection` says how the mutants were chosen (the sites on changed lines left out because their source line does not hold
   * what they mutate, by why, and how many mutants re-run only the tests that reached them); absent when no mutant was looked for.
   * `ranBy` names, per changed file, the spec files among `opts.caseFiles` whose tests' dumps (those the measurement read) ran a line of
   * it; a dump no case file wrote counts for none. Absent when the collector cannot tell which dump ran what. In memory only.
   * `opts.onRead` is told every read of dumps the measurement made, whatever it came to (the record of the read: dumps, bytes, time, outcome), for the trace.
   * `opts.byExecution` measures what the passing tests ran and runs no mutant: `mutationPass` then holds the pass that would run on
   * this measurement (mutants were chosen and there are passing cases to judge them against), with what this one read of the dumps
   * gave, so the costly re-runs can be a step of their own (`measureMutation`) that reads none of those dumps again; its
   * `mutantSelection` says how the mutants were chosen, due or not.
   * `opts.rerunBudget` holds the mutation pass's re-runs to the time left (a re-run the allowance cannot hold is not started, and
   * `bundleMutation.leftOut` counts it); absent, every re-run starts.
   * `opts.exceptTests` names the tests (as the coverage fixture names a test's dumps) whose dumps are not read: a test that failed under
   * the measurement execution ran the code partway and checked nothing, so it credits no line and chooses no mutant, and the mutation pass
   * judges no mutant only they reached (`bundleMutation.notJudged`). `opts.firstObservation` is the measurement execution, observed: the
   * mutation pass takes it as the mutants' first unmutated observation instead of re-running one. `opts.rerun` runs the mutation pass's
   * re-runs (a run gives its own execution port).
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string; caseFiles?: string[]; candidates?: readonly UseCaseCandidate[]; crossRepo?: boolean; exclusions?: CoverageExclusions; byExecution?: boolean; rerunBudget?: RerunBudget; exceptTests?: readonly string[]; firstObservation?: MeasuredPages; onRead?: (read: CoverageRead) => void; rerun?: MutantRerun }): Promise<CoverageSignal>;
  /**
   * The mutation pass a measurement by execution returned (`mutationPass`): its mutants re-run and judged (each re-run held to
   * `opts.rerunBudget`) and the coverage they verify, the measurement by execution with the dumps of each killed mutant's re-run added.
   * Reads none of the dumps the measurement by execution read; the proofs' recount is told to `opts.onRead`. Its `bundleMutation` is
   * absent when no mutant was judged, unreadable or left out: the measurement is then the one by execution, unchanged. Absent on a port
   * with no mutation pass. `opts.rerun` runs each re-run: a run gives its own execution port, so every re-run is one of its executions.
   */
  measureMutation?(pass: MutationPass, specDir: string, opts?: { rerunBudget?: RerunBudget; onRead?: (read: CoverageRead) => void; rerun?: MutantRerun }): Promise<CoverageSignal>;
  /**
   * Whether the change's own lines (its test files left out) may hold a code line a measurement counts. False only when every changed
   * file is of a declared language whose statement syntax says none of its added lines is code (an import, a type-only declaration, a
   * comment, a blank line): such a change has no changed code line whatever the page ran, so no measurement execution is due for it and
   * `measure` reads no dumps for it. A file of a kind no declared language owns may be held by the page's scripts (a component
   * template), which only the scripts' maps can tell, so it may hold code. Absent on a port that cannot tell.
   */
  holdsChangedCode?(diff: string): boolean;
  /**
   * Single source of truth for whether a measured status blocks publish.
   * Only "enforce" + "fail" blocks; "unknown" never blocks regardless of mode.
   */
  blocks(status: "pass" | "fail" | "unknown"): boolean;
  /**
   * The change-coverage counted again over dumps a run already holds, re-running nothing (no oracle, no mutant): each source's dumps of
   * its own spec files (the measurement execution that ran their bytes on disk, chosen by the caller), plus the dumps of the `proofs`,
   * which the caller gives only for spec files whose bytes are still those the proofs' mutants ran against. Null when nothing can be
   * counted that way (coverage off, no diff, no source, a collector that reads reports a run writes whole, or a source whose dumps could
   * not be read). Absent on a port that cannot recount. `opts.caseFiles`
   * are the spec files of the passing cases the recounted dumps belong to: `ranBy` is told against them, as `measure` tells it.
   */
  /**
   * The surviving mutants applied again, each re-running its `specFiles`, and judged against `baselineCases` (the passing cases of
   * those specs) as the first pass judged them: killed when one of those cases fails. Re-runs land under `namespace`, each held to
   * `opts.rerunBudget` as the first pass's are (one it cannot hold is not started, and `leftOut` counts it). Null when none was judged,
   * unreadable or left out. Absent on a port with no mutation pass. A signal, never a gate.
   */
  recheckSurvivors?(survivors: readonly MutantRun[], specDir: string, namespace: string, baselineCases: readonly string[], opts?: { rerunBudget?: RerunBudget; rerun?: MutantRerun }): Promise<BundleMutationResult | null>;
  recount?(br: BlastRadius, specDir: string, diff: string | undefined, sources: readonly CoverageSource[], opts?: { proofs?: readonly MutantProof[]; exclusions?: CoverageExclusions; caseFiles?: readonly string[]; onRead?: (read: CoverageRead) => void }): Promise<CoverageRecount | null>;
}

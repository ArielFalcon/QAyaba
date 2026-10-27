import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CandidateValue, FaultAim, ValueStats } from "../../domain/fault-injection-score.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { BundleMutationOutcome, CoverageMeasurement, CoverageRecount, CoverageRerun, MutantSelectionRecord, UntakenArm } from "../../domain/objective-signal.ts";
import type { BundleMutationResult, MutantProof, MutantRun } from "../../domain/coverage-collector.ts";
import type { CoverageExclusions } from "../../domain/coverage-exclusions.ts";

export interface ObjectiveSignalPort {
  /**
   * `valueScore` absent means not measured — never a fabricated 0.
   * `mutantCount`/`killedCount` mirror the value-oracle's own ValueOracleResult: absent means the
   * oracle never ran this measure() call (e.g. coverage.mode "off"); `null` means it ran but has no
   * count to report. Neither is ever fabricated as 0 — that would read as a genuine measured zero.
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.candidates` are the use cases the change makes testable: the measurement then carries `perCandidate`, a signal that
   * never gates. `opts.crossRepo` says the diff was withheld because the changed lines live in another repo.
   * `opts.faultAim` is what the response oracle may corrupt and for which use cases; without it the oracle gives no score
   * (`valueScore` null) and `valueByCandidate` is absent. It is a signal and never gates.
   * `opts.caseFiles` are the spec files of this run's passing cases: a bundle mutant re-runs the ones whose tests reached it.
   * `opts.exclusions` are the changed files that are not a gap of the suite (reached only through routes the change made unavailable,
   * or imported only by tests): they leave the diff before anything is collected, counted or mutated, and the measurement records them apart.
   * `opts.namespace` overrides the dump namespace for the regen's second
   * measure(); the first measurement is untouched.
   * `opts.reruns` are later executions of some spec files, in the order they ran: the measurement then reads the latest dumps of
   * every spec file (the namespace's without the re-run files, then each re-run's for the files it re-ran, as `recount` does), and
   * its mutants are chosen from those dumps. A re-run whose dumps cannot be read with the rest measures nothing ("unknown").
   * The coverage counts what the passing tests ran and what a mutant a test killed made run (the verified coverage);
   * `mutantProofs` names those mutants' re-runs, so a recount can count them again, and is absent when none added a line.
   * `survivorRuns` are the mutants no test noticed, in the order of `bundleMutation.survived`, as they were run, so a regeneration
   * they drove can apply them again; they name the served script and its edit, so they never reach an agent.
   * `mutantSelection` says how the mutants were chosen (the sites on changed lines left out because their source line does not hold
   * what they mutate, by why, and how many mutants re-run only the tests that reached them); absent when no mutant was looked for.
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string; caseFiles?: string[]; candidates?: readonly UseCaseCandidate[]; crossRepo?: boolean; faultAim?: FaultAim; reruns?: readonly CoverageRerun[]; exclusions?: CoverageExclusions }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; valueByCandidate?: CandidateValue[]; valueStats?: ValueStats; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; untakenArms?: UntakenArm[]; bundleMutation?: BundleMutationOutcome; mutantSelection?: MutantSelectionRecord; mutantProofs?: MutantProof[]; survivorRuns?: MutantRun[]; measurement?: CoverageMeasurement }>;
  /**
   * Single source of truth for whether a measured status blocks publish.
   * Only "enforce" + "fail" blocks; "unknown" never blocks regardless of mode.
   */
  blocks(status: "pass" | "fail" | "unknown"): boolean;
  /**
   * The change-coverage counted again over dumps a run already holds, re-running nothing (no oracle, no mutant): the first
   * measurement's namespace without the dumps of each re-run's spec files, plus every re-run's own dumps, plus the dumps of the
   * `proofs` whose spec files were not re-run. Null when nothing can be counted that way (coverage off, no diff, a collector that
   * reads reports a run writes whole, or a source whose dumps could not be read). Absent on a port that cannot recount.
   */
  /**
   * The surviving mutants applied again, each re-running its `specFiles`, and judged against `baselineCases` (the passing cases of
   * those specs) as the first pass judged them: killed when one of those cases fails. Re-runs land under `namespace`. Null when none
   * was judged. Absent on a port with no mutation pass. A signal, never a gate.
   */
  recheckSurvivors?(survivors: readonly MutantRun[], specDir: string, namespace: string, baselineCases: readonly string[]): Promise<BundleMutationResult | null>;
  recount?(br: BlastRadius, specDir: string, diff: string | undefined, reruns: readonly CoverageRerun[], opts?: { namespace?: string; proofs?: readonly MutantProof[]; exclusions?: CoverageExclusions }): Promise<CoverageRecount | null>;
}

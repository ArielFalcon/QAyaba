/*
 * The mutation pass a measurement by execution found due, as data: the mutants it chose and what its one read of the execution's dumps
 * gave, so the pass that follows runs the mutants and verifies the coverage without reading those dumps again. The run holds it and hands
 * it back to the port that returned it; nothing else reads it. Its mutants name the served script and its edits, so it never reaches an
 * agent or the record.
 */
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";
import type { CoverageReport, DumpSource, MutantRun } from "./coverage-collector.ts";
import type { CoverageExclusions } from "./coverage-exclusions.ts";
import type { CoverageReadFault } from "./dump-outcome.ts";
import type { FileRanBy, MutantSelectionRecord } from "./objective-signal.ts";

export interface MutationPass {
  /** The mutants chosen and how; the passing cases they are judged against; the namespace their re-runs land under. */
  mutants: MutantRun[];
  selection: MutantSelectionRecord;
  judgedAgainst: string[];
  namespace: string;
  /** The dumps the measurement read: a killed mutant's dumps are counted with them. */
  sources: DumpSource[];
  /** The change the measurement counted (the diff without test files and excluded files) and its changed files. */
  changeDiff: string;
  changedFiles: string[];
  /** The coverage by execution, and what its read told: the scripts it saw, why its evidence could not be read, which spec ran each changed file. */
  executed: ChangeCoverage;
  scripts?: CoverageReport["scripts"];
  trouble?: "no-dumps" | CoverageReadFault;
  ranBy?: FileRanBy[];
  /** What the measurement was asked to tell beside its figures. */
  caseFiles: string[];
  exclusions?: CoverageExclusions;
  candidates?: readonly UseCaseCandidate[];
  crossRepo?: boolean;
}

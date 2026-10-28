/* ObjectiveSignalPort: change-coverage measure, recount + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CoverageMeasurement } from "../../domain/objective-signal.ts";
import type { ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";
import type { CoverageRecount, CoverageRerun, FileRanBy } from "../../domain/objective-signal.ts";
import { isDumpOfSpecFile } from "../../domain/dump-names.ts";
import type { BundleMutationPort } from "../../application/ports/bundle-mutation.port.ts";
import type { CoverageCollectorPort } from "../../application/ports/coverage-collector.port.ts";
import type { ValueOraclePort } from "../../application/ports/value-oracle.port.ts";
import type { BundleMutationResult, CoverageReport, DumpSource, MutantProof, MutantRun } from "../../domain/coverage-collector.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "../../domain/decide-coverage.service.ts";
import { parseDiffHunks, type NoCodeLinesOf } from "../../domain/assemble-change-coverage.ts";
import { linesWithoutCode } from "../statement-code-lines.ts";
import { selectMutants, type SourceLineOf } from "../../domain/select-mutants.ts";
import type { MutantSelectionRecord } from "../../domain/objective-signal.ts";
import { RepoReader } from "../../../../shared-infrastructure/repo-reader.ts";
import { MAX_SPEC_SOURCE_BYTES } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { diffWithoutTestFiles } from "../../domain/diff-without-test-files.ts";
import { diffWithoutFiles, excludedFilesOf, type CoverageExclusions } from "../../domain/coverage-exclusions.ts";
import { diffChangedFiles, perCandidateCoverage } from "../../domain/per-candidate-coverage.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  oracle: ValueOraclePort;
  /* The mutation pass over the served script; absent when the value oracle is off or the target has no browser. */
  mutation?: BundleMutationPort;
  /* The text of a changed file of the working copy (a mutant's source line, an unloaded file's statements); absent → the working copy (`repoDir`) is read through the confined reader. */
  readSource?: (file: string) => string | undefined;
}

export interface ObjectiveSignalPortStaticContext {
  policy: CoveragePolicy;
  repoDir: string;
  /* Turns CoverageReport + diff into ChangeCoverage, an unloaded file's lines read by its language's statement syntax. Absent → decide() gets null → unknown, never blocks. */
  assembleChangeCoverage?: (diff: string, report: CoverageReport, noCodeOf?: NoCodeLinesOf) => ChangeCoverage;
  baselineCases?: string[];
  /* Same per-run namespace ExecutionPortAdapter uses so dumps are read from the directory execution wrote. Optional; falls back to br.sha.toString(). */
  namespace?: string;
}

/* What the measurement counted, and why one that decides nothing did not. `byExecution` is the same measurement before a killed mutant's dumps were added, when they were. */
function measurementOf(cc: ChangeCoverage | null, skipped: CoverageMeasurement["unmeasured"], scripts?: CoverageReport["scripts"], diff?: string, byExecution?: ChangeCoverage): CoverageMeasurement {
  if (!cc) return { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: skipped ?? "not-assembled" };
  const count = (lines: { lines: number[] }[] | undefined): number => (lines ?? []).reduce((n, f) => n + f.lines.length, 0);
  const counts = {
    changedLines: cc.overall.changedLines,
    coveredChanged: cc.overall.coveredChanged,
    changedFiles: cc.perFile.length,
    mappedFiles: cc.perFile.filter((file) => file.covered > 0).length,
    ...(cc.branches ? { changedBranches: cc.branches.changedBranches, takenBranches: cc.branches.takenBranches } : {}),
    ...(cc.notExecutable ? { notExecutableLines: count(cc.notExecutable) } : {}),
    ...(cc.notLoaded?.length ? { notLoadedFiles: cc.notLoaded.map((f) => f.file) } : {}),
    ...(cc.noCode?.length ? { noCodeFiles: cc.noCode } : {}),
    ...(byExecution
      ? {
          coveredByExecution: byExecution.overall.coveredChanged,
          provenByMutation: cc.overall.coveredChanged - byExecution.overall.coveredChanged,
          ...(cc.branches && byExecution.branches ? { armsProvenByMutation: cc.branches.takenBranches - byExecution.branches.takenBranches } : {}),
        }
      : {}),
  };
  /* A diff that changes files and adds no line only deletes; one whose added lines are none of them code has no changed lines. */
  if (cc.overall.changedLines === 0) return { ...counts, unmeasured: diff !== undefined && diffChangedFiles(diff).length > 0 && parseDiffHunks(diff).size === 0 ? "deletion-only" : "no-changed-lines" };
  if (cc.measured) return counts;
  /* Scripts ran and none of them carried a source map: nothing could have mapped them to the repository, whatever the change was. */
  const unmappable = scripts !== undefined && scripts.total > 0 && scripts.withSourceMap === 0;
  return { ...counts, unmeasured: unmappable ? "no-source-maps" : "no-changed-file-mapped" };
}

/* What the measurement left out as no gap of the suite, recorded apart; nothing when it left none. */
function recordedExclusions(exclusions: CoverageExclusions | undefined): Pick<CoverageMeasurement, "unreachableByDesign" | "testSupportFiles"> {
  return {
    ...(exclusions?.unreachableByDesign.length ? { unreachableByDesign: exclusions.unreachableByDesign } : {}),
    ...(exclusions?.testSupportFiles.length ? { testSupportFiles: exclusions.testSupportFiles } : {}),
  };
}

/* The change a measurement counts: the commit's diff without its test files and without the files the run's facts say are no gap of the suite. */
function changeDiffOf(diff: string | undefined, exclusions: CoverageExclusions | undefined): string | undefined {
  return diff ? diffWithoutFiles(diffWithoutTestFiles(diff).diff, excludedFilesOf(exclusions)) : undefined;
}

/*
 * Which spec files ran each changed file, told from the dumps a report read: a dump counts for the spec files whose test its name says
 * wrote it, and a dump none of `specFiles` wrote counts for none, never for every one of them. A file no attributable dump ran is left
 * out. Absent when the report does not say which dump ran what.
 */
function ranByOf(report: CoverageReport | null | undefined, specFiles: readonly string[]): FileRanBy[] | undefined {
  if (!report?.ranBy) return undefined;
  const files = [...new Set(specFiles)].sort();
  return report.ranBy.flatMap(({ file, dumps }) => {
    const ran = files.filter((spec) => dumps.some((dump) => isDumpOfSpecFile(dump, spec)));
    return ran.length > 0 ? [{ file, specFiles: ran }] : [];
  });
}

/* The source line of a changed file, each file read once per measurement through `readSource`. */
function sourceLines(readSource: (file: string) => string | undefined): SourceLineOf {
  const lines = new Map<string, string[] | undefined>();
  return (file, line) => {
    if (!lines.has(file)) lines.set(file, readSource(file)?.split(/\r?\n/));
    return lines.get(file)?.[line - 1];
  };
}

/* The working copy's text of a changed file, through the strict, capped read; a file that cannot be used gives no text, said once. */
function workingCopySource(repoDir: string, purpose: string): (file: string) => string | undefined {
  return (file) => {
    const reader = new RepoReader(repoDir);
    const text = reader.optionalText(file, MAX_SPEC_SOURCE_BYTES);
    reader.warn(`${purpose}: the source of a changed file`);
    return text;
  };
}

/* The lines of an unloaded changed file its language's statement syntax says hold no code, each file read once per measurement. */
function noCodeLines(readSource: (file: string) => string | undefined): NoCodeLinesOf {
  const known = new Map<string, ReadonlySet<number> | undefined>();
  return (file) => {
    if (!known.has(file)) {
      const text = readSource(file);
      known.set(file, text === undefined ? undefined : linesWithoutCode(file, text));
    }
    return known.get(file);
  };
}

/*
 * The latest dumps of every spec file: the base namespace without the re-run spec files, then each re-run's namespace for the spec
 * files it re-ran. Reruns are in the order they ran: a spec re-run again is read from its latest rerun only, so an earlier rerun's
 * dumps of it never count; and a rerun's namespace is read for its own spec files only, never whole.
 */
function latestDumpsOf(base: string, reruns: readonly CoverageRerun[]): { sources: DumpSource[]; rewritten: string[] } {
  const rewritten = [...new Set(reruns.flatMap((r) => r.specFiles))];
  const rerunSources = reruns.flatMap((r, i): DumpSource[] => {
    const later = new Set(reruns.slice(i + 1).flatMap((x) => x.specFiles));
    const current = r.specFiles.filter((file) => !later.has(file));
    return current.length === 0 ? [] : [{ namespace: r.namespace, onlySpecFiles: current }];
  });
  return { sources: [{ namespace: base, exceptSpecFiles: rewritten }, ...rerunSources], rewritten };
}

export class ObjectiveSignalPortAdapter implements ObjectiveSignalPort {
  constructor(
    private readonly deps: ObjectiveSignalPortCollaborators,
    private readonly ctx: ObjectiveSignalPortStaticContext,
  ) {}

  async measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: Parameters<ObjectiveSignalPort["measure"]>[4]): ReturnType<ObjectiveSignalPort["measure"]> {
    const namespace = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    /* coverage.mode "off" skips collector IO and the value oracle. decide() sees null → "unknown" (never blocks). */
    if (this.ctx.policy.mode === "off") {
      return { status: this.deps.decide.decide(null, this.ctx.policy), ratio: null };
    }
    /* The change is its own code: the repo's test files a commit carries are neither collected nor counted, or a suite would be measured against the unit tests it never runs (or, on the code target, credited with the lines those tests run of themselves). */
    const changeDiff = changeDiffOf(diff, opts?.exclusions);
    /* Per-call changed files from the live diff. Composition-time collectors often hold a static empty list; absent diff → collector constructor value. */
    const changedFiles = changeDiff !== undefined ? [...parseDiffHunks(changeDiff).keys()] : undefined;
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    /* The latest dumps of every spec file: after re-runs of some of them, the namespace alone holds the others' only. */
    const rerun = (opts?.reruns?.length ?? 0) > 0;
    const sources = latestDumpsOf(namespace, opts?.reruns ?? []).sources;
    const report = willAssemble ? await this.collectFrom(specDir, namespace, rerun ? sources : undefined, changedFiles) : null;
    const noCodeOf = this.noCodeOf();
    const executed: ChangeCoverage | null = report ? this.ctx.assembleChangeCoverage!(changeDiff!, report, noCodeOf) : null;

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases, opts?.faultAim);

    /* Mutants only of a measured change, on its changed lines, where a test reached: first the decisions an arm of which no test ran. */
    let bundleMutation: BundleMutationResult | null = null;
    let mutantSelection: MutantSelectionRecord | undefined;
    if (this.deps.mutation && report?.mutationSites && executed?.measured && changeDiff !== undefined) {
      const { mutants, skipped } = selectMutants(report.mutationSites, parseDiffHunks(changeDiff), opts?.caseFiles ?? [], undefined, report.branches, sourceLines(this.deps.readSource ?? workingCopySource(this.ctx.repoDir, "mutation")));
      const bySpecFile = mutants.filter((m) => m.tests === undefined).length;
      mutantSelection = { ...(skipped.count > 0 ? { skippedSites: skipped } : {}), rerunsByTest: mutants.length - bySpecFile, rerunsBySpecFile: bySpecFile };
      /* The first judgment of the survivors also tells what each moved (their pages against an unmutated re-run); the re-check of a regeneration's answer does not. */
      if (mutants.length > 0) bundleMutation = await this.deps.mutation.measure(mutants, specDir, namespace, baselineCases ?? this.ctx.baselineCases ?? [], { observe: true });
    }
    const proofs = bundleMutation?.proofs ?? [];
    /* What a killed mutant made run, a test checked: the verified coverage adds it, the coverage by execution alone stays beside it. */
    const withProofs = proofs.length > 0 && executed ? await this.withProofs(specDir, rerun ? sources : [{ namespace }], proofs, changeDiff!, changedFiles, noCodeOf) : null;
    const verified = withProofs?.cc ?? null;
    const cc = verified ?? executed;
    /* Which spec ran each changed file, from the dumps the measurement that stands read. */
    const ranBy = ranByOf(withProofs?.report ?? report, opts?.caseFiles ?? []);

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;
    const aggregate = measurementOf(cc, !diff ? "no-diff" : this.ctx.assembleChangeCoverage === undefined ? "not-assembled" : undefined, report?.scripts, changeDiff, verified ? executed! : undefined);
    /* Per use case: figures beside the aggregate, which stays the only one that decides. */
    const candidates = opts?.candidates ?? [];
    const measurement: CoverageMeasurement = candidates.length > 0
      ? { ...aggregate, ...recordedExclusions(opts?.exclusions), perCandidate: perCandidateCoverage({ candidates, diff: changeDiff, coverage: cc, aggregate: aggregate.unmeasured, crossRepo: opts?.crossRepo === true }) }
      : { ...aggregate, ...recordedExclusions(opts?.exclusions) };


    return {
      status,
      ratio,
      valueScore: oracleResult.valueScore,
      ...(oracleResult.perCandidate !== undefined ? { valueByCandidate: oracleResult.perCandidate } : {}),
      ...(oracleResult.stats !== undefined ? { valueStats: oracleResult.stats } : {}),
      mutantCount: oracleResult.mutantCount,
      killedCount: oracleResult.killedCount,
      ...(willAssemble && cc?.uncovered ? { uncovered: cc.uncovered } : {}),
      ...(cc?.untakenArms ? { untakenArms: cc.untakenArms } : {}),
      ...(bundleMutation
        ? {
            bundleMutation: {
              applied: bundleMutation.applied,
              killed: bundleMutation.killed,
              survived: bundleMutation.survived,
              ...(mutantSelection?.skippedSites ? { skippedSites: mutantSelection.skippedSites } : {}),
              ...(mutantSelection?.rerunsBySpecFile ? { rerunsBySpecFile: mutantSelection.rerunsBySpecFile } : {}),
            },
          }
        : {}),
      ...(mutantSelection ? { mutantSelection } : {}),
      ...(verified ? { mutantProofs: proofs } : {}),
      ...(bundleMutation?.survivorRuns ? { survivorRuns: bundleMutation.survivorRuns } : {}),
      measurement,
      ...(ranBy ? { ranBy } : {}),
    };
  }

  /*
   * The dumps a measurement reads: the namespace's, or, after re-runs of some spec files, the latest of every spec file. Null when a
   * re-run's dumps could not be read with the rest, or the collector cannot add namespaces: a part never stands for the suite.
   */
  private async collectFrom(specDir: string, namespace: string, latest: readonly DumpSource[] | undefined, changedFiles: string[] | undefined): Promise<CoverageReport | null> {
    if (latest === undefined) return this.deps.collector.collect(specDir, namespace, changedFiles);
    const { recollect } = this.deps.collector;
    if (!recollect) return null;
    const report = await recollect.call(this.deps.collector, specDir, latest, changedFiles);
    return report.incomplete ? null : report;
  }

  /* The coverage of `sources` with the dumps of each proof's re-run added (its edit undone, only its failing spec files); null when a source could not be read, so a part never stands for the whole. */
  private async withProofs(specDir: string, sources: readonly DumpSource[], proofs: readonly MutantProof[], changeDiff: string, changedFiles: string[] | undefined, noCodeOf: NoCodeLinesOf): Promise<{ cc: ChangeCoverage; report: CoverageReport } | null> {
    const { recollect } = this.deps.collector;
    if (!recollect || !this.ctx.assembleChangeCoverage) return null;
    const proofSources = proofs.map(({ namespace, specFiles, ...mutant }) => ({ namespace, onlySpecFiles: specFiles, mutant }));
    const report = await recollect.call(this.deps.collector, specDir, [...sources, ...proofSources], changedFiles);
    return report.incomplete ? null : { cc: this.ctx.assembleChangeCoverage(changeDiff, report, noCodeOf), report };
  }

  /* An unloaded changed file's statements, read from the working copy once per measurement. */
  private noCodeOf(): NoCodeLinesOf {
    return noCodeLines(this.deps.readSource ?? workingCopySource(this.ctx.repoDir, "change-coverage"));
  }

  async recheckSurvivors(survivors: readonly MutantRun[], specDir: string, namespace: string, baselineCases: readonly string[]): Promise<BundleMutationResult | null> {
    if (!this.deps.mutation || survivors.length === 0) return null;
    return this.deps.mutation.measure([...survivors], specDir, namespace, [...baselineCases]);
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.deps.decide.blocks(status, this.ctx.policy);
  }

  async recount(br: BlastRadius, specDir: string, diff: string | undefined, reruns: readonly CoverageRerun[], opts?: { namespace?: string; proofs?: readonly MutantProof[]; exclusions?: CoverageExclusions; caseFiles?: readonly string[] }): Promise<CoverageRecount | null> {
    const { recollect } = this.deps.collector;
    if (this.ctx.policy.mode === "off" || !diff || !this.ctx.assembleChangeCoverage || !recollect) return null;
    const changeDiff = changeDiffOf(diff, opts?.exclusions)!;
    const base = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    const { sources, rewritten } = latestDumpsOf(base, reruns);
    /* A proof holds only for the spec bytes that killed its mutant: the re-run spec files are not those any more. */
    const proofs = (opts?.proofs ?? []).map((p) => ({ ...p, specFiles: p.specFiles.filter((file) => !rewritten.includes(file)) })).filter((p) => p.specFiles.length > 0);
    const proofSources = proofs.map(({ namespace, specFiles, ...mutant }) => ({ namespace, onlySpecFiles: specFiles, mutant }));
    const report = await recollect.call(this.deps.collector, specDir, [...sources, ...proofSources], [...parseDiffHunks(changeDiff).keys()]);
    /* A source that could not be read would count a part of the suite as the whole: the measurement before the recount stands. */
    if (report.incomplete) return null;
    const cc = this.ctx.assembleChangeCoverage(changeDiff, report, this.noCodeOf());
    const ranBy = ranByOf(report, opts?.caseFiles ?? []);
    return {
      status: this.deps.decide.decide(cc, this.ctx.policy),
      ratio: cc.measured ? cc.overall.ratio : null,
      uncovered: cc.uncovered,
      untakenArms: cc.untakenArms ?? [],
      measurement: { ...measurementOf(cc, undefined, report.scripts), ...recordedExclusions(opts?.exclusions) },
      ...(ranBy ? { ranBy } : {}),
    };
  }
}

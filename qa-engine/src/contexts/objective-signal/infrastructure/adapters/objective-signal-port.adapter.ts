/* ObjectiveSignalPort: change-coverage measure, recount + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CoverageMeasurement } from "../../domain/objective-signal.ts";
import type { ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";
import type { CoverageRecount, CoverageRerun, FileRanBy } from "../../domain/objective-signal.ts";
import { isDumpOfSpecFile } from "../../domain/dump-names.ts";
import type { BundleMutationPort } from "../../application/ports/bundle-mutation.port.ts";
import type { CoverageCollectorPort } from "../../application/ports/coverage-collector.port.ts";
import type { BundleMutationResult, CoverageRead, CoverageReport, DumpSource, MutantProof, MutantRun } from "../../domain/coverage-collector.ts";
import type { CoverageReadFault } from "../../domain/dump-outcome.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "../../domain/decide-coverage.service.ts";
import { parseDiffHunks, type NoCodeLinesOf } from "../../domain/assemble-change-coverage.ts";
import { linesWithoutCode } from "../statement-code-lines.ts";
import { selectMutants, type SourceLineOf } from "../../domain/select-mutants.ts";
import type { MutantSelectionRecord } from "../../domain/objective-signal.ts";
import type { MutationPass } from "../../domain/mutation-pass.ts";
import type { RerunBudget } from "../../domain/rerun-budget.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { RepoReader } from "../../../../shared-infrastructure/repo-reader.ts";
import { MAX_SPEC_SOURCE_BYTES } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { diffWithoutTestFiles } from "../../domain/diff-without-test-files.ts";
import { diffWithoutFiles, excludedFilesOf, type CoverageExclusions } from "../../domain/coverage-exclusions.ts";
import { diffChangedFiles, perCandidateCoverage } from "../../domain/per-candidate-coverage.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  /* The mutation pass over the served script; absent when `qa.changeCoverage.bundleMutation` is off. */
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

/* What a report says of how its evidence was read: the fault that left it unused, or that no dump was there at all. Nothing of either for a report whose collector does not record its reads. */
function readTroubleOf(report: CoverageReport | null | undefined, fault?: CoverageReadFault): "no-dumps" | CoverageReadFault | undefined {
  const reads = report?.reads ?? [];
  const failed = fault ?? report?.fault;
  if (failed) return failed;
  return reads.length > 0 && reads.every((read) => read.outcome === "absent") ? "no-dumps" : undefined;
}

/* Every read of dumps a collection made is told to the observer, in the order read; an observer's fault is never a measurement's. */
function tellReads(reads: readonly CoverageRead[] | undefined, observer: ((read: CoverageRead) => void) | undefined): void {
  if (!observer) return;
  for (const read of reads ?? []) {
    try {
      observer(read);
    } catch {
      /* observability never changes a measurement */
    }
  }
}

/* What the measurement counted, and why one that decides nothing did not. `byExecution` is the same measurement before a killed mutant's dumps were added, when they were. `trouble` is why the evidence could not be read, when it could not: it is the reason, ahead of any a reading of the evidence would give. `evidenceLeftOut` says the measurement stands without the evidence a read failed to give. */
function measurementOf(cc: ChangeCoverage | null, skipped: CoverageMeasurement["unmeasured"], scripts?: CoverageReport["scripts"], diff?: string, byExecution?: ChangeCoverage, trouble?: "no-dumps" | CoverageReadFault, evidenceLeftOut?: readonly CoverageReadFault[]): CoverageMeasurement {
  if (!cc) return { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: skipped ?? trouble ?? "not-assembled" };
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
    ...(evidenceLeftOut && evidenceLeftOut.length > 0 ? { evidenceLeftOut: [...evidenceLeftOut] } : {}),
    ...(byExecution
      ? {
          coveredByExecution: byExecution.overall.coveredChanged,
          provenByMutation: cc.overall.coveredChanged - byExecution.overall.coveredChanged,
          ...(cc.branches && byExecution.branches ? { armsProvenByMutation: cc.branches.takenBranches - byExecution.branches.takenBranches } : {}),
        }
      : {}),
  };
  /* A diff that changes files and adds no code line is deletion-only; one whose added lines are only in unloaded files that hold no code has no changed lines. */
  if (cc.overall.changedLines === 0) return { ...counts, unmeasured: diff !== undefined && diffChangedFiles(diff).length > 0 && !(cc.noCode?.length) ? "deletion-only" : "no-changed-lines" };
  if (cc.measured) return counts;
  /* Scripts ran and none of them carried a source map: nothing could have mapped them to the repository, whatever the change was. */
  const unmappable = scripts !== undefined && scripts.total > 0 && scripts.withSourceMap === 0;
  return { ...counts, unmeasured: trouble ?? (unmappable ? "no-source-maps" : "no-changed-file-mapped") };
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
    /* coverage.mode "off" skips collector IO and the mutation pass. decide() sees null → "unknown" (never blocks). */
    if (this.ctx.policy.mode === "off") {
      return { status: this.deps.decide.decide(null, this.ctx.policy), ratio: null };
    }
    /* The change is its own code: the repo's test files a commit carries are neither collected nor counted, or a suite would be measured against the unit tests it never runs. */
    const changeDiff = changeDiffOf(diff, opts?.exclusions);
    /* Per-call changed files from the live diff. Composition-time collectors often hold a static empty list; absent diff → collector constructor value. */
    const changedFiles = changeDiff !== undefined ? [...parseDiffHunks(changeDiff).keys()] : undefined;
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    /* The latest dumps of every spec file: after re-runs of some of them, the namespace alone holds the others' only. */
    const rerun = (opts?.reruns?.length ?? 0) > 0;
    const sources = latestDumpsOf(namespace, opts?.reruns ?? []).sources;
    const collected = willAssemble ? await this.collectFrom(specDir, namespace, rerun ? sources : undefined, changedFiles) : undefined;
    const report = collected?.report ?? null;
    tellReads(collected?.reads, opts?.onRead);
    const noCodeOf = this.noCodeOf();
    const executed: ChangeCoverage | null = report ? this.ctx.assembleChangeCoverage!(changeDiff!, report, noCodeOf) : null;
    const caseFiles = opts?.caseFiles ?? [];
    const asked = { caseFiles, ...(opts?.exclusions ? { exclusions: opts.exclusions } : {}), ...(opts?.candidates ? { candidates: opts.candidates } : {}), ...(opts?.crossRepo ? { crossRepo: true } : {}) };
    const trouble = readTroubleOf(report, collected?.fault);
    const ranBy = ranByOf(report, caseFiles);

    /* Mutants only of a measured change, on its changed lines, where a test reached: first the decisions an arm of which no test ran. */
    if (!(this.deps.mutation && report?.mutationSites && executed?.measured && changeDiff !== undefined)) {
      const skipped = !diff ? "no-diff" : this.ctx.assembleChangeCoverage === undefined ? "not-assembled" : undefined;
      return this.resultOf({ cc: executed, executed: null, skipped, scripts: report?.scripts, changeDiff, trouble, ranBy, asked, willAssemble });
    }
    const { mutants, skipped } = selectMutants(report.mutationSites, parseDiffHunks(changeDiff), caseFiles, undefined, report.branches, sourceLines(this.deps.readSource ?? workingCopySource(this.ctx.repoDir, "mutation")));
    const bySpecFile = mutants.filter((m) => m.tests === undefined).length;
    const selection: MutantSelectionRecord = { ...(skipped.count > 0 ? { skippedSites: skipped } : {}), rerunsByTest: mutants.length - bySpecFile, rerunsBySpecFile: bySpecFile };
    const pass: MutationPass = {
      mutants,
      selection,
      judgedAgainst: baselineCases ?? this.ctx.baselineCases ?? [],
      namespace,
      sources: rerun ? sources : [{ namespace }],
      changeDiff,
      changedFiles: changedFiles ?? [],
      executed,
      ...(report.scripts ? { scripts: report.scripts } : {}),
      ...(trouble ? { trouble } : {}),
      ...(ranBy ? { ranBy } : {}),
      ...asked,
    };
    const due = mutants.length > 0 && pass.judgedAgainst.length > 0;
    /* By execution alone: what the passing tests ran, and the pass still to run on it when one is due. */
    if (opts?.byExecution) return { ...this.resultOf({ cc: executed, executed: null, scripts: pass.scripts, changeDiff, trouble, ranBy, asked, willAssemble: true }), ...(due ? { mutationPass: pass } : {}) };
    return this.mutate(pass, specDir, opts?.rerunBudget, opts?.onRead, noCodeOf);
  }

  async measureMutation(pass: MutationPass, specDir: string, opts?: { rerunBudget?: RerunBudget; onRead?: (read: CoverageRead) => void }): ReturnType<ObjectiveSignalPort["measure"]> {
    return this.mutate(pass, specDir, opts?.rerunBudget, opts?.onRead);
  }

  /*
   * The mutation pass over a measurement's chosen mutants, and the coverage it verifies: the measurement by execution held in `pass`, with
   * the dumps of each killed mutant's re-run added (its edit undone). Nothing the measurement by execution read is read again; only the
   * proofs' recount reads, and a recount whose dumps could not be read leaves the coverage by execution standing, saying what it lacks.
   */
  private async mutate(pass: MutationPass, specDir: string, rerunBudget: RerunBudget | undefined, onRead: ((read: CoverageRead) => void) | undefined, noCodeOf: NoCodeLinesOf = this.noCodeOf()): ReturnType<ObjectiveSignalPort["measure"]> {
    /* The first judgment of the survivors also tells what each moved (their pages against an unmutated re-run); the re-check of a regeneration's answer does not. */
    const bundleMutation = pass.mutants.length > 0 ? await this.deps.mutation!.measure(pass.mutants, specDir, pass.namespace, pass.judgedAgainst, { observe: true, ...(rerunBudget ? { budget: rerunBudget } : {}) }) : null;
    const proofs = bundleMutation?.proofs ?? [];
    /* What a killed mutant made run, a test checked: the verified coverage adds it, the coverage by execution alone stays beside it. */
    const proved = proofs.length > 0 ? await this.withProofs(specDir, pass.sources, proofs, pass.changeDiff, pass.changedFiles, noCodeOf) : null;
    tellReads(proved?.report.reads, onRead);
    /* A part never stands for the whole: a proof pass whose dumps could not be read leaves the measurement by execution, and says what it stands without. */
    const verified = proved?.cc ?? null;
    const evidenceLeftOut = proved && !proved.cc && proved.report.fault ? [proved.report.fault] : undefined;
    /* Which spec ran each changed file, from the dumps the measurement that stands read. */
    const ranBy = verified ? ranByOf(proved!.report, pass.caseFiles) : pass.ranBy;
    const asked = { caseFiles: pass.caseFiles, ...(pass.exclusions ? { exclusions: pass.exclusions } : {}), ...(pass.candidates ? { candidates: pass.candidates } : {}), ...(pass.crossRepo ? { crossRepo: true } : {}) };
    const measured = this.resultOf({ cc: verified ?? pass.executed, executed: verified ? pass.executed : null, scripts: pass.scripts, changeDiff: pass.changeDiff, trouble: pass.trouble, ranBy, asked, willAssemble: true, ...(evidenceLeftOut ? { evidenceLeftOut } : {}) });
    return {
      ...measured,
      ...(bundleMutation
        ? {
            bundleMutation: {
              applied: bundleMutation.applied,
              killed: bundleMutation.killed,
              survived: bundleMutation.survived,
              ...(bundleMutation.unreadable ? { unreadable: bundleMutation.unreadable } : {}),
              ...(bundleMutation.leftOut ? { leftOut: bundleMutation.leftOut } : {}),
              ...(pass.selection.skippedSites ? { skippedSites: pass.selection.skippedSites } : {}),
              ...(pass.selection.rerunsBySpecFile ? { rerunsBySpecFile: pass.selection.rerunsBySpecFile } : {}),
            },
          }
        : {}),
      mutantSelection: pass.selection,
      ...(verified ? { mutantProofs: proofs } : {}),
      ...(bundleMutation?.survivorRuns ? { survivorRuns: bundleMutation.survivorRuns } : {}),
    };
  }

  /*
   * What a measurement decides and records from the coverage that stands (`cc`): its status, ratio, what it counted (with `executed`, the
   * coverage by execution, beside a verified one), the lines and arms no test ran, and which spec ran each changed file.
   */
  private resultOf(m: { cc: ChangeCoverage | null; executed: ChangeCoverage | null; skipped?: CoverageMeasurement["unmeasured"]; scripts: CoverageReport["scripts"] | undefined; changeDiff: string | undefined; trouble: "no-dumps" | CoverageReadFault | undefined; ranBy: FileRanBy[] | undefined; asked: { caseFiles: string[]; exclusions?: CoverageExclusions; candidates?: readonly UseCaseCandidate[]; crossRepo?: boolean }; willAssemble: boolean; evidenceLeftOut?: readonly CoverageReadFault[] }): Awaited<ReturnType<ObjectiveSignalPort["measure"]>> {
    const { cc, asked } = m;
    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;
    const aggregate = measurementOf(cc, m.skipped, m.scripts, m.changeDiff, m.executed ?? undefined, m.trouble, m.evidenceLeftOut);
    /* Per use case: figures beside the aggregate, which stays the only one that decides. */
    const candidates = asked.candidates ?? [];
    const measurement: CoverageMeasurement = candidates.length > 0
      ? { ...aggregate, ...recordedExclusions(asked.exclusions), perCandidate: perCandidateCoverage({ candidates, diff: m.changeDiff, coverage: cc, aggregate: aggregate.unmeasured, crossRepo: asked.crossRepo === true }) }
      : { ...aggregate, ...recordedExclusions(asked.exclusions) };
    return {
      status,
      ratio,
      ...(m.willAssemble && cc?.uncovered ? { uncovered: cc.uncovered } : {}),
      ...(cc?.untakenArms ? { untakenArms: cc.untakenArms } : {}),
      measurement,
      ...(m.ranBy ? { ranBy: m.ranBy } : {}),
    };
  }

  /*
   * The dumps a measurement reads: the namespace's, or, after re-runs of some spec files, the latest of every spec file. The report is
   * null when a re-run's dumps could not be read with the rest, or the collector cannot add namespaces: a part never stands for the
   * suite. Then `fault` says why the read ended badly, when it did, and `reads` holds the record of every read made.
   */
  private async collectFrom(specDir: string, namespace: string, latest: readonly DumpSource[] | undefined, changedFiles: string[] | undefined): Promise<{ report: CoverageReport | null; fault?: CoverageReadFault; reads: readonly CoverageRead[] }> {
    if (latest === undefined) {
      const report = await this.deps.collector.collect(specDir, namespace, changedFiles);
      return { report, ...(report.fault ? { fault: report.fault } : {}), reads: report.reads ?? [] };
    }
    const { recollect } = this.deps.collector;
    if (!recollect) return { report: null, reads: [] };
    const report = await recollect.call(this.deps.collector, specDir, latest, changedFiles);
    return { report: report.incomplete ? null : report, ...(report.fault ? { fault: report.fault } : {}), reads: report.reads ?? [] };
  }

  /* The coverage of `sources` with the dumps of each proof's re-run added (its edit undone, only its failing spec files); its `cc` is null when a source could not be read, so a part never stands for the whole, and the report it was asked of is told either way. Null when the collector cannot add namespaces. */
  private async withProofs(specDir: string, sources: readonly DumpSource[], proofs: readonly MutantProof[], changeDiff: string, changedFiles: string[] | undefined, noCodeOf: NoCodeLinesOf): Promise<{ cc: ChangeCoverage | null; report: CoverageReport } | null> {
    const { recollect } = this.deps.collector;
    if (!recollect || !this.ctx.assembleChangeCoverage) return null;
    const proofSources = proofs.map(({ namespace, specFiles, ...mutant }) => ({ namespace, onlySpecFiles: specFiles, mutant }));
    const report = await recollect.call(this.deps.collector, specDir, [...sources, ...proofSources], changedFiles);
    return { cc: report.incomplete ? null : this.ctx.assembleChangeCoverage(changeDiff, report, noCodeOf), report };
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

  async recount(br: BlastRadius, specDir: string, diff: string | undefined, reruns: readonly CoverageRerun[], opts?: { namespace?: string; proofs?: readonly MutantProof[]; exclusions?: CoverageExclusions; caseFiles?: readonly string[]; onRead?: (read: CoverageRead) => void }): Promise<CoverageRecount | null> {
    const { recollect } = this.deps.collector;
    if (this.ctx.policy.mode === "off" || !diff || !this.ctx.assembleChangeCoverage || !recollect) return null;
    const changeDiff = changeDiffOf(diff, opts?.exclusions)!;
    const base = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    const { sources, rewritten } = latestDumpsOf(base, reruns);
    /* A proof holds only for the spec bytes that killed its mutant: the re-run spec files are not those any more. */
    const proofs = (opts?.proofs ?? []).map((p) => ({ ...p, specFiles: p.specFiles.filter((file) => !rewritten.includes(file)) })).filter((p) => p.specFiles.length > 0);
    const proofSources = proofs.map(({ namespace, specFiles, ...mutant }) => ({ namespace, onlySpecFiles: specFiles, mutant }));
    const report = await recollect.call(this.deps.collector, specDir, [...sources, ...proofSources], [...parseDiffHunks(changeDiff).keys()]);
    tellReads(report.reads, opts?.onRead);
    /* A source that could not be read would count a part of the suite as the whole: the measurement before the recount stands, and the read that failed is told to the observer. */
    if (report.incomplete) return null;
    const cc = this.ctx.assembleChangeCoverage(changeDiff, report, this.noCodeOf());
    const ranBy = ranByOf(report, opts?.caseFiles ?? []);
    return {
      status: this.deps.decide.decide(cc, this.ctx.policy),
      ratio: cc.measured ? cc.overall.ratio : null,
      uncovered: cc.uncovered,
      untakenArms: cc.untakenArms ?? [],
      measurement: { ...measurementOf(cc, undefined, report.scripts, undefined, undefined, readTroubleOf(report)), ...recordedExclusions(opts?.exclusions) },
      ...(ranBy ? { ranBy } : {}),
    };
  }
}

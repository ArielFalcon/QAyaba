/* ObjectiveSignalPort: change-coverage measure, recount + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CoverageMeasurement } from "../../domain/objective-signal.ts";
import type { ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";
import type { CoverageRecount, CoverageRerun } from "../../domain/objective-signal.ts";
import type { BundleMutationPort } from "../../application/ports/bundle-mutation.port.ts";
import type { CoverageCollectorPort } from "../../application/ports/coverage-collector.port.ts";
import type { ValueOraclePort } from "../../application/ports/value-oracle.port.ts";
import type { BundleMutationResult, CoverageReport, DumpSource } from "../../domain/coverage-collector.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "../../domain/decide-coverage.service.ts";
import { parseDiffHunks } from "../../domain/assemble-change-coverage.ts";
import { selectMutants } from "../../domain/select-mutants.ts";
import { diffWithoutTestFiles } from "@kernel/diff-parser/diff-without-test-files.ts";
import { diffChangedFiles, perCandidateCoverage } from "../../domain/per-candidate-coverage.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  oracle: ValueOraclePort;
  /* The mutation pass over the served script; absent when the value oracle is off or the target has no browser. */
  mutation?: BundleMutationPort;
}

export interface ObjectiveSignalPortStaticContext {
  policy: CoveragePolicy;
  repoDir: string;
  /* Turns CoverageReport + diff into ChangeCoverage. Absent → decide() gets null → unknown, never blocks. */
  assembleChangeCoverage?: (diff: string, report: CoverageReport) => ChangeCoverage;
  baselineCases?: string[];
  /* Same per-run namespace ExecutionPortAdapter uses so dumps are read from the directory execution wrote. Optional; falls back to br.sha.toString(). */
  namespace?: string;
}

/* What the measurement counted, and why one that decides nothing did not. */
function measurementOf(cc: ChangeCoverage | null, skipped: CoverageMeasurement["unmeasured"], scripts?: CoverageReport["scripts"], diff?: string): CoverageMeasurement {
  if (!cc) return { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: skipped ?? "not-assembled" };
  const counts = {
    changedLines: cc.overall.changedLines,
    coveredChanged: cc.overall.coveredChanged,
    changedFiles: cc.perFile.length,
    mappedFiles: cc.perFile.filter((file) => file.covered > 0).length,
    ...(cc.branches ? { changedBranches: cc.branches.changedBranches, takenBranches: cc.branches.takenBranches } : {}),
  };
  /* A diff that changes files and adds no line only deletes. */
  if (cc.overall.changedLines === 0) return { ...counts, unmeasured: diff !== undefined && diffChangedFiles(diff).length > 0 ? "deletion-only" : "no-changed-lines" };
  if (cc.measured) return counts;
  /* Scripts ran and none of them carried a source map: nothing could have mapped them to the repository, whatever the change was. */
  const unmappable = scripts !== undefined && scripts.total > 0 && scripts.withSourceMap === 0;
  return { ...counts, unmeasured: unmappable ? "no-source-maps" : "no-changed-file-mapped" };
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
    const changeDiff = diff ? diffWithoutTestFiles(diff).diff : undefined;
    /* Per-call changed files from the live diff. Composition-time collectors often hold a static empty list; absent diff → collector constructor value. */
    const changedFiles = changeDiff !== undefined ? [...parseDiffHunks(changeDiff).keys()] : undefined;
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    const report = willAssemble ? await this.deps.collector.collect(specDir, namespace, changedFiles) : null;
    const cc: ChangeCoverage | null = report ? this.ctx.assembleChangeCoverage!(changeDiff!, report) : null;

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;
    const aggregate = measurementOf(cc, !diff ? "no-diff" : this.ctx.assembleChangeCoverage === undefined ? "not-assembled" : undefined, report?.scripts, changeDiff);
    /* Per use case: figures beside the aggregate, which stays the only one that decides. */
    const candidates = opts?.candidates ?? [];
    const measurement: CoverageMeasurement = candidates.length > 0
      ? { ...aggregate, perCandidate: perCandidateCoverage({ candidates, diff: changeDiff, coverage: cc, aggregate: aggregate.unmeasured, crossRepo: opts?.crossRepo === true }) }
      : aggregate;

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases, opts?.faultAim);

    /* Mutants only of a measured change, on its changed lines, where a test reached. */
    let bundleMutation: BundleMutationResult | null = null;
    if (this.deps.mutation && report?.mutationSites && cc?.measured && changeDiff !== undefined) {
      const mutants = selectMutants(report.mutationSites, parseDiffHunks(changeDiff), opts?.caseFiles ?? []);
      if (mutants.length > 0) bundleMutation = await this.deps.mutation.measure(mutants, specDir, namespace, baselineCases ?? this.ctx.baselineCases ?? []);
    }

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
      ...(bundleMutation ? { bundleMutation } : {}),
      measurement,
    };
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.deps.decide.blocks(status, this.ctx.policy);
  }

  async recount(br: BlastRadius, specDir: string, diff: string | undefined, reruns: readonly CoverageRerun[], opts?: { namespace?: string }): Promise<CoverageRecount | null> {
    const { recollect } = this.deps.collector;
    if (this.ctx.policy.mode === "off" || !diff || !this.ctx.assembleChangeCoverage || !recollect) return null;
    const changeDiff = diffWithoutTestFiles(diff).diff;
    const base = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    const sources: DumpSource[] = [{ namespace: base, exceptSpecFiles: [...new Set(reruns.flatMap((r) => r.specFiles))] }, ...reruns.map((r) => ({ namespace: r.namespace }))];
    const report = await recollect.call(this.deps.collector, specDir, sources, [...parseDiffHunks(changeDiff).keys()]);
    const cc = this.ctx.assembleChangeCoverage(changeDiff, report);
    return {
      status: this.deps.decide.decide(cc, this.ctx.policy),
      ratio: cc.measured ? cc.overall.ratio : null,
      uncovered: cc.uncovered,
      untakenArms: cc.untakenArms ?? [],
      measurement: measurementOf(cc, undefined, report.scripts),
    };
  }
}

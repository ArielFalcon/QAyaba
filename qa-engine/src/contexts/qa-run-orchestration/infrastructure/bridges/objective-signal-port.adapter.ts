/* ObjectiveSignalPort: change-coverage measure + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CoverageMeasurement, ObjectiveSignalPort } from "../../application/ports/index.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, CoverageReport, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";
import { parseDiffHunks } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { diffWithoutTestFiles } from "@contexts/generation/domain/diff-without-test-files.ts";

export interface ObjectiveSignalPortCollaborators {
  collector: CoverageCollectorPort;
  decide: DecideCoverageService;
  oracle: ValueOraclePort;
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
function measurementOf(cc: ChangeCoverage | null, skipped: CoverageMeasurement["unmeasured"], scripts?: CoverageReport["scripts"]): CoverageMeasurement {
  if (!cc) return { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: skipped ?? "not-assembled" };
  const counts = {
    changedLines: cc.overall.changedLines,
    coveredChanged: cc.overall.coveredChanged,
    changedFiles: cc.perFile.length,
    mappedFiles: cc.perFile.filter((file) => file.covered > 0).length,
  };
  if (cc.overall.changedLines === 0) return { ...counts, unmeasured: "no-changed-lines" };
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

  async measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; measurement?: CoverageMeasurement }> {
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
    const measurement = measurementOf(cc, !diff ? "no-diff" : this.ctx.assembleChangeCoverage === undefined ? "not-assembled" : undefined, report?.scripts);

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases);

    return {
      status,
      ratio,
      valueScore: oracleResult.valueScore,
      mutantCount: oracleResult.mutantCount,
      killedCount: oracleResult.killedCount,
      ...(willAssemble && cc?.uncovered ? { uncovered: cc.uncovered } : {}),
      measurement,
    };
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.deps.decide.blocks(status, this.ctx.policy);
  }
}

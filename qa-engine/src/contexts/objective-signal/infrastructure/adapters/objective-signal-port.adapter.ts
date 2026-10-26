/* ObjectiveSignalPort: change-coverage measure + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CoverageMeasurement } from "../../domain/objective-signal.ts";
import type { ObjectiveSignalPort } from "../../application/ports/objective-signal.port.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "@contexts/objective-signal/application/index.ts";
import type { CoverageCollectorPort, CoverageReport, ValueOraclePort } from "@contexts/objective-signal/application/index.ts";
import { parseDiffHunks } from "@contexts/objective-signal/application/index.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { CandidateValue, FaultAim, ValueStats } from "../../domain/fault-injection-score.ts";
import { diffChangedFiles, perCandidateCoverage } from "../../domain/per-candidate-coverage.ts";

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
function measurementOf(cc: ChangeCoverage | null, skipped: CoverageMeasurement["unmeasured"], scripts?: CoverageReport["scripts"], diff?: string): CoverageMeasurement {
  if (!cc) return { changedLines: 0, coveredChanged: 0, changedFiles: 0, mappedFiles: 0, unmeasured: skipped ?? "not-assembled" };
  const counts = {
    changedLines: cc.overall.changedLines,
    coveredChanged: cc.overall.coveredChanged,
    changedFiles: cc.perFile.length,
    mappedFiles: cc.perFile.filter((file) => file.covered > 0).length,
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

  async measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string; candidates?: readonly UseCaseCandidate[]; crossRepo?: boolean; faultAim?: FaultAim }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; valueByCandidate?: CandidateValue[]; valueStats?: ValueStats; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; measurement?: CoverageMeasurement }> {
    const namespace = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    /* coverage.mode "off" skips collector IO and the value oracle. decide() sees null → "unknown" (never blocks). */
    if (this.ctx.policy.mode === "off") {
      return { status: this.deps.decide.decide(null, this.ctx.policy), ratio: null };
    }
    /* Per-call changed files from the live diff. Composition-time collectors often hold a static empty list; absent diff → collector constructor value. */
    const changedFiles = diff ? [...parseDiffHunks(diff).keys()] : undefined;
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    const report = willAssemble ? await this.deps.collector.collect(specDir, namespace, changedFiles) : null;
    const cc: ChangeCoverage | null = report ? this.ctx.assembleChangeCoverage!(diff!, report) : null;

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;
    const aggregate = measurementOf(cc, !diff ? "no-diff" : this.ctx.assembleChangeCoverage === undefined ? "not-assembled" : undefined, report?.scripts, diff);
    /* Per use case: figures beside the aggregate, which stays the only one that decides. */
    const candidates = opts?.candidates ?? [];
    const measurement: CoverageMeasurement = candidates.length > 0
      ? { ...aggregate, perCandidate: perCandidateCoverage({ candidates, diff, coverage: cc, aggregate: aggregate.unmeasured, crossRepo: opts?.crossRepo === true }) }
      : aggregate;

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases, opts?.faultAim);

    return {
      status,
      ratio,
      valueScore: oracleResult.valueScore,
      ...(oracleResult.perCandidate !== undefined ? { valueByCandidate: oracleResult.perCandidate } : {}),
      ...(oracleResult.stats !== undefined ? { valueStats: oracleResult.stats } : {}),
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

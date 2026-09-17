/* ObjectiveSignalPort: change-coverage measure + blocks. unknown never blocks. */

import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { ObjectiveSignalPort } from "../../application/ports/index.ts";
import { DecideCoverageService, type ChangeCoverage, type CoveragePolicy } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, CoverageReport, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";
import { parseDiffHunks } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";

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

export class ObjectiveSignalPortAdapter implements ObjectiveSignalPort {
  constructor(
    private readonly deps: ObjectiveSignalPortCollaborators,
    private readonly ctx: ObjectiveSignalPortStaticContext,
  ) {}

  async measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; uncovered?: { file: string; lines: number[] }[] }> {
    const namespace = opts?.namespace ?? this.ctx.namespace ?? br.sha.toString();
    /* coverage.mode "off" skips collector IO and the value oracle. decide() sees null → "unknown" (never blocks). */
    if (this.ctx.policy.mode === "off") {
      return { status: this.deps.decide.decide(null, this.ctx.policy), ratio: null };
    }
    /* Per-call changed files from the live diff. Composition-time collectors often hold a static empty list; absent diff → collector constructor value. */
    const changedFiles = diff ? [...parseDiffHunks(diff).keys()] : undefined;
    const willAssemble = this.ctx.assembleChangeCoverage !== undefined && !!diff;
    const cc: ChangeCoverage | null = willAssemble
      ? this.ctx.assembleChangeCoverage!(diff!, await this.deps.collector.collect(specDir, namespace, changedFiles))
      : null;

    const status = this.deps.decide.decide(cc, this.ctx.policy);
    const ratio = cc?.measured ? cc.overall.ratio : null;

    const oracleResult = await this.deps.oracle.measure(br, this.ctx.repoDir, namespace, baselineCases ?? this.ctx.baselineCases);

    return { status, ratio, valueScore: oracleResult.valueScore, ...(willAssemble && cc?.uncovered ? { uncovered: cc.uncovered } : {}) };
  }

  blocks(status: "pass" | "fail" | "unknown"): boolean {
    return this.deps.decide.blocks(status, this.ctx.policy);
  }
}

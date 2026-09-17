/* Coverage keystone. Unmeasured or zero changed lines → unknown. unknown NEVER blocks publish — blocks() is true only for enforce + fail. */

export type CoverageStatus = "pass" | "fail" | "unknown";
export type CoverageMode = "off" | "signal" | "enforce";
export interface CoveragePolicy { mode: CoverageMode; minRatio: number; }

export interface ChangeCoverage {
  measured: boolean;
  overall: { changedLines: number; coveredChanged: number; ratio: number };
  perFile: { file: string; changed: number; covered: number; ratio: number }[];
  uncovered: { file: string; lines: number[] }[];
  branches: { changedBranches: number; takenBranches: number; ratio: number } | null;
}

export class DecideCoverageService {
  decide(cc: ChangeCoverage | null, policy: CoveragePolicy): CoverageStatus {
    if (!cc || !cc.measured || cc.overall.changedLines === 0) return "unknown";
    return cc.overall.ratio >= policy.minRatio ? "pass" : "fail";
  }

  blocks(status: CoverageStatus, policy: CoveragePolicy): boolean {
    return policy.mode === "enforce" && status === "fail";
  }
}

/* Coverage keystone. Unmeasured or zero changed lines → unknown. unknown NEVER blocks publish — blocks() is true only for enforce + fail. */

export type CoverageStatus = "pass" | "fail" | "unknown";
export type CoverageMode = "off" | "signal" | "enforce";
export interface CoveragePolicy { mode: CoverageMode; minRatio: number; }

export interface ChangeCoverage {
  measured: boolean;
  overall: { changedLines: number; coveredChanged: number; ratio: number };
  perFile: { file: string; changed: number; covered: number; ratio: number }[];
  uncovered: { file: string; lines: number[] }[];
  /* The arms of the decisions on changed lines, and how many ran; null when no decision was seen on a changed line. A signal beside the line ratio: it never decides the status. */
  branches: { changedBranches: number; takenBranches: number; ratio: number } | null;
  /* The arms on changed lines that never ran, in file and line order. */
  untakenArms?: { file: string; line: number; kind: string; arm: string }[];
  /* The changed lines a loaded script holds no code for (imports, types, comments): neither counted nor uncovered. Absent when the collector cannot tell code from the rest. */
  notExecutable?: { file: string; lines: number[] }[];
  /* The changed files no loaded script maps: their non-blank added lines are counted, and uncovered. */
  notLoaded?: { file: string; lines: number[] }[];
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

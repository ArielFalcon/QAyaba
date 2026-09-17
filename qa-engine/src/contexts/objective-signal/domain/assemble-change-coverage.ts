import type { CoverageReport } from "../application/ports/index.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";

type CoveredLines = Map<string, Set<number>>;

export function parseDiffHunks(diff: string): CoveredLines {
  const changed: CoveredLines = new Map();
  let file: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      file = null;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).trim();
        file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
      }
      continue;
    }
    if (file === null) continue;
    const c = raw[0];
    if (c === "+") {
      let set = changed.get(file);
      if (!set) changed.set(file, (set = new Set()));
      set.add(newLine);
      newLine++;
    } else if (c === "-") {
    } else if (c === "\\") {
    } else {
      newLine++;
    }
  }
  return changed;
}

export function computeChangeCoverage(changed: CoveredLines, covered: CoveredLines): ChangeCoverage {
  const perFile: ChangeCoverage["perFile"] = [];
  const uncovered: ChangeCoverage["uncovered"] = [];
  let totalChanged = 0;
  let totalCovered = 0;
  let anyFileMeasured = false;

  for (const [file, lineSet] of changed) {
    const cov = covered.get(file);
    if (cov) anyFileMeasured = true;
    let fileCovered = 0;
    const fileUncovered: number[] = [];
    for (const ln of lineSet) {
      if (cov?.has(ln)) fileCovered++;
      else fileUncovered.push(ln);
    }
    totalChanged += lineSet.size;
    totalCovered += fileCovered;
    perFile.push({ file, changed: lineSet.size, covered: fileCovered, ratio: lineSet.size ? fileCovered / lineSet.size : 1 });
    if (fileUncovered.length) uncovered.push({ file, lines: fileUncovered.sort((a, b) => a - b) });
  }

  return {
    measured: anyFileMeasured,
    overall: { changedLines: totalChanged, coveredChanged: totalCovered, ratio: totalChanged ? totalCovered / totalChanged : 1 },
    perFile,
    uncovered,
    branches: null,
  };
}

function toCoveredLines(report: CoverageReport): CoveredLines {
  const out: CoveredLines = new Map();
  for (const entry of report.covered) {
    out.set(entry.file, new Set(entry.lines));
  }
  return out;
}

export function assembleChangeCoverage(diff: string, report: CoverageReport): ChangeCoverage {
  const changed = parseDiffHunks(diff);
  const covered = toCoveredLines(report);
  return computeChangeCoverage(changed, covered);
}

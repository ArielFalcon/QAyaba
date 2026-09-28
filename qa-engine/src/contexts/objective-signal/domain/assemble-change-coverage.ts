import type { CoverageReport } from "../application/ports/index.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";

type CoveredLines = Map<string, Set<number>>;

/*
 * Added lines per file, numbered on the new side. A hunk's new side spans exactly the line count its
 * "@@" header declares (an omitted count is 1). Once that many context/added lines are read, the rest
 * of the hunk can only be removed lines, which map nothing, and what follows is the next file's
 * header — a git "diff --git" block or a plain diff's "---"/"+++" pair — so a "+++ " line inside a
 * hunk stays content while the one after it names the next file. "diff --git" always starts a new
 * file, even after a hunk cut short of its count.
 */
export function parseDiffHunks(diff: string): CoveredLines {
  const changed: CoveredLines = new Map();
  let file: string | null = null;
  let newLine = 0;
  let newLeft = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      file = null;
      newLeft = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      newLeft = Number(hunk[2] ?? 1);
      continue;
    }
    if (newLeft <= 0) {
      /* Only the new-side header names the file. A deleted file's reads "+++ /dev/null": its hunks
         declare zero new-side lines, so that name never receives an added line. */
      if (raw.startsWith("+++ ")) {
        file = raw.slice(4).trim().replace(/^[ab]\//, "").replace(/\t.*/, "");
      }
      continue;
    }
    const c = raw[0];
    if (c === "+") {
      if (file !== null) {
        let set = changed.get(file);
        if (!set) changed.set(file, (set = new Set()));
        set.add(newLine);
      }
      newLine++;
      newLeft--;
    } else if (c === "-") {
    } else if (c === "\\") {
    } else {
      newLine++;
      newLeft--;
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

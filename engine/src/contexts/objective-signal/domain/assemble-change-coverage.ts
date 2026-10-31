import type { BranchHit, CoverageReport } from "./coverage-collector.ts";
import type { ChangeCoverage } from "./decide-coverage.service.ts";
import { LanguageRegistry } from "@kernel/language-id.ts";

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
  for (const [file, lines] of addedLines(diff)) changed.set(file, new Set(lines.keys()));
  return changed;
}

/* The text of each added line per file, numbered on the new side as `parseDiffHunks` numbers them. */
export function addedLines(diff: string): Map<string, Map<number, string>> {
  const changed = new Map<string, Map<number, string>>();
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
        if (!set) changed.set(file, (set = new Map()));
        set.set(newLine, raw.slice(1));
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

/* The arms of the decisions on changed lines: how many, how many ran, and which never did. Null counts when no decision is on a changed line. */
function changedBranches(changed: CoveredLines, hits: readonly BranchHit[]): Pick<ChangeCoverage, "branches" | "untakenArms"> {
  let total = 0;
  let taken = 0;
  const untakenArms: NonNullable<ChangeCoverage["untakenArms"]> = [];
  for (const hit of hits) {
    if (!changed.get(hit.file)?.has(hit.line)) continue;
    for (const arm of hit.arms) {
      total++;
      if (arm.taken) taken++;
      else untakenArms.push({ file: hit.file, line: hit.line, kind: hit.kind, arm: arm.label });
    }
  }
  if (total === 0) return { branches: null };
  untakenArms.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { branches: { changedBranches: total, takenBranches: taken, ratio: taken / total }, untakenArms };
}

export function computeChangeCoverage(changed: CoveredLines, covered: CoveredLines, branchHits: readonly BranchHit[] = []): ChangeCoverage {
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
    ...changedBranches(changed, branchHits),
  };
}

function toCoveredLines(report: CoverageReport): CoveredLines {
  const out: CoveredLines = new Map();
  for (const entry of report.covered) {
    out.set(entry.file, new Set(entry.lines));
  }
  return out;
}

/* The lines of a changed file its language's statement syntax says hold no executable code; undefined when the language declares none or its source cannot be read. */
export type NoCodeLinesOf = (file: string) => ReadonlySet<number> | undefined;

/*
 * The changed lines a browser collection can count: those its scripts hold code for. A line a loaded script's source map maps no code
 * to (an import, a type, a comment, a brace) is not code and is left out; a covered line is code whatever the map says. A changed
 * file no loaded script maps is not loaded, and none of its lines ran: its language's statement syntax (`noCodeOf`) says which of its
 * lines hold no code (an import, a re-export, a type-only declaration), which are left out like the lines no map reaches, and its
 * other non-blank added lines are counted; a file whose every changed line is no code leaves the measurement (`noCode`); a language
 * that declares no syntax, or a source that cannot be read, counts every non-blank added line. That holds only for a file a script
 * can hold: one of a declared language, or of a kind (an extension) the run's scripts map for some file; a document or a style
 * sheet no script maps is not changed code and is not counted.
 */
export function executableChanged(added: ReadonlyMap<string, ReadonlyMap<number, string>>, executable: CoveredLines, covered: CoveredLines, noCodeOf?: NoCodeLinesOf): Pick<ChangeCoverage, "notExecutable" | "notLoaded" | "noCode"> & { counted: CoveredLines } {
  const counted: CoveredLines = new Map();
  const notExecutable: { file: string; lines: number[] }[] = [];
  const notLoaded: { file: string; lines: number[] }[] = [];
  const noCode: string[] = [];
  const mappedKinds = new Set([...executable.keys()].map(extensionOf));
  for (const [file, lines] of added) {
    const code = executable.get(file);
    if (!code && LanguageRegistry.languageForFile(file) === null && !mappedKinds.has(extensionOf(file))) continue;
    const cov = covered.get(file);
    const none = code ? undefined : noCodeOf?.(file);
    const kept: number[] = [];
    const left: number[] = [];
    for (const [line, text] of lines) {
      if (code ? code.has(line) || cov?.has(line) : text.trim() !== "" && !none?.has(line)) kept.push(line);
      else left.push(line);
    }
    if (kept.length > 0) counted.set(file, new Set(kept));
    if ((code || none) && left.length > 0) notExecutable.push({ file, lines: left.sort((a, b) => a - b) });
    if (!code && kept.length > 0) notLoaded.push({ file, lines: kept.sort((a, b) => a - b) });
    if (none && kept.length === 0 && lines.size > 0) noCode.push(file);
  }
  return { counted, notExecutable, notLoaded, ...(noCode.length > 0 ? { noCode } : {}) };
}

/* A file's extension, lower-cased, or "" when its name has none. */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function assembleChangeCoverage(diff: string, report: CoverageReport, noCodeOf?: NoCodeLinesOf): ChangeCoverage {
  const covered = toCoveredLines(report);
  if (!report.executable) return computeChangeCoverage(parseDiffHunks(diff), covered, report.branches);
  const { counted, ...apart } = executableChanged(addedLines(diff), toCoveredLines({ covered: report.executable }), covered, noCodeOf);
  return { ...computeChangeCoverage(counted, covered, report.branches), ...apart };
}

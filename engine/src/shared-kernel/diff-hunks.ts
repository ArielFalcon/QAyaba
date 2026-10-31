/*
 * Hunk and file-section primitives of a unified diff that several parties share: the file a `diff --git` section names, the
 * lines it adds and removes, and which hunks overlap the lines of a changed symbol. Pure.
 */
import { diffGitHeaderPath, type DiffHunk } from "./diff-parser/diff-parser.service.ts";
import type { ChangedSymbol } from "./change-reach.ts";

/* The file a `diff --git` section names; the empty string when its header cannot be read. */
export function sectionPath(section: string): string {
  const header = /^diff --git .*$/m.exec(section)?.[0];
  return header ? (diffGitHeaderPath(header) ?? "") : "";
}

export interface SectionStat {
  added: number;
  removed: number;
  status: "new" | "deleted" | "modified";
}

/* The lines a file section adds and removes (the `---`/`+++` side lines are not content) and whether the file is new or deleted. */
export function sectionStat(section: string): SectionStat {
  let added = 0;
  let removed = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  const status = /^new file mode/m.test(section) ? "new" : /^deleted file mode/m.test(section) ? "deleted" : "modified";
  return { added, removed, status };
}

/* The lines a hunk adds and removes. */
export function hunkLineCounts(hunk: DiffHunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/* Whether the hunk lies in the seed's file and overlaps its range; a seed with no range is the whole file. */
export function hunkOverlapsSeed(hunk: DiffHunk, seed: ChangedSymbol): boolean {
  return seed.file === hunk.file && (seed.range === undefined || (seed.range.start <= hunk.newEnd && hunk.newStart <= seed.range.end));
}

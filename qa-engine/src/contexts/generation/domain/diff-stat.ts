/* The size of a change as the diff really shows it: files touched and lines added and removed. Nothing here is estimated, and no commit count is claimed (the diff does not carry one). */

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/* Lines a unified diff uses to introduce a file before its first hunk; they are not content lines. */
const FILE_HEADER_RE =
  /^(?:diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;

export function diffStat(input: { diff: string; changedFiles?: readonly string[] }): DiffStat {
  let added = 0;
  let removed = 0;
  let headerCount = 0;
  let inHunk = false;
  for (const line of input.diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      headerCount++;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && FILE_HEADER_RE.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  const files = input.changedFiles?.length ? input.changedFiles.length : headerCount;
  return { files, added, removed };
}

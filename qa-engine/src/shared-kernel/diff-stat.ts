/* The size of a change as the diff really shows it: files touched and lines added and removed. Nothing here is estimated, and no commit count is claimed (the diff does not carry one). */

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/* The two lines that name a file's old and new side before its first hunk. They start like a removed and an added line but are not content; every other header line starts with a letter. */
const FILE_SIDE_RE = /^(?:--- |\+\+\+ )/;

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
    if (!inHunk && FILE_SIDE_RE.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  const files = input.changedFiles?.length ? input.changedFiles.length : headerCount;
  return { files, added, removed };
}

/* The size classes a change falls in, smallest first. */
export const DIFF_TIER_NAMES = ["tiny", "focused", "broad"] as const;
export type DiffTier = (typeof DIFF_TIER_NAMES)[number];

/* What the two smaller tiers admit: a change is in the smallest tier whose two limits both hold, with the changed lines counted as added plus removed. Anything larger is broad, which has no limit. */
/* Declared limitation: the tiers count raw files and changed lines, so generated files and lockfiles inflate a tier and a one-line change can have a wide blast radius; a tier is only an upper bound on the effort and always admits the no-op. */
export const DIFF_TIERS = {
  tiny: { maxFiles: 2, maxLines: 40 },
  focused: { maxFiles: 8, maxLines: 400 },
} as const;

function fits(stat: DiffStat, limits: { maxFiles: number; maxLines: number }): boolean {
  return stat.files <= limits.maxFiles && stat.added + stat.removed <= limits.maxLines;
}

export function diffTier(stat: DiffStat): DiffTier {
  if (fits(stat, DIFF_TIERS.tiny)) return "tiny";
  return fits(stat, DIFF_TIERS.focused) ? "focused" : "broad";
}

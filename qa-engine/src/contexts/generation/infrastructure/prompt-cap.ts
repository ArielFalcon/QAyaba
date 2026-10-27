/*
 * Prompt-budget capping for the two shapes a generator/reviewer prompt carries: a diff (capDiff)
 * and free-form prose like a commit body (capText) — genuinely distinct truncation strategies, not
 * two names for the same thing. capDiff splits the diff into per-file sections (`diff --git a/...
 * b/...` boundaries), relevance-orders them (changed source FIRST; style sheets after it;
 * lockfiles/generated/snapshot/binary/build-artifact/map/changelog files LAST —
 * LOW_RELEVANCE_PATTERNS), keeps every WHOLE section that still fits the budget, and lists each one
 * it leaves out on a line of its own with its added and removed lines (never truncates a hunk
 * mid-line), so a reader of a large change still sees every file it touches. A degenerate single-oversized-file overflow
 * hard-slices that one section. capText is flat prose truncation with no file-awareness.
 * capDiff is the only diff capper; nothing in src/ keeps a copy. The lead's planning turn does not go through it: its diff is
 * the change map and the hunks that fit the lead's window (plan-diff-section.ts).
 */
import { changeFileLine } from "@kernel/change-map.ts";
import { sectionPath, sectionStat } from "@kernel/diff-hunks.ts";
import { isLowRelevance, isStyleSheet } from "@kernel/file-classes.ts";

export const MAX_PROMPT_DIFF_CHARS = 50_000;

/* One line for a section left out: its path, its added and removed lines, and whether the file is new or deleted. */
function omittedLine(section: string, file: string): string {
  return changeFileLine({ path: file, ...sectionStat(section) });
}

export function extractDiffFilePath(section: string): string {
  return sectionPath(section);
}

const DIFF_HEADER_START_RE = /^diff --git /;

export function capDiff(diff: string, maxChars: number = MAX_PROMPT_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  const rawSections = diff.split(/^(?=diff --git )/m);

  const firstSection = rawSections[0] ?? "";
  const hasRealPreamble = !DIFF_HEADER_START_RE.test(firstSection);

  const preamble = hasRealPreamble ? firstSection : "";
  const fileSections = hasRealPreamble ? rawSections.slice(1) : rawSections;
  const highRelevance: string[] = [];
  const styleSheets: string[] = [];
  const lowRelevance: string[] = [];
  for (const s of fileSections) {
    const filePath = extractDiffFilePath(s);
    if (isLowRelevance(filePath)) {
      lowRelevance.push(s);
    } else if (isStyleSheet(filePath)) {
      styleSheets.push(s);
    } else {
      highRelevance.push(s);
    }
  }
  const ordered = [preamble, ...highRelevance, ...styleSheets, ...lowRelevance];

  const kept: string[] = [];
  const omitted: string[] = [];
  const omittedLines = new Map<string, string>();
  let used = 0;
  for (const section of ordered) {
    if (used + section.length <= maxChars) {
      kept.push(section);
      used += section.length;
    } else {
      if (section === preamble) continue;
      const file = extractDiffFilePath(section) || (/^diff --git a\/(\S+)/.exec(section)?.[1] ?? "(unnamed section)");
      omitted.push(file);
      omittedLines.set(file, omittedLine(section, file));
    }
  }
  if (kept.filter((s) => s !== preamble).length === 0 && fileSections.length > 0) {
    const firstFile = highRelevance[0] ?? styleSheets[0] ?? lowRelevance[0] ?? fileSections[0]!;
    kept.push(firstFile.slice(0, maxChars));
    const name = extractDiffFilePath(firstFile);
    const idx = omitted.indexOf(name);
    /* indexOf returns -1 when this section's name couldn't be found in `omitted` (e.g. its header
       is malformed enough that extractDiffFilePath can't match it here even though the main loop's
       looser fallback regex found A name for it there). `splice(-1, 1)` would otherwise delete the
       LAST unrelated entry instead of doing nothing — silently un-reporting a genuine omission. */
    if (idx !== -1) omitted.splice(idx, 1);
  }
  return (
    kept.join("") +
    `\n[diff truncated for the prompt: ${omitted.length} file(s) omitted (${diff.length} chars total).` +
    ` Read the full change in the working copy with \`git show <sha>\`. Omitted, with the lines each adds and removes:\n` +
    omitted.map((file) => omittedLines.get(file) ?? `- ${file}`).join("\n") +
    `]\n`
  );
}

export const MAX_PROMPT_BODY_CHARS = 4_000;

export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}

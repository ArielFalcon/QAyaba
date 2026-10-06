/*
 * "Already in the prompt" detection by content: a read counts as redundant
 * work when most of what it returned was already visible in the turn's own
 * prompt. A file the prompt renders compactly (a facts list, a summary) is
 * invisible to this measure, so the prompt also lists such files by path
 * (AssembledPrompt.providedPaths) and the tracker counts a read of a listed
 * path separately; the two counts are never merged.
 */

export const PROVIDED_CONTEXT_SAMPLE_LINES = 24;
export const PROVIDED_CONTEXT_MIN_LINE_LENGTH = 12;
export const PROVIDED_CONTEXT_MIN_SAMPLE_LINES = 3;
export const PROVIDED_CONTEXT_MATCH_RATIO = 0.8;

/* Strips a leading line-number gutter — cat -n style ("   12\t..."), a pipe
   style ("12| ...") or a colon style ("12: ...") — common across read-tool
   output renderings. */
const GUTTER_RE = /^\s*\d+[|:\t]\s?/;

function normalizeLine(line: string): string {
  return line.replace(GUTTER_RE, "").trim();
}

/* A unified diff shows a changed line behind a one-character `+` or `-` marker (a context line behind a
   space, which normalizing already trims). The file itself shows the line without the marker. */
function withoutDiffMarker(line: string): string | null {
  if (line[0] !== "+" && line[0] !== "-") return null;
  return line.slice(1).trim();
}

/** Samples up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines from a
 *  completed read's raw output, keeping only lines at least
 *  PROVIDED_CONTEXT_MIN_LINE_LENGTH characters long. Stops scanning once the
 *  sample is full, so a huge read costs no more than a small one. */
export function sampleReadOutput(output: string): string[] {
  const sampled: string[] = [];
  let lineStart = 0;
  while (sampled.length < PROVIDED_CONTEXT_SAMPLE_LINES) {
    const newline = output.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? output.length : newline;
    const line = normalizeLine(output.slice(lineStart, lineEnd));
    if (line.length >= PROVIDED_CONTEXT_MIN_LINE_LENGTH) sampled.push(line);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return sampled;
}

/** Indexes the turn's own prompt, normalized the same way as sampled read
 *  output, so the two are comparable at flush time. A line of a diff the
 *  prompt carries is indexed both as written and without its `+`/`-` marker,
 *  so a read of the changed file matches the diff's lines. */
export function indexPromptLines(prompt: string): ReadonlySet<string> {
  const index = new Set<string>();
  for (const raw of prompt.split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (line.length >= PROVIDED_CONTEXT_MIN_LINE_LENGTH) index.add(line);
    const unmarked = withoutDiffMarker(line);
    if (unmarked !== null && unmarked.length >= PROVIDED_CONTEXT_MIN_LINE_LENGTH) index.add(unmarked);
  }
  return index;
}

/** A read counts as already-provided-by-the-prompt when at least
 *  PROVIDED_CONTEXT_MATCH_RATIO of at least PROVIDED_CONTEXT_MIN_SAMPLE_LINES
 *  sampled lines are present in the prompt's line index. */
export function isProvidedByPrompt(
  sampledLines: readonly string[],
  promptIndex: ReadonlySet<string>,
): boolean {
  if (sampledLines.length < PROVIDED_CONTEXT_MIN_SAMPLE_LINES) return false;
  const matches = sampledLines.filter((line) => promptIndex.has(line)).length;
  return matches / sampledLines.length >= PROVIDED_CONTEXT_MATCH_RATIO;
}

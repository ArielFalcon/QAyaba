/*
 * "Already in the prompt" detection — content-based, with no
 * manifest threading (a manifest from the prompt builders is out of scope:
 * this change must not touch them). A read counts as redundant work when
 * most of what it returned was already visible in the turn's own prompt.
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
  if (line.length === 0 || (line[0] !== "+" && line[0] !== "-")) return null;
  return line.slice(1).trim();
}

/** Samples up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines from a
 *  completed read's raw output, keeping only lines at least
 *  PROVIDED_CONTEXT_MIN_LINE_LENGTH characters long. Stops scanning once the
 *  sample is full, so a huge read costs no more than a small one. */
export function sampleReadOutput(output: string): string[] {
  const sampled: string[] = [];
  let lineStart = 0;
  while (lineStart <= output.length && sampled.length < PROVIDED_CONTEXT_SAMPLE_LINES) {
    const newline = output.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? output.length : newline;
    const carriageReturn = lineEnd > lineStart && output[lineEnd - 1] === "\r" ? 1 : 0;
    const line = normalizeLine(output.slice(lineStart, lineEnd - carriageReturn));
    if (line.length >= PROVIDED_CONTEXT_MIN_LINE_LENGTH) sampled.push(line);
    lineStart = lineEnd + 1;
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

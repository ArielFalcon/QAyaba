/*
 * "Already in the prompt" detection (design D8) — content-based, with no
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

function normalizedQualifyingLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((line) => line.length >= PROVIDED_CONTEXT_MIN_LINE_LENGTH);
}

/** Samples up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines from a
 *  completed read's raw output, keeping only lines at least
 *  PROVIDED_CONTEXT_MIN_LINE_LENGTH characters long. */
export function sampleReadOutput(output: string): string[] {
  return normalizedQualifyingLines(output).slice(0, PROVIDED_CONTEXT_SAMPLE_LINES);
}

/** Indexes the turn's own prompt, normalized the same way as sampled read
 *  output, so the two are comparable at flush time. */
export function indexPromptLines(prompt: string): ReadonlySet<string> {
  return new Set(normalizedQualifyingLines(prompt));
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

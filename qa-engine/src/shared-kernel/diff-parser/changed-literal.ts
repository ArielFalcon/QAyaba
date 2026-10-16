/* A quoted string literal a diff added to or removed from a file: what a page could show as a label or a caption, read from the quotes alone, so it holds for any language the diff is written in. */
export interface ChangedLiteral {
  file: string; /* repo-relative */
  line: number; /* 1-based: on the new side for an added literal, on the old side for a removed one */
  value: string;
  side: "added" | "removed";
  /* How many lines of the file, as it is after the change, hold the value and were not changed by it. Set by a caller that read the file; absent when the file was not read. */
  unchangedLines?: number;
}

/* The most distinct literals a diff reports on each side: a change that rewrites a whole screen says no more by listing more. */
export const MAX_ADDED_LITERALS = 8;
export const MAX_REMOVED_LITERALS = 4;

const MIN_LITERAL_CHARS = 2;
const MAX_LITERAL_CHARS = 80;

/* A line that is a comment or a module statement holds quotes that are neither labels nor captions. */
const NON_CONTENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|<!--|--\s|import\b|export\b[^"'`]*\bfrom\b|from\b|package\b|using\b|require\b|@import\b)/;

/* A value that names a place or a module rather than showing text. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

/* One capitalised token that is an identifier of some convention: one with an underscore, a dotted path, or a name with more than one hump. */
const IDENTIFIER_TOKEN = /^(?:[A-Za-z0-9]*_[A-Za-z0-9_]*|[\w$]+(?:\.[\w$]+)+|\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}*)+\w*)$/u;

/* What a literal must look like to be a label: some text with a letter, no substitution in it, and either a phrase or one capitalised word. A single lower-case token ("submit", "primary") is far more often a code value than a label, so it is left out. */
export function isLabelLike(value: string): boolean {
  if (value.length < MIN_LITERAL_CHARS || value.length > MAX_LITERAL_CHARS) return false;
  if (!/\p{L}/u.test(value)) return false;
  if (/\$\{|\{\{|\}\}|#\{|<%|%>/.test(value)) return false;
  if (SCHEME_PREFIX.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return false;
  if (/\s/.test(value)) return true;
  if (IDENTIFIER_TOKEN.test(value)) return false;
  return /^\p{Lu}/u.test(value);
}

const QUOTES = new Set(['"', "'", "`"]);

/* The label-like string literals of one line, in order. A quote opens a literal and the next unescaped quote of the same kind on the line closes it; a quote that never closes (an apostrophe) opens nothing. */
export function labelLiteralsOfLine(line: string): string[] {
  if (NON_CONTENT_LINE.test(line)) return [];
  const found: string[] = [];
  let i = 0;
  while (i < line.length) {
    const quote = line[i]!;
    if (!QUOTES.has(quote)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) {
      i++;
      continue;
    }
    const value = line.slice(i + 1, j).trim();
    if (isLabelLike(value)) found.push(value);
    i = j + 1;
  }
  return found;
}

/* A quoted string literal a diff added to or removed from a file: what a page could show as a label or a caption, read from the quotes alone, so it holds for any language the diff is written in. */
export interface ChangedLiteral {
  file: string; /* repo-relative */
  line: number; /* 1-based: on the new side for an added literal, on the old side for a removed one */
  value: string;
  side: "added" | "removed";
  /* How many lines of the file, as it is after the change, hold the value and were not changed by it. Set by a caller that read the file; absent when the file was not read. */
  unchangedLines?: number;
}

/* The most distinct literals a diff reports on each side for one file: a change that rewrites a whole screen says no more by listing more. */
export const MAX_ADDED_LITERALS = 8;
export const MAX_REMOVED_LITERALS = 4;
/* The most a whole diff reports on each side, taken from its files in turn so that the first files of the diff cannot crowd out the rest. */
export const MAX_ADDED_LITERALS_IN_ALL = 24;
export const MAX_REMOVED_LITERALS_IN_ALL = 12;

const MIN_LITERAL_CHARS = 2;
const MAX_LITERAL_CHARS = 80;

/* A line that is a comment or a module statement holds quotes that are neither labels nor captions. */
const NON_CONTENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|<!--|--\s|import\b|export\b[^"'`]*\bfrom\b|from\b|package\b|using\b|require\b|@import\b)/;

/* A value that names a place or a module rather than showing text. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

/* One capitalised token that is an identifier of some convention: one with an underscore, a dotted path, or a name with more than one hump. */
const IDENTIFIER_TOKEN = /^(?:[A-Za-z0-9]*_[A-Za-z0-9_]*|[\w$]+(?:\.[\w$]+)+|\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}*)+\w*)$/u;

/* A hole the program fills in at run time: braces, a printf conversion, a `:name` token, a template or ERB tag. What a page shows is not this text. */
const PLACEHOLDER = /[{}]|<%|%>|%(?:\d+\$)?\d*(?:\.\d+)?[sdifuxXeEgGcb@]|(?:^|[\s(\[]):[A-Za-z_]/;

/* A phrase made only of lower-case ASCII tokens, one of them utility-shaped (a hyphen, colon, underscore, digit, slash or bracket): a list of CSS classes, not words. */
const LOWER_TOKEN = /^[a-z0-9][a-z0-9_\-:\/\[\]\.%#!&>*=]*$/;
const UTILITY_SHAPED = /[-:_\/\[\d]/;
export function isClassList(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((token) => LOWER_TOKEN.test(token)) && tokens.some((token) => UTILITY_SHAPED.test(token));
}

/* The common named entities: the Latin-1 letters and signs, and the punctuation pages use most. An entity not listed is left as written. */
const LATIN1_ENTITY_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", bull: "•", trade: "™",
  ...Object.fromEntries(LATIN1_ENTITY_NAMES.map((name, i) => [name, String.fromCharCode(0xa0 + i)])),
};

const codePoint = (value: number): string | undefined => (Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : undefined);

/* The text a page would show for a literal as it is written in source: HTML entities and the common backslash escapes (quotes, a backslash, \xNN, \uNNNN) decoded; anything else is left as written. */
export function decodeLiteralText(text: string): string {
  const entities = text.replace(/&(#x[0-9a-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const decoded = codePoint(body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
      return decoded ?? whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
  return entities.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(['"`\\/]))/g, (whole, u?: string, x?: string, plain?: string) => {
    if (plain !== undefined) return plain;
    return codePoint(parseInt((u ?? x)!, 16)) ?? whole;
  });
}

/* What a literal must look like to be a label: some text with a letter, no placeholder, not a list of CSS classes, and either a phrase or one capitalised word or one word of a script without case. A single lower-case token of a cased script ("submit", "primary") is far more often a code value than a label, so it is left out. */
export function isLabelLike(value: string): boolean {
  if (value.length < MIN_LITERAL_CHARS || value.length > MAX_LITERAL_CHARS) return false;
  if (!/\p{L}/u.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (SCHEME_PREFIX.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return false;
  if (/\s/.test(value)) return !isClassList(value);
  if (IDENTIFIER_TOKEN.test(value)) return false;
  return /^[\p{Lu}\p{Lo}]/u.test(value);
}

const QUOTES = new Set(['"', "'", "`"]);

/* The label-like string literals of one line, in order, as a page would show them. A quote opens a literal and the next unescaped quote of the same kind on the line closes it; a quote that never closes (an apostrophe) opens nothing. */
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
    const value = decodeLiteralText(line.slice(i + 1, j)).trim();
    if (isLabelLike(value)) found.push(value);
    i = j + 1;
  }
  return found;
}

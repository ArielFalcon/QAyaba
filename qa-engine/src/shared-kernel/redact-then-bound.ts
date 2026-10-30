/* The one rule for bounding text that came from outside the orchestrator (an agent's words, a page, a process's output, a network error, a commit, an operator's guidance): it is REDACTED first and CUT after, never the other way round. A secret that straddles a cut leaves its first characters in the kept text, and no pattern or value matches the prefix a cut leaves (a token cut to its first twenty characters no longer looks like a token), so a producer that bounds before the exit redacts is a leak the exit cannot see. Every producer's bound goes through `redactThenBound`; the exits keep their own redaction (defence in depth).
   The redactor is a parameter so the same rule serves the domain (which imports nothing outward) and every layer: the engine's pattern policy is bound to it in shared-infrastructure/redaction/redact-and-bound.ts, the shell binds its own. */

import { MAX_SECRET_VALUE_CHARS } from "./run-secret-redaction.ts";

/* How much text past the bound the redactor sees. Redaction needs the END of what it must take out: a run secret by value (up to MAX_SECRET_VALUE_CHARS, and a spelling of it that doubles it: an HTML, JSON or URL escaping) and the patterns that close on a delimiter (a private key's PEM block, about 3,300 characters for the largest RSA key; a quoted credential). A pattern that only runs on (a token, a base64 run, a `\S+` value) still matches the part the window holds, so a window that ends inside it loses nothing. Past this lookahead a secret that needs its end is left whole in the window and cut with it: the longest span redaction promises to close. */
export const REDACTION_LOOKAHEAD_CHARS = 2 * MAX_SECRET_VALUE_CHARS;

/* What stands for text whose redaction failed: never the raw text. */
export const REDACTION_FAILED = "[redacted]";

/* The start of every marker that says a text was cut at a safety bound; a section counts its cuts by it. */
export const CUT_MARKER_PREFIX = "[… cut: ";

/* The marker of a text cut at a safety bound on `what`: the length the text had before redaction and what was kept. */
export const cutMarker = (what: string) => (original: number, kept: number): string => `${CUT_MARKER_PREFIX}${original - kept} more chars of ${original}, past the safety bound on ${what}]`;

export interface BoundOptions {
  /* Which end of the text is kept. Default: the head. */
  keep?: "head" | "tail";
  /* Appended to the kept head when something was cut; receives the length the text had before redaction and the number of characters kept. */
  marker?: (original: number, kept: number) => string;
}

/* The text redacted by `redact`, then cut to `maxChars`. The redactor is given the kept end plus REDACTION_LOOKAHEAD_CHARS, so a bounded cost buys the end of whatever straddles the cut. A redactor that throws yields REDACTION_FAILED. */
export function redactThenBound(raw: string, maxChars: number, redact: (text: string) => string, options: BoundOptions = {}): string {
  const tail = options.keep === "tail";
  const windowChars = maxChars + REDACTION_LOOKAHEAD_CHARS;
  const windowed = raw.length > windowChars;
  try {
    const seen = !windowed ? raw : tail ? raw.slice(raw.length - windowChars) : raw.slice(0, windowChars);
    const redacted = redact(seen);
    const cut = windowed || redacted.length > maxChars;
    if (!cut) return redacted;
    const kept = tail ? redacted.slice(Math.max(0, redacted.length - maxChars)) : redacted.slice(0, maxChars);
    return !tail && options.marker !== undefined ? kept + options.marker(raw.length, kept.length) : kept;
  } catch {
    return REDACTION_FAILED;
  }
}

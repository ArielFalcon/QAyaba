/* The one rule for bounding text that came from outside the orchestrator (an agent's words, a page, a process's output, a network error, a commit, an operator's guidance): it is REDACTED first and CUT after, never the other way round. A secret that straddles a cut leaves its first characters in the kept text, and no pattern or value matches the prefix a cut leaves (a token cut to its first twenty characters no longer looks like a token), so a producer that bounds before the exit redacts is a leak the exit cannot see. Every producer's bound goes through `redactThenBound`; the exits keep their own redaction (defence in depth). A producer that holds the text in another process or in memory keeps a bound of its own that is a memory bound, large enough to hold the bound plus the lookahead (REDACTION_LOOKAHEAD_CHARS), and says so through `BoundOptions.rawIsWindow`; the cut that matters is this one.
   The redactor is a parameter so the same rule serves the domain (which imports nothing outward) and every layer: the engine's pattern policy is bound to it in shared-infrastructure/redaction/redact-and-bound.ts, the shell binds its own. */

import { REDACTED } from "./ports/redaction.port.ts";
import { MAX_SECRET_VALUE_CHARS } from "./run-secret-redaction.ts";

/* How much text past the bound the redactor sees. Redaction needs the END of what it must take out: a run secret by value (up to MAX_SECRET_VALUE_CHARS, and a spelling of it that doubles it: an HTML, JSON or URL escaping) and the patterns that close on a delimiter (a private key's PEM block, about 3,300 characters for the largest RSA key; a quoted credential). A pattern that only runs on (a token, a base64 run, a `\S+` value) still matches the part the window holds, so a window that ends inside it loses nothing. Past this lookahead a secret that needs its end is left whole in the window and cut with it: the longest span redaction promises to close. */
export const REDACTION_LOOKAHEAD_CHARS = 2 * MAX_SECRET_VALUE_CHARS;

/* The most characters a process that cannot redact (the browser capture, the seed's fixtures: they do not hold the run's secrets and must not) keeps of one piece of text it hands to the orchestrator. It is a memory bound, not a limit on what a prompt or a record shows: it holds the bound any orchestrator site applies to such text (every one is far below the lookahead) plus the lookahead, so the orchestrator's redact-then-bound sees the text whole. A text of at least this length may have been cut by its producer, and its bound is applied as for a window (`BoundOptions.rawIsWindow`). The seed's copy of the failure capture (config/e2e/fixtures.ts) repeats this number, because it is spliced into an app's own file and imports nothing; a test pins that they agree. */
export const PRODUCER_MEMORY_BOUND_CHARS = 2 * REDACTION_LOOKAHEAD_CHARS;

/* What stands for text whose redaction failed: never the raw text. */
export const REDACTION_FAILED = "[redacted]";

/* The start of every marker that says a text was cut at a safety bound; a section counts its cuts by it. */
export const CUT_MARKER_PREFIX = "[… cut: ";

/* The marker of a text cut at a safety bound on `what`: the characters the text had before redaction and the characters kept after it (the two are measured on different texts, so neither is a difference of the other). */
export const cutMarker = (what: string) => (original: number, kept: number): string => `${CUT_MARKER_PREFIX}kept ${kept} of ${original} chars before redaction, past the safety bound on ${what}]`;

/* How many times, each doubling the view, a view that redaction shrank is widened to find the bound's worth of text that was matched with its whole lookahead (a blob of base64 or a key can take out thousands of characters); a view still short after it keeps what it has, so the redactor never sees more than 2^MAX_WIDENINGS times the bound plus its lookahead. */
const MAX_WIDENINGS = 3;

export interface BoundOptions {
  /* Which end of the text is kept. Default: the head. */
  keep?: "head" | "tail";
  /* Appended to the kept head when something was cut; receives the length the text had before redaction and the number of characters kept. */
  marker?: (original: number, kept: number) => string;
  /* `raw` is itself the retained window of a longer text, cut at the end away from the kept one (its end for a head, its start for a tail): the producer held no more of it. Its first or last REDACTION_LOOKAHEAD_CHARS were therefore never seen whole by the redactor, and none of them is kept. */
  rawIsWindow?: boolean;
}

const commonPrefixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

const commonSuffixLength = (a: string, b: string): number => {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
};

/* The first `count` characters, ending before a `[REDACTED]` the cut would have split. */
function headOf(text: string, count: number): string {
  if (count >= text.length) return text;
  const marker = text.lastIndexOf(REDACTED, Math.max(0, count - 1));
  return marker >= 0 && marker < count && marker + REDACTED.length > count ? text.slice(0, marker) : text.slice(0, count);
}

/* The last `count` characters, starting after a `[REDACTED]` the cut would have split. */
function tailOf(text: string, count: number): string {
  if (count >= text.length) return text;
  const start = text.length - count;
  const marker = text.indexOf(REDACTED, Math.max(0, start - REDACTED.length + 1));
  return marker >= 0 && marker < start && marker + REDACTED.length > start ? text.slice(marker + REDACTED.length) : text.slice(start);
}

/* The text redacted by `redact`, then cut to `maxChars`.
   The redactor is given the kept end plus REDACTION_LOOKAHEAD_CHARS, so a bounded cost buys the end of whatever straddles the cut. What the redactor saw is not all trustworthy: a secret that straddles the far edge of that view was never matched whole, and redaction that shrinks the view (a base64 blob, a key) moves the kept end toward that edge. So the kept text is only the stable part of the redacted view: the part that the redaction of the view WITHOUT its last lookahead (for a tail: without its first) reproduces exactly, which holds nothing derived from the unmatched edge. A view too short after redaction to hold `maxChars` of it is doubled up to MAX_WIDENINGS times, then kept as it stands. A redactor that throws yields REDACTION_FAILED. */
export function redactThenBound(raw: string, maxChars: number, redact: (text: string) => string, options: BoundOptions = {}): string {
  const tail = options.keep === "tail";
  const rawIsWindow = options.rawIsWindow === true;
  const view = (chars: number): string => (tail ? raw.slice(raw.length - chars) : raw.slice(0, chars));
  try {
    let chars = Math.min(raw.length, maxChars + REDACTION_LOOKAHEAD_CHARS);
    for (let widenings = 0; ; widenings++) {
      const seen = view(chars);
      const redacted = redact(seen);
      if (!rawIsWindow && chars >= raw.length) {
        if (redacted.length <= maxChars) return redacted;
        const kept = tail ? tailOf(redacted, maxChars) : headOf(redacted, maxChars);
        return !tail && options.marker !== undefined ? kept + options.marker(raw.length, kept.length) : kept;
      }
      const inner = tail ? seen.slice(REDACTION_LOOKAHEAD_CHARS) : seen.slice(0, Math.max(0, seen.length - REDACTION_LOOKAHEAD_CHARS));
      const stable = tail ? commonSuffixLength(redacted, redact(inner)) : commonPrefixLength(redacted, redact(inner));
      const canWiden = !rawIsWindow && widenings < MAX_WIDENINGS;
      if (stable < maxChars && canWiden) {
        chars = Math.min(raw.length, chars * 2);
        continue;
      }
      const room = Math.min(maxChars, stable);
      const kept = tail ? tailOf(redacted, room) : headOf(redacted, room);
      return !tail && options.marker !== undefined ? kept + options.marker(raw.length, kept.length) : kept;
    }
  } catch {
    return REDACTION_FAILED;
  }
}

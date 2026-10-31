/* Event-pattern SHAPE catalog. Config supplies concrete base-type and method names; the shape lives here once. Every identifier in the regexes comes from EventPatternRef, never a hardcoded watched-app string. */
import type { EventPatternRef } from "../domain/index.ts";

/** Escape regex metacharacters so a config-supplied type/method name is matched literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A single occurrence found in one file's text, discriminated by `role`. Kept as ONE union (rather than 4 separate extractor functions) so `event-resolver.adapter.ts` can run one extraction pass per file and then dispatch by role — the catalog owns 100% of the parsing/regex logic, the resolver owns 100% of the cross-repo JOIN logic. */
export type EventPatternOccurrence =
  | { role: "listener"; className: string; eventName: string }
  | { role: "broker-interface"; className: string; modelName: string }
  | { role: "broker-impl"; className: string; brokerInterfaceName: string }
  | { role: "publisher"; className: string; eventName: string };

/** Extracts event-pattern occurrences from one file's text, guided by the config-supplied ref. */
export type EventPatternExtractor = (fileText: string, ref: EventPatternRef) => EventPatternOccurrence[];

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Find the nearest `class <Name>` declaration whose body encloses `matchIndex`, by walking backward from `matchIndex`, tracking brace depth, until the opening `{` of the immediately enclosing block is found, then taking the LAST class declaration before that point. */
function findEnclosingClass(text: string, matchIndex: number): string | null {
  let depth = 0;
  let openBraceIndex = -1;
  for (let i = matchIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        openBraceIndex = i;
        break;
      }
      depth--;
    }
  }
  if (openBraceIndex === -1) return null;
  const before = text.slice(0, openBraceIndex);
  let lastName: string | null = null;
  CLASS_DECL_RE.lastIndex = 0;
  for (let m; (m = CLASS_DECL_RE.exec(before)) !== null;) {
    const name = m[1];
    if (name) lastName = name;
  }
  return lastName;
}


/** Find the character range [start, end) of the body of the class starting at `classNameEnd` (the index right after the class name, before "extends"/"implements"/"{"). Returns null if no balanced opening/closing brace pair is found. */
function findClassBodyRange(text: string, searchFrom: number): { start: number; end: number } | null {
  const openIdx = text.indexOf("{", searchFrom);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: openIdx + 1, end: i };
    }
  }
  return null;
}

function extractListeners(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const base = escapeRegExp(ref.listenerBaseType);
  const eventCall = escapeRegExp(ref.listenerEventCall);
  const classRe = new RegExp(
    `\\bclass\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s+(?:extends|implements)\\s+(?:[A-Za-z_$][\\w$]*\\.)*${base}\\b`,
    "g",
  );
  const eventCallRe = new RegExp(`\\b${eventCall}\\s*\\([^,]+,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*class\\s*\\)`);

  const results: EventPatternOccurrence[] = [];
  for (let m; (m = classRe.exec(text)) !== null;) {
    const className = m[1];
    if (!className) continue;
    const body = findClassBodyRange(text, classRe.lastIndex);
    if (!body) continue;
    const bodyText = text.slice(body.start, body.end);
    const eventMatch = eventCallRe.exec(bodyText);
    const eventName = eventMatch?.[1];
    if (!eventName) continue;
    results.push({ role: "listener", className, eventName });
  }
  return results;
}


function extractBrokerInterfaces(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const subscriberBase = escapeRegExp(ref.subscriberBaseType);
  const re = new RegExp(
    `\\binterface\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s+extends\\s+(?:[A-Za-z_$][\\w$]*\\.)*${subscriberBase}\\s*<\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*>`,
    "g",
  );
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = re.exec(text)) !== null;) {
    const className = m[1];
    const modelName = m[2];
    if (!className || !modelName) continue;
    results.push({ role: "broker-interface", className, modelName });
  }
  return results;
}

function extractBrokerImpls(text: string): EventPatternOccurrence[] {
  const re = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+implements\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = re.exec(text)) !== null;) {
    const className = m[1];
    const brokerInterfaceName = m[2];
    if (!className || !brokerInterfaceName) continue;
    results.push({ role: "broker-impl", className, brokerInterfaceName });
  }
  return results;
}

const EVENT_CLASS_ARG_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*class\b/g;

/** Find the character range of the argument-list substring (between the parens) for the call whose opening paren is at `openParenIndex`. Returns null on unbalanced parens. STRING/CHAR-LITERAL AWARENESS: a naive raw-character paren count is fooled by a `)` (or `(`) appearing INSIDE a string or char literal argument (e.g. a subject built from a literal containing a closing paren) — that literal `)` decrements depth early and truncates the argument-list substring before the real trailing `Name.class` argument, silently dropping the event. Fix: while walking, track whether the scan is currently inside a double-quoted string (`"..."`) or single-quoted char (`'...'`) literal; while inside one, parens are skipped entirely (they don't affect depth), and a backslash-escaped quote (`\"` / `\'`) or any other backslash escape (`\\`) does not end the literal — only an UNESCAPED matching quote does. */
function findMatchingCloseParen(text: string, openParenIndex: number): number | null {
  let depth = 1;
  let stringQuote: '"' | "'" | null = null; // the quote char of the literal we're inside, or null
  for (let i = openParenIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (stringQuote !== null) {
      if (ch === "\\") {
        i++;
      } else if (ch === stringQuote) {
        stringQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function extractVariantBPublishers(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const publishCall = escapeRegExp(ref.publishCall);
  const callRe = new RegExp(`\\b${publishCall}\\s*\\(`, "g");
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = callRe.exec(text)) !== null;) {
    const openParenIndex = m.index + m[0].length - 1;
    const closeParenIndex = findMatchingCloseParen(text, openParenIndex);
    if (closeParenIndex === null) continue;
    const argsText = text.slice(openParenIndex + 1, closeParenIndex);

    let eventName: string | undefined;
    EVENT_CLASS_ARG_RE.lastIndex = 0;
    for (let cm; (cm = EVENT_CLASS_ARG_RE.exec(argsText)) !== null;) {
      eventName = cm[1];
    }
    if (!eventName) continue;

    const className = findEnclosingClass(text, m.index);
    if (!className) continue;
    results.push({ role: "publisher", className, eventName });
  }
  return results;
}

/** class-based-domain-events: the ONLY entry today. Strips comments first (so a commented-out or Javadoc-mentioned "class"/base-type/method never becomes a false occurrence), then runs all four occurrence extractors and concatenates their results. Fail-open by construction: every extractor is a pure regex scan that returns [] on no match, never throws. */
const classBasedDomainEvents: EventPatternExtractor = (fileText, ref) => {
  const stripped = stripComments(fileText);
  return [
    ...extractListeners(stripped, ref),
    ...extractBrokerInterfaces(stripped, ref),
    ...extractBrokerImpls(stripped),
    ...extractVariantBPublishers(stripped, ref),
  ];
};

/** In-core registry of event-pattern shapes, keyed by `EventPatternRef.kind`. */
export const EventPatternCatalog: Record<string, EventPatternExtractor> = {
  "class-based-domain-events": classBasedDomainEvents,
};

/** The event-pattern shape kinds the core can extract (the keys of EventPatternCatalog). A profile whose `eventPattern.kind` is not here cannot be resolved, so config validation rejects it up front (loud, at load time) instead of letting it degrade to zero extracted occurrences downstream — mirrors KNOWN_CALL_SITE_KINDS from call-site-catalog.ts. */
export const KNOWN_EVENT_PATTERN_KINDS: ReadonlySet<string> = new Set(Object.keys(EventPatternCatalog));

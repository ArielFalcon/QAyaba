/*
 * Facts about the watched repo's test harness that the run can state without the agent having to
 * read a file: the configured test-id attribute and what the suite's shared fixtures file exports.
 * They are facts only — never an instruction — and they describe attacker-influenceable repo
 * content, so every name is validated as a plain identifier, bounded in length and count.
 */

export interface HarnessFacts {
  /* Only when the app declares one: no default is invented. */
  testIdAttribute?: string;
  fixtures?: {
    /* Path of the fixtures file relative to the suite directory. */
    file: string;
    exports: readonly string[];
  };
}

export const MAX_FIXTURE_EXPORTS = 40;
export const MAX_EXPORT_NAME_LENGTH = 64;
export const MAX_ATTRIBUTE_NAME_LENGTH = 64;

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ATTRIBUTE_RE = /^[A-Za-z_][A-Za-z0-9_:.-]*$/;

export function isSafeIdentifier(name: string): boolean {
  return name.length <= MAX_EXPORT_NAME_LENGTH && IDENTIFIER_RE.test(name);
}

export function isSafeAttributeName(name: string): boolean {
  return name.length <= MAX_ATTRIBUTE_NAME_LENGTH && ATTRIBUTE_RE.test(name);
}

/* A comment, or a string or template literal; one that is never closed runs to the end of the source. */
const NON_CODE_RE = /\/\/.*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\]|\\[\s\S])*"?|'(?:[^'\\]|\\[\s\S])*'?|`(?:[^`\\]|\\[\s\S])*`?/g;

const DECLARATION_RE = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*\s*|function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)([A-Za-z_$][\w$]*)/g;
/* An export list holds no brace of its own, so a list ends at the first brace after it opens: an opening brace that is never closed cannot make the scan re-read the rest of the source from every later position. */
const LIST_RE = /\bexport\s*\{([^{}]*)\}/g;
const NAMESPACE_RE = /\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g;
/* One entry of an export list, trimmed: `name` or `name as alias`, exposing the last identifier. A type-only entry (`type T`) does not fit. */
const SPECIFIER_RE = /^(?:[A-Za-z_$][\w$]*\s+as\s+)?([A-Za-z_$][\w$]*)$/;

function listedNames(specifiers: string): string[] {
  return specifiers
    .split(",")
    .map((specifier) => SPECIFIER_RE.exec(specifier.trim())?.[1])
    .filter((name): name is string => name !== undefined && name !== "default");
}

interface Found {
  at: number;
  names: string[];
}

function foundBy(code: string, re: RegExp, namesOf: (match: RegExpMatchArray) => string[]): Found[] {
  return Array.from(code.matchAll(re), (match) => ({ at: match.index!, names: namesOf(match) }));
}

const firstGroup = (match: RegExpMatchArray): string[] => [match[1]!];

/* The runtime names a module exports, in source order and once each: declarations, export lists (the alias when there is one) and namespace re-exports. Type-only and default exports are not names an importer can use. */
export function extractExportedNames(source: string): string[] {
  const code = source.replace(NON_CODE_RE, " ");
  const found = [
    ...foundBy(code, DECLARATION_RE, firstGroup),
    ...foundBy(code, NAMESPACE_RE, firstGroup),
    ...foundBy(code, LIST_RE, (match) => listedNames(match[1]!)),
  ];
  const ordered = found.sort((x, y) => x.at - y.at).flatMap((f) => f.names);
  return [...new Set(ordered)].filter(isSafeIdentifier).slice(0, MAX_FIXTURE_EXPORTS);
}

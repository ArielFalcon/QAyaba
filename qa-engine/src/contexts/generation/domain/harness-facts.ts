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

/* The source with every comment, string literal and template literal blanked out (newlines kept), so what is left is code only. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < source.length && source[i] !== ch) i += source[i] === "\\" ? 2 : 1;
      i++;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const DECLARATION_RE = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*\s*|function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)([A-Za-z_$][\w$]*)/g;
const LIST_RE = /\bexport\s*\{([^}]*)\}/g;
const NAMESPACE_RE = /\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g;

function listedNames(specifiers: string): string[] {
  const names: string[] = [];
  for (const raw of specifiers.split(",")) {
    const specifier = raw.trim();
    if (specifier === "" || /^type\s/.test(specifier)) continue;
    const exposed = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(specifier)?.[1] ?? /^([A-Za-z_$][\w$]*)$/.exec(specifier)?.[1];
    if (exposed !== undefined && exposed !== "default") names.push(exposed);
  }
  return names;
}

/* The runtime names a module exports, in source order and once each: declarations, export lists (the alias when there is one) and namespace re-exports. Type-only and default exports are not names an importer can use. */
export function extractExportedNames(source: string): string[] {
  const code = codeOnly(source);
  const found: Array<{ at: number; name: string }> = [];
  for (const match of code.matchAll(DECLARATION_RE)) found.push({ at: match.index ?? 0, name: match[1]! });
  for (const match of code.matchAll(NAMESPACE_RE)) found.push({ at: match.index ?? 0, name: match[1]! });
  for (const match of code.matchAll(LIST_RE)) {
    for (const name of listedNames(match[1]!)) found.push({ at: match.index ?? 0, name });
  }
  const ordered = found.sort((a, b) => a.at - b.at).map((f) => f.name);
  return [...new Set(ordered)].filter(isSafeIdentifier).slice(0, MAX_FIXTURE_EXPORTS);
}

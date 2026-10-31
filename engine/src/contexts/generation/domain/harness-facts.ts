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
    /* The exported functions as declared, one line each. */
    signatures?: readonly string[];
    /* The fixtures a test receives, as the file's own type declares them, one line each. */
    members?: readonly string[];
  };
  /* What the suite's Playwright config declares. */
  playwright?: PlaywrightConfigFacts;
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

/* ---- What a suite's fixtures and Playwright config declare, as bounded one-line facts ---- */

export const MAX_DECLARATION_LINES = 16;
export const MAX_DECLARATION_LENGTH = 140;
export const MAX_PROJECTS = 8;
export const MAX_PROJECT_NAME_LENGTH = 48;

export interface PlaywrightProjectFact {
  name: string;
  /* The device descriptor the project spreads (`devices["Desktop Chrome"]`), when it does. */
  device?: string;
  /* The viewport it declares, `width x height`, when it does. */
  viewport?: string;
  dependencies?: readonly string[];
  testMatch?: string;
}

export interface PlaywrightConfigFacts {
  testDir?: string;
  testMatch?: string;
  /* Whether the shared `use` block declares a storage state. */
  storageState: boolean;
  projects: readonly PlaywrightProjectFact[];
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DECLARATION_LENGTH ? `${flat.slice(0, MAX_DECLARATION_LENGTH - 1)}…` : flat;
};

/* The source up to the body of a declaration: a function's signature ends where its block opens. */
function declarationHead(line: string): string {
  const fn = /^(export\s+(?:async\s+)?function\s*\*?\s*[\w$]+[^{]*)/.exec(line);
  return oneLine(fn ? fn[1]! : line.replace(/\s*=\s*.*$/, ""));
}

/* One line per runtime export that is a function, as declared (`export function ns(namespace: string, name: string): string`). Constants and re-exports state their name only (the export list has it). */
export function exportedSignatures(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    if (!/^export\s+(?:async\s+)?function\b/.test(line)) continue;
    out.push(declarationHead(line));
    if (out.length >= MAX_DECLARATION_LINES) break;
  }
  return out;
}

/* The fixtures a test receives, as the suite declares them: the members of the type its `base.extend<Type>(…)` is given, each with the trailing comment on its line. Members that start with an underscore are the harness's own and are left out. Nothing when the type is not an interface declared in the same file. */
export function fixtureMembers(source: string): string[] {
  const typeName = /\.extend\s*<\s*([A-Za-z_$][\w$]*)/.exec(source)?.[1];
  if (typeName === undefined) return [];
  const open = new RegExp(`\\binterface\\s+${typeName}\\b[^{]*\\{`).exec(source);
  if (!open) return [];
  const out: string[] = [];
  let depth = 1;
  for (const line of source.slice(open.index + open[0].length).split("\n")) {
    const member = depth === 1 ? /^\s*([A-Za-z][\w$]*)\??\s*:/.exec(line) : null;
    if (member) {
      out.push(oneLine(line));
      if (out.length >= MAX_DECLARATION_LINES) break;
    }
    for (const ch of line.replace(/\/\/.*$/, "")) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth <= 0) break;
  }
  return out;
}

const LITERAL = `(?:"([^"\\n]*)"|'([^'\\n]*)'|\`([^\`\\n]*)\`)`;
const literalOf = (match: RegExpExecArray | null): string | undefined => match?.[1] ?? match?.[2] ?? match?.[3];
const keyed = (key: string, text: string): string | undefined => literalOf(new RegExp(`\\b${key}\\s*:\\s*${LITERAL}`).exec(text));
const safeText = (value: string | undefined, max: number): string | undefined => (value !== undefined && value.length > 0 && value.length <= max && /^[\w .*/{}()@,!+-]+$/.test(value) ? value : undefined);

function projectOf(chunk: string): PlaywrightProjectFact | undefined {
  const name = safeText(keyed("name", chunk), MAX_PROJECT_NAME_LENGTH);
  if (name === undefined) return undefined;
  const device = safeText(literalOf(new RegExp(`devices\\s*\\[\\s*${LITERAL}\\s*\\]`).exec(chunk)), MAX_PROJECT_NAME_LENGTH);
  const size = /\bviewport\s*:\s*\{\s*width\s*:\s*(\d{2,5})\s*,\s*height\s*:\s*(\d{2,5})/.exec(chunk);
  const deps = /\bdependencies\s*:\s*\[([^\]]*)\]/.exec(chunk)?.[1];
  const dependencies = deps === undefined ? [] : Array.from(deps.matchAll(new RegExp(LITERAL, "g")), (m) => safeText(literalOf(m), MAX_PROJECT_NAME_LENGTH)).filter((d): d is string => d !== undefined);
  const testMatch = safeText(keyed("testMatch", chunk), MAX_DECLARATION_LENGTH);
  return {
    name,
    ...(device ? { device } : {}),
    ...(size ? { viewport: `${size[1]}x${size[2]}` } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(testMatch ? { testMatch } : {}),
  };
}

/* What the suite's Playwright config declares about where specs live, how a session is carried and which projects exist. Read from the text, so a value computed at run time (an environment variable, a spread) states nothing; a project is found by its literal `name`. Undefined when nothing could be read. */
export function playwrightConfigFacts(source: string): PlaywrightConfigFacts | undefined {
  /* Comments are blanked, a string is kept whole: a glob such as "**\/*.spec.ts" holds a comment's opening. */
  const code = source.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/.*|\/\*[\s\S]*?\*\//g, (_all, str: string | undefined) => str ?? " ");
  const at = code.search(/\bprojects\s*:\s*\[/);
  const head = at < 0 ? code : code.slice(0, at);
  const tail = at < 0 ? "" : code.slice(at);
  const testDir = safeText(keyed("testDir", head), MAX_DECLARATION_LENGTH);
  const testMatch = safeText(keyed("testMatch", head), MAX_DECLARATION_LENGTH);
  const storageState = /\bstorageState\s*:/.test(head);
  const chunks = tail.split(/(?=\bname\s*:)/).slice(1);
  const projects = chunks.map(projectOf).filter((p): p is PlaywrightProjectFact => p !== undefined).slice(0, MAX_PROJECTS);
  if (testDir === undefined && testMatch === undefined && !storageState && projects.length === 0) return undefined;
  return { ...(testDir ? { testDir } : {}), ...(testMatch ? { testMatch } : {}), storageState, projects };
}

/* The facts as prompt lines, each value passed through `scrub` (the caller's sanitizer or redaction). Facts only, never an instruction. Nothing when there is nothing to state. */
export function harnessFactLines(facts: HarnessFacts, e2eRelDir: string, scrub: (text: string) => string): string[] {
  const s = scrub;
  const lines: string[] = [];
  if (facts.testIdAttribute) lines.push(`testIdAttribute: ${s(facts.testIdAttribute)}`);
  const fixtures = facts.fixtures;
  if (fixtures?.exports.length) {
    lines.push(`fixtures: ${s(`${e2eRelDir}/${fixtures.file}`)} exports ${fixtures.exports.map(s).join(", ")}`);
    if (fixtures.exports.includes("test")) lines.push(`specs import ${fixtures.exports.includes("expect") ? "test and expect" : "test"} from that module, not from @playwright/test`);
    for (const signature of fixtures.signatures ?? []) lines.push(`function: ${s(signature)}`);
    for (const member of fixtures.members ?? []) lines.push(`fixture a test receives: ${s(member)}`);
  }
  const config = facts.playwright;
  if (config) {
    const declared = [config.testDir ? `testDir ${config.testDir}` : "", config.testMatch ? `testMatch ${config.testMatch}` : "", config.storageState ? "storageState declared" : ""].filter(Boolean);
    if (declared.length > 0) lines.push(`playwright config: ${s(declared.join(", "))}`);
    for (const project of config.projects) {
      const detail = [
        project.device ? `device ${project.device}` : "",
        project.viewport ? `viewport ${project.viewport}` : "",
        project.testMatch ? `testMatch ${project.testMatch}` : "",
        project.dependencies?.length ? `depends on ${project.dependencies.join(", ")}` : "",
      ].filter(Boolean);
      lines.push(`playwright project: ${s(project.name)}${detail.length > 0 ? ` (${s(detail.join("; "))})` : ""}`);
    }
  }
  return lines;
}

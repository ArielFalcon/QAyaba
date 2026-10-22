/*
 * Fake-pass detector for the campaign (scripts/campaign.ts). EXPERIMENT ONLY, pure: source text in, flags out.
 *
 * A spec that goes green proves nothing when it cannot go red. `expect(true).toBe(true)`, a test that only navigates,
 * an empty body and a probe the agent left behind (`_explore.spec.ts`) all pass; counting them as "pass" scores an arm
 * for noise. The detector is the same for both arms and reads the spec's text only, so it is a heuristic with one
 * direction of error that matters: it may flag a spec that asserts through a helper it cannot see, it must not let the
 * patterns above through. A flagged spec never counts as valid; the owner can still read the flags and the file.
 */

export const FAKE_FLAG = {
  /** The file name says it is a probe or a scratch file. */
  PROBE_NAME: "probe-name",
  /** The file defines no test. */
  NO_TESTS: "no-tests",
  /** A test whose body holds nothing (or only comments). */
  EMPTY_BODY: "empty-test-body",
  /** An `expect` on a literal: it passes (or fails) whatever the application does. */
  TAUTOLOGY: "tautological-expect",
  /** No `expect` on the page, a locator, a request or a value read from them anywhere in the file. */
  NO_PAGE_EXPECT: "no-page-expect",
  /** An `expect` whose matcher cannot fail on what it is given: `expect(locator).toBeTruthy()`, a count that is at least zero, any URL or title, the body being visible. */
  VACUOUS: "vacuous-expect",
  /** A test (or a group) that is skipped or marked fixme: it is green because it never ran. */
  SKIPPED: "skipped-test",
} as const;

export type FakeFlagKind = (typeof FAKE_FLAG)[keyof typeof FAKE_FLAG];

export interface FakeFlag {
  kind: FakeFlagKind;
  /** What was found, for a person to read. */
  detail: string;
}

/* Words that make a file a probe, taken as whole tokens of any path segment (so `template`, `attempt` and `user-register` are not probes). */
const PROBE_WORDS: ReadonlySet<string> = new Set(["tmp", "temp", "scratch", "probe", "playground", "sandbox"]);
/* The fixtures every page-driven test starts from. */
const BASE_FIXTURES = ["page", "request", "context", "browser"] as const;
const BARE_FIXTURE = new RegExp(`^(?:${BASE_FIXTURES.join("|")})$`);
const VACUOUS_MATCHER = /^\s*\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined|not\.toBeFalsy)\s*\(/;
/* `.toBeGreaterThanOrEqual(0)` and `.toBeGreaterThan(-1)`: true of anything that is a count. */
const AT_LEAST_ZERO_MATCHER = /^\s*\.(?:toBeGreaterThanOrEqual\s*\(\s*0\s*\)|toBeGreaterThan\s*\(\s*-1\s*\))/;
/* `toHaveURL` / `toHaveTitle` given a regular expression that every string matches. */
const MATCH_ALL_MATCHER = /^\s*\.(?:toHaveURL|toHaveTitle)\s*\(\s*\/\^?\(?(?:\?:)?\.[*+]\)?\$?\/[a-z]*\s*[,)]/;
const EQUALITY_MATCHER = /^\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/;
const VISIBLE_MATCHER = /^\s*\.(?:toBeVisible|toBeAttached)\s*\(/;
const ROOT_ELEMENT_LOCATOR = /\.locator\(\s*(['"`])(?:body|html)\1\s*\)\s*$/;
/* What reads a value out of a locator, a page or a response: an expression that ends in one of them is a value, not a handle. */
const VALUE_READ = /\.(?:count|textContent|innerText|innerHTML|inputValue|isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable|getAttribute|evaluate|evaluateAll|boundingBox|allTextContents|allInnerTexts|title|url|status|statusText|ok|json|text|headers)\s*\(/;
const LOCATOR_CONSTRUCTOR = /\b(?:locator|frameLocator|getBy[A-Za-z]*)\s*\(/;
const COUNT_EXPRESSION = /\.count\s*\(|\.length\b/;
const SKIP_CALL = /(?<![.\w$])test(?:\.describe)?\.(?:skip|fixme)\s*\(/g;
const LITERAL_ARGUMENT = /^(?:true|false|null|undefined|NaN|-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`$\\]|\\.)*`)$/i;
const ARITHMETIC_LITERALS = /^[\d\s+\-*/%().]+$/;
const PAGE_WORDS = /\b(?:page|request|context|browser|locator|frameLocator|getBy[A-Za-z]*)\b/;
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);
const MAX_DECLARATION_CHARS = 400;

/**
 * The source with comments blanked and the inside of strings, templates and regular expressions replaced by `_`, same
 * length, so that an index in the result is an index in the source and the structure can be scanned without being fooled by text.
 */
function maskNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number, fill: string): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = fill;
  };
  let i = 0;
  let lastCode = "";
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop, " ");
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop, " ");
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, source.length), "_");
      i = j + 1;
      lastCode = c;
    } else if (c === "/" && (lastCode === "" || REGEX_PRECEDERS.has(lastCode))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      blank(i + 1, Math.min(j, source.length), "_");
      i = j + 1;
      lastCode = "/";
    } else {
      if (!/\s/.test(c)) lastCode = c;
      i += 1;
    }
  }
  return out.join("");
}

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/** The index of the bracket that closes the one at `open`, or -1 when it never closes. `masked` has no string or comment to trip over. */
function matchClose(masked: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    const closer = OPENERS[c];
    if (closer !== undefined) stack.push(closer);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

interface TestCall {
  /** Where the callback's body starts and ends in the masked source. */
  from: number;
  to: number;
  /** The body, masked. */
  body: string;
}

/** Where the body of the callback of the call whose parentheses are `masked[open..close]` starts and ends; null when there is none. */
function callbackRange(masked: string, open: number, close: number): { from: number; to: number } | null {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]!;
    if (OPENERS[c] !== undefined) depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === "=" && masked[i + 1] === ">") {
      let k = i + 2;
      while (k < close && /\s/.test(masked[k]!)) k += 1;
      if (masked[k] !== "{") return { from: k, to: close };
      const end = matchClose(masked, k);
      return end === -1 ? null : { from: k + 1, to: end };
    } else if (depth === 0 && masked.startsWith("function", i) && !/[\w$]/.test(masked[i - 1] ?? " ") && !/[\w$]/.test(masked[i + 8] ?? " ")) {
      const paren = masked.indexOf("(", i);
      const parenEnd = paren === -1 ? -1 : matchClose(masked, paren);
      const brace = parenEnd === -1 ? -1 : masked.indexOf("{", parenEnd);
      const end = brace === -1 ? -1 : matchClose(masked, brace);
      return end === -1 || end > close ? null : { from: brace + 1, to: end };
    }
  }
  return null;
}

function findTests(masked: string): TestCall[] {
  const calls: TestCall[] = [];
  const pattern = /(?<![.\w$])test(?:\.only)?\s*\(/g;
  for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const range = callbackRange(masked, open, close);
    if (range !== null) calls.push({ ...range, body: masked.slice(range.from, range.to) });
  }
  return calls;
}

/** What the file says about tests that do not run: a declaration that skips (or marks fixme) a test or a group, and an unconditional skip inside a body. A skip that depends on a condition is not one. */
function skipDetails(masked: string): string[] {
  const details: string[] = [];
  const pattern = new RegExp(SKIP_CALL.source, "g");
  for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const first = masked.slice(open + 1, close).trim();
    const firstArgument = first.split(",")[0]!.trim();
    if (first === "" || firstArgument === "true" || /^['"`]/.test(firstArgument)) details.push(m[0].replace(/\s*\($/, ""));
  }
  return details;
}

interface Declaration {
  name: string;
  expression: string;
}

function declarations(masked: string): Declaration[] {
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  const found: Declaration[] = [];
  for (let m = declaration.exec(masked); m !== null; m = declaration.exec(masked)) {
    const from = m.index + m[0].length;
    const semicolon = masked.indexOf(";", from);
    const end = semicolon === -1 ? from + MAX_DECLARATION_CHARS : Math.min(semicolon, from + MAX_DECLARATION_CHARS);
    found.push({ name: m[1]!, expression: masked.slice(from, end) });
  }
  return found;
}

const mentions = (names: ReadonlySet<string>, expression: string): boolean =>
  [...names].some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(expression));

/** Names declared from an expression that mentions the page, a locator or a request (directly or through another such name). */
function pageDerivedNames(found: readonly Declaration[]): Set<string> {
  const names = new Set<string>(BASE_FIXTURES);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, expression } of found) {
      if (names.has(name)) continue;
      if (PAGE_WORDS.test(expression) || mentions(names, expression)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

/** Whether an expression is a handle on something (a locator, the page, a request context), not a value read from it: no `await`, and it does not end in a call that reads a value. */
function isHandleExpression(expression: string, handles: ReadonlySet<string>): boolean {
  const text = expression.trim();
  if (/\bawait\b/.test(text) || VALUE_READ.test(text)) return false;
  return handles.has(text) || LOCATOR_CONSTRUCTOR.test(text) || mentions(BASE_NAMES, text);
}

const BASE_NAMES: ReadonlySet<string> = new Set(BASE_FIXTURES);

/** Names declared as a handle: a locator, or something built from one or from a fixture, never awaited and never read. */
function handleNames(found: readonly Declaration[]): Set<string> {
  const names = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, expression } of found) {
      if (names.has(name) || !isHandleExpression(expression, names)) continue;
      names.add(name);
      changed = true;
    }
  }
  return names;
}

/** Names declared from a count (`.count()`, `.length`) or from another such name. */
function countNames(found: readonly Declaration[]): Set<string> {
  const names = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, expression } of found) {
      if (names.has(name)) continue;
      if (COUNT_EXPRESSION.test(expression) || mentions(names, expression)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

interface ExpectCall {
  /** Where the `expect(` starts in the source. */
  index: number;
  /** The expression handed to `expect(`, from the source. */
  argument: string;
  /** The same, masked. */
  maskedArgument: string;
  /** What follows the closing parenthesis, masked. */
  after: string;
  /** The same, from the source (a regular expression's pattern is only here). */
  afterSource: string;
}

function findExpects(source: string, masked: string): ExpectCall[] {
  const calls: ExpectCall[] = [];
  const pattern = /(?<![.\w$])expect(?:\.(?:soft|poll))?\s*\(/g;
  for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    calls.push({
      index: m.index,
      argument: source.slice(open + 1, close).trim(),
      maskedArgument: masked.slice(open + 1, close),
      after: masked.slice(close + 1, close + 60),
      afterSource: source.slice(close + 1, close + 80),
    });
  }
  return calls;
}

const isLiteralArgument = (argument: string): boolean => LITERAL_ARGUMENT.test(argument) || (/\d/.test(argument) && ARITHMETIC_LITERALS.test(argument));

function probeNameFlag(path: string): FakeFlag | undefined {
  const segments = path.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? path;
  if (base.startsWith("_") || base.startsWith(".")) return { kind: FAKE_FLAG.PROBE_NAME, detail: `${base} starts like a scratch file` };
  for (const segment of segments) {
    const word = segment.replace(/\.spec\.ts$/, "").split(/[._-]+/).find((token) => PROBE_WORDS.has(token.toLowerCase()));
    if (word !== undefined) return { kind: FAKE_FLAG.PROBE_NAME, detail: `${path} is named like a probe ('${word}')` };
  }
  return undefined;
}

/** Which kind of evidence one `expect` is. */
const EXPECT_KIND = { TAUTOLOGY: "tautology", VACUOUS: "vacuous", ROOT_ONLY: "root-visible", OBSERVING: "observing", OTHER: "other" } as const;
type ExpectKind = (typeof EXPECT_KIND)[keyof typeof EXPECT_KIND];

interface ClassifiedExpect {
  kind: ExpectKind;
  flag?: FakeFlag;
}

interface Names {
  derived: ReadonlySet<string>;
  handles: ReadonlySet<string>;
  counts: ReadonlySet<string>;
}

function classifyExpect(call: ExpectCall, names: Names, derivedWord: RegExp): ClassifiedExpect {
  const shown = call.argument.slice(0, 60);
  if (isLiteralArgument(call.argument)) {
    return { kind: EXPECT_KIND.TAUTOLOGY, flag: { kind: FAKE_FLAG.TAUTOLOGY, detail: `expect(${shown}) asserts on a literal` } };
  }
  const same = EQUALITY_MATCHER.exec(call.afterSource);
  if (same !== null && same[1] === call.argument) {
    return { kind: EXPECT_KIND.TAUTOLOGY, flag: { kind: FAKE_FLAG.TAUTOLOGY, detail: `expect(${shown}) is compared with itself` } };
  }
  if (VACUOUS_MATCHER.test(call.after) && isHandleExpression(call.maskedArgument, names.handles)) {
    return { kind: EXPECT_KIND.VACUOUS, flag: { kind: FAKE_FLAG.VACUOUS, detail: `expect(${shown}) holds a handle, which is true of any page` } };
  }
  if (AT_LEAST_ZERO_MATCHER.test(call.after) && (COUNT_EXPRESSION.test(call.maskedArgument) || names.counts.has(call.argument))) {
    return { kind: EXPECT_KIND.VACUOUS, flag: { kind: FAKE_FLAG.VACUOUS, detail: `expect(${shown}) is a count that is never below zero` } };
  }
  if (MATCH_ALL_MATCHER.test(call.afterSource)) {
    return { kind: EXPECT_KIND.VACUOUS, flag: { kind: FAKE_FLAG.VACUOUS, detail: `expect(${shown}) is given a pattern that every URL or title matches` } };
  }
  if (VISIBLE_MATCHER.test(call.after) && ROOT_ELEMENT_LOCATOR.test(call.argument)) return { kind: EXPECT_KIND.ROOT_ONLY };
  if (PAGE_WORDS.test(call.maskedArgument) || derivedWord.test(call.maskedArgument)) return { kind: EXPECT_KIND.OBSERVING };
  return { kind: EXPECT_KIND.OTHER };
}

/** What is wrong with a spec as a proof that something works, or an empty list when nothing in its text says it cannot fail. Each test body is judged on its own; an assertion outside every body (a hook or a helper) counts for all of them. */
export function detectFakeSpec(path: string, source: string): FakeFlag[] {
  const flags: FakeFlag[] = [];
  const named = probeNameFlag(path);
  if (named) flags.push(named);

  const masked = maskNonCode(source);
  for (const skipped of skipDetails(masked)) flags.push({ kind: FAKE_FLAG.SKIPPED, detail: `${skipped}() keeps a test from running` });
  const tests = findTests(masked);
  if (tests.length === 0) {
    flags.push({ kind: FAKE_FLAG.NO_TESTS, detail: "the file defines no test" });
    return flags;
  }
  for (const test of tests) if (test.body.trim() === "") flags.push({ kind: FAKE_FLAG.EMPTY_BODY, detail: "a test has an empty body" });

  const found = declarations(masked);
  const derived = pageDerivedNames(found);
  const names: Names = { derived, handles: handleNames(found), counts: countNames(found) };
  const derivedWord = new RegExp(`\\b(?:${[...derived].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\b`);
  const classified = findExpects(source, masked).map((call) => ({ call, ...classifyExpect(call, names, derivedWord) }));

  const insideSomeTest = (index: number): boolean => tests.some((t) => index >= t.from && index < t.to);
  const outside = classified.filter(({ call }) => !insideSomeTest(call.index));
  for (const { flag } of outside) if (flag) flags.push(flag);
  const sharedObserving = outside.some(({ kind }) => kind === EXPECT_KIND.OBSERVING);

  for (const test of tests) {
    if (test.body.trim() === "") continue;
    const own = classified.filter(({ call }) => call.index >= test.from && call.index < test.to);
    for (const { flag } of own) if (flag) flags.push(flag);
    if (sharedObserving || own.some(({ kind }) => kind === EXPECT_KIND.OBSERVING)) continue;
    if (own.some(({ kind }) => kind === EXPECT_KIND.ROOT_ONLY)) {
      flags.push({ kind: FAKE_FLAG.VACUOUS, detail: "the only assertion is that the body of the page is visible" });
    } else {
      flags.push({ kind: FAKE_FLAG.NO_PAGE_EXPECT, detail: "no expect on the page, a locator, a request or a value read from them" });
    }
  }
  return flags;
}

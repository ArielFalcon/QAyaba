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
  /** `expect(page).toBeTruthy()` and its kin: true of any page. */
  VACUOUS: "vacuous-expect",
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
  /** The callback's body, masked; null when the call has no callback. */
  body: string | null;
}

/** The body of the callback of the call whose parentheses are `masked[open..close]`, masked; null when there is none. */
function callbackBody(masked: string, open: number, close: number): string | null {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]!;
    if (OPENERS[c] !== undefined) depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === "=" && masked[i + 1] === ">") {
      let k = i + 2;
      while (k < close && /\s/.test(masked[k]!)) k += 1;
      if (masked[k] !== "{") return masked.slice(k, close);
      const end = matchClose(masked, k);
      return end === -1 ? null : masked.slice(k + 1, end);
    } else if (depth === 0 && masked.startsWith("function", i) && !/[\w$]/.test(masked[i - 1] ?? " ") && !/[\w$]/.test(masked[i + 8] ?? " ")) {
      const paren = masked.indexOf("(", i);
      const parenEnd = paren === -1 ? -1 : matchClose(masked, paren);
      const brace = parenEnd === -1 ? -1 : masked.indexOf("{", parenEnd);
      const end = brace === -1 ? -1 : matchClose(masked, brace);
      return end === -1 || end > close ? null : masked.slice(brace + 1, end);
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
    calls.push({ body: callbackBody(masked, open, close) });
  }
  return calls.filter((c) => c.body !== null);
}

/** Names declared from an expression that mentions the page, a locator or a request (directly or through another such name). */
function pageDerivedNames(masked: string): Set<string> {
  const names = new Set<string>(BASE_FIXTURES);
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  const found: Array<{ name: string; expression: string }> = [];
  for (let m = declaration.exec(masked); m !== null; m = declaration.exec(masked)) {
    const from = m.index + m[0].length;
    const semicolon = masked.indexOf(";", from);
    const end = semicolon === -1 ? from + MAX_DECLARATION_CHARS : Math.min(semicolon, from + MAX_DECLARATION_CHARS);
    found.push({ name: m[1]!, expression: masked.slice(from, end) });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, expression } of found) {
      if (names.has(name)) continue;
      if (PAGE_WORDS.test(expression) || [...names].some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(expression))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

interface ExpectCall {
  /** The expression handed to `expect(`, from the source. */
  argument: string;
  /** The same, masked. */
  maskedArgument: string;
  /** What follows the closing parenthesis, masked. */
  after: string;
}

function findExpects(source: string, masked: string): ExpectCall[] {
  const calls: ExpectCall[] = [];
  const pattern = /(?<![.\w$])expect(?:\.(?:soft|poll))?\s*\(/g;
  for (let m = pattern.exec(masked); m !== null; m = pattern.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    calls.push({ argument: source.slice(open + 1, close).trim(), maskedArgument: masked.slice(open + 1, close), after: masked.slice(close + 1, close + 60) });
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

/** What is wrong with a spec as a proof that something works, or an empty list when nothing in its text says it cannot fail. */
export function detectFakeSpec(path: string, source: string): FakeFlag[] {
  const flags: FakeFlag[] = [];
  const named = probeNameFlag(path);
  if (named) flags.push(named);

  const masked = maskNonCode(source);
  const tests = findTests(masked);
  if (tests.length === 0) {
    flags.push({ kind: FAKE_FLAG.NO_TESTS, detail: "the file defines no test" });
    return flags;
  }
  for (const test of tests) if ((test.body ?? "").trim() === "") flags.push({ kind: FAKE_FLAG.EMPTY_BODY, detail: "a test has an empty body" });

  const derived = pageDerivedNames(masked);
  const derivedWord = new RegExp(`\\b(?:${[...derived].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\b`);
  let observing = 0;
  for (const call of findExpects(source, masked)) {
    if (isLiteralArgument(call.argument)) {
      flags.push({ kind: FAKE_FLAG.TAUTOLOGY, detail: `expect(${call.argument.slice(0, 60)}) asserts on a literal` });
    } else if (BARE_FIXTURE.test(call.argument) && VACUOUS_MATCHER.test(call.after)) {
      flags.push({ kind: FAKE_FLAG.VACUOUS, detail: `expect(${call.argument}) is true of any page` });
    } else if (PAGE_WORDS.test(call.maskedArgument) || derivedWord.test(call.maskedArgument)) {
      observing += 1;
    }
  }
  if (observing === 0) flags.push({ kind: FAKE_FLAG.NO_PAGE_EXPECT, detail: "no expect on the page, a locator, a request or a value read from them" });
  return flags;
}

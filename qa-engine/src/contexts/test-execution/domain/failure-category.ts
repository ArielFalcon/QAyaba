/*
 * Why a test case failed, read from the text of Playwright's error. A pure classifier over an already redacted message: it decides nothing about
 * a verdict, only labels a failure for the trace and its metrics.
 *
 * It is pinned to the wording of Playwright's messages, which is not a stable interface: the fixtures in
 * qa-engine/test/contexts/test-execution/domain/failure-category.test.ts are the messages of the version the image pins, and moving Playwright
 * means re-checking them (AGENTS.md, "When Playwright moves"). A message none of the rules know is left unclassified, never guessed.
 */

import { stripAnsi } from "@kernel/ansi.ts";

export const FAILURE_CATEGORY = {
  SELECTOR: "selector",
  AUTH: "auth",
  DATA_STATE: "data_state",
  TIMEOUT: "timeout",
  ASSERTION: "assertion",
  INFRA: "infra",
  EGRESS: "egress",
} as const;
export type FailureCategory = (typeof FAILURE_CATEGORY)[keyof typeof FAILURE_CATEGORY];

export type SelectorStrategy = "testid" | "role" | "text" | "css";

export interface ClassifyContext {
  /* Hosts the egress filter refused during the run: a network error naming one of them is the filter's doing. */
  deniedHosts?: readonly string[];
}

const NET_ERROR = /net::ERR_[A-Z_]+/;
const INFRA = [
  /Executable doesn't exist/i,
  /browserType\.launch/i,
  /Target (page, context or browser|closed)/i,
  /Browser has been closed/i,
  /browser (has )?crashed/i,
  /Page crashed/i,
  /\bENOSPC\b/,
  /\bEMFILE\b/,
  /Failed to launch/i,
  /Protocol error \(/i,
  /Connection closed while reading from the driver/i,
];
/* Auth is read from an HTTP status or from a navigation that ended on a login path; words like "unauthorized" or "session expired" are as likely to be page text an assertion quotes. */
const AUTH_STATUS = [/\bstatus(?: code)?:?\s+(401|403)\b/i, /\bReceived:\s+(401|403)\b/];
/* A navigation that ended on a login path decides even inside an assertion about the URL. */
const AUTH_LOGIN_PATH = [/Received (string|pattern|URL):\s+"?[^\s"]*\/(log-?in|sign-?in|auth|sso)\b/i];
/* Data state is read from an HTTP status too, never from words in an assertion (an expected text may well say "conflict" or "already exists"). */
const DATA_STATE_STATUS = [/\bstatus(?: code)?:?\s+(404|409|422)\b/i, /\bReceived:\s+(404|409|422)\b/];
const STRICT = /strict mode violation/i;
/* What decides a selector failure whatever else the message says: the element is not there, is hidden, or the locator is ambiguous. */
const SELECTOR_DECISIVE = [STRICT, /<element\(s\) not found>/, /resolved to hidden/i];
/* Call-log wording of an action that could not find or use its element. It decides only when the message is no assertion. */
const SELECTOR_CALL_LOG = [
  /waiting for (getBy\w+|locator|frameLocator)\(/i,
  /element is not (visible|enabled|stable|editable|attached)/i,
  /intercepts pointer events/i,
  /did not find some options/i,
];
const TIMEOUT = [/Test timeout of \d+\s*ms exceeded/i, /Timeout \d+\s*ms exceeded/i, /exceeded while waiting/i, /Test ended\./i, /Navigation timeout/i];
/* An assertion announces itself on its first line (expect(...) failed, expect.matcher:, an AssertionError); its Expected/Received labels follow. */
const ASSERTION_FIRST_LINE = [/\bexpect(\.\w+)?[(:]/, /AssertionError/, /unexpected value/i];
const ASSERTION_BODY = [/^\s*Expected( string| value| pattern| substring| array)?:/m, /^\s*Received( string| value| array)?:/m];

const any = (rules: readonly RegExp[], text: string): boolean => rules.some((re) => re.test(text));
const firstLineOf = (text: string): string => text.split("\n").find((line) => line.trim() !== "") ?? "";

export function classifyFailure(message: string, ctx: ClassifyContext = {}): FailureCategory | undefined {
  const text = stripAnsi(message);
  if (text.trim() === "") return undefined;
  if (NET_ERROR.test(text) && (ctx.deniedHosts ?? []).some((host) => host !== "" && text.includes(host))) return FAILURE_CATEGORY.EGRESS;
  if (any(INFRA, text) || NET_ERROR.test(text)) return FAILURE_CATEGORY.INFRA;
  if (any(SELECTOR_DECISIVE, text)) return FAILURE_CATEGORY.SELECTOR;
  if (any(AUTH_LOGIN_PATH, text)) return FAILURE_CATEGORY.AUTH;
  /* A failure that announces itself as an assertion is one: a status it quotes (Received: 404, Expected: "status 409") is a value compared, not a response the test got. A status decides only for a navigation or a response error. */
  const firstIsAssertion = any(ASSERTION_FIRST_LINE, firstLineOf(text));
  if (!firstIsAssertion) {
    if (any(AUTH_STATUS, text)) return FAILURE_CATEGORY.AUTH;
    if (any(DATA_STATE_STATUS, text)) return FAILURE_CATEGORY.DATA_STATE;
  }
  if (firstIsAssertion || (any(ASSERTION_BODY, text) && /\bto[A-Z]\w*\(/.test(text))) return FAILURE_CATEGORY.ASSERTION;
  if (any(SELECTOR_CALL_LOG, text)) return FAILURE_CATEGORY.SELECTOR;
  if (any(TIMEOUT, text)) return FAILURE_CATEGORY.TIMEOUT;
  return undefined;
}

/* "strict mode violation: <locator> resolved to N elements": N, or undefined when the message is no such violation. */
export function strictModeMatchCount(message: string): number | undefined {
  const text = stripAnsi(message);
  if (!STRICT.test(text)) return undefined;
  const found = /resolved to (\d+) elements?/i.exec(text);
  if (!found) return undefined;
  const count = Number(found[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/* The first locator the message names, as the kind of selector it is: a test id, a role, a visible text or label, or CSS. */
export function locatorStrategy(message: string): SelectorStrategy | undefined {
  const text = stripAnsi(message);
  const named = /\b(getByTestId|getByRole|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle|locator|frameLocator)\(([^)\n]*)/.exec(text);
  if (!named) return undefined;
  const [, method, args] = named;
  switch (method) {
    case "getByTestId":
      return "testid";
    case "getByRole":
      return "role";
    case "getByText":
    case "getByLabel":
    case "getByPlaceholder":
    case "getByAltText":
    case "getByTitle":
      return "text";
    default:
      if (/data-(testid|test-id|test|cy|qa)\b|\[data-[a-z-]*test/i.test(args ?? "")) return "testid";
      if (/^\s*['"`]?(role=|text=|internal:role|internal:text)/i.test(args ?? "")) return /role=|internal:role/i.test(args ?? "") ? "role" : "text";
      return "css";
  }
}

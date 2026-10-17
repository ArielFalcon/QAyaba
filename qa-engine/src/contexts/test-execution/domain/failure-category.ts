/*
 * Why a test case failed, read from the text of Playwright's error. A pure classifier over an already redacted message: it decides nothing about
 * a verdict, only labels a failure for the trace and its metrics.
 *
 * It is pinned to the wording of Playwright's messages, which is not a stable interface: the fixtures in
 * qa-engine/test/contexts/test-execution/domain/failure-category.test.ts are the messages of the version the image pins, and moving Playwright
 * means re-checking them (CLAUDE.md, "When Playwright moves"). A message none of the rules know is left unclassified, never guessed.
 */

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

/* eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");

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
const AUTH = [
  /status (code )?(401|403)\b/i,
  /\b(401|403)\b[^\n]{0,40}(unauthori[sz]ed|forbidden)/i,
  /\bunauthori[sz]ed\b/i,
  /session (has )?(expired|invalidated|is gone)/i,
  /Received (string|pattern|URL):\s+"?[^\s"]*\/(log-?in|sign-?in|auth|sso)\b/i,
  /redirected to (the )?(log-?in|sign-?in)/i,
];
const STRICT = /strict mode violation/i;
const SELECTOR = [
  STRICT,
  /Received: <element\(s\) not found>/,
  /waiting for (getBy\w+|locator|frameLocator)\(/i,
  /element is not (visible|enabled|stable|editable|attached)/i,
  /resolved to hidden/i,
  /<element\(s\) not found>/,
  /intercepts pointer events/i,
  /did not find some options/i,
];
const TIMEOUT = [/Test timeout of \d+\s*ms exceeded/i, /Timeout \d+\s*ms exceeded/i, /exceeded while waiting/i, /Test ended\./i, /Navigation timeout/i];
const DATA_STATE = [
  /already exists/i,
  /\bduplicate\b/i,
  /\bconflict\b/i,
  /status (code )?(404|409|422)\b/i,
  /no (data|results|records|items) (found|available)/i,
  /toHaveCount/,
];
const ASSERTION = [/expect\(/, /Expected( string| value| pattern| substring| array)?:/, /Received( string| value| array)?:/, /AssertionError/, /\btoBe\w*\(/, /\btoHave\w*\(/, /\btoContain\w*\(/, /\btoEqual\(/, /\btoMatch\w*\(/];

const any = (rules: readonly RegExp[], text: string): boolean => rules.some((re) => re.test(text));

export function classifyFailure(message: string, ctx: ClassifyContext = {}): FailureCategory | undefined {
  const text = stripAnsi(message);
  if (text.trim() === "") return undefined;
  if (NET_ERROR.test(text) && (ctx.deniedHosts ?? []).some((host) => host !== "" && text.includes(host))) return FAILURE_CATEGORY.EGRESS;
  if (any(INFRA, text) || (NET_ERROR.test(text))) return FAILURE_CATEGORY.INFRA;
  if (any(AUTH, text)) return FAILURE_CATEGORY.AUTH;
  if (any(SELECTOR, text)) return FAILURE_CATEGORY.SELECTOR;
  if (any(TIMEOUT, text)) return FAILURE_CATEGORY.TIMEOUT;
  if (any(DATA_STATE, text)) return FAILURE_CATEGORY.DATA_STATE;
  if (any(ASSERTION, text)) return FAILURE_CATEGORY.ASSERTION;
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

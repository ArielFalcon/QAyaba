/*
 * What a browser navigation came to, as a closed set: the page loaded, the app answered with a login or an authorization
 * refusal, the page failed to load (an error status or a network failure), or the request was refused by the guard or the egress
 * filter. A pure, deterministic read of the tool's answer text and of the login addresses the app declares; the text itself never
 * leaves this function, so the outcome is safe to record in every capture mode. It reads a bounded prefix, so a huge page costs
 * a bounded amount, and it never throws.
 *
 * Heuristic by nature: the tool's answer is text, not a structured status. It is anchored to the part that speaks for the tool
 * (the code it ran, the page URL and title, an error section) and never to the page's own content: everything from the
 * "Page Snapshot" marker on is the page. A signal found only there is not evidence, so the answer is `unknown`, never a false
 * `http_error`, `auth_challenge` or `blocked`. A tool call that failed is all status, so its whole answer is read.
 */

export const NAV_OUTCOMES = ["ok", "auth_challenge", "http_error", "blocked", "unknown"] as const;
export type NavOutcome = (typeof NAV_OUTCOMES)[number];

/* The longest prefix of an answer that is read: the status line and the page state come first. */
export const NAV_OUTCOME_READ_CHARS = 8_000;

export interface NavOutcomeInput {
  status: "completed" | "error";
  output: string;
  /* The address the call asked for, when its input carried one. */
  requestedUrl?: string;
  /* Absolute addresses of the app's declared login page(s). */
  loginUrls: readonly string[];
  /* Origins that exist only to authenticate (a dedicated identity origin): any page there is a login step. */
  authOnlyOrigins: readonly string[];
}

const NAVIGATE_TOOL = /(^|_)(browser_navigate|authbrowser_navigate)$/i;

/* Whether a tool call opens an address: the Playwright MCP's `browser_navigate` or the authenticated browser's `authbrowser_navigate`, with or without an MCP server prefix. */
export function isNavigationCall(tool: string): boolean {
  return NAVIGATE_TOOL.test(tool);
}

const BLOCKED = /"code"\s*:\s*"blocked"|ERR_BLOCKED_BY|ERR_TUNNEL_CONNECTION_FAILED|ERR_ACCESS_DENIED|would write to DEV|blocked by (the )?(route guard|egress)/i;
const SESSION_GONE = /session invalidated/i;
const UNAUTHORIZED = /\b(401|403)\b[^\n]{0,40}(unauthori[sz]ed|forbidden)|\b(unauthori[sz]ed|forbidden)\b[^\n]{0,40}\b(401|403)\b|Response status code (401|403)|\b(401|403) (Unauthorized|Forbidden)\b|WWW-Authenticate/i;
const HTTP_ERROR = /\b(404|410|429|5\d\d)\b[^\n]{0,30}(not found|gone|error|unavailable|bad gateway|gateway timeout|too many requests|server)|(not found|server error|bad gateway|service unavailable|gateway timeout)\b[^\n]{0,30}\b(404|410|5\d\d)\b|Response status code (4\d\d|5\d\d)|net::ERR_[A-Z_]+|ERR_(NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|CERT_[A-Z_]+|TIMED_OUT)/i;
const SNAPSHOT_MARKER = /^[-*\s]*Page Snapshot\b/im;
/* Without a marker, a page that loaded is judged by its opening lines only: the rest may be content. */
const STATUS_HEAD_CHARS = 600;
const PAGE_URL = /(?:Page URL|url)\s*:\s*(\S+)/i;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function sameLocation(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
}

/* Whether a page address is one of the login steps the app declares. */
function isAuthPage(url: URL, input: NavOutcomeInput): boolean {
  if (input.authOnlyOrigins.includes(url.origin)) return true;
  return input.loginUrls.some((login) => {
    const declared = parse(login);
    return declared !== undefined && sameLocation(url, declared);
  });
}

export function classifyNavOutcome(input: NavOutcomeInput): NavOutcome {
  try {
    const text = typeof input.output === "string" ? input.output.slice(0, NAV_OUTCOME_READ_CHARS) : "";
    if (text.trim() === "") return "unknown";
    const marker = SNAPSHOT_MARKER.exec(text);
    const status = input.status === "error" && marker === null ? text : marker ? text.slice(0, marker.index) : text.slice(0, STATUS_HEAD_CHARS);
    const content = status.length < text.length;
    if (BLOCKED.test(status)) return "blocked";
    if (SESSION_GONE.test(status) || UNAUTHORIZED.test(status)) return "auth_challenge";

    const landed = PAGE_URL.exec(status)?.[1];
    const landedUrl = landed === undefined ? undefined : parse(landed);
    if (landedUrl !== undefined && isAuthPage(landedUrl, input)) {
      const asked = input.requestedUrl === undefined ? undefined : parse(input.requestedUrl);
      /* Asking for the login page and getting it is a page that loaded; getting it after asking for another is a challenge. */
      if (asked === undefined || !isAuthPage(asked, input)) return "auth_challenge";
    }
    if (HTTP_ERROR.test(status)) return "http_error";
    /* A signal that sits only in the page's content proves nothing about the navigation. */
    if (content && (BLOCKED.test(text) || SESSION_GONE.test(text) || UNAUTHORIZED.test(text) || HTTP_ERROR.test(text))) return "unknown";
    return input.status === "completed" ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

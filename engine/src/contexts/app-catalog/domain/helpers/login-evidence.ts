/*
 * What a login attempt left behind, how it is classified, and how it is rendered into the one note a
 * failed login writes to the run history and the logs. The evidence holds structural facts only (paths, methods,
 * statuses, counts, markers): never a body, a header, a query string or a value the operator typed.
 * Every string a page or a network could have echoed back goes through `scrubSecrets`, which removes
 * the account's user name and password by exact value in every spelling a URL, a form body or a
 * JSON body would give them, BEFORE the text is cut to its bound, so no prefix of a credential
 * survives a cut. This module is a protected path: weakening it leaks the account.
 *
 * Covered: the raw value, `encodeURIComponent`, `encodeURI` (which leaves reserved characters such as
 * `/` and `&` raw beside escaped ones), form encoding, JSON with and without ASCII-only escapes, and a
 * backslash read as a slash (a browser does that to a path).
 *
 * Known residual, not covered here (the discovery child's own scrub covers the first four, so a
 * child-produced text is clean of them): a decomposed (NFD) spelling of a composed (NFC) secret or the
 * reverse, HTML entities, a JSON body that escapes `&`, `<` and `>` as `\u0026`-style sequences (Go),
 * one that escapes `/` as `\/` (PHP), and any other encoding a server invents.
 */

import { PRECONDITION_KIND, type PreconditionKind } from "../auth-precondition.ts";

/** The longest alert or page-error text a note carries, counted after the credentials are removed. */
export const EVIDENCE_TEXT_MAX = 200;
/** How many submit-time requests a note lists. */
export const MAX_RENDERED_REQUESTS = 10;

const REDACTED = "[redacted]";

export const FORM_STATE = {
  FOUND: "found",
  ABSENT: "absent",
  AMBIGUOUS: "ambiguous",
} as const;

export type FormState = (typeof FORM_STATE)[keyof typeof FORM_STATE];

/** A request the login sent: method and path only, and the status when a response came. */
export interface LoginRequest {
  method: string;
  pathname: string;
  status: number | null;
}

/** What the pages looked like, decided from their structure and never from their text. */
export interface LoginMarkers {
  captcha: boolean;
  sso: boolean;
}

export interface LoginEvidence {
  /** The paths visited while looking for the login form, in order. */
  ladder: readonly string[];
  form: FormState;
  /** Any page of the whole ladder had a password field. */
  ladderHadPasswordField: boolean;
  markers: LoginMarkers;
  /** A challenge element was visible after the submit (a badge or an invisible one does not count). */
  challengeVisible: boolean;
  /** A second-factor step (a structural marker, never text) was on screen after the submit; one seen only on an earlier page does not count. */
  secondFactorVisible: boolean;
  filled: boolean;
  submitted: boolean;
  /** The form's own submit event fired after the submit action: the page's handler for the form ran (or was about to). Without it, what the page threw next is not tied to the login. */
  submitEventFired: boolean;
  /**
   * The requests that were the login's own, sorted and capped by whoever produced the evidence: they started after
   * the submit and carry the account in their address or body (a native GET form's navigation is one too). The
   * app's other traffic in the same window (telemetry, a refresh, a poll) is not listed.
   */
  requests: readonly LoginRequest[];
  /** One of the login's own requests was still in flight when the deadline passed. */
  inFlightAtDeadline: boolean;
  pageErrorCount: number;
  firstPageError: string | null;
  /**
   * An exception surfaced after the submit (a page error, or a console error that carried an Error object) whose
   * signature had not been seen before it. A recurring one, or plain console text, never counts.
   */
  newExceptionAfterSubmit: boolean;
  /** The first such exception, already scrubbed of the account by whoever produced the evidence. */
  firstNewException: string | null;
  firstAlert: string | null;
  submitDisabled: boolean;
  finalPath: string;
  passwordGone: boolean;
  /** A fresh browser context was opened with the saved session and its page read; without it the next field says nothing. */
  freshContextChecked: boolean;
  /** That fresh context no longer shows the password field. */
  freshContextPasswordGone: boolean;
  storageStateWritten: boolean;
}

export const LOGIN_STATUS = {
  AUTHENTICATED: "authenticated",
  INCONCLUSIVE: "inconclusive",
  FAILED: "failed",
} as const;

/**
 * What the evidence proves. `failed` needs positive evidence of one kind of failure; everything else
 * is `inconclusive`, and `attempted` says whether a credential was actually submitted (a seed that
 * signs in again must not follow a submit that was made).
 */
export type LoginOutcome =
  | { status: typeof LOGIN_STATUS.AUTHENTICATED }
  | { status: typeof LOGIN_STATUS.INCONCLUSIVE; attempted: boolean }
  | { status: typeof LOGIN_STATUS.FAILED; kind: PreconditionKind };

/* The statuses a server answers a rejected credential with. */
const REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 403]);

const failed = (kind: PreconditionKind): LoginOutcome => ({ status: LOGIN_STATUS.FAILED, kind });
const inconclusive = (attempted: boolean): LoginOutcome => ({ status: LOGIN_STATUS.INCONCLUSIVE, attempted });

/**
 * Reads a login attempt. Pure: the same evidence gives the same outcome and the evidence is not
 * changed. Only positive evidence fails a login, and text alone (an alert, a page error) never does:
 * a failure needs a structural marker or a submit-time request, and a request still in flight at the
 * deadline proves nothing yet. `attempted` follows what was submitted: a recorded submit is an
 * attempt unless it visibly sent no request, because a seed that submits again after a rejected
 * credential risks a lockout. A submit whose form's handler ran, threw in the page and sent nothing is
 * positive evidence that this login cannot complete; one that threw but did send a request is left to
 * the request rules. Rules run in this order.
 */
export function classifyLoginEvidence(evidence: LoginEvidence): LoginOutcome {
  const { markers, requests } = evidence;
  if (evidence.submitted && evidence.passwordGone && evidence.freshContextChecked && evidence.freshContextPasswordGone && evidence.storageStateWritten) {
    return { status: LOGIN_STATUS.AUTHENTICATED };
  }
  /* Only when no page of the whole ladder had a password field: one that did means the login may live elsewhere. */
  if (evidence.form === FORM_STATE.ABSENT && markers.sso && !evidence.ladderHadPasswordField) return failed(PRECONDITION_KIND.SSO_ONLY);
  /* No form, an ambiguous one, or fields that would not fill teach nothing, but a submit that was recorded went out: the seed must not send another. */
  if (evidence.form !== FORM_STATE.FOUND || !evidence.filled || !evidence.submitted) return inconclusive(evidence.submitted);
  /* A submit that has visibly gone somewhere: the password field left, or a request was answered and none is still pending. */
  const settled = evidence.passwordGone || (requests.length > 0 && !evidence.inFlightAtDeadline);
  /* A visible challenge after a submit that left the password visible with nothing in flight; a badge or an invisible one is ignored. */
  if (!evidence.passwordGone && markers.captcha && evidence.challengeVisible && !evidence.inFlightAtDeadline) return failed(PRECONDITION_KIND.CAPTCHA_PRESENT);
  /* Seen on screen after the submit, and only once the submit settled: earlier, the step may just be the page the submit is still leaving. */
  if (evidence.secondFactorVisible && settled) return failed(PRECONDITION_KIND.SECOND_FACTOR_REQUIRED);
  /* A login request still in flight may not have set its session yet, and with no request of the login seen (its account is in a header, say) nothing shows that the field went because of a login: a fresh context proves nothing then. */
  if (evidence.passwordGone && evidence.freshContextChecked && !evidence.freshContextPasswordGone && !evidence.inFlightAtDeadline && requests.length > 0) return failed(PRECONDITION_KIND.SESSION_NOT_PERSISTABLE);
  if (!evidence.passwordGone) {
    /* A request still in flight proves nothing yet, and a submit that sent none (Enter did nothing, a click-only form) is left to the stock seed. */
    if (evidence.inFlightAtDeadline) return inconclusive(true);
    /* The form's handler ran, threw a new exception and no request went out: the login cannot complete. Without the submit event the exception may be the page's own business, and without one silence proves nothing: the stock seed decides. */
    if (requests.length === 0) return evidence.newExceptionAfterSubmit && evidence.submitEventFired ? failed(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE) : inconclusive(false);
    const rejected = requests.some((request) => request.status !== null && REJECTION_STATUSES.has(request.status));
    return failed(rejected ? PRECONDITION_KIND.CREDENTIALS_REJECTED : PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE);
  }
  /* The password went, but no session was written or no fresh context was read: submitted, and not proven. */
  return inconclusive(true);
}

/* The runtime has `toWellFormed` (Node 20+); the ES2022 library the projects compile against does not declare it. */
const toWellFormed = (text: string): string => (text as string & { toWellFormed(): string }).toWellFormed();

/* Every way a URL, a form body or a JSON body (escaped, or ASCII-only escaped) spells a value back. */
function spellingsOf(secret: string): string[] {
  /* A lone surrogate cannot be percent-encoded; the repaired form is what a server would have received. */
  const wellFormed = toWellFormed(secret);
  const form = new URLSearchParams({ k: wellFormed }).toString().slice(2);
  const json = JSON.stringify(wellFormed).slice(1, -1);
  const asciiJson = json.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const asPath = wellFormed.replace(/\\/g, "/");
  return [secret, wellFormed, encodeURIComponent(wellFormed), encodeURI(wellFormed), asPath, encodeURI(asPath), form, json, asciiJson];
}

const escapeForRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Removes every secret from the text by exact value, in every spelling and whatever the case (a name
 * echoed in capitals, percent or escape hex in either case). Every occurrence of every spelling is
 * located on the ORIGINAL text, including the ones that overlap each other, and the stretches they
 * cover are merged and replaced once, so a secret that contains or overlaps another leaves no
 * fragment of either behind. An empty secret is skipped (it would match between every character).
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const spellings = new Set(secrets.filter((secret) => secret !== "").flatMap(spellingsOf));
  const found: Array<[number, number]> = [];
  for (const spelling of spellings) {
    /* The lookahead finds occurrences that overlap one another; the capture is the text as it stands, whatever its case. */
    const occurrence = new RegExp(`(?=(${escapeForRegExp(spelling)}))`, "giu");
    for (const match of text.matchAll(occurrence)) found.push([match.index, match.index + match[1]!.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  let scrubbed = "";
  let copiedTo = 0;
  for (const [start, end] of found) {
    if (start >= copiedTo) {
      scrubbed += text.slice(copiedTo, start) + REDACTED;
      copiedTo = end;
    } else {
      copiedTo = Math.max(copiedTo, end);
    }
  }
  return scrubbed + text.slice(copiedTo);
}

/* The credentials come out first and the cut comes after, so a value straddling the cut vanishes whole. */
function scrubbedAndBounded(text: string, secrets: readonly string[]): string {
  return scrubSecrets(text, secrets).slice(0, EVIDENCE_TEXT_MAX);
}

/**
 * The note a failed login ends the run with: the kind and the structural facts behind it, worded
 * without assigning fault, and free of every credential in `secrets`. Does not change the evidence.
 */
export function renderLoginEvidence(kind: PreconditionKind, evidence: LoginEvidence, secrets: readonly string[]): string {
  const clean = (text: string): string => scrubSecrets(text, secrets);
  const requests = evidence.requests
    .slice(0, MAX_RENDERED_REQUESTS)
    .map((request) => `${clean(request.method)} ${clean(request.pathname)} ${request.status ?? "no response"}`);
  /* A part with nothing to say is left out, never rendered empty. */
  const parts = [
    kind,
    `pages tried: ${evidence.ladder.map(clean).join(", ")}`,
    `ended on ${clean(evidence.finalPath)}`,
    requests.length === 0 ? null : `submit requests: ${requests.join(", ")}`,
    `page errors: ${evidence.pageErrorCount}`,
    evidence.firstPageError === null ? null : `first page error: ${scrubbedAndBounded(evidence.firstPageError, secrets)}`,
    evidence.firstNewException === null ? null : `first new exception after submit: ${scrubbedAndBounded(evidence.firstNewException, secrets)}`,
    evidence.firstAlert === null ? null : `alert: ${scrubbedAndBounded(evidence.firstAlert, secrets)}`,
  ];
  return parts.filter((part): part is string => part !== null).join("; ");
}

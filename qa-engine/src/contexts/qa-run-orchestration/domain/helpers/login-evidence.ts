/*
 * What a login attempt left behind, how it is classified, and how it is rendered into the one note a
 * failed login writes to the run history and the logs. The evidence holds structural facts only (paths, methods,
 * statuses, counts, markers): never a body, a header, a query string or a value the operator typed.
 * Every string a page or a network could have echoed back goes through `scrubSecrets`, which removes
 * the account's user name and password by exact value in every spelling a URL, a form body or a
 * JSON body would give them, BEFORE the text is cut to its bound, so no prefix of a credential
 * survives a cut. This module is a protected path: weakening it leaks the account.
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

/** A non-GET request seen while the login was submitted: method and path only, and the status when a response came. */
export interface LoginRequest {
  method: string;
  pathname: string;
  status: number | null;
}

/** What the pages looked like, decided from their structure and never from their text. */
export interface LoginMarkers {
  captcha: boolean;
  secondFactor: boolean;
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
  filled: boolean;
  submitted: boolean;
  /** Submit-time non-GET requests, sorted and capped by whoever produced the evidence. */
  requests: readonly LoginRequest[];
  /** A submit-time request was still in flight when the deadline passed. */
  inFlightAtDeadline: boolean;
  pageErrorCount: number;
  firstPageError: string | null;
  firstAlert: string | null;
  submitDisabled: boolean;
  finalPath: string;
  passwordGone: boolean;
  /** A fresh browser context, loaded with the saved session, no longer shows the password field. */
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
 * deadline proves nothing yet. Rules run in this order.
 */
export function classifyLoginEvidence(evidence: LoginEvidence): LoginOutcome {
  const { markers, requests } = evidence;
  if (evidence.submitted && evidence.passwordGone && evidence.freshContextPasswordGone && evidence.storageStateWritten) {
    return { status: LOGIN_STATUS.AUTHENTICATED };
  }
  /* Only when no page of the whole ladder had a password field: one that did means the login may live elsewhere. */
  if (evidence.form === FORM_STATE.ABSENT && markers.sso && !evidence.ladderHadPasswordField) return failed(PRECONDITION_KIND.SSO_ONLY);
  /* No form, an ambiguous one, fields that would not fill, or nothing submitted: no credential went anywhere. */
  if (evidence.form !== FORM_STATE.FOUND || !evidence.filled || !evidence.submitted) return inconclusive(false);
  /* A visible challenge after a submit that left the password visible; a badge or an invisible one is ignored. */
  if (!evidence.passwordGone && markers.captcha && evidence.challengeVisible) return failed(PRECONDITION_KIND.CAPTCHA_PRESENT);
  if (markers.secondFactor) return failed(PRECONDITION_KIND.SECOND_FACTOR_REQUIRED);
  if (evidence.passwordGone && !evidence.freshContextPasswordGone) return failed(PRECONDITION_KIND.SESSION_NOT_PERSISTABLE);
  if (!evidence.passwordGone) {
    /* A request still in flight proves nothing yet, and a submit that sent none (Enter did nothing, a click-only form) is left to the stock seed. */
    if (evidence.inFlightAtDeadline) return inconclusive(true);
    if (requests.length === 0) return inconclusive(false);
    const rejected = requests.some((request) => request.status !== null && REJECTION_STATUSES.has(request.status));
    return failed(rejected ? PRECONDITION_KIND.CREDENTIALS_REJECTED : PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE);
  }
  /* The password went and a fresh context is clean, but no session was written: submitted, and not proven. */
  return inconclusive(true);
}

/* Every way a URL, a form body or a JSON body (escaped, or ASCII-only escaped) spells a value back. */
function spellingsOf(secret: string): string[] {
  const form = new URLSearchParams({ k: secret }).toString().slice(2);
  const json = JSON.stringify(secret).slice(1, -1);
  const asciiJson = json.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [secret, encodeURIComponent(secret), form, json, asciiJson];
}

/**
 * Removes every secret from the text by exact value, in every spelling. The longest spelling goes
 * first so a secret that contains another leaves no fragment of the longer one; an empty secret is
 * skipped (it would match between every character).
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const spellings = [...new Set(secrets.filter((secret) => secret !== "").flatMap(spellingsOf))].sort((a, b) => b.length - a.length);
  return spellings.reduce((scrubbed, spelling) => scrubbed.split(spelling).join(REDACTED), text);
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
    evidence.firstAlert === null ? null : `alert: ${scrubbedAndBounded(evidence.firstAlert, secrets)}`,
  ];
  return parts.filter((part): part is string => part !== null).join("; ");
}

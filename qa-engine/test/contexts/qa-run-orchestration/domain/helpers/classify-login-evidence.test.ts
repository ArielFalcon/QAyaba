import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORM_STATE,
  classifyLoginEvidence,
  type LoginEvidence,
  type LoginOutcome,
} from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { PRECONDITION_KIND, type PreconditionKind } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import { scriptedLoginEvidence } from "../../../../support/login-evidence.ts";

/* What a login attempt that got in looks like, before a row bends one fact of it. */
const SIGNED_IN: Partial<LoginEvidence> = {
  requests: [{ method: "POST", pathname: "/api/session", status: 200 }],
  passwordGone: true,
  freshContextPasswordGone: true,
  storageStateWritten: true,
  finalPath: "/home",
};

const authenticated = (): LoginOutcome => ({ status: "authenticated" });
const inconclusive = (attempted: boolean): LoginOutcome => ({ status: "inconclusive", attempted });
const failed = (kind: PreconditionKind): LoginOutcome => ({ status: "failed", kind });

interface Row {
  name: string;
  evidence: Partial<LoginEvidence>;
  outcome: LoginOutcome;
}

const ROWS: readonly Row[] = [
  /* authenticated: submitted, the password field gone, a fresh context clean, the session written */
  { name: "a submit that removed the password, held in a fresh context, with the session written, is authenticated", evidence: SIGNED_IN, outcome: authenticated() },
  { name: "authenticated wins over a stale second-factor marker", evidence: { ...SIGNED_IN, markers: { captcha: false, secondFactor: true, sso: false } }, outcome: authenticated() },
  { name: "a session that was never written is not authenticated, but the submit went through", evidence: { ...SIGNED_IN, storageStateWritten: false }, outcome: inconclusive(true) },
  { name: "nothing is authenticated when nothing was submitted, whatever the page shows", evidence: { ...SIGNED_IN, submitted: false, requests: [] }, outcome: inconclusive(false) },

  /* sso-only: only when no page of the whole ladder had a password field */
  { name: "no form and an sso marker across a ladder with no password field is sso-only", evidence: { form: FORM_STATE.ABSENT, ladderHadPasswordField: false, markers: { captcha: false, secondFactor: false, sso: true }, filled: false, submitted: false, requests: [] }, outcome: failed(PRECONDITION_KIND.SSO_ONLY) },
  { name: "an sso marker is not enough when some page of the ladder had a password field", evidence: { form: FORM_STATE.ABSENT, ladderHadPasswordField: true, markers: { captcha: false, secondFactor: false, sso: true }, filled: false, submitted: false, requests: [] }, outcome: inconclusive(false) },
  { name: "an sso marker does not make a login sso-only while a form was found", evidence: { ladderHadPasswordField: false, markers: { captcha: false, secondFactor: false, sso: true } }, outcome: failed(PRECONDITION_KIND.CREDENTIALS_REJECTED) },
  { name: "no form and no sso marker is inconclusive, not sso-only", evidence: { form: FORM_STATE.ABSENT, ladderHadPasswordField: false, filled: false, submitted: false, requests: [] }, outcome: inconclusive(false) },

  /* captcha-present: only after a submit left the password visible and a challenge is visible */
  { name: "a visible challenge after a submit that left the password visible is captcha-present", evidence: { markers: { captcha: true, secondFactor: false, sso: false }, challengeVisible: true, requests: [] }, outcome: failed(PRECONDITION_KIND.CAPTCHA_PRESENT) },
  { name: "a captcha badge that is not a visible challenge is ignored, and the rejected submit is read as such", evidence: { markers: { captcha: true, secondFactor: false, sso: false }, challengeVisible: false }, outcome: failed(PRECONDITION_KIND.CREDENTIALS_REJECTED) },
  { name: "a captcha badge with no request at all is inconclusive and leaves the stock seed to run", evidence: { markers: { captcha: true, secondFactor: false, sso: false }, challengeVisible: false, requests: [] }, outcome: inconclusive(false) },
  { name: "a challenge seen before anything was submitted is inconclusive", evidence: { markers: { captcha: true, secondFactor: false, sso: false }, challengeVisible: true, submitted: false, requests: [] }, outcome: inconclusive(false) },

  /* a form that was absent, ambiguous, not filled or not submitted teaches nothing */
  { name: "no form found is inconclusive and unattempted", evidence: { form: FORM_STATE.ABSENT, ladderHadPasswordField: false, filled: false, submitted: false, requests: [] }, outcome: inconclusive(false) },
  { name: "an ambiguous form is inconclusive and unattempted", evidence: { form: FORM_STATE.AMBIGUOUS, filled: false, submitted: false, requests: [] }, outcome: inconclusive(false) },
  { name: "a form whose fields could not be filled is inconclusive and unattempted", evidence: { filled: false, submitted: false, requests: [] }, outcome: inconclusive(false) },
  { name: "a filled form that was never submitted is inconclusive and unattempted", evidence: { submitted: false, requests: [] }, outcome: inconclusive(false) },
  { name: "a submit recorded against a form that was not found is not believed", evidence: { form: FORM_STATE.ABSENT, ladderHadPasswordField: true }, outcome: inconclusive(false) },
  { name: "a submit recorded against an ambiguous form is not believed", evidence: { form: FORM_STATE.AMBIGUOUS }, outcome: inconclusive(false) },
  { name: "a submit recorded although the fields were never filled is not believed", evidence: { filled: false }, outcome: inconclusive(false) },

  { name: "a challenge still visible once the password is gone is not captcha-present", evidence: { ...SIGNED_IN, freshContextPasswordGone: false, markers: { captcha: true, secondFactor: false, sso: false }, challengeVisible: true }, outcome: failed(PRECONDITION_KIND.SESSION_NOT_PERSISTABLE) },

  /* second-factor-required: after a submit, by a structural marker */
  { name: "a second-factor marker after a submit that removed the password is second-factor-required", evidence: { ...SIGNED_IN, storageStateWritten: false, freshContextPasswordGone: false, markers: { captcha: false, secondFactor: true, sso: false } }, outcome: failed(PRECONDITION_KIND.SECOND_FACTOR_REQUIRED) },
  { name: "a second-factor marker after a submit that left the password visible is second-factor-required too", evidence: { markers: { captcha: false, secondFactor: true, sso: false } }, outcome: failed(PRECONDITION_KIND.SECOND_FACTOR_REQUIRED) },
  { name: "a second-factor marker before anything was submitted is inconclusive", evidence: { submitted: false, requests: [], markers: { captcha: false, secondFactor: true, sso: false } }, outcome: inconclusive(false) },

  /* session-not-persistable: the password went but a fresh context shows it again */
  { name: "a password that is gone but shows again in a fresh context is session-not-persistable", evidence: { ...SIGNED_IN, freshContextPasswordGone: false, storageStateWritten: true }, outcome: failed(PRECONDITION_KIND.SESSION_NOT_PERSISTABLE) },

  /* password still visible: credentials-rejected / login-did-not-complete need a submit-time request and none in flight */
  { name: "a 401 to a submit with the password still visible is credentials-rejected", evidence: { requests: [{ method: "POST", pathname: "/api/session", status: 401 }] }, outcome: failed(PRECONDITION_KIND.CREDENTIALS_REJECTED) },
  { name: "a 403 to a submit with the password still visible is credentials-rejected", evidence: { requests: [{ method: "POST", pathname: "/api/session", status: 403 }] }, outcome: failed(PRECONDITION_KIND.CREDENTIALS_REJECTED) },
  { name: "any rejected request among others makes it credentials-rejected", evidence: { requests: [{ method: "POST", pathname: "/api/log", status: 500 }, { method: "POST", pathname: "/api/session", status: 401 }] }, outcome: failed(PRECONDITION_KIND.CREDENTIALS_REJECTED) },
  { name: "a submit answered with a success status but the password still visible did not complete", evidence: { requests: [{ method: "POST", pathname: "/api/session", status: 200 }] }, outcome: failed(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE) },
  { name: "a submit answered with a server error and no rejection did not complete", evidence: { requests: [{ method: "POST", pathname: "/api/session", status: 500 }] }, outcome: failed(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE) },
  { name: "a submit that sent no request at all is inconclusive and unattempted, so the stock seed still runs", evidence: { requests: [] }, outcome: inconclusive(false) },
  { name: "a request still in flight at the deadline is inconclusive but attempted, even after a rejection", evidence: { inFlightAtDeadline: true, requests: [{ method: "POST", pathname: "/api/session", status: 401 }] }, outcome: inconclusive(true) },
  { name: "a request in flight with none seen yet is inconclusive and attempted", evidence: { inFlightAtDeadline: true, requests: [] }, outcome: inconclusive(true) },
  { name: "an alert that reads like a rejection, with no request behind it, never yields a failure", evidence: { requests: [], firstAlert: "Invalid credentials" }, outcome: inconclusive(false) },
  { name: "a page error with no request behind it never yields a failure", evidence: { requests: [], pageErrorCount: 2, firstPageError: "TypeError: x is undefined" }, outcome: inconclusive(false) },
];

for (const row of ROWS) {
  test(row.name, () => {
    assert.deepEqual(classifyLoginEvidence(scriptedLoginEvidence(row.evidence)), row.outcome);
  });
}

test("the same evidence always gives the same outcome", () => {
  for (const row of ROWS) {
    const evidence = scriptedLoginEvidence(row.evidence);
    assert.deepEqual(classifyLoginEvidence(evidence), classifyLoginEvidence(structuredClone(evidence)), row.name);
  }
});

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) freeze(inner);
    Object.freeze(value);
  }
  return value;
}

test("classifying never changes the evidence it reads", () => {
  for (const row of ROWS) {
    const evidence = freeze(scriptedLoginEvidence(row.evidence));
    assert.doesNotThrow(() => classifyLoginEvidence(evidence), row.name);
  }
});

test("every failure kind is reachable from some row, so a kind is never classified nowhere", () => {
  const reached = new Set(ROWS.flatMap((row) => (row.outcome.status === "failed" ? [row.outcome.kind] : [])));
  for (const kind of Object.values(PRECONDITION_KIND)) {
    assert.ok(reached.has(kind), `${kind} has no row`);
  }
});

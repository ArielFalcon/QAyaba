import { FORM_STATE, type LoginEvidence } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";

/**
 * A login attempt as the login tests script it. Unless a test says otherwise the attempt found one
 * form, filled and submitted it, saw the password field stay, and saw one rejected submit request:
 * the plainest evidence of a login that did not go through.
 */
export function scriptedLoginEvidence(over: Partial<LoginEvidence> = {}): LoginEvidence {
  return {
    ladder: ["/", "/login"],
    form: FORM_STATE.FOUND,
    ladderHadPasswordField: true,
    markers: { captcha: false, sso: false },
    challengeVisible: false,
    secondFactorVisible: false,
    filled: true,
    submitted: true,
    requests: [{ method: "POST", pathname: "/api/session", status: 401 }],
    inFlightAtDeadline: false,
    pageErrorCount: 0,
    firstPageError: null,
    firstAlert: null,
    submitDisabled: false,
    finalPath: "/login",
    passwordGone: false,
    freshContextChecked: false,
    freshContextPasswordGone: false,
    storageStateWritten: false,
    ...over,
  };
}

/*
 * A failed run precondition: the app's login was positively evidenced to fail before generation had
 * anything to test. It is a typed error, told apart from a generic auth failure (which stays an
 * infrastructure error), and it carries the kind of failure, a note already scrubbed of every
 * credential, and how long the attempt took — nothing else. It holds no evidence and no cause, so a
 * log line or a persisted note built from it cannot leak what the login page or the network said.
 */

/* Neutral kinds: each names what was observed, never who is at fault. These are the ones the login evidence is classified into (helpers/login-evidence.ts). */
export const CLASSIFIED_PRECONDITION_KIND = {
  CREDENTIALS_REJECTED: "credentials-rejected",
  LOGIN_DID_NOT_COMPLETE: "login-did-not-complete",
  SECOND_FACTOR_REQUIRED: "second-factor-required",
  CAPTCHA_PRESENT: "captcha-present",
  SSO_ONLY: "sso-only",
  SESSION_NOT_PERSISTABLE: "session-not-persistable",
} as const;

export const PRECONDITION_KIND = {
  ...CLASSIFIED_PRECONDITION_KIND,
  /* The login's child was refused hosts by the egress filter and did not sign in: the network layer, not the account or the app, is the probable cause. Told by the adapter from what the filter did, never classified from the page's evidence. */
  EGRESS_DENIED: "egress-denied",
} as const;

export type PreconditionKind = (typeof PRECONDITION_KIND)[keyof typeof PRECONDITION_KIND];

export class AuthPreconditionError extends Error {
  constructor(
    readonly kind: PreconditionKind,
    /** Already scrubbed of credentials by the caller. */
    readonly note: string,
    /** How long the login attempt took, in milliseconds. */
    readonly ms: number,
  ) {
    super(note);
    this.name = new.target.name;
  }
}

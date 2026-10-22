/*
 * The durable copy of an app's accepted e2e suite, kept outside the watched repo's working copy. A run's checkout wipes every
 * untracked file of the mirror, so a suite that was never published (shadow mode, or a pull request not merged yet) would start from
 * nothing on the next run, with the stock login seed and no specs. The store brings back exactly what an accepted run proved.
 *
 * The suite directory is untrusted: it is where the agent writes. Whatever the store takes from it, or puts into it, goes through
 * the confined readers and writers; a path that is a link, a named pipe or over a cap is never followed, waited on or admitted.
 */

/** The working copy a suite lives in: the checkout, and the suite directory inside it. */
export interface SuiteRoot {
  mirrorDir: string;
  specDir: string;
}

export interface SuiteRestoreResult {
  /** Files written into the working copy because git does not track them. */
  restored: number;
  /** Stored files left out because git tracks the path with other content than the one they were admitted over: git wins. */
  trackedWins: number;
  /** Tracked files whose content is the stored one: git still has the revision the store was admitted over, so the unpublished change is put back over it. */
  overlaid: number;
  /** The stored login (`auth.setup.ts`) was put back. */
  authRestored: boolean;
}

export interface SuiteCaptureInput extends SuiteRoot {
  runId: string;
  sha: string;
  /**
   * The specs (paths below the suite directory) that ran green in the accepted run, each with the sha256 of the bytes that executed
   * (`fingerprint`, taken before anything could rewrite them). A spec is admitted only while its bytes are still those: a regeneration
   * after the run leaves a file that never executed, which keeps the stored content. Any other spec keeps the stored content too.
   */
  executedGreen: ReadonlyMap<string, string>;
  /** The hash of the `auth.setup.ts` that actually signed in this run; absent when none did. Only then is the login admitted. */
  authVerifiedSha256?: string;
}

export interface SuiteCaptureResult {
  /** Entries the store holds after this capture. */
  entries: number;
  /** Entries added or whose content changed. */
  admitted: number;
  /** Entries removed (deleted in the working copy, or git has the path now with other content). */
  dropped: number;
  /** Files seen in the working copy that were not admitted, with the reason; the login is among them when it was not verified. */
  skipped: ReadonlyArray<{ path: string; reason: string }>;
}

/* Why a stored login is demoted, in the words `demoteAuth` is given (they go to logs and the store's manifest). The trace never carries these words: it carries the member of DEMOTE_REASON_CLASS they classify as. */
export const DEMOTE_REASON = {
  LOGIN_DID_NOT_SIGN_IN: "the restored login did not complete a sign-in before generation",
} as const;

export const DEMOTE_REASON_CLASS = ["login-did-not-sign-in", "other"] as const;
export type DemoteReasonClass = (typeof DEMOTE_REASON_CLASS)[number];

export function classifyDemoteReason(reason: string): DemoteReasonClass {
  return reason === DEMOTE_REASON.LOGIN_DID_NOT_SIGN_IN ? "login-did-not-sign-in" : "other";
}

export interface SuiteStorePort {
  /** Puts the stored suite into the working copy, after a checkout and before the project setup. A store with nothing in it restores nothing. */
  restore(root: SuiteRoot): Promise<SuiteRestoreResult>;
  /** The sha256 of the bytes each of these specs holds now, keyed by its normalized path; a spec that cannot be read confined is left out. Taken right after the run that executed them, it is the evidence a capture requires. */
  fingerprint(root: SuiteRoot, specs: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Replaces the stored suite with what an accepted run left. The caller calls it only after `restore` of the same run succeeded: a path the working copy lacks is read as deleted. */
  capture(input: SuiteCaptureInput): Promise<SuiteCaptureResult>;
  /** Marks the stored login as one that no longer works and takes it out of the working copy, so the project setup seeds the stock one again. */
  demoteAuth(root: SuiteRoot, reason: string): Promise<void>;
}

/* Why a capture left a file out, in the words the result carries; the trace classifies a reason by these (suite-store-trace.ts). A reason of the confined reader (a link, a pipe, a file over the cap) is its own. */
export const SKIP_REASON = {
  VANISHED: "the file vanished during the capture",
  SESSION_STATE: "login session (storage state)",
  CHANGED_AFTER_RUN: "changed after it ran green: these bytes never executed",
  NOT_VERIFIED_LOGIN: "not the login that signed in",
} as const;

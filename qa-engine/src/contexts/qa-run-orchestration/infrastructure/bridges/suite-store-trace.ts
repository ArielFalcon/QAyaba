/*
 * The suite store as spans: `qayaba.suite_store.restore`, `.capture` and `.demote`, children of the phase that is open, with the counts each call
 * returns. A decorator: what the store returns, and what it throws, is returned and thrown as it was.
 *
 * It also tells the login span of the same run two facts the store alone knows (that the login in use was restored, and that a restored login
 * was demoted), through run-auth-notes.ts, since the login adapter has no other way to learn them.
 */

import { noteSuiteAuth } from "../../../../shared-infrastructure/telemetry/run-auth-notes.ts";
import { startRunChildSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import { SKIP_REASON, type SuiteCaptureInput, SuiteCaptureResult, SuiteRestoreResult, SuiteRoot, SuiteStorePort } from "../../../../shared-kernel/ports/suite-store.port.ts";
import type { TelemetryPort } from "../../../../shared-kernel/telemetry/telemetry.port.ts";

export const SKIP_CLASS = ["login-session", "changed-after-run", "login-not-verified", "vanished", "unreadable"] as const;
export type SkipClass = (typeof SKIP_CLASS)[number];

/* A skip reason as a member of a closed set: the store's own reasons by their constants, and every other (a reason of the confined reader) as unreadable, so no free text is a label. */
export function classifySkipReason(reason: string): SkipClass {
  switch (reason) {
    case SKIP_REASON.SESSION_STATE:
      return "login-session";
    case SKIP_REASON.CHANGED_AFTER_RUN:
      return "changed-after-run";
    case SKIP_REASON.NOT_VERIFIED_LOGIN:
      return "login-not-verified";
    case SKIP_REASON.VANISHED:
      return "vanished";
    default:
      return "unreadable";
  }
}

export class TracedSuiteStore implements SuiteStorePort {
  constructor(
    private readonly inner: SuiteStorePort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async restore(root: SuiteRoot): Promise<SuiteRestoreResult> {
    const span = startRunChildSpan(this.telemetry, "qayaba.suite_store.restore");
    try {
      const result = await this.inner.restore(root);
      span.setAttrs({
        "qayaba.suite_store.restored": result.restored,
        "qayaba.suite_store.overlaid": result.overlaid,
        "qayaba.suite_store.tracked_wins": result.trackedWins,
        "qayaba.suite_store.auth_restored": result.authRestored,
      });
      if (result.authRestored) noteSuiteAuth((notes) => { notes.restored = true; });
      span.end();
      return result;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  }

  fingerprint(root: SuiteRoot, specs: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return this.inner.fingerprint(root, specs);
  }

  async capture(input: SuiteCaptureInput): Promise<SuiteCaptureResult> {
    const span = startRunChildSpan(this.telemetry, "qayaba.suite_store.capture");
    try {
      const result = await this.inner.capture(input);
      const reasons = [...new Set(result.skipped.map((s) => classifySkipReason(s.reason)))];
      span.setAttrs({
        "qayaba.suite_store.entries": result.entries,
        "qayaba.suite_store.admitted": result.admitted,
        "qayaba.suite_store.dropped": result.dropped,
        "qayaba.suite_store.skipped": result.skipped.length,
        ...(reasons.length > 0 ? { "qayaba.suite_store.skip_reasons": reasons } : {}),
      });
      span.end();
      return result;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  }

  async demoteAuth(root: SuiteRoot, reason: string): Promise<void> {
    const span = startRunChildSpan(this.telemetry, "qayaba.suite_store.demote", { "qayaba.suite_store.reason": reason });
    try {
      await this.inner.demoteAuth(root, reason);
      noteSuiteAuth((notes) => {
        notes.restored = false;
        notes.demotedReason = reason;
      });
      span.end();
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  }
}

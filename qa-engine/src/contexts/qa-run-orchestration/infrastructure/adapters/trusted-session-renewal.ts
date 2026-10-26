/*
 * The renewal of the saved session that an authoring tool (run_spec, the authenticated browser) may ask for when a call ends on the
 * login page. Renewing runs the app's login script, `auth.setup.ts`, in the sandbox with the test account in its environment (the
 * login profile). That file is the agent's to rewrite while it authors, so a renewal asked for from inside the authoring loop must
 * never run what the agent wrote: it runs the login only as it stood when the loop opened (the stock seed, or the login a verified
 * run stored and the suite store restored, both settled before the agent's first turn), and only a bounded number of times. Anything
 * else is a lost session, which the tool reports; the run's own login phase renews it between phases, from the same file, outside
 * the loop. The comparison is by the sha256 of the bytes read strictly, so a link, a pipe or an oversized file is never a login.
 */

import { createHash } from "node:crypto";
import { MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import type { SessionRenewalPort } from "@contexts/test-execution/application/index.ts";
import type { AuthSessionContext, AuthSessionPort } from "../../application/ports/auth-session.port.ts";

const LOGIN_SCRIPT = "auth.setup.ts";

/* What the login script is: its sha256, "absent" when there is none, or undefined when it cannot be vouched for (a link, a pipe, over the cap, unreadable). */
function loginScriptState(specDir: string): string | undefined {
  try {
    const read = readOwnedSpecFile({ mirrorDir: specDir, specDir }, LOGIN_SCRIPT, MAX_SPEC_SOURCE_BYTES);
    if ("absent" in read) return "absent";
    if ("reason" in read) return undefined;
    return createHash("sha256").update(read.bytes).digest("hex");
  } catch {
    return undefined;
  }
}

export function trustedSessionRenewal(authSession: AuthSessionPort, context: AuthSessionContext, specDir: string, maxRenewals: number): SessionRenewalPort {
  const trusted = loginScriptState(specDir);
  let renewals = 0;
  return {
    renew: async (signal) => {
      if (renewals >= maxRenewals) {
        console.warn(`[qa] the saved session was lost again and was not renewed: this run already renewed it ${renewals} time(s) from inside the authoring loop`);
        return false;
      }
      if (trusted === undefined || loginScriptState(specDir) !== trusted) {
        console.warn("[qa] the saved session was lost and was not renewed: the login script is not the one the loop opened with, and a login the agent may have written is never run while it authors");
        return false;
      }
      renewals += 1;
      try {
        await authSession.prepare({ specDir, baseUrl: context.baseUrl, ...(context.auth ? { auth: context.auth } : {}), phase: "pre-execute" }, signal);
        return true;
      } catch (err) {
        console.error(`[qa] renewing the saved session from the authoring loop failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
  };
}

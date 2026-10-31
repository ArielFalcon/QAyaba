/*
 * The check of a saved session by the orchestrator's own browser: each path is opened by a navigation, with the session as it is saved
 * now, and where the app sent it is judged by the rule the authenticated browser uses for "session invalidated" (sent to a login page,
 * a 401 document, a password field on a page other than the one asked for: `detectInvalidation`). A page asked for that opens where it
 * was asked says nothing against the session, whatever its path or form looks like. The browser holds the test account's lease while
 * it reads, starts for the check and is closed after it; it only navigates (reads), through the route guard its host was built with.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { AccountLock } from "../domain/account-lock.ts";
import { detectInvalidation } from "../domain/agent-browser-session-invalidation.ts";
import type { AgentBrowserHostPort } from "./ports/agent-browser-host.port.ts";
import type { SessionCheck, SessionCheckPort } from "./ports/session-check.port.ts";

/* The one page of the check's browser. */
const CHECK_PAGE = "session-check";

/* The most a check opens: the pages the failing tests asked for, never a crawl. */
export const MAX_SESSION_CHECK_PATHS = 3;

export interface BrowserSessionCheckDeps {
  host: AgentBrowserHostPort;
  baseUrl: string;
  /* The app's declared login path (auth.loginPath), believed whatever led to it. */
  loginPath?: string;
  lock: AccountLock;
  account: string;
  /* The time one page may take to open. */
  perPageMs: number;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class BrowserSessionCheck implements SessionCheckPort {
  constructor(private readonly deps: BrowserSessionCheckDeps) {}

  async check(paths: readonly string[], signal?: AbortSignal): Promise<SessionCheck> {
    const asked = [...new Set(paths)].filter((path) => path.startsWith("/")).slice(0, MAX_SESSION_CHECK_PATHS);
    const pages = asked.length > 0 ? asked : ["/"];
    try {
      return await this.deps.lock.withLock(this.deps.account, () => this.read(pages, signal), signal);
    } catch (err) {
      return { state: "unknown", reason: `the check could not run: ${messageOf(err)}` };
    } finally {
      await this.deps.host.close().catch((err: unknown) => engineLog.error(`[qa] closing the session check's browser failed: ${messageOf(err)}`));
    }
  }

  private async read(pages: readonly string[], signal: AbortSignal | undefined): Promise<SessionCheck> {
    const { host, baseUrl, loginPath, perPageMs } = this.deps;
    const unread: string[] = [];
    for (const path of pages) {
      const callSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(perPageMs)]);
      try {
        const state = await host.perform(CHECK_PAGE, { kind: "navigate", url: new URL(path, baseUrl).toString() }, { signal: callSignal, timeoutMs: perPageMs });
        const lost = detectInvalidation(
          { url: state.url, requestedPath: state.requestedPath, viaNavigation: true, passwordFieldVisible: state.passwordFieldVisible, ...(state.documentStatus !== undefined ? { documentStatus: state.documentStatus } : {}) },
          { ...(loginPath !== undefined ? { loginPath } : {}) },
        );
        if (lost) return { state: "lost", detail: lost.detail };
      } catch (err) {
        unread.push(`${path} (${messageOf(err).split("\n")[0]})`);
      }
    }
    return unread.length === pages.length ? { state: "unknown", reason: `no page could be read: ${unread.join(", ")}` } : { state: "held" };
  }
}

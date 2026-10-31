/*
 * SessionCheckPort → a browser of the orchestrator's own, built for one check over the run's launcher and the saved session as it
 * stands now (read from the run's auth directory, as the authenticated browser reads it), behind a route guard that admits the run's
 * origins and no write. It is the authenticated browser's machinery and rule, used by the orchestrator for itself: no agent reaches
 * it. Called inside the run (its sandbox scope and its auth directory are the active ones). A run with no saved session has nothing to
 * check, and says so instead of opening the app signed out.
 */

import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { originOf } from "../../../../shared-kernel/egress-policy.ts";
import { BrowserSessionCheck, createRouteGuard, type AccountLock, type AgentBrowserHostPort, type BrowserLauncherPort, type SessionCheck, type SessionCheckPort, type SessionMaterial } from "@contexts/test-execution/application/index.ts";

/* The time one page of the check may take to open. */
export const SESSION_CHECK_PAGE_MS = 30_000;

export interface SessionCheckAdapterDeps {
  baseUrl: string;
  launcher: BrowserLauncherPort;
  createHost: (parts: { launcher: BrowserLauncherPort; material: () => Promise<SessionMaterial>; guard: ReturnType<typeof createRouteGuard> }) => AgentBrowserHostPort;
  /* The run's saved session, read into memory; called inside the run's scope. */
  material: () => SessionMaterial;
  /* Routes of the app no browser of the orchestrator opens (qa.agentBrowser.denyRoutes). */
  denyRoutes: readonly string[];
  account: string;
  lock: AccountLock;
  loginPath?: string;
}

export class SessionCheckAdapter implements SessionCheckPort {
  constructor(private readonly deps: SessionCheckAdapterDeps) {}

  async check(paths: readonly string[], signal?: AbortSignal): Promise<SessionCheck> {
    const material = this.deps.material();
    if (material.storageState === undefined) return { state: "unknown", reason: "the run holds no saved session to check" };
    const origins = activeExecScope()?.egress.dev;
    const guard = createRouteGuard({
      origins: origins !== undefined && origins.length > 0 ? origins : [originOf(this.deps.baseUrl) ?? this.deps.baseUrl],
      denyRoutes: this.deps.denyRoutes,
      allowMutating: [],
    });
    const host = this.deps.createHost({ launcher: this.deps.launcher, material: async () => material, guard });
    const check = new BrowserSessionCheck({
      host,
      baseUrl: this.deps.baseUrl,
      ...(this.deps.loginPath !== undefined ? { loginPath: this.deps.loginPath } : {}),
      lock: this.deps.lock,
      account: this.deps.account,
      perPageMs: SESSION_CHECK_PAGE_MS,
    });
    return check.check(paths, signal);
  }
}

/*
 * AgentBrowserPort → the authenticated browser of one run. Opened inside the run (so the run's sandbox scope and its secret
 * scope are the ones active), it keeps a capability for the run, builds the browser's host over the run's origins and
 * the app's route lists, registers both where the authoring agents' sessions will find them, and serves every call inside a
 * snapshot of that run's async context: the HTTP request that brings a call in has no scope of its own, and the browser must
 * start in this run's sandbox and have this run's secrets taken out of what it reports.
 * A run is granted the browser only when it is enabled (the app's setting, or the run's own choice), the generator's runtime
 * can call a custom tool, and the run has a saved session to use. The browser is started by the first call, not by the grant.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS } from "@kernel/agent-browser.ts";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { originOf } from "../../../../shared-infrastructure/egress/egress-policy.ts";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { AgentBrowserCapability } from "@contexts/test-execution/domain/agent-browser-capability.ts";
import { createRouteGuard } from "@contexts/test-execution/domain/agent-browser-route-guard.ts";
import { AgentBrowserUseCase } from "@contexts/test-execution/application/agent-browser.use-case.ts";
import type { AgentBrowserHostPort } from "@contexts/test-execution/application/ports/agent-browser.ports.ts";
import { PlaywrightAgentBrowserHost } from "@contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host.ts";
import type { BrowserLauncherPort, SessionMaterial } from "@contexts/test-execution/infrastructure/agent-browser/playwright-types.ts";
import type { AuthSessionContext, AuthSessionPort } from "../../application/ports/auth-session.port.ts";
import type { AgentBrowserHandle, AgentBrowserOpenInput, AgentBrowserPort } from "../../application/ports/index.ts";
import type { AgentBrowserRegistry } from "../agent-browser-registry.ts";
import { trustedSessionRenewal } from "./trusted-session-renewal.ts";

/* How long a capability lives when the run has no deadline armed: far beyond any run, and only a backstop to the revocation the run does itself. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface AgentBrowserPortAdapterDeps {
  registry: AgentBrowserRegistry;
  /* The app's own setting (qa.agentBrowser). */
  setting: { enabled: boolean; denyRoutes: readonly string[]; allowMutating: readonly string[] };
  /* Whether the generator role runs on a runtime that can call a custom tool (OpenCode; never Codex). Read at each open: the runtime is switchable. */
  generatorRuntimeCanCall: () => boolean;
  baseUrl: string;
  /* The run's saved session, read into memory; called inside the run's scope. */
  material: () => SessionMaterial;
  launcher: BrowserLauncherPort;
  /* Test seam: the host the calls are served by. Absent: the Playwright host over `launcher`. */
  createHost?: (parts: { launcher: BrowserLauncherPort; material: () => Promise<SessionMaterial>; guard: ReturnType<typeof createRouteGuard> }) => AgentBrowserHostPort;
  /* With the context: signs in again when a call finds the session gone. Absent: a lost session is only reported. */
  authSession?: AuthSessionPort;
  authContext?: AuthSessionContext;
  /* The key two users of one test account contend on, and the process-wide lock they contend through. */
  account: string;
  lock: AccountLock;
  loginPath?: string;
  deadline?: RunDeadlineView;
  /* Takes the run's secrets out of any text that leaves; called inside the run's scope. */
  redact: (text: string) => string;
  now?: () => number;
}

/* The renewal the use case asks for: a sign-in again for the run's suite, only with the login the loop opened with and at most twice per run (trusted-session-renewal.ts). */
export const MAX_AGENT_BROWSER_RENEWALS = 2;

export class AgentBrowserPortAdapter implements AgentBrowserPort {
  constructor(private readonly deps: AgentBrowserPortAdapterDeps) {}

  async open(input: AgentBrowserOpenInput): Promise<AgentBrowserHandle | undefined> {
    const enabled = input.enabled ?? this.deps.setting.enabled;
    if (!enabled) return undefined;
    if (!this.deps.generatorRuntimeCanCall()) {
      console.warn(`[qa] the authenticated browser is enabled for run ${input.runId} but the generator's runtime cannot call a custom tool (only OpenCode can); the run goes on with run_spec alone, if it has it`);
      return undefined;
    }
    const probe = this.deps.material();
    if (probe.storageState === undefined && probe.clientCertificate === undefined) {
      console.warn(`[qa] the authenticated browser is enabled for run ${input.runId} but the run has no saved session to use (a public app, or a login that did not complete); the run goes on without it`);
      return undefined;
    }

    const now = this.deps.now ?? Date.now;
    const left = this.deps.deadline?.remainingMs();
    const capability = new AgentBrowserCapability({
      runId: input.runId,
      limits: DEFAULT_AGENT_BROWSER_LIMITS,
      expiresAtMs: now() + (left !== undefined && left > 0 ? left : DEFAULT_TTL_MS),
      now,
    });
    const origins = activeExecScope()?.egress.dev;
    const guard = createRouteGuard({
      origins: origins !== undefined && origins.length > 0 ? origins : [originOf(this.deps.baseUrl) ?? this.deps.baseUrl],
      denyRoutes: this.deps.setting.denyRoutes,
      allowMutating: this.deps.setting.allowMutating,
    });
    /* The run's async context as it is now: the run's sandbox scope and its secret scope. The browser starts, and the session is read, inside it. */
    const inRunContext = AsyncLocalStorage.snapshot();
    const hostParts = { launcher: this.deps.launcher, material: async () => inRunContext(() => this.deps.material()), guard };
    const host = this.deps.createHost ? this.deps.createHost(hostParts) : new PlaywrightAgentBrowserHost(hostParts);
    const useCase = new AgentBrowserUseCase({
      capability,
      host,
      baseUrl: this.deps.baseUrl,
      guard,
      account: this.deps.account,
      lock: this.deps.lock,
      ...(this.deps.authSession && this.deps.authContext ? { session: trustedSessionRenewal(this.deps.authSession, this.deps.authContext, input.specDir, MAX_AGENT_BROWSER_RENEWALS) } : {}),
      ...(this.deps.loginPath !== undefined ? { loginPath: this.deps.loginPath } : {}),
      ...(this.deps.deadline ? { deadline: this.deps.deadline } : {}),
      redact: this.deps.redact,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    /* A call belongs to its session: when the session ends nobody reads the answer, and a browser action left running would hold the account. */
    const running = new Map<string, Set<AbortController>>();
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      capability.revoke();
      this.deps.registry.unregister(input.runId);
      for (const controllers of running.values()) for (const controller of controllers) controller.abort();
      await inRunContext(() => host.close()).catch((err: unknown) => {
        console.error(`[qa] closing the agent browser failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    this.deps.registry.register({
      runId: input.runId,
      capability,
      call: async (request) => {
        const own = new AbortController();
        const mine = running.get(request.sessionId) ?? new Set<AbortController>();
        mine.add(own);
        running.set(request.sessionId, mine);
        try {
          return await inRunContext(() => useCase.call(request, own.signal));
        } finally {
          mine.delete(own);
          if (mine.size === 0) running.delete(request.sessionId);
        }
      },
      endSession: (sessionId) => {
        for (const controller of running.get(sessionId) ?? []) controller.abort();
        void host.release?.(sessionId);
      },
      close,
    });
    return { limits: capability.limits, grantShare: (delegationId, calls) => capability.setShare(delegationId, calls), signals: () => capability.signal, close };
  }
}

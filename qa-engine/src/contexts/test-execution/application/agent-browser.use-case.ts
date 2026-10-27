/*
 * One `authbrowser_*` call: an authoring agent asks the orchestrator's browser, which holds the run's saved session, to open
 * a page, read it, click or type. Nothing the agent controls decides a limit: whether the session may call, how many calls
 * the run has, what the browser may request and when the session counts as lost are all decided here and in the guard, and the
 * agent never sees a cookie. Each call holds the test account for its duration, so it never interleaves with a spec the
 * run_spec tool or the suite is executing as the same account.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";
import type { RunDeadlineView } from "@kernel/run-deadline.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import type { AccountLock } from "../domain/account-lock.ts";
import { AGENT_BROWSER_REFUSAL, type AgentBrowserCapability, type AgentBrowserRefusalCode } from "../domain/agent-browser-capability.ts";
import type { RouteGuard } from "../domain/agent-browser-route-guard.ts";
import { detectInvalidation } from "../domain/agent-browser-session-invalidation.ts";
import type { AgentBrowserHostPort } from "./ports/agent-browser-host.port.ts";
import type { BlockedRequest, BrowserAction, ObservedRequests, PageState } from "../domain/agent-browser-host.ts";
import { BrowserActionError } from "../domain/agent-browser-host.ts";
import type { SessionRenewalPort } from "./ports/session-renewal.port.ts";
import type { CallObserver } from "./run-spec.use-case.ts";

export const MAX_SNAPSHOT_CHARS = 12_000;
export const MAX_URL_CHARS = 2_000;
export const MAX_TYPED_CHARS = 2_000;
export const MAX_REPORTED_BLOCKS = 5;
/* Said to the agent when the run's calls are about to run out. */
export const LOW_CALLS = 10;
const REF = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

export type AgentBrowserRequest = { sessionId: string; agent: string; /* The assistant message the tool reported; it only joins this call to the agent's own span of it. */ messageId?: string } & (
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; submit?: boolean }
);

export interface AgentBrowserBudget {
  callsLeft: number;
}

export interface AgentBrowserPageReport {
  url: string;
  title: string;
  snapshot: string;
  truncated?: true;
}

export type AgentBrowserResponse =
  | { ok: true; page: AgentBrowserPageReport; blocked: BlockedRequest[]; requests: ObservedRequests; notes: string[]; budget: AgentBrowserBudget }
  | { ok: false; code: AgentBrowserRefusalCode; message: string; budget: AgentBrowserBudget };

export interface AgentBrowserDeps {
  capability: AgentBrowserCapability;
  host: AgentBrowserHostPort;
  /* The app's address: a path is resolved against it. */
  baseUrl: string;
  guard: RouteGuard;
  /* The key two users of one test account contend on. */
  account: string;
  lock: AccountLock;
  /* Absent: a lost session is only reported. */
  session?: SessionRenewalPort;
  /* The app's login path, when it declares one. */
  loginPath?: string;
  deadline?: RunDeadlineView;
  /* Where a session's authoring scope is, when the run declares a location: the action runs there. */
  location?: (sessionId: string) => GeoLocation | undefined;
  /* Takes the run's secrets out of any text that leaves; the run's own scope must be active when it is called. */
  redact: (text: string) => string;
  /* A signal that fires once a call has waited this long for the account. Defaults to a timer. */
  leaseWaitSignal?: (ms: number) => AbortSignal;
  signal?: AbortSignal;
  /* The clock the wait for the account is measured on. Default: the system clock. */
  now?: () => number;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return cut(url.split(/[?#]/)[0] ?? "", 500);
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export class AgentBrowserUseCase {
  constructor(private readonly deps: AgentBrowserDeps) {}

  /* `callSignal` is this call's own cancellation (its session ended); the run's cancellation stops it too. */
  async call(request: AgentBrowserRequest, callSignal?: AbortSignal, observe?: CallObserver): Promise<AgentBrowserResponse> {
    const { capability } = this.deps;
    const tell = (attrs: Attrs): void => {
      try {
        observe?.setAttrs(attrs);
      } catch {
        /* observing never changes the call */
      }
    };
    const stop = callSignal && this.deps.signal ? AbortSignal.any([callSignal, this.deps.signal]) : (callSignal ?? this.deps.signal);
    const refused = capability.authorize(request.sessionId, request.agent);
    if (refused) return this.refusal(refused.code, refused.message, request.sessionId);

    const action = this.actionOf(request);
    if ("message" in action) return this.refusal(AGENT_BROWSER_REFUSAL.INVALID_REQUEST, action.message, request.sessionId);
    tell({ "qayaba.browser.action": action.kind });
    if (action.kind === "navigate") {
      const decision = this.deps.guard.decide({ method: "GET", url: action.url });
      if (!decision.allow) {
        tell({ "qayaba.browser.blocks": 1, "qayaba.browser.block_reasons": [decision.reason] });
        capability.recordBlocks(1);
        return this.refusal(AGENT_BROWSER_REFUSAL.BLOCKED, `${decision.detail}; the browser does not open it`, request.sessionId);
      }
    }

    const reservation = capability.reserve(request.sessionId);
    if (!reservation.ok) return this.refusal(reservation.code, reservation.message, request.sessionId);

    const waitSignal = AbortSignal.any([...(stop ? [stop] : []), (this.deps.leaseWaitSignal ?? AbortSignal.timeout.bind(AbortSignal))(capability.limits.leaseWaitMs)]);
    /* Whether the call got the account and began: one that did not is given back, not spent. */
    let began = false;
    const now = this.deps.now ?? Date.now;
    const asked = now();
    let waited = false;
    try {
      return await this.deps.lock.withLock(
        this.deps.account,
        async () => {
          waited = true;
          tell({ "qayaba.lease.wait_ms": Math.max(0, now() - asked) });
          /* What was true when the call asked may not be true when it gets the account: the run may have ended or run out of time. */
          const gone = capability.authorize(request.sessionId, request.agent);
          if (gone) return this.refusal(gone.code, gone.message, request.sessionId);
          began = true;
          return this.perform(request.sessionId, action, stop, tell);
        },
        waitSignal,
      );
    } catch (err) {
      if (stop?.aborted) return this.refusal(AGENT_BROWSER_REFUSAL.FAILED, "the call was cancelled", request.sessionId);
      if (waitSignal.aborted) return this.refusal(AGENT_BROWSER_REFUSAL.BUSY, "DEV busy: the test account is in use by another step of this run; try again in a moment", request.sessionId);
      engineLog.error(`[qa] authenticated browser call ${reservation.callNumber} failed in the harness: ${err instanceof Error ? err.message : String(err)}`);
      return this.refusal(AGENT_BROWSER_REFUSAL.FAILED, "the browser could not complete the call", request.sessionId);
    } finally {
      if (!waited) tell({ "qayaba.lease.wait_ms": Math.max(0, now() - asked) });
      if (!began) capability.refund(request.sessionId);
    }
  }

  private async perform(sessionId: string, action: BrowserAction, stop: AbortSignal | undefined, tell: (attrs: Attrs) => void): Promise<AgentBrowserResponse> {
    const { capability, host } = this.deps;
    const timeoutMs = Math.min(capability.limits.perCallMs, this.deps.deadline?.remainingMs() ?? Number.POSITIVE_INFINITY);
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(Math.max(1, timeoutMs))]);
    const geolocation = this.deps.location?.(sessionId);
    let state: PageState;
    try {
      state = await host.perform(sessionId, action, { signal, timeoutMs, ...(geolocation ? { geolocation } : {}), ...(capability.isReadOnly(sessionId) ? { readOnly: true } : {}) });
    } catch (err) {
      if (err instanceof BrowserActionError) return this.refusal(AGENT_BROWSER_REFUSAL.FAILED, err.message, sessionId);
      engineLog.error(`[qa] authenticated browser action failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.refusal(AGENT_BROWSER_REFUSAL.FAILED, "the browser could not complete the call", sessionId);
    }

    capability.recordBlocks(state.blocked.length);
    tell({
      ...(state.documentStatus !== undefined ? { "http.response.status_code": state.documentStatus } : {}),
      "qayaba.browser.blocks": state.blocked.length,
      ...(state.blocked.length > 0 ? { "qayaba.browser.block_reasons": [...new Set(state.blocked.map((b) => b.reason))] } : {}),
    });
    const lost = detectInvalidation(
      { url: state.url, requestedPath: state.requestedPath, viaNavigation: action.kind === "navigate", passwordFieldVisible: state.passwordFieldVisible, ...(state.documentStatus !== undefined ? { documentStatus: state.documentStatus } : {}) },
      { ...(this.deps.loginPath !== undefined ? { loginPath: this.deps.loginPath } : {}) },
    );
    if (lost) return this.invalidated(sessionId, lost.detail, signal, tell);
    this.noteRead(sessionId, state.url);
    return this.report(state, sessionId);
  }

  private async invalidated(sessionId: string, detail: string, signal: AbortSignal, tell: (attrs: Attrs) => void): Promise<AgentBrowserResponse> {
    const { capability, host, session } = this.deps;
    let renewed: boolean | undefined;
    if (session && capability.canRenew()) {
      try {
        renewed = await session.renew(signal);
      } catch (err) {
        engineLog.error(`[qa] authenticated browser session renewal failed: ${err instanceof Error ? err.message : String(err)}`);
        renewed = false;
      }
      if (renewed) await host.reset();
    }
    capability.recordInvalidation(renewed);
    tell({ "qayaba.auth.invalidated": true, "qayaba.auth.renewed": renewed === true });
    const next = renewed
      ? "The session was renewed; navigate again to continue."
      : "The session could not be renewed; do not rely on this browser for the rest of the run and use what the task supplies.";
    return this.refusal(AGENT_BROWSER_REFUSAL.SESSION_INVALIDATED, `session invalidated: ${this.deps.redact(detail)}. ${next}`, sessionId);
  }

  /* The page the browser showed, by its path, goes to the session's ledger; an address that cannot be read as one leaves no entry. */
  private noteRead(sessionId: string, url: string): void {
    try {
      this.deps.capability.recordRead(sessionId, new URL(url).pathname);
    } catch {
      /* nothing was shown at an address that is not one */
    }
  }

  private report(state: PageState, sessionId: string): AgentBrowserResponse {
    const { redact, capability } = this.deps;
    const truncated = state.snapshot.length > MAX_SNAPSHOT_CHARS;
    const notes = [...state.notes.map(redact)];
    if (truncated) notes.push(`the page tree was cut at ${MAX_SNAPSHOT_CHARS} characters`);
    const left = capability.callsLeft(sessionId);
    if (left <= LOW_CALLS) notes.push(`${left} authenticated browser call(s) left`);
    return {
      ok: true,
      page: {
        url: redact(withoutQuery(state.url)),
        title: redact(cut(state.title, 300)),
        snapshot: redact(cut(state.snapshot, MAX_SNAPSHOT_CHARS)),
        ...(truncated ? { truncated: true as const } : {}),
      },
      blocked: state.blocked.slice(0, MAX_REPORTED_BLOCKS).map((b) => ({ reason: b.reason, detail: redact(b.detail) })),
      requests: this.requestsReport(state.requests),
      notes,
      budget: { callsLeft: left },
    };
  }

  /* The requests the page made, redacted like every other text that leaves. Two that read the same once redacted are one, with their counts added. */
  private requestsReport(seen: ObservedRequests): ObservedRequests {
    const { redact } = this.deps;
    const listed = new Map<string, ObservedRequests["listed"][number]>();
    for (const r of seen.listed) {
      const url = redact(r.url);
      const key = `${r.blocked ? "!" : ""}${r.method} ${url}`;
      const held = listed.get(key);
      if (held) held.count += r.count;
      else listed.set(key, { method: r.method, url, count: r.count, ...(r.blocked ? { blocked: true as const } : {}) });
    }
    const hosts = new Map<string, number>();
    for (const h of seen.otherHosts) {
      const host = redact(h.host);
      hosts.set(host, (hosts.get(host) ?? 0) + h.count);
    }
    return { listed: [...listed.values()], otherHosts: [...hosts].map(([host, count]) => ({ host, count })), omitted: seen.omitted };
  }

  /* A refusal, with the calls the asking session may still make. */
  private refusal(code: AgentBrowserRefusalCode, message: string, sessionId: string): AgentBrowserResponse {
    return { ok: false, code, message: this.deps.redact(message), budget: { callsLeft: this.deps.capability.callsLeft(sessionId) } };
  }

  /* The browser action a request names, or why it is not one. A navigation's address is resolved against the app's base. */
  private actionOf(request: AgentBrowserRequest): BrowserAction | { message: string } {
    const r = request as { action?: unknown; url?: unknown; ref?: unknown; text?: unknown; submit?: unknown };
    switch (r.action) {
      case "snapshot":
        return { kind: "snapshot" };
      case "navigate": {
        if (typeof r.url !== "string" || r.url.trim() === "" || r.url.length > MAX_URL_CHARS) return { message: `url must be a path or address of at most ${MAX_URL_CHARS} characters` };
        try {
          return { kind: "navigate", url: new URL(r.url.trim(), this.deps.baseUrl).toString() };
        } catch {
          return { message: "url could not be read as an address" };
        }
      }
      case "click":
        if (typeof r.ref !== "string" || !REF.test(r.ref)) return { message: "ref must be one of the [ref=...] values of the last snapshot" };
        return { kind: "click", ref: r.ref };
      case "type":
        if (typeof r.ref !== "string" || !REF.test(r.ref)) return { message: "ref must be one of the [ref=...] values of the last snapshot" };
        if (typeof r.text !== "string" || r.text.length > MAX_TYPED_CHARS) return { message: `text must be a string of at most ${MAX_TYPED_CHARS} characters` };
        if (r.submit !== undefined && typeof r.submit !== "boolean") return { message: "submit must be a boolean" };
        return { kind: "type", ref: r.ref, text: r.text, submit: r.submit === true };
      default:
        return { message: "action must be navigate, snapshot, click or type" };
    }
  }
}

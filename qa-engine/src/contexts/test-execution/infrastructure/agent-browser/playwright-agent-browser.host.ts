/*
 * The orchestrator's browser for the authenticated agent tools. One browser process per run, one context in it, one page per
 * agent session. The context is built from the run's saved session held in memory: the cookies are handed to the browser as
 * data and are never written to a file, and nothing the browser refreshes is saved. Every request the context makes, scripts,
 * images, redirects and web sockets included, passes the route guard; service workers are blocked so that no page can answer
 * a request on its own and slip past it, and downloads are off. The surface is four actions (navigate, snapshot, click,
 * type): there is no way here to evaluate script, upload a file or inject anything, and an action outside the list is refused.
 * The module imports no file API on purpose (see the dependency rule): all it holds comes in through its dependencies.
 */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";
import type { GeoLocation } from "@kernel/geolocation.ts";
import { BrowserActionError, type BlockedRequest, type BrowserAction, type BrowserCallOptions, type PageState } from "../../domain/agent-browser-host.ts";
import { type AgentBrowserHostPort } from "../../application/ports/agent-browser-host.port.ts";
import type { RouteGuard } from "../../domain/agent-browser-route-guard.ts";
import type { BrowserLauncherPort, LaunchedBrowser, PwContext, PwContextOptions, PwPage, PwRequest, SessionMaterial } from "../../domain/playwright-types.ts";

const VIEWPORT = { width: 1280, height: 800 } as const;
/* The longest the browser waits for a page to go quiet after a click or a keypress; a page that never does is reported as it is. */
const SETTLE_MS = 2_000;
/* Blocks kept between two reports. */
const MAX_PENDING_BLOCKS = 50;

/*
 * Runs in every document of the context. Playwright's own `serviceWorkers: "block"` swaps `register` on the page's
 * `navigator.serviceWorker` for a stub; this does the same on the prototype, so reaching for the original through the
 * prototype chain finds the stub too. A page can still get a pristine one from a fresh frame, which is why the route guard,
 * the egress filter and the session's own rights stay the limits: this only closes the obvious door.
 */
export const BLOCK_SERVICE_WORKERS_SCRIPT = `(() => {
  try {
    if (typeof ServiceWorkerContainer === "undefined") return;
    Object.defineProperty(ServiceWorkerContainer.prototype, "register", { value: async () => { console.warn("Service Worker registration is blocked"); }, writable: false, configurable: false });
  } catch (_) {}
})();`;

interface PageEntry {
  page: PwPage;
  /* The last address the app itself served: where a page left on the browser's error page is reopened. */
  lastGoodUrl: string | undefined;
  blocked: BlockedRequest[];
  notes: string[];
  status: number | undefined;
  /* The session's role never writes to DEV: its page's requests are judged without the app's allowMutating entries. */
  readOnly: boolean;
}

export interface PlaywrightAgentBrowserHostDeps {
  launcher: BrowserLauncherPort;
  /* The session as it is saved now. Read each time a context is built, so a renewed login is picked up. */
  material: () => Promise<SessionMaterial>;
  guard: RouteGuard;
  /* The app's declared default: the context opens at it, with the permission granted. Absent: no location is set. */
  geolocation?: GeoLocation;
  now?: () => number;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

/* The first line of a Playwright error, without its `page.x:` prefix, its call log or the address it carries a query in. */
function readable(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const first = (text.split("\n")[0] ?? "").replace(/^[A-Za-z]+\.[A-Za-z]+: /, "").replace(/\?[^\s)]*/g, "");
  return first.slice(0, 200);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || /^Timeout \d+ms exceeded/.test(err.message));
}

export class PlaywrightAgentBrowserHost implements AgentBrowserHostPort {
  private launched: LaunchedBrowser | undefined;
  private context: PwContext | undefined;
  private building: Promise<PwContext> | undefined;
  private readonly entries = new Map<string, PageEntry>();
  /* Sessions that had a page a reset or a crash took away: their next page is new, and they are told. */
  private readonly lostPages = new Set<string>();
  private readonly byPage = new WeakMap<PwPage, PageEntry>();
  /* Blocks and notes no page could be told of (a request of a page that is gone, a tab closed on its own). */
  private readonly loose: { blocked: BlockedRequest[]; notes: string[] } = { blocked: [], notes: [] };
  private creatingPage = false;
  private closed = false;
  /* Counts the times what is being built stopped being the thing wanted (a reset, a browser that died): a build that finds it moved on discards what it made. */
  private epoch = 0;
  private readonly now: () => number;

  constructor(private readonly deps: PlaywrightAgentBrowserHostDeps) {
    this.now = deps.now ?? Date.now;
  }

  async perform(sessionId: string, action: BrowserAction, options: BrowserCallOptions): Promise<PageState> {
    const kind = (action as { kind?: unknown }).kind;
    if (kind !== "navigate" && kind !== "snapshot" && kind !== "click" && kind !== "type") throw new BrowserActionError("this browser can navigate, snapshot, click and type, and nothing else");
    if (this.closed) throw new BrowserActionError("the browser is closed: the run it belonged to has ended");
    const deadline = this.now() + options.timeoutMs;
    const remaining = (): number => {
      if (options.signal.aborted) throw new BrowserActionError("the call ran out of time or was cancelled");
      return Math.max(500, deadline - this.now());
    };
    remaining();
    const entry = await this.entryFor(sessionId);
    entry.status = undefined;
    entry.readOnly = options.readOnly === true;
    const requestedPath = action.kind === "navigate" ? pathOf(action.url) : pathOf(entry.page.url());
    try {
      /* The context is shared by every session; the call holds the account, so setting the caller's location here cannot race another session's. */
      if (options.geolocation) await this.context?.setGeolocation(options.geolocation);
      switch (action.kind) {
        case "navigate":
          await this.navigate(entry, action.url, remaining);
          break;
        case "click":
          await this.click(entry, action.ref, remaining);
          break;
        case "type":
          await this.type(entry, action.ref, action.text, action.submit, remaining);
          break;
        case "snapshot":
          break;
      }
    } catch (err) {
      if (err instanceof BrowserActionError) throw err;
      if (action.kind === "navigate" && entry.blocked.length > 0) {
        /* The guard stopped the navigation: what it stopped is the answer. */
      } else {
        throw new BrowserActionError(this.failure(action, err));
      }
    }
    const state = await this.observe(entry, requestedPath, remaining);
    return (await this.reopenIfBlocked(entry, state, requestedPath, remaining)) ?? state;
  }

  async reset(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.building = undefined;
    this.epoch += 1;
    this.forgetPages();
    if (context) await context.close().catch(() => undefined);
  }

  async release(sessionId: string): Promise<void> {
    this.lostPages.delete(sessionId);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.byPage.delete(entry.page);
    await entry.page.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const launched = this.launched;
    this.launched = undefined;
    await this.reset();
    if (launched) await this.stop(launched);
  }

  /* Every page goes with its context. A reset on one session's account of the login renews the session for all of them, so the sessions that had a page are remembered, to be told when they get a new one. */
  private forgetPages(): void {
    for (const [sessionId, entry] of this.entries) {
      this.byPage.delete(entry.page);
      this.lostPages.add(sessionId);
    }
    this.entries.clear();
  }

  /* Stops a browser and its process; never throws. */
  private async stop(launched: LaunchedBrowser): Promise<void> {
    await launched.browser.close().catch(() => undefined);
    await launched.dispose().catch(() => undefined);
  }

  /* The browser process died or its connection closed: everything built on it is gone, so the next call builds anew. */
  private async lost(launched: LaunchedBrowser): Promise<void> {
    if (this.launched !== launched) return;
    this.launched = undefined;
    this.epoch += 1;
    this.context = undefined;
    this.building = undefined;
    this.forgetPages();
    engineLog.error("[qa] the agent browser disconnected; the next call starts a new one");
    await this.stop(launched);
  }

  private failure(action: BrowserAction, err: unknown): string {
    if (action.kind === "click" || action.kind === "type") {
      return isTimeout(err)
        ? `ref ${action.ref} was not found on the page or could not be acted on in time; take a snapshot and use a ref from it`
        : `ref ${action.ref} could not be acted on: ${readable(err)}`;
    }
    if (action.kind === "navigate") return `the page could not be opened: ${readable(err)}`;
    return `the page could not be read: ${readable(err)}`;
  }

  private async navigate(entry: PageEntry, url: string, remaining: () => number): Promise<void> {
    const response = await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (response) entry.status = response.status();
  }

  private async click(entry: PageEntry, ref: string, remaining: () => number): Promise<void> {
    await entry.page.locator(`aria-ref=${ref}`).click({ timeout: remaining() });
    await this.settle(entry, remaining);
  }

  private async type(entry: PageEntry, ref: string, text: string, submit: boolean, remaining: () => number): Promise<void> {
    const field = entry.page.locator(`aria-ref=${ref}`);
    if ((await field.getAttribute("type", { timeout: remaining() }))?.toLowerCase() === "password") {
      throw new BrowserActionError("this browser does not type into password fields");
    }
    await field.fill(text, { timeout: remaining() });
    if (submit) {
      await field.press("Enter", { timeout: remaining() });
      await this.settle(entry, remaining);
    }
  }

  /* A navigation the guard aborted leaves the page on the browser's own error page, which says nothing about the app. The page the agent was on is reopened (a read, judged by the guard like any other) and it is told. */
  private async reopenIfBlocked(entry: PageEntry, seen: PageState, requestedPath: string, remaining: () => number): Promise<PageState | undefined> {
    const back = entry.lastGoodUrl;
    if (!seen.url.startsWith("chrome-error:") || back === undefined) return undefined;
    try {
      await entry.page.goto(back, { waitUntil: "domcontentloaded", timeout: remaining() });
    } catch {
      return undefined;
    }
    const reopened = await this.observe(entry, requestedPath, remaining);
    return {
      ...reopened,
      blocked: [...seen.blocked, ...reopened.blocked],
      notes: [...seen.notes, `a blocked request ended the page on the browser's error page; ${pathOf(back)} was reopened, so take refs from this snapshot`, ...reopened.notes],
    };
  }

  private async settle(entry: PageEntry, remaining: () => number): Promise<void> {
    await entry.page.waitForLoadState("networkidle", { timeout: Math.min(remaining(), SETTLE_MS) }).catch(() => undefined);
  }

  private async observe(entry: PageEntry, requestedPath: string, remaining: () => number): Promise<PageState> {
    const page = entry.page;
    const [title, snapshot, passwords] = [
      await page.title().catch(() => ""),
      await page.ariaSnapshot({ mode: "ai", timeout: remaining() }).catch(() => ""),
      await page.locator('input[type="password"]:visible').count().catch(() => 0),
    ];
    const url = page.url();
    if (/^https?:/.test(url)) entry.lastGoodUrl = url;
    const blocked = [...this.loose.blocked.splice(0), ...entry.blocked.splice(0)];
    const notes = [...this.loose.notes.splice(0), ...entry.notes.splice(0)];
    return {
      url,
      title,
      snapshot,
      ...(entry.status !== undefined ? { documentStatus: entry.status } : {}),
      passwordFieldVisible: passwords > 0,
      requestedPath,
      blocked,
      notes,
    };
  }

  private async entryFor(sessionId: string): Promise<PageEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    if (this.entries.size >= MAX_SESSION_PAGES) throw new BrowserActionError(`at most ${MAX_SESSION_PAGES} sessions can hold a browser page at once in this run`);
    const context = await this.contextFor();
    this.creatingPage = true;
    let page: PwPage;
    try {
      page = await context.newPage();
    } finally {
      this.creatingPage = false;
    }
    const entry: PageEntry = { page, lastGoodUrl: undefined, blocked: [], notes: [], status: undefined, readOnly: false };
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) entry.status = response.status();
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
      entry.notes.push("a dialog the page raised was dismissed");
    });
    if (this.lostPages.delete(sessionId)) entry.notes.push("the browser was restarted (the saved session was renewed, or the browser stopped), so this is a new page: navigate to the address you need and take refs from a fresh snapshot");
    this.byPage.set(page, entry);
    this.entries.set(sessionId, entry);
    return entry;
  }

  private contextFor(): Promise<PwContext> {
    if (this.context) return Promise.resolve(this.context);
    if (this.building) return this.building;
    const building: Promise<PwContext> = this.build().catch((err: unknown) => {
      /* Only the build still wanted is forgotten: a reset or a crash may already have started the next one. */
      if (this.building === building) this.building = undefined;
      throw err;
    });
    this.building = building;
    return building;
  }

  private async build(): Promise<PwContext> {
    const epoch = this.epoch;
    const gone = (): BrowserActionError => new BrowserActionError(this.closed ? "the browser is closed: the run it belonged to has ended" : "the browser was restarted while it was starting; try again");
    /* Every await below can outlast a close or a reset: what was made before it is discarded, never left running. */
    const launched = this.launched ?? (await this.start());
    if (this.closed || this.epoch !== epoch) throw gone();
    const material = await this.deps.material();
    if (this.closed || this.epoch !== epoch) throw gone();
    const options: PwContextOptions = {
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { ...VIEWPORT },
      ...(material.storageState ? { storageState: material.storageState } : {}),
      ...(material.httpCredentials ? { httpCredentials: material.httpCredentials } : {}),
      ...(material.clientCertificate ? { clientCertificates: [material.clientCertificate] } : {}),
      ...(this.deps.geolocation ? { permissions: ["geolocation"], geolocation: this.deps.geolocation } : {}),
    };
    const context = await launched.browser.newContext(options);
    try {
      if (this.closed || this.epoch !== epoch) throw gone();
      await this.configure(context);
      if (this.closed || this.epoch !== epoch) throw gone();
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
    this.context = context;
    return context;
  }

  /* Starts the browser process. A browser that finished starting after the host was closed is stopped, not kept; one that is kept is watched for its death. */
  private async start(): Promise<LaunchedBrowser> {
    const launched = await this.deps.launcher.launch();
    if (this.closed) {
      await this.stop(launched);
      throw new BrowserActionError("the browser is closed: the run it belonged to has ended");
    }
    this.launched = launched;
    launched.browser.on?.("disconnected", () => void this.lost(launched));
    return launched;
  }

  private async configure(context: PwContext): Promise<void> {
    await context.addInitScript(BLOCK_SERVICE_WORKERS_SCRIPT);
    await context.route("**/*", async (route) => {
      /* Fails closed: whatever goes wrong while deciding, the request does not go out. */
      let allowed = false;
      try {
        const request = route.request();
        const decision = this.deps.guard.decide({ method: request.method(), url: request.url() }, { readOnly: this.requestIsReadOnly(request) });
        allowed = decision.allow;
        if (!decision.allow) this.recordBlock(request, decision.detail, decision.reason);
      } catch (err) {
        engineLog.error(`[qa] the agent browser could not judge a request, so it was blocked: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (allowed) await route.continue().catch(() => undefined);
      else await route.abort("blockedbyclient").catch(() => undefined);
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      const decision = this.deps.guard.decide({ method: "GET", url: ws.url() });
      if (decision.allow) {
        ws.connectToServer();
        return;
      }
      this.loose.blocked.push({ reason: decision.reason, detail: `web socket: ${decision.detail}` });
      await ws.close({ code: 1008, reason: "blocked" }).catch(() => undefined);
    });
    context.on("page", (page) => {
      if (this.creatingPage) return;
      this.loose.notes.push("the page tried to open a new tab; it was closed (use navigate to open an address)");
      void page.close().catch(() => undefined);
    });
  }

  /* Whether the page that made a request belongs to a read-only session. A request no page can be named for is read-only while any read-only session holds a page: it cannot be told apart, so it gets the narrower right. */
  private requestIsReadOnly(request: PwRequest): boolean {
    let page: PwPage | null = null;
    try {
      page = request.frame().page();
    } catch {
      /* Playwright cannot name the frame of some requests. */
    }
    const entry = page ? this.byPage.get(page) : undefined;
    if (entry) return entry.readOnly;
    return [...this.entries.values()].some((held) => held.readOnly);
  }

  private recordBlock(request: PwRequest, detail: string, reason: BlockedRequest["reason"]): void {
    let page: PwPage | null = null;
    try {
      page = request.frame().page();
    } catch {
      /* Playwright cannot name the frame of some requests (a navigation issued before its frame exists). */
    }
    const entry = page ? this.byPage.get(page) : undefined;
    const pending = entry ? entry.blocked : this.loose.blocked;
    if (pending.length < MAX_PENDING_BLOCKS) pending.push({ reason, detail });
  }
}

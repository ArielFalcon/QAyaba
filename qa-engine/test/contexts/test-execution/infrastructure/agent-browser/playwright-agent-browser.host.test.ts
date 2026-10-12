import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouteGuard } from "@contexts/test-execution/domain/agent-browser-route-guard.ts";
import { BrowserActionError, type BrowserAction } from "@contexts/test-execution/application/ports/agent-browser.ports.ts";
import { PlaywrightAgentBrowserHost } from "@contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host.ts";
import type { LaunchedBrowser, PwBrowser, PwContext, PwContextOptions, PwDialog, PwFrame, PwLocator, PwPage, PwRequest, PwResponse, PwRoute, PwWebSocketRoute, SessionMaterial } from "@contexts/test-execution/infrastructure/agent-browser/playwright-types.ts";

const BASE = "https://dev.example.com";

class FakeLocator implements PwLocator {
  readonly log: string[] = [];
  constructor(private readonly page: FakePage, private readonly selector: string) {}
  async click(): Promise<void> {
    if (this.page.failOn === this.selector) throw new Error("Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e9')");
    this.page.actions.push(`click ${this.selector}`);
    await this.page.afterClick?.();
  }
  async fill(text: string): Promise<void> { this.page.actions.push(`fill ${this.selector} ${text}`); }
  async press(key: string): Promise<void> { this.page.actions.push(`press ${this.selector} ${key}`); }
  async getAttribute(): Promise<string | null> { return this.page.typeOf.get(this.selector) ?? null; }
  async count(): Promise<number> { return this.selector.includes("password") ? this.page.passwordFields : 0; }
}

class FakePage implements PwPage {
  currentUrl = "about:blank";
  titleText = "T";
  tree = "- heading [ref=e1]";
  passwordFields = 0;
  failOn: string | undefined;
  readonly typeOf = new Map<string, string>();
  readonly actions: string[] = [];
  gotoStatus = 200;
  gotoThrows: Error | undefined;
  /* What the browser does while a navigation is under way (the requests it makes) before it settles or fails. */
  gotoHook: ((url: string) => Promise<void>) | undefined;
  afterClick: (() => Promise<void>) | undefined;
  closed = false;
  readonly handlers: { response: ((r: PwResponse) => void)[]; dialog: ((d: PwDialog) => void)[] } = { response: [], dialog: [] };
  readonly frame: PwFrame = { page: () => this };
  constructor(private readonly context: FakeContext) {}
  async goto(url: string): Promise<PwResponse | null> {
    this.actions.push(`goto ${url}`);
    await this.gotoHook?.(url);
    if (this.gotoThrows) throw this.gotoThrows;
    this.currentUrl = url;
    const response = this.responseFor(url, this.gotoStatus);
    for (const h of this.handlers.response) h(response);
    return response;
  }
  responseFor(url: string, status: number): PwResponse {
    const request: PwRequest = { method: () => "GET", url: () => url, isNavigationRequest: () => true, frame: () => this.frame };
    return { status: () => status, request: () => request, frame: () => this.frame };
  }
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.titleText; }
  async ariaSnapshot(): Promise<string> { return this.tree; }
  locator(selector: string): PwLocator { return new FakeLocator(this, selector); }
  async waitForLoadState(): Promise<void> {}
  mainFrame(): PwFrame { return this.frame; }
  on(event: "response" | "dialog", handler: ((r: PwResponse) => void) & ((d: PwDialog) => void)): void {
    (this.handlers[event] as unknown[]).push(handler);
  }
  async close(): Promise<void> { this.closed = true; this.context.pages.delete(this); }
}

class FakeContext implements PwContext {
  readonly pages = new Set<FakePage>();
  routeHandler: ((route: PwRoute) => Promise<void> | void) | undefined;
  wsHandler: ((ws: PwWebSocketRoute) => Promise<void> | void) | undefined;
  pageListeners: ((page: PwPage) => void)[] = [];
  closed = false;
  constructor(readonly options: PwContextOptions) {}
  async route(_url: RegExp | string, handler: (route: PwRoute) => Promise<void> | void): Promise<void> { this.routeHandler = handler; }
  async routeWebSocket(_url: RegExp | string, handler: (ws: PwWebSocketRoute) => Promise<void> | void): Promise<void> { this.wsHandler = handler; }
  readonly initScripts: string[] = [];
  async addInitScript(script: string): Promise<void> { this.initScripts.push(script); }
  async newPage(): Promise<PwPage> {
    const page = new FakePage(this);
    this.pages.add(page);
    for (const l of this.pageListeners) l(page);
    return page;
  }
  on(_event: "page", handler: (page: PwPage) => void): void { this.pageListeners.push(handler); }
  async close(): Promise<void> { this.closed = true; }
  /* A request the page makes: what the browser hands the route handler. */
  async request(page: FakePage | undefined, method: string, url: string): Promise<{ continued: boolean; aborted: boolean }> {
    const out = { continued: false, aborted: false };
    const request: PwRequest = { method: () => method, url: () => url, isNavigationRequest: () => false, frame: () => (page ? page.frame : { page: () => null }) };
    const route: PwRoute = { request: () => request, continue: async () => { out.continued = true; }, abort: async () => { out.aborted = true; } };
    await this.routeHandler!(route);
    return out;
  }
}

class FakeBrowser implements PwBrowser {
  readonly contexts: FakeContext[] = [];
  closed = false;
  private readonly disconnectHandlers: (() => void)[] = [];
  /* Held while set: the context is not handed out until it resolves, so a test can act while the host is mid-build. */
  newContextGate: Promise<void> | undefined;
  async newContext(options: PwContextOptions): Promise<PwContext> {
    const context = new FakeContext(options);
    this.contexts.push(context);
    await this.newContextGate;
    return context;
  }
  async close(): Promise<void> { this.closed = true; }
  on(_event: "disconnected", handler: () => void): void { this.disconnectHandlers.push(handler); }
  /* The browser process died or its pipe closed. */
  crash(): void { for (const handler of this.disconnectHandlers) handler(); }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function setup(over: { material?: SessionMaterial; denyRoutes?: string[]; allowMutating?: string[] } = {}) {
  const browser = new FakeBrowser();
  const browsers: FakeBrowser[] = [];
  /* While set, the step is held until it resolves, so a test can act while the host is mid-build. */
  const gates: { launch?: Promise<void>; material?: Promise<void> } = {};
  let launches = 0;
  let disposed = 0;
  let materialReads = 0;
  const host = new PlaywrightAgentBrowserHost({
    launcher: {
      launch: async (): Promise<LaunchedBrowser> => {
        launches += 1;
        const launched = launches === 1 ? browser : new FakeBrowser();
        browsers.push(launched);
        await gates.launch;
        return { browser: launched, dispose: async () => { disposed += 1; } };
      },
    },
    material: async () => { materialReads += 1; await gates.material; return over.material ?? { storageState: { cookies: [{ name: "sid", value: "s3cret" }], origins: [] } }; },
    guard: createRouteGuard({ origins: [BASE], denyRoutes: over.denyRoutes ?? ["/admin/**"], allowMutating: over.allowMutating ?? [] }),
  });
  const signal = new AbortController().signal;
  const call = (sessionId: string, action: BrowserAction) => host.perform(sessionId, action, { signal, timeoutMs: 10_000 });
  return { host, browser, browsers, gates, call, counts: () => ({ launches, disposed, materialReads }) };
}

const pageOf = (browser: FakeBrowser): FakePage => [...browser.contexts[0]!.pages][0]!;

test("a context blocks service workers and downloads and starts from the session held in memory", async () => {
  const material: SessionMaterial = { storageState: { cookies: [{ name: "sid" }], origins: [] }, httpCredentials: { username: "gate", password: "pw" } };
  const { browser, call } = setup({ material });
  await call("s1", { kind: "snapshot" });
  const options = browser.contexts[0]!.options;
  assert.equal(options.serviceWorkers, "block");
  assert.equal(options.acceptDownloads, false);
  assert.equal(typeof options.storageState, "object", "the session is handed over as data, never as a path");
  assert.deepEqual(options.storageState, material.storageState);
  assert.deepEqual(options.httpCredentials, material.httpCredentials);
  assert.equal(options.clientCertificates, undefined);
});

test("every document of the context gets a script that replaces service-worker registration on the prototype", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const scripts = browser.contexts[0]!.initScripts;
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /ServiceWorkerContainer\.prototype/);
});

test("a request the guard cannot judge is blocked, not let through", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const context = browser.contexts[0]!;
  const out = { continued: false, aborted: false };
  const request: PwRequest = { method: () => { throw new Error("gone"); }, url: () => `${BASE}/`, isNavigationRequest: () => false, frame: () => ({ page: () => null }) };
  await context.routeHandler!({ request: () => request, continue: async () => { out.continued = true; }, abort: async () => { out.aborted = true; } });
  assert.deepEqual(out, { continued: false, aborted: true });
});

test("a block is still reported when playwright cannot name the frame of the request", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const context = browser.contexts[0]!;
  const request: PwRequest = { method: () => "POST", url: () => `${BASE}/api/x`, isNavigationRequest: () => true, frame: () => { throw new Error("frame is not available"); } };
  const out = { aborted: false };
  await context.routeHandler!({ request: () => request, continue: async () => undefined, abort: async () => { out.aborted = true; } });
  assert.equal(out.aborted, true);
  assert.equal((await call("s1", { kind: "snapshot" })).blocked[0]?.reason, "method");
});

test("a page a blocked request left on the browser's error page is reopened where the agent was", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  const page = pageOf(browser);
  page.afterClick = async () => { page.currentUrl = "chrome-error://chromewebdata/"; };
  const state = await call("s1", { kind: "click", ref: "e5" });
  assert.equal(state.url, `${BASE}/orders`);
  assert.ok(state.notes.some((n) => /reopened/.test(n)));
});

test("a client certificate in the session material is handed to the context for its origin", async () => {
  const pfx = Buffer.from("x");
  const { browser, call } = setup({ material: { clientCertificate: { origin: BASE, pfx, passphrase: "p" } } });
  await call("s1", { kind: "snapshot" });
  assert.deepEqual(browser.contexts[0]!.options.clientCertificates, [{ origin: BASE, pfx, passphrase: "p" }]);
});

test("the browser starts once for the run and each agent session gets its own page", async () => {
  const { browser, call, counts } = setup();
  await call("s1", { kind: "snapshot" });
  await call("s2", { kind: "snapshot" });
  await call("s1", { kind: "snapshot" });
  assert.equal(counts().launches, 1);
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0]!.pages.size, 2);
});

test("a navigation goes to the address, waits for the document and reports the page with its status", async () => {
  const { browser, call } = setup();
  const state = await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  assert.equal(state.url, `${BASE}/orders`);
  assert.equal(state.title, "T");
  assert.equal(state.snapshot, "- heading [ref=e1]");
  assert.equal(state.documentStatus, 200);
  assert.equal(state.requestedPath, "/orders");
  assert.deepEqual(pageOf(browser).actions, [`goto ${BASE}/orders`]);
});

test("a click acts on the element the snapshot's ref names and on nothing else", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  const state = await call("s1", { kind: "click", ref: "e5" });
  assert.ok(pageOf(browser).actions.includes("click aria-ref=e5"));
  assert.equal(state.requestedPath, "/orders", "without a navigation the request is the page the session was on");
  assert.equal(state.documentStatus, undefined, "a status from an earlier call is not reported again");
});

test("an element that cannot be acted on is an error the agent can read, without the browser's own call log", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  pageOf(browser).failOn = "aria-ref=e9";
  await assert.rejects(call("s1", { kind: "click", ref: "e9" }), (err: unknown) => {
    assert.ok(err instanceof BrowserActionError);
    assert.match(err.message, /e9/);
    assert.doesNotMatch(err.message, /Call log/);
    return true;
  });
});

test("typing fills the field, presses Enter only when asked, and never types into a password field", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const page = pageOf(browser);
  await call("s1", { kind: "type", ref: "e2", text: "hello", submit: false });
  assert.deepEqual(page.actions.filter((a) => a.startsWith("fill") || a.startsWith("press")), ["fill aria-ref=e2 hello"]);
  await call("s1", { kind: "type", ref: "e2", text: "again", submit: true });
  assert.ok(page.actions.includes("press aria-ref=e2 Enter"));
  page.typeOf.set("aria-ref=e3", "password");
  await assert.rejects(call("s1", { kind: "type", ref: "e3", text: "x", submit: false }), BrowserActionError);
  assert.ok(!page.actions.includes("fill aria-ref=e3 x"));
});

test("a page showing a password field is reported as such", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  pageOf(browser).passwordFields = 1;
  assert.equal((await call("s1", { kind: "snapshot" })).passwordFieldVisible, true);
});

test("an action the surface does not have is refused and reaches no page method", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const before = pageOf(browser).actions.length;
  await assert.rejects(call("s1", { kind: "evaluate", expression: "document.cookie" } as unknown as BrowserAction), BrowserActionError);
  await assert.rejects(call("s1", { kind: "file_upload", paths: ["/etc/passwd"] } as unknown as BrowserAction), BrowserActionError);
  assert.equal(pageOf(browser).actions.length, before);
});

test("a request of the context is let through only when the guard allows it, and the page that made a blocked one is told", async () => {
  const { browser, call } = setup({ denyRoutes: ["/admin/**"] });
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  const context = browser.contexts[0]!;
  const page = pageOf(browser);
  assert.deepEqual(await context.request(page, "GET", `${BASE}/api/orders`), { continued: true, aborted: false });
  assert.deepEqual(await context.request(page, "POST", `${BASE}/api/orders`), { continued: false, aborted: true });
  assert.deepEqual(await context.request(page, "GET", `${BASE}/admin/users`), { continued: false, aborted: true });
  assert.deepEqual(await context.request(page, "GET", "https://tracker.example.net/p.gif"), { continued: false, aborted: true });
  const state = await call("s1", { kind: "snapshot" });
  assert.deepEqual(state.blocked.map((b) => b.reason), ["method", "deny-route", "origin"]);
  assert.match(state.blocked[0]!.detail, /POST/);
  const again = await call("s1", { kind: "snapshot" });
  assert.deepEqual(again.blocked, [], "a block is reported once");
});

test("a navigation the guard aborts is reported as a block, not as a failure", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const context = browser.contexts[0]!;
  const page = pageOf(browser);
  page.gotoThrows = new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT at https://dev.example.com/admin");
  page.gotoHook = async (url) => { await context.request(page, "GET", url); };
  const state = await call("s1", { kind: "navigate", url: `${BASE}/admin/users` });
  assert.equal(state.blocked[0]?.reason, "deny-route");
});

test("a navigation that fails for another reason is an error that names the cause without the call log", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  pageOf(browser).gotoThrows = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://dev.example.com/\nCall log:\n  - navigating");
  await assert.rejects(call("s1", { kind: "navigate", url: `${BASE}/` }), (err: unknown) => {
    assert.ok(err instanceof BrowserActionError);
    assert.match(err.message, /ERR_NAME_NOT_RESOLVED/);
    assert.doesNotMatch(err.message, /Call log/);
    return true;
  });
});

test("a web socket is allowed to connect only when the guard allows its address", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const context = browser.contexts[0]!;
  const outcomes: string[] = [];
  const ws = (url: string): PwWebSocketRoute => ({ url: () => url, close: async () => { outcomes.push(`closed ${url}`); }, connectToServer: () => { outcomes.push(`connected ${url}`); } });
  await context.wsHandler!(ws("wss://dev.example.com/socket"));
  await context.wsHandler!(ws("wss://other.example.net/socket"));
  assert.deepEqual(outcomes, ["connected wss://dev.example.com/socket", "closed wss://other.example.net/socket"]);
});

test("a page the app opens by itself is closed and the agent is told", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  const context = browser.contexts[0]!;
  const popup = (await context.newPage()) as FakePage;
  await new Promise((r) => setImmediate(r));
  assert.equal(popup.closed, true);
  const state = await call("s1", { kind: "snapshot" });
  assert.ok(state.notes.some((n) => /new tab/i.test(n)));
});

test("a dialog the page raises is dismissed", async () => {
  const { browser, call } = setup();
  await call("s1", { kind: "snapshot" });
  let dismissed = 0;
  for (const h of pageOf(browser).handlers.dialog) h({ dismiss: async () => { dismissed += 1; } });
  assert.equal(dismissed, 1);
});

test("a reset drops the context and the next call builds a new one from the session as it is read then", async () => {
  const { browser, call, host, counts } = setup();
  await call("s1", { kind: "snapshot" });
  await host.reset();
  assert.equal(browser.contexts[0]!.closed, true);
  await call("s1", { kind: "snapshot" });
  assert.equal(browser.contexts.length, 2);
  assert.equal(counts().materialReads, 2);
  assert.equal(counts().launches, 1, "the browser process is kept");
});

test("releasing a session closes its page and no other", async () => {
  const { browser, call, host } = setup();
  await call("s1", { kind: "snapshot" });
  await call("s2", { kind: "snapshot" });
  await host.release("s1");
  assert.equal(browser.contexts[0]!.pages.size, 1);
});

test("closing stops the context, the browser and the process, and is safe to repeat or to meet a fault", async () => {
  const { browser, call, host, counts } = setup();
  await call("s1", { kind: "snapshot" });
  browser.contexts[0]!.close = async () => { throw new Error("already gone"); };
  await host.close();
  await host.close();
  assert.equal(browser.closed, true);
  assert.equal(counts().disposed, 1);
  await assert.rejects(call("s1", { kind: "snapshot" }), BrowserActionError, "a closed host starts nothing again");
});

test("a call whose time is up or whose session ended does not touch the page", async () => {
  const { host } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.perform("s1", { kind: "snapshot" }, { signal: controller.signal, timeoutMs: 1000 }), BrowserActionError);
});

test("no more than the allowed number of sessions can hold a page at once", async () => {
  const { call } = setup();
  for (const id of ["a", "b", "c", "d"]) await call(id, { kind: "snapshot" });
  await assert.rejects(call("e", { kind: "snapshot" }), BrowserActionError);
});

test("a browser that fails to start is tried again by the next call", async () => {
  const browser = new FakeBrowser();
  let attempts = 0;
  const host = new PlaywrightAgentBrowserHost({
    launcher: { launch: async () => { attempts += 1; if (attempts === 1) throw new Error("no chromium"); return { browser, dispose: async () => undefined }; } },
    material: async () => ({}),
    guard: createRouteGuard({ origins: [BASE], denyRoutes: [], allowMutating: [] }),
  });
  const options = { signal: new AbortController().signal, timeoutMs: 1000 };
  await assert.rejects(host.perform("s1", { kind: "snapshot" }, options));
  await host.perform("s1", { kind: "snapshot" }, options);
  assert.equal(attempts, 2);
});

test("closing the host while the browser is still starting does not leave the browser that finishes starting running", async () => {
  const { host, browser, gates, call, counts } = setup();
  const launching = gate();
  gates.launch = launching.promise;
  const pending = call("s1", { kind: "snapshot" });
  await new Promise((r) => setImmediate(r));
  await host.close();
  launching.open();
  await assert.rejects(pending, BrowserActionError);
  assert.equal(browser.closed, true, "the browser that came up after the close is closed");
  assert.equal(counts().disposed, 1, "and its process is stopped");
  assert.equal(browser.contexts.length, 0, "no context was built on it");
});

test("closing the host while the session is being read does not build a context on the browser", async () => {
  const { host, browser, gates, call, counts } = setup();
  const reading = gate();
  gates.material = reading.promise;
  const pending = call("s1", { kind: "snapshot" });
  await new Promise((r) => setImmediate(r));
  await host.close();
  reading.open();
  await assert.rejects(pending, BrowserActionError);
  assert.equal(browser.contexts.length, 0);
  assert.equal(browser.closed, true);
  assert.equal(counts().disposed, 1);
});

test("closing the host while the context is being built closes that context too", async () => {
  const { host, browser, call } = setup();
  const building = gate();
  browser.newContextGate = building.promise;
  const pending = call("s1", { kind: "snapshot" });
  await new Promise((r) => setImmediate(r));
  await host.close();
  building.open();
  await assert.rejects(pending, BrowserActionError);
  assert.equal(browser.contexts[0]!.closed, true);
  assert.equal(browser.closed, true);
});

test("a browser that crashed is replaced by the next call: a new process, a new context from the session as it is now, a new page", async () => {
  const { browsers, call, counts } = setup();
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  browsers[0]!.crash();
  const state = await call("s1", { kind: "navigate", url: `${BASE}/cart` });
  assert.equal(state.url, `${BASE}/cart`);
  assert.equal(counts().launches, 2);
  assert.equal(counts().materialReads, 2, "the session is read again");
  assert.equal(counts().disposed, 1, "the process of the browser that died is stopped");
  assert.equal(browsers[1]!.contexts.length, 1);
  assert.equal(browsers[1]!.contexts[0]!.pages.size, 1);
});

test("a crash that comes after the host was closed starts nothing", async () => {
  const { host, browsers, call, counts } = setup();
  await call("s1", { kind: "snapshot" });
  await host.close();
  browsers[0]!.crash();
  assert.equal(counts().launches, 1);
  assert.equal(counts().disposed, 1, "the close already stopped it, and the crash does not stop it again");
});

test("a session whose page a reset took away is told its page is new, and a session that never had one is told nothing", async () => {
  const { host, call } = setup();
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  await call("s2", { kind: "navigate", url: `${BASE}/cart` });
  await host.reset();
  const again = await call("s2", { kind: "snapshot" });
  assert.ok(again.notes.some((n) => /new page|restarted/.test(n)), "the agent is told its refs are gone");
  const first = await call("s3", { kind: "snapshot" });
  assert.deepEqual(first.notes, []);
  const next = await call("s2", { kind: "snapshot" });
  assert.deepEqual(next.notes, [], "and told once");
});

test("a session whose page a crashed browser took away is told its page is new", async () => {
  const { browsers, call } = setup();
  await call("s1", { kind: "navigate", url: `${BASE}/orders` });
  browsers[0]!.crash();
  const again = await call("s1", { kind: "snapshot" });
  assert.ok(again.notes.some((n) => /new page|restarted/.test(n)));
});

/*
 * Test support: loads the web console (web/public/js — format.js, api.js and optionally
 * console.js, in index.html's order) into a node:vm context with just enough browser surface to
 * run it: a scripted fetch, a manual clock, sessionStorage, and a string-backed DOM. Tests talk to
 * the console only through its public seams — window.QayabaConsole.api, the rendered text of the
 * #app root, the click delegation on it, and the login screen — never through its internals.
 *
 * Time is virtual: setTimeout/setInterval only fire when a test calls advance(ms), so reconnect
 * backoff and timers are exercised deterministically without real waiting. Responses are
 * delivered on a macrotask (like real network I/O), so a client that reconnects without ever
 * waiting still yields between requests and shows up as an unbounded request count instead of
 * starving the test process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const JS_DIR = join(import.meta.dirname, "..", "..", "..", "web", "public", "js");

export interface ConsoleRequest {
  method: string;
  /* The absolute URL's origin, or null for a request to the console's own origin (a relative URL). */
  origin: string | null;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  /* Virtual time the request was made at. */
  at: number;
  /* An SSE reply's connection was released by the client (aborted or its body cancelled). */
  released: boolean;
}

/* An SSE reply: the frames the server writes, then either a clean close or a held-open stream. */
export interface SseReply {
  status: 200;
  sse: string[];
  hold?: boolean;
}
export interface JsonReply {
  status: number;
  json?: unknown;
}
export type Reply = SseReply | JsonReply;
export type Routes = (req: ConsoleRequest) => Reply;

/*
 * A control API serving a small fleet, enough for console.js to boot and render: the apps, their
 * run feeds and the queue, plus any per-test route that takes precedence. Every optional read the
 * console tolerates missing (signals, trends, reports, …) answers 404 unless a test serves it.
 */
export function controlApi(fleet: {
  apps: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  running?: { id: string; app: string } | null;
  pending?: number;
  extra?: (req: ConsoleRequest) => Reply | undefined;
}): Routes {
  return (req) => {
    const own = fleet.extra?.(req);
    if (own) return own;
    const url = new URL(req.path, "http://console.test");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/apps") return { status: 200, json: fleet.apps };
    if (path === "/queue") return { status: 200, json: { pending: fleet.pending ?? 0, running: fleet.running ?? null } };
    if (path === "/runs") return { status: 200, json: fleet.runs.filter((r) => r.app === url.searchParams.get("app")) };
    const run = path.match(/^\/runs\/([^/]+)$/);
    if (run) {
      const found = fleet.runs.find((r) => r.id === decodeURIComponent(run[1]!));
      return found ? { status: 200, json: found } : { status: 404, json: { error: "not found" } };
    }
    if (/^\/runs\/[^/]+\/events$/.test(path)) return { status: 200, sse: [], hold: true };
    return { status: 404, json: { error: "not found" } };
  };
}

export function appView(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, repo: `org/${name}`, baseUrl: `https://dev.${name}.test`, versionUrl: "", code: false, shadow: true,
    needsReview: true, testDataPrefix: "qa", services: [], ...extra,
  };
}

export function runRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, app: "shop", sha: "abcdef1234567", target: "e2e", mode: "diff", status: "done", verdict: "pass",
    cases: [], logs: [], at: new Date().toISOString(), ...extra,
  };
}

/* One SSE frame carrying a RunEvent, as the control API writes it. */
export function sseEvent(runId: string, seq: number, body: Record<string, unknown>): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, runId, ts: seq, body })}\n\n`;
}

export interface RunHandlers {
  onStep?: (step: string, detail?: string) => void;
  onPlan?: (todos: unknown[]) => void;
  onCase?: (name: string, status: string, ms?: number) => void;
  onLog?: (glyph: string, text: string) => void;
  onVerdict?: (verdict: string, body?: unknown) => void;
  onError?: () => void;
}

export interface ConsoleApi {
  loadAll(): Promise<Record<string, any>>;
  subscribeRun(runId: string, handlers: RunHandlers): (() => void) | null;
  createRun(input: Record<string, unknown>): Promise<unknown>;
  cancelRun(id: string): Promise<unknown>;
  continueRun(id: string, input?: Record<string, unknown>): Promise<unknown>;
  applyAgentKey(key: string): Promise<unknown>;
  agentStatus(): Promise<unknown>;
}

export interface ConsoleHarness {
  api: ConsoleApi;
  requests: ConsoleRequest[];
  requestsTo(path: string): ConsoleRequest[];
  /* Advance virtual time, firing due timers and letting I/O settle in between. */
  advance(ms: number): Promise<void>;
  /* Let pending I/O and promise chains settle without moving the clock. */
  settle(): Promise<void>;
  storage: Map<string, string>;
  /* console.js only: the #app root's visible text, a click on a [data-action] control, the login screen. */
  text(): string;
  click(action: string, id?: string): void;
  loginVisible(): boolean;
  toastText(): string;
  /* The ids of the controls outside the #app root that respond to a click (the login screen's buttons). */
  loginControls(): string[];
  pressLogin(id: string): void;
  typeLogin(id: string, text: string): void;
  /* Types into, and reads back, a text field the console rendered (looked up by its element id). */
  type(id: string, text: string): void;
  fieldValue(id: string): string;
  /* The login screen's error line, or "" while it is hidden. */
  loginError(): string;
}

export interface LoadOptions {
  routes: Routes;
  mode?: "live" | "mock";
  token?: string | null;
  withConsole?: boolean;
  search?: string;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/* Minimal element: innerHTML is a plain string; every query finds nothing. */
function element(id: string): Record<string, any> {
  const el: Record<string, any> = {
    id,
    _html: "",
    style: {},
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    value: "",
    hidden: false,
    disabled: false,
    textContent: "",
    href: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(type: string, fn: (e: unknown) => void) {
      (el.listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    focus() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    closest: () => null,
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html,
    set: (v: unknown) => {
      el._html = String(v);
    },
  });
  return el;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function loadConsole(opts: LoadOptions): Promise<ConsoleHarness> {
  const requests: ConsoleRequest[] = [];
  const storage = new Map<string, string>();
  if (opts.token) storage.set("qayaba_token", opts.token);

  /* ── virtual clock ── */
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, Timer>();
  const schedule = (fn: () => void, ms: unknown, every: boolean): number => {
    const delay = Math.max(0, Number(ms) || 0);
    const id = nextTimerId++;
    timers.set(id, { id, at: now + delay, fn, every: every ? Math.max(1, delay) : null });
    return id;
  };
  const clear = (id: unknown): void => {
    timers.delete(Number(id));
  };

  /* ── scripted fetch ── */
  const fetchStub = async (url: string, init: Record<string, any> = {}): Promise<Response> => {
    const signal = init.signal as AbortSignal | undefined;
    const absolute = /^https?:\/\//.test(String(url));
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: ConsoleRequest = {
      method: String(init.method ?? "GET").toUpperCase(),
      origin: absolute ? new URL(String(url)).origin : null,
      path,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal,
      at: now,
      released: false,
    };
    requests.push(req);
    await macrotask();
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const reply = opts.routes(req);
    if ("sse" in reply) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of reply.sse) controller.enqueue(encoder.encode(frame));
          if (!reply.hold) controller.close();
          signal?.addEventListener("abort", () => {
            req.released = true;
            try {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            } catch {
              /* already closed */
            }
          });
        },
        cancel() {
          req.released = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };

  /* ── browser surface ── */
  const elements = new Map<string, Record<string, any>>();
  const byId = (id: string): Record<string, any> => {
    let el = elements.get(id);
    if (!el) {
      el = element(id);
      elements.set(id, el);
    }
    return el;
  };
  const root = byId("app");
  const loginScreen = byId("login-screen");
  loginScreen.style.display = "none";
  const location = { hash: "", search: opts.search ?? "", href: "http://localhost/app/" + (opts.search ?? ""), reload() {} };
  const window: Record<string, any> = {
    QAYABA_CONSOLE_CONFIG: { mode: opts.mode ?? "live", baseUrl: "" },
    location,
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
  };
  const document = {
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    currentScript: null,
  };
  const ctx = createContext({
    window,
    document,
    location,
    history: window.history,
    fetch: fetchStub,
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
    },
    setTimeout: (fn: () => void, ms?: number) => schedule(fn, ms, false),
    clearTimeout: clear,
    setInterval: (fn: () => void, ms?: number) => schedule(fn, ms, true),
    clearInterval: clear,
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: true }),
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    DOMException,
    Response,
    console,
  });
  window.window = window;

  /* index.html's order; the mock dataset only matters to the mock adapter. */
  const scripts = [
    ...(opts.mode === "mock" ? ["data.mock.js"] : []),
    "format.js",
    "api.js",
    ...(opts.withConsole ? ["console.js"] : []),
  ];
  for (const file of scripts) runInContext(readFileSync(join(JS_DIR, file), "utf8"), ctx, { filename: file });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await macrotask();
  };

  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    await settle();
    for (;;) {
      let due: Timer | undefined;
      for (const t of timers.values()) if (t.at <= until && (!due || t.at < due.at)) due = t;
      if (!due) break;
      now = due.at;
      if (due.every === null) timers.delete(due.id);
      else due.at = now + due.every;
      due.fn();
      await settle();
    }
    now = until;
  };

  await settle();

  const consoleNs = window.QayabaConsole as { api: ConsoleApi } | undefined;
  if (!consoleNs) throw new Error("api.js did not attach window.QayabaConsole");

  return {
    api: consoleNs.api,
    requests,
    requestsTo: (path) => requests.filter((r) => r.path.split("?")[0] === path),
    advance,
    settle,
    storage,
    text: () => visibleText(root._html as string),
    click(action, id) {
      const handlers = (root.listeners.click ?? []) as Array<(e: unknown) => void>;
      const target = { closest: () => ({ dataset: { action, id } }), classList: { contains: () => false } };
      for (const fn of handlers) fn({ target });
    },
    loginVisible: () => loginScreen.style.display !== "none",
    toastText: () => visibleText((byId("overlay")._html as string) ?? ""),
    loginControls: () =>
      [...elements.values()].filter((el) => el !== root && (el.listeners.click ?? []).length > 0).map((el) => el.id as string),
    pressLogin(id) {
      for (const fn of (byId(id).listeners.click ?? []) as Array<(e: unknown) => void>) fn({ target: byId(id) });
    },
    typeLogin(id, text) {
      byId(id).value = text;
    },
    type(id, text) {
      byId(id).value = text;
    },
    fieldValue: (id) => String(byId(id).value ?? ""),
    loginError: () => {
      const el = byId("login-error");
      return el.style.display === "none" ? "" : String(el.textContent ?? "");
    },
  };
}

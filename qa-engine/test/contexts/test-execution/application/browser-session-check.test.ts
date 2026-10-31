/* The orchestrator's check of a saved session: each page is opened by a navigation and where the app sent it is judged by the authenticated browser's own "session invalidated" rule; a page that opens where it was asked says nothing against the session, whatever it looks like. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountLock, BrowserSessionCheck, MAX_SESSION_CHECK_PATHS, type AgentBrowserHostPort, type PageState } from "@contexts/test-execution/application/index.ts";

const BASE = "https://dev.example";

/* A host whose pages answer from `pages` by the path asked for; a path not listed throws. */
function host(pages: Record<string, Partial<PageState>>, seen: { asked: string[]; closed: number }): AgentBrowserHostPort {
  return {
    perform: async (_session, action) => {
      if (action.kind !== "navigate") throw new Error("the check only navigates");
      const path = new URL(action.url).pathname;
      seen.asked.push(path);
      const page = pages[path];
      if (!page) throw new Error(`net::ERR_FAILED at ${path}`);
      return { url: `${BASE}${path}`, title: "", snapshot: "", passwordFieldVisible: false, requestedPath: path, blocked: [], requests: { listed: [], otherHosts: [], omitted: 0 }, notes: [], ...page } as PageState;
    },
    reset: async () => {},
    close: async () => {
      seen.closed += 1;
    },
  };
}

const check = (pages: Record<string, Partial<PageState>>, seen = { asked: [] as string[], closed: 0 }, loginPath?: string) =>
  new BrowserSessionCheck({ host: host(pages, seen), baseUrl: BASE, lock: new AccountLock(), account: "demo/QA_USER", perPageMs: 1_000, ...(loginPath ? { loginPath } : {}) });

test("a page the app sends to its login page shows the session lost", async () => {
  const result = await check({ "/orders": { url: `${BASE}/login?next=%2Forders` } }).check(["/orders"]);
  assert.equal(result.state, "lost");
});

test("a page answered 401 shows the session lost", async () => {
  const result = await check({ "/orders": { documentStatus: 401 } }).check(["/orders"]);
  assert.equal(result.state, "lost");
});

test("a page that opens where it was asked holds the session, whatever its path or its form looks like", async () => {
  const seen = { asked: [] as string[], closed: 0 };
  const result = await check(
    {
      "/login": { passwordFieldVisible: true },
      "/account/security": { passwordFieldVisible: true },
      "/auth/callback": {},
      "/productos": {},
    },
    seen,
  ).check(["/login", "/account/security", "/auth/callback"]);
  assert.deepEqual(result, { state: "held" });
  assert.deepEqual(seen.asked, ["/login", "/account/security", "/auth/callback"]);
});

test("with no page to ask for, the app's root is opened", async () => {
  const seen = { asked: [] as string[], closed: 0 };
  await check({ "/": {} }, seen).check([]);
  assert.deepEqual(seen.asked, ["/"]);
});

test("the check opens at most its bound of pages and closes its browser", async () => {
  const seen = { asked: [] as string[], closed: 0 };
  const paths = Array.from({ length: MAX_SESSION_CHECK_PATHS + 2 }, (_, i) => `/p${i}`);
  await check(Object.fromEntries(paths.map((p) => [p, {}])), seen).check(paths);
  assert.equal(seen.asked.length, MAX_SESSION_CHECK_PATHS);
  assert.equal(seen.closed, 1);
});

test("no page that could be read says nothing: unknown, never lost", async () => {
  const result = await check({}).check(["/orders"]);
  assert.equal(result.state, "unknown");
});

test("the app's declared login path is believed whatever led to it", async () => {
  const result = await check({ "/orders": { url: `${BASE}/entrar` } }, undefined, "/entrar").check(["/orders"]);
  assert.equal(result.state, "lost");
});

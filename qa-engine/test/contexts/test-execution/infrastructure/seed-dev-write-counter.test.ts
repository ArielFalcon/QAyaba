/* The seed's DEV-write counter is what run_spec charges against a flow's share and the run's cap, so it counts a write only once DEV answered it, and keeps a request that is still out apart as `pending`, in a ledger it writes when the test starts and rewrites on every change, so a test that is killed has left what it did: a mutating request to one of the run's DEV origins (PW_DEV_ORIGINS, set by the launcher from the egress lease). A page's own writes to other hosts (analytics, error reporters) cost nothing, and every counted request is recorded beside the count by method and origin + pathname. The seed cannot be imported (it needs the test runner's package), so the capture block between its markers is compiled and driven with a stand-in page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { MAX_DEV_WRITE_REQUESTS } from "@contexts/test-execution/domain/dev-write-request.ts";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

interface Capture {
  start(page: unknown, request: unknown): Promise<void>;
  finish(page: unknown, testInfo: unknown): Promise<void>;
}

/* A fresh copy of the block per call: its counters and listened contexts are module state. */
function loadCapture(): Promise<Capture> {
  const start = SEED.indexOf("// >>> qa-failure-capture");
  const end = SEED.indexOf("// Set by the seed's _failureCapture fixture");
  assert.ok(start >= 0 && end > start, "the seed marks its failure capture block");
  const body = SEED.slice(start, end).replace(/^import type .*$/m, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(`return (async () => { ${js}\nreturn { start: qaFailureCaptureStart, finish: qaFailureCaptureFinish }; })();`)() as Promise<Capture>;
}

const DEV = "https://dev.example.com";
const DEV_ORIGINS = JSON.stringify([DEV, "https://*.api.example.com:8443"]);

interface Sent { method: string; url: string; body?: string | null | "throws" }
interface ApiCall { target: string; method: string }
type Listener = (request: unknown) => void;

/* The browser request a page sends: one object for the three events a request goes through. */
function requestOf(sent: Sent): { method(): string; url(): string; postData(): string | null } {
  return { method: () => sent.method, url: () => sent.url, postData: () => { if (sent.body === "throws") throw new Error("body unavailable"); return sent.body ?? null; } };
}

/* The bookkeeping of a ledger a finished test left with nothing in flight (the version the runner reads, no pending request, done). */
const FINISHED = { v: 2, pending: 0, done: true };

const FINISH_INFO = { status: "passed", expectedStatus: "passed", titlePath: ["", "orders.spec.ts", "lists orders"], project: { name: "desktop" }, file: "/e2e/orders.spec.ts", retry: 0, testId: "t1", workerIndex: 0 };

/* One test of a spec, driven by hand: the context emits the request events, the `request` fixture fetches, and the ledger can be read at any point. */
async function withRig<T>(origins: string | undefined, run: (rig: {
  start(): Promise<void>;
  finish(): Promise<void>;
  emit(event: "request" | "requestfinished" | "requestfailed", request: unknown): void;
  fetch(call: ApiCall): Promise<unknown>;
  setFetch(fn: () => Promise<unknown>): void;
  ledger(): Record<string, unknown>;
  files(): string[];
  afterLoad(fn: () => void): void;
}) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "seed-dev-writes-"));
  const keys = ["QA_FAILURE_CAPTURE_DIR", "PW_COUNT_DEV_WRITES", "PW_DEV_ORIGINS", "PW_BASE_URL", "TEST_WORKER_INDEX"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.QA_FAILURE_CAPTURE_DIR = dir;
  process.env.PW_COUNT_DEV_WRITES = "1";
  process.env.PW_BASE_URL = DEV;
  process.env.TEST_WORKER_INDEX = "3";
  if (origins === undefined) delete process.env.PW_DEV_ORIGINS; else process.env.PW_DEV_ORIGINS = origins;
  try {
    const listeners = new Map<string, Listener[]>();
    let answer: () => Promise<unknown> = async () => ({ ok: () => true });
    const context = { on: (event: string, fn: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }, request: { fetch: async () => ({}) } };
    const page = { on() {}, url: () => `${DEV}/orders`, context: () => context, locator: () => ({ ariaSnapshot: async () => "- main" }) };
    const request = { fetch: async (_target: unknown, _options?: { method?: string }) => answer() };
    const { start, finish } = await loadCapture();
    return await run({
      start: () => start(page, request),
      finish: () => finish(page, FINISH_INFO),
      emit: (event, r) => { for (const fn of listeners.get(event) ?? []) fn(r); },
      fetch: (call) => request.fetch(call.target, { method: call.method }),
      setFetch: (fn) => { answer = fn; },
      ledger: () => {
        const name = readdirSync(dir).find((n) => n.startsWith("ledger-"));
        assert.ok(name, "the counter leaves a ledger");
        return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      },
      files: () => readdirSync(dir),
      afterLoad: (fn) => fn(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/* One finished test: the browser context sends and gets answered `browser` requests and the `request` fixture fetches `api`; returns the ledger the counter left. */
async function ledgerOf(opts: { browser?: Sent[]; api?: ApiCall[]; origins?: string | undefined; afterLoad?: () => void }): Promise<Record<string, unknown>> {
  return withRig(opts.origins, async (rig) => {
    await rig.start();
    opts.afterLoad?.();
    for (const sent of opts.browser ?? []) {
      const r = requestOf(sent);
      rig.emit("request", r);
      rig.emit("requestfinished", r);
    }
    for (const call of opts.api ?? []) await rig.fetch(call);
    await rig.finish();
    return rig.ledger();
  });
}

test("a page that writes by itself to a third-party origin leaves the write count at 0", async () => {
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser: [{ method: "POST", url: "https://errors.tracker.example/api/1/envelope?key=k" }, { method: "PUT", url: "https://analytics.example.org/collect" }] });
  assert.deepEqual(ledger, { ...FINISHED, writes: 0 });
});

test("a write to a declared DEV origin counts, and is recorded by method and origin + pathname without its query", async () => {
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser: [{ method: "POST", url: `${DEV}/api/orders?token=secret` }, { method: "GET", url: `${DEV}/api/orders` }] });
  assert.deepEqual(ledger, { ...FINISHED, writes: 1, requests: [{ method: "POST", url: `${DEV}/api/orders` }] });
});

test("a declared origin is matched by host and port as the egress filter matches it: a wildcard covers its subdomains on its own port only", async () => {
  const ledger = await ledgerOf({
    origins: DEV_ORIGINS,
    browser: [
      { method: "PATCH", url: "https://orders.api.example.com:8443/v1/o/1" },
      { method: "PATCH", url: "https://orders.api.example.com/v1/o/1" },
      { method: "DELETE", url: "https://api.example.com:8443/v1/o/1" },
      { method: "DELETE", url: "https://dev.example.com:444/x" },
    ],
  });
  assert.equal(ledger.writes, 1);
});

test("a write through the request fixture counts by the URL it resolves to, a relative one against the base URL", async () => {
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, api: [{ target: "/api/carts", method: "post" }, { target: "https://hooks.thirdparty.example/x", method: "POST" }, { target: `${DEV}/api/carts/1`, method: "GET" }] });
  assert.deepEqual(ledger, { ...FINISHED, writes: 1, requests: [{ method: "POST", url: `${DEV}/api/carts` }] });
});

test("without a readable list of DEV origins every answered write counts, the closed reading", async () => {
  for (const origins of [undefined, "", "not json", "[]", JSON.stringify(["ftp://dev.example.com"])]) {
    const ledger = await ledgerOf({ origins, browser: [{ method: "POST", url: "https://errors.tracker.example/api/1/envelope" }, { method: "POST", url: `${DEV}/api/orders` }] });
    assert.equal(ledger.writes, 2, `origins ${JSON.stringify(origins)}`);
  }
});

test("a test records at most the cap of counted requests, and its count keeps every write", async () => {
  const browser = Array.from({ length: 25 }, (_, i) => ({ method: "POST", url: `${DEV}/api/items/${i}` }));
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser });
  assert.equal(ledger.writes, 25);
  assert.equal((ledger.requests as unknown[]).length, MAX_DEV_WRITE_REQUESTS, "the seed records what one ledger file may hold");
});

test("a spec that rewrites the launch environment after the fixtures loaded still has its DEV writes counted against DEV", async () => {
  const ledger = await ledgerOf({
    origins: DEV_ORIGINS,
    afterLoad: () => {
      process.env.PW_BASE_URL = "https://other.example";
      process.env.PW_DEV_ORIGINS = JSON.stringify(["https://other.example"]);
    },
    browser: [{ method: "POST", url: `${DEV}/api/orders` }],
    api: [{ target: "/api/orders", method: "PUT" }],
  });
  assert.deepEqual(ledger, { ...FINISHED, writes: 2, requests: [{ method: "POST", url: `${DEV}/api/orders` }, { method: "PUT", url: `${DEV}/api/orders` }] });
});

/* The identity provider the page keeps the saved session alive with is one of the run's DEV origins (the app's login needs it declared), so its token requests reach the counter. */
const IDP = "https://id.example.com";
const WITH_IDP = JSON.stringify([DEV, IDP]);
const TOKEN = `${IDP}/oauth/token`;
const REFRESH = "grant_type=refresh_token&refresh_token=r&client_id=web";
const CODE = "grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fdev.example.com%2F&code_verifier=v";

test("a page's token refresh to the identity provider is session traffic: it spends no write and is recorded apart", async () => {
  const ledger = await ledgerOf({ origins: WITH_IDP, browser: [{ method: "POST", url: `${TOKEN}?x=1`, body: REFRESH }, { method: "POST", url: TOKEN, body: REFRESH }, { method: "POST", url: TOKEN, body: CODE }] });
  assert.deepEqual(ledger, { ...FINISHED, writes: 0, sessionRequests: [{ method: "POST", url: TOKEN }, { method: "POST", url: TOKEN }, { method: "POST", url: TOKEN }] });
});

test("every other write still counts beside the session traffic: the app's, the identity provider's other endpoints, and anything that is not a plain token request to it", async () => {
  const ledger = await ledgerOf({
    origins: WITH_IDP,
    browser: [
      { method: "POST", url: TOKEN, body: REFRESH },
      { method: "POST", url: `${DEV}/api/orders`, body: "item=1" },
      { method: "POST", url: `${DEV}/oauth/token`, body: REFRESH },
      { method: "POST", url: `${IDP}/account/password`, body: "password=new&confirm=new" },
      { method: "POST", url: `${IDP}/register`, body: "user=u" },
      { method: "POST", url: TOKEN, body: "grant_type=password&username=u&password=p" },
      { method: "POST", url: TOKEN, body: JSON.stringify({ grant_type: "refresh_token" }) },
      { method: "POST", url: TOKEN, body: null },
      { method: "POST", url: TOKEN, body: "throws" },
      { method: "PUT", url: TOKEN, body: REFRESH },
      { method: "DELETE", url: TOKEN, body: REFRESH },
    ],
  });
  assert.equal(ledger.writes, 10);
  assert.deepEqual(ledger.sessionRequests, [{ method: "POST", url: TOKEN }]);
  assert.deepEqual((ledger.requests as Array<{ url: string }>).map((r) => r.url), [`${DEV}/api/orders`, `${DEV}/oauth/token`, `${IDP}/account/password`, `${IDP}/register`, TOKEN, TOKEN, TOKEN, TOKEN, TOKEN, TOKEN]);
});

test("a token request without a readable list of origins is never session traffic, the closed reading", async () => {
  for (const origins of [undefined, "not json"]) {
    const ledger = await ledgerOf({ origins, browser: [{ method: "POST", url: TOKEN, body: REFRESH }] });
    assert.equal(ledger.writes, 1, `origins ${JSON.stringify(origins)}`);
  }
});

test("a test records at most the cap of session requests, and the write count is not touched by them", async () => {
  const browser = Array.from({ length: 25 }, () => ({ method: "POST", url: TOKEN, body: REFRESH }));
  const ledger = await ledgerOf({ origins: WITH_IDP, browser });
  assert.equal(ledger.writes, 0);
  assert.equal((ledger.sessionRequests as unknown[]).length, MAX_DEV_WRITE_REQUESTS);
});

/* ── the ledger exists from the test's start, so a test that is killed has left what it did ───────────────────────────── */

test("a test's ledger is on disk from its start, before any write: nothing counted, nothing pending, not done", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    assert.deepEqual(rig.ledger(), { v: 2, writes: 0, pending: 0, done: false });
  });
});

test("the writes DEV answered are in the ledger of a test that never finishes", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    for (const url of [`${DEV}/api/orders`, `${DEV}/api/carts`]) {
      const r = requestOf({ method: "POST", url });
      rig.emit("request", r);
      rig.emit("requestfinished", r);
    }
    const ledger = rig.ledger();
    assert.equal(ledger.writes, 2);
    assert.equal(ledger.pending, 0);
    assert.equal(ledger.done, false);
    assert.deepEqual(ledger.requests, [{ method: "POST", url: `${DEV}/api/orders` }, { method: "POST", url: `${DEV}/api/carts` }]);
  });
});

test("a write is pending from the moment it is sent and becomes a counted write once DEV answered it", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    const r = requestOf({ method: "DELETE", url: `${DEV}/api/orders/1` });
    rig.emit("request", r);
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [0, 1]);
    rig.emit("requestfinished", r);
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [1, 0]);
  });
});

test("a write that failed on the network leaves pending and is not counted", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    const r = requestOf({ method: "PUT", url: `${DEV}/api/orders/1` });
    rig.emit("request", r);
    rig.emit("requestfailed", r);
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [0, 0]);
  });
});

test("only a mutating request to a DEV origin is ever pending: a read and a third party's write are not", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    rig.emit("request", requestOf({ method: "GET", url: `${DEV}/api/orders` }));
    rig.emit("request", requestOf({ method: "POST", url: "https://errors.tracker.example/api/1/envelope" }));
    assert.equal(rig.ledger().pending, 0);
  });
});

test("a write through the request fixture is pending while it is out, counted once it came back, and dropped when it throws", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    let release: (() => void) | undefined;
    rig.setFetch(() => new Promise((resolve) => { release = () => resolve({ ok: () => true }); }));
    const out = rig.fetch({ target: "/api/carts", method: "POST" });
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [0, 1], "pending before the fetch is answered");
    release?.();
    await out;
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [1, 0]);

    rig.setFetch(async () => { throw new Error("socket hang up"); });
    await assert.rejects(rig.fetch({ target: "/api/carts", method: "POST" }), /socket hang up/);
    assert.deepEqual([rig.ledger().writes, rig.ledger().pending], [1, 0], "the throw is the caller's and leaves pending");
  });
});

test("a finished test counts only the writes DEV answered, and says it is done", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    const answered = requestOf({ method: "POST", url: `${DEV}/api/orders` });
    rig.emit("request", answered);
    rig.emit("requestfinished", answered);
    rig.emit("request", requestOf({ method: "POST", url: `${DEV}/api/carts` }));
    await rig.finish();
    const ledger = rig.ledger();
    assert.equal(ledger.writes, 1);
    assert.equal(ledger.done, true);
  });
});

test("a token refresh to the identity provider is never pending, and is recorded apart once it is answered", async () => {
  await withRig(WITH_IDP, async (rig) => {
    await rig.start();
    const r = requestOf({ method: "POST", url: TOKEN, body: REFRESH });
    rig.emit("request", r);
    assert.equal(rig.ledger().pending, 0);
    rig.emit("requestfinished", r);
    const ledger = rig.ledger();
    assert.deepEqual([ledger.writes, ledger.pending], [0, 0]);
    assert.deepEqual(ledger.sessionRequests, [{ method: "POST", url: TOKEN }]);
  });
});

test("each test of a worker has a ledger file of its own, named by process, worker and sequence, and none of the temporary files stays", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    await rig.finish();
    await rig.start();
    const r = requestOf({ method: "POST", url: `${DEV}/api/orders` });
    rig.emit("request", r);
    rig.emit("requestfinished", r);
    await rig.finish();
    const files = rig.files();
    assert.equal(files.length, 2, `two ledgers and nothing else: ${files.join(", ")}`);
    for (const name of files) assert.match(name, new RegExp(`^ledger-p${process.pid}-w3-\\d+\\.json$`));
  });
});

/* The seed's DEV-write counter is what run_spec charges against a flow's share and the run's cap, so it counts a write only once DEV answered it, and keeps a request that is still out apart as `pending`, in a ledger it writes when the test starts and rewrites on every change, so a test that is killed has left what it did: a mutating request to one of the run's DEV origins (PW_DEV_ORIGINS, set by the launcher from the egress lease). A page's own writes to other hosts (analytics, error reporters) cost nothing, and every counted request is recorded beside the count by method, origin + pathname and sender (the page or an API client), with how many times it was sent. The counter decides nothing about who caused a request: the control load a worker runs before its first test records what the page sends with no spec action, and the orchestrator charges against it. The seed cannot be imported (it needs the test runner's package), so the capture block between its markers is compiled and driven with a stand-in page. */
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

/* What the block reads of the test runner's `test` object: the running test's info, which names the project's context options and the test's timeout. */
interface TestStub { info(): unknown }

/* A fresh copy of the block per call: its counters and listened contexts are module state. */
function loadCapture(test: TestStub): Promise<Capture> {
  const start = SEED.indexOf("// >>> qa-failure-capture");
  const end = SEED.indexOf("// Set by the seed's _failureCapture fixture");
  assert.ok(start >= 0 && end > start, "the seed marks its failure capture block");
  const body = SEED.slice(start, end).replace(/^import type .*$/m, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function("test", `return (async () => { ${js}\nreturn { start: qaFailureCaptureStart, finish: qaFailureCaptureFinish }; })();`)(test) as Promise<Capture>;
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
const FINISHED = { v: 2, pending: 0, done: true, project: "desktop" };

const FINISH_INFO = { status: "passed", expectedStatus: "passed", titlePath: ["", "orders.spec.ts", "lists orders"], project: { name: "desktop" }, file: "/e2e/orders.spec.ts", retry: 0, testId: "t1", workerIndex: 0 };

/* The browser of a worker whose `newContext` a spec patched before its first test (its module code or a beforeAll can): it counts the contexts anything asks it for, and answers none. */
function patchedBrowser() {
  const asked: Array<Record<string, unknown>> = [];
  return { browser: { newContext: async (options: Record<string, unknown>) => { asked.push(options); throw new Error("a context the spec's patch would shape"); } }, asked };
}

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
  /* The files the counter left that are not a test's ledger, by name. */
  others(): string[];
}) => Promise<T>, worker?: ReturnType<typeof patchedBrowser>): Promise<T> {
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
    const context = { on: (event: string, fn: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }, request: { fetch: async () => ({}) }, browser: () => worker?.browser ?? null };
    const page = { on() {}, url: () => `${DEV}/orders`, context: () => context, locator: () => ({ ariaSnapshot: async () => "- main" }) };
    const request = { fetch: async (_target: unknown, _options?: { method?: string }) => answer() };
    const info = { timeout: 30_000, project: { name: "desktop" } };
    const { start, finish } = await loadCapture({ info: () => info });
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
      others: () => readdirSync(dir).filter((n) => !n.startsWith("ledger-")),
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
  assert.deepEqual(ledger, { ...FINISHED, writes: 1, requests: [{ method: "POST", url: `${DEV}/api/orders`, sender: "page", count: 1 }] });
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
  assert.deepEqual(ledger, { ...FINISHED, writes: 1, requests: [{ method: "POST", url: `${DEV}/api/carts`, sender: "api", count: 1 }] });
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
  assert.deepEqual(ledger, { ...FINISHED, writes: 2, requests: [{ method: "POST", url: `${DEV}/api/orders`, sender: "page", count: 1 }, { method: "PUT", url: `${DEV}/api/orders`, sender: "api", count: 1 }] });
});

/* ── the counter records who sent a request and how often, and decides nothing about cause ─────────────────────────── */

const IDP = "https://id.example.com";
const WITH_IDP = JSON.stringify([DEV, IDP]);
const TOKEN = `${IDP}/oauth/token`;
const REFRESH = "grant_type=refresh_token&refresh_token=r&client_id=web";

test("a request sent again is one recorded request with its count, kept apart by sender", async () => {
  const browser = [...Array.from({ length: 3 }, () => ({ method: "POST", url: `${DEV}/api/orders?x=1` })), { method: "POST", url: `${DEV}/api/carts` }];
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser, api: [{ target: "/api/orders", method: "POST" }, { target: "/api/orders", method: "POST" }] });
  assert.equal(ledger.writes, 6);
  assert.deepEqual(ledger.requests, [
    { method: "POST", url: `${DEV}/api/orders`, sender: "page", count: 3 },
    { method: "POST", url: `${DEV}/api/carts`, sender: "page", count: 1 },
    { method: "POST", url: `${DEV}/api/orders`, sender: "api", count: 2 },
  ]);
});

test("a token request to the identity provider counts like any other write: the counter keys nothing on a protocol shape or a body", async () => {
  const ledger = await ledgerOf({ origins: WITH_IDP, browser: [{ method: "POST", url: `${TOKEN}?x=1`, body: REFRESH }, { method: "POST", url: TOKEN, body: REFRESH }, { method: "POST", url: TOKEN, body: "throws" }, { method: "POST", url: TOKEN, body: null }] });
  assert.deepEqual(ledger, { ...FINISHED, writes: 4, requests: [{ method: "POST", url: TOKEN, sender: "page", count: 4 }] });
});

test("a page that posts a refresh-token form body to the API origin fifty times has all fifty counted and recorded", async () => {
  const browser = Array.from({ length: 50 }, () => ({ method: "POST", url: `${DEV}/api/orders`, body: REFRESH }));
  const ledger = await ledgerOf({ origins: WITH_IDP, browser });
  assert.deepEqual(ledger, { ...FINISHED, writes: 50, requests: [{ method: "POST", url: `${DEV}/api/orders`, sender: "page", count: 50 }] });
});

test("a ledger records the count of every write even past the distinct requests it keeps", async () => {
  const browser = [...Array.from({ length: 25 }, (_, i) => ({ method: "POST", url: `${DEV}/api/items/${i}` })), ...Array.from({ length: 5 }, () => ({ method: "POST", url: `${DEV}/api/items/0` }))];
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser });
  assert.equal(ledger.writes, 30);
  const requests = ledger.requests as Array<{ count: number }>;
  assert.equal(requests.length, MAX_DEV_WRITE_REQUESTS);
  assert.ok(requests.reduce((sum, r) => sum + r.count, 0) <= 30, "what is recorded never exceeds what is counted");
});

test("a ledger carries nothing about session traffic: no field of it is read by a protocol", async () => {
  const ledger = await ledgerOf({ origins: WITH_IDP, browser: [{ method: "POST", url: TOKEN, body: REFRESH }] });
  assert.equal("controlRequests" in ledger, false);
});

/* ── the control load is not the block's: it runs in a process of its own before the spec child (control-load.run.cjs) ────── */

test("the capture block opens no context of its own and leaves no control: a control made inside the worker could be shaped by the code that ran before the first test", async () => {
  const worker = patchedBrowser();
  await withRig(WITH_IDP, async (rig) => {
    await rig.start();
    assert.deepEqual(worker.asked, [], "a spec's module code or beforeAll that patched the worker's browser sees no context made by the block");
    assert.deepEqual(rig.others(), [], "the control is the orchestrator's, measured in a process no spec code shares");
  }, worker);
});

test("a test's ledger names the project its test belongs to, so the orchestrator charges it against the control of that project", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    assert.equal(rig.ledger().project, "desktop");
  });
});

/* ── the ledger exists from the test's start, so a test that is killed has left what it did ───────────────────────────── */

test("a test's ledger is on disk from its start, before any write: nothing counted, nothing pending, not done", async () => {
  await withRig(DEV_ORIGINS, async (rig) => {
    await rig.start();
    assert.deepEqual(rig.ledger(), { v: 2, writes: 0, pending: 0, done: false, project: "desktop" });
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
    assert.deepEqual(ledger.requests, [{ method: "POST", url: `${DEV}/api/orders`, sender: "page", count: 1 }, { method: "POST", url: `${DEV}/api/carts`, sender: "page", count: 1 }]);
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

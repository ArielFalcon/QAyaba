/* The seed's DEV-write counter is what run_spec charges against a flow's share and the run's cap, so it counts only a write DEV answered: a mutating request to one of the run's DEV origins (PW_DEV_ORIGINS, set by the launcher from the egress lease). A page's own writes to other hosts (analytics, error reporters) cost nothing, and every counted request is recorded beside the count by method and origin + pathname. The seed cannot be imported (it needs the test runner's package), so the capture block between its markers is compiled and driven with a stand-in page. */
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

interface Sent { method: string; url: string }
interface ApiCall { target: string; method: string }

/* One test: the browser context finishes `browser` requests and the `request` fixture fetches `api`; returns the ledger the counter left. */
async function ledgerOf(opts: { browser?: Sent[]; api?: ApiCall[]; origins?: string | undefined; afterLoad?: () => void }): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "seed-dev-writes-"));
  const keys = ["QA_FAILURE_CAPTURE_DIR", "PW_COUNT_DEV_WRITES", "PW_DEV_ORIGINS", "PW_BASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.QA_FAILURE_CAPTURE_DIR = dir;
  process.env.PW_COUNT_DEV_WRITES = "1";
  process.env.PW_BASE_URL = DEV;
  if (opts.origins === undefined) delete process.env.PW_DEV_ORIGINS; else process.env.PW_DEV_ORIGINS = opts.origins;
  try {
    const finished: Array<(r: unknown) => void> = [];
    const context = { on: (event: string, fn: (r: unknown) => void) => { if (event === "requestfinished") finished.push(fn); }, request: { fetch: async () => ({}) } };
    const page = { on() {}, url: () => `${DEV}/orders`, context: () => context, locator: () => ({ ariaSnapshot: async () => "- main" }) };
    const request = { fetch: async (_target: unknown, _options?: { method?: string }) => ({ ok: () => true }) };
    const { start, finish } = await loadCapture();
    opts.afterLoad?.();
    await start(page, request);
    for (const sent of opts.browser ?? []) for (const fn of finished) fn({ method: () => sent.method, url: () => sent.url });
    for (const call of opts.api ?? []) await request.fetch(call.target, { method: call.method });
    await finish(page, { status: "passed", expectedStatus: "passed", titlePath: ["", "orders.spec.ts", "lists orders"], project: { name: "desktop" }, file: "/e2e/orders.spec.ts", retry: 0, testId: "t1", workerIndex: 0 });
    const ledger = readdirSync(dir).find((n) => n.startsWith("ledger-"));
    assert.ok(ledger, "the counter leaves a ledger");
    return JSON.parse(readFileSync(join(dir, ledger), "utf8")) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test("a page that writes by itself to a third-party origin leaves the write count at 0", async () => {
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser: [{ method: "POST", url: "https://errors.tracker.example/api/1/envelope?key=k" }, { method: "PUT", url: "https://analytics.example.org/collect" }] });
  assert.deepEqual(ledger, { writes: 0 });
});

test("a write to a declared DEV origin counts, and is recorded by method and origin + pathname without its query", async () => {
  const ledger = await ledgerOf({ origins: DEV_ORIGINS, browser: [{ method: "POST", url: `${DEV}/api/orders?token=secret` }, { method: "GET", url: `${DEV}/api/orders` }] });
  assert.deepEqual(ledger, { writes: 1, requests: [{ method: "POST", url: `${DEV}/api/orders` }] });
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
  assert.deepEqual(ledger, { writes: 1, requests: [{ method: "POST", url: `${DEV}/api/carts` }] });
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
  assert.deepEqual(ledger, { writes: 2, requests: [{ method: "POST", url: `${DEV}/api/orders` }, { method: "PUT", url: `${DEV}/api/orders` }] });
});

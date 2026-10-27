/* The seed's failure capture records as network errors only the requests the page depends on: the app's own origin or an origin it declares, for a document, fetch, xhr, script or style sheet. The rest of the failed traffic (error-tracking and analytics beacons, a map vendor's events, the browser's housekeeping) is counted apart and never explains a case. The seed cannot be imported (it needs the test runner's package), so the capture block between its markers is compiled and driven with a stand-in page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

interface Capture {
  start(page: unknown, request: unknown): Promise<void>;
  finish(page: unknown, testInfo: unknown): Promise<void>;
}

const capture = (() => {
  const start = SEED.indexOf("// >>> qa-failure-capture");
  const end = SEED.indexOf("// Set by the seed's _failureCapture fixture");
  assert.ok(start >= 0 && end > start, "the seed marks its failure capture block");
  const body = SEED.slice(start, end).replace(/^import type .*$/m, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(`return (async () => { ${js}\nreturn { start: qaFailureCaptureStart, finish: qaFailureCaptureFinish }; })();`)() as Promise<Capture>;
})();

const APP = "https://app.example";

interface Failure { url: string; type: string; status?: number }

/* One test attempt: the page fails the given requests (status: answered with it; none: the request failed), then the capture runs. Returns the dump it wrote, if any. */
async function attempt(opts: { failures: Failure[]; origins?: string[]; noBase?: boolean; expected?: boolean; finalUrl?: string }): Promise<Record<string, unknown> | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "seed-network-"));
  const saved = { dir: process.env.QA_FAILURE_CAPTURE_DIR, origins: process.env.PW_APP_ORIGINS, base: process.env.PW_BASE_URL };
  process.env.QA_FAILURE_CAPTURE_DIR = dir;
  if (opts.noBase) delete process.env.PW_BASE_URL; else process.env.PW_BASE_URL = APP;
  if (opts.origins) process.env.PW_APP_ORIGINS = JSON.stringify(opts.origins); else delete process.env.PW_APP_ORIGINS;
  try {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const page = {
      on: (event: string, fn: (arg: unknown) => void) => { (handlers[event] ??= []).push(fn); },
      url: () => opts.finalUrl ?? `${APP}/orders`,
      locator: () => ({ ariaSnapshot: async () => "- main" }),
    };
    const { start, finish } = await capture;
    await start(page, {});
    for (const f of opts.failures) {
      const request = { url: () => f.url, resourceType: () => f.type, method: () => "GET", failure: () => ({ errorText: "net::ERR_FAILED" }) };
      if (f.status === undefined) for (const fn of handlers.requestfailed ?? []) fn(request);
      else for (const fn of handlers.response ?? []) fn({ url: () => f.url, status: () => f.status, request: () => request });
    }
    const expected = opts.expected ?? true;
    await finish(page, { status: expected ? "passed" : "failed", expectedStatus: "passed", titlePath: ["", "orders.spec.ts", "lists orders"], project: { name: "desktop" }, file: "/e2e/orders.spec.ts", retry: 0, testId: "t1", workerIndex: 0 });
    const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
    return files.length > 0 ? JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<string, unknown> : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [["QA_FAILURE_CAPTURE_DIR", saved.dir], ["PW_APP_ORIGINS", saved.origins], ["PW_BASE_URL", saved.base]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const BEACONS: Failure[] = [
  { url: "https://errors.tracker.example/api/1/envelope?key=k", type: "fetch" },
  { url: "https://events.maps.example/log", type: "ping" },
  { url: "https://background.browser.example/update.js", type: "script" },
];

test("a passing test whose only failed requests are third-party beacons writes no failure dump", async () => {
  assert.equal(await attempt({ failures: BEACONS }), undefined);
});

test("a failing test counts third-party failures apart and keeps them out of its network errors", async () => {
  const dump = await attempt({ failures: [...BEACONS, { url: `${APP}/api/orders?page=1`, type: "fetch" }], expected: false });
  assert.deepEqual(dump?.networkErrors, [{ url: `${APP}/api/orders`, errorText: "net::ERR_FAILED", resourceType: "fetch" }]);
  assert.deepEqual(dump?.backgroundNetwork, { count: 3, hosts: ["errors.tracker.example", "events.maps.example", "background.browser.example"] });
});

test("a failed fetch to an origin the app declares is a network error, wildcard origins included", async () => {
  const dump = await attempt({
    failures: [{ url: "https://api.backend.example:8443/orders", type: "fetch" }, { url: "https://eu.cdn.example/app.js", type: "script" }, { url: "https://api.backend.example/orders", type: "fetch" }],
    origins: [APP, "https://api.backend.example:8443", "https://*.cdn.example"],
  });
  assert.deepEqual((dump?.networkErrors as { url: string }[]).map((e) => e.url), ["https://api.backend.example:8443/orders", "https://eu.cdn.example/app.js"]);
  assert.deepEqual(dump?.backgroundNetwork, { count: 1, hosts: ["api.backend.example"] });
});

test("a failed image, font or beacon of the app's own origin is background, not a network error", async () => {
  const dump = await attempt({
    failures: [{ url: `${APP}/logo.png`, type: "image" }, { url: `${APP}/f.woff2`, type: "font" }, { url: `${APP}/api/orders`, type: "xhr" }],
    expected: false,
  });
  assert.deepEqual((dump?.networkErrors as { url: string }[]).map((e) => e.url), [`${APP}/api/orders`]);
  assert.equal((dump?.backgroundNetwork as { count: number }).count, 2);
});

test("a same-origin 5xx of a foreground request is still attributed and recorded", async () => {
  const dump = await attempt({ failures: [{ url: `${APP}/api/orders`, type: "fetch", status: 503 }] });
  assert.equal(dump?.httpStatus, 503);
  assert.deepEqual(dump?.networkErrors, [{ url: `${APP}/api/orders`, status: 503, resourceType: "fetch" }]);
  assert.equal(dump?.backgroundNetwork, undefined);
});

test("a third-party 5xx neither attributes the page's status nor makes a passing test dump", async () => {
  assert.equal(await attempt({ failures: [{ url: "https://errors.tracker.example/envelope", type: "fetch", status: 502 }] }), undefined);
  const dump = await attempt({ failures: [{ url: "https://errors.tracker.example/envelope", type: "fetch", status: 502 }], expected: false });
  assert.equal(dump?.httpStatus, undefined);
  assert.deepEqual(dump?.networkErrors, []);
  assert.equal((dump?.backgroundNetwork as { count: number }).count, 1);
});

test("without the declared origins the app's own origin alone is the page's", async () => {
  const dump = await attempt({ failures: [{ url: `${APP}/api/orders`, type: "fetch" }, { url: "https://api.backend.example/orders", type: "fetch" }] });
  assert.deepEqual((dump?.networkErrors as { url: string }[]).map((e) => e.url), [`${APP}/api/orders`]);
});

test("with no origin known at all (a run outside the orchestrator) no host is foreign, and the resource type alone decides", async () => {
  const dump = await attempt({ failures: [{ url: "https://api.backend.example/orders", type: "fetch" }, { url: "https://events.maps.example/log", type: "ping" }], noBase: true });
  assert.deepEqual((dump?.networkErrors as { url: string }[]).map((e) => e.url), ["https://api.backend.example/orders"]);
  assert.equal((dump?.backgroundNetwork as { count: number }).count, 1);
});

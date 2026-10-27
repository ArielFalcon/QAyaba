/* The seed's observation record is what the orchestrator diffs between a mutant's re-run and the unmutated one: for each test that ran, the requests its page depended on (method, origin and pathname with a count, never a query) and the accessible tree it ended on. It exists only when the orchestrator asks (PW_OBSERVE=1), so an ordinary run leaves what it always left. */
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

/* A fresh copy of the block per call: its collections are module state. */
function loadCapture(): Promise<Capture> {
  const start = SEED.indexOf("// >>> qa-failure-capture");
  const end = SEED.indexOf("// Set by the seed's _failureCapture fixture");
  assert.ok(start >= 0 && end > start, "the seed marks its failure capture block");
  const body = SEED.slice(start, end).replace(/^import type .*$/m, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(`return (async () => { ${js}\nreturn { start: qaFailureCaptureStart, finish: qaFailureCaptureFinish }; })();`)() as Promise<Capture>;
}

interface Sent { method: string; url: string; type: string }
interface Left { observed: Record<string, unknown> | undefined; files: string[] }

const TREE = '- main:\n  - heading "Map" [level=1]\n  - button "Dark theme" [pressed]\n';

/* One test whose page sends `sent`; returns what the capture left in its directory. */
async function leftBy(opts: { observe: boolean; sent?: Sent[]; status?: string; tree?: string | "throws" }): Promise<Left> {
  const dir = mkdtempSync(join(tmpdir(), "seed-observe-"));
  const keys = ["QA_FAILURE_CAPTURE_DIR", "PW_OBSERVE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.QA_FAILURE_CAPTURE_DIR = dir;
  if (opts.observe) process.env.PW_OBSERVE = "1"; else delete process.env.PW_OBSERVE;
  try {
    const requested: Array<(r: unknown) => void> = [];
    const page = {
      on: (event: string, fn: (r: unknown) => void) => { if (event === "request") requested.push(fn); },
      url: () => "https://dev.example.com/map",
      context: () => ({ on() {}, request: { fetch: async () => ({}) } }),
      locator: () => ({ ariaSnapshot: async () => { if (opts.tree === "throws") throw new Error("page closed"); return opts.tree ?? TREE; } }),
    };
    const { start, finish } = await loadCapture();
    await start(page, { fetch: async () => ({ ok: () => true }) });
    for (const sent of opts.sent ?? []) for (const fn of requested) fn({ method: () => sent.method, url: () => sent.url, resourceType: () => sent.type });
    const status = opts.status ?? "passed";
    await finish(page, { status, expectedStatus: status === "skipped" ? "skipped" : "passed", titlePath: ["", "map.spec.ts", "map shell", "applies the theme"], project: { name: "desktop" }, file: "/e2e/map.spec.ts", retry: 0, testId: "t1", workerIndex: 0 });
    const files = readdirSync(dir);
    const observed = files.find((n) => n.startsWith("observed-"));
    return { observed: observed ? (JSON.parse(readFileSync(join(dir, observed), "utf8")) as Record<string, unknown>) : undefined, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test("a test that ran under PW_OBSERVE leaves the requests its page depended on, by method and origin + pathname with a count, and the tree it ended on", async () => {
  const { observed } = await leftBy({
    observe: true,
    sent: [
      { method: "GET", url: "https://api.maps.example/styles/v1/acme/dark?access_token=secret-token", type: "fetch" },
      { method: "GET", url: "https://api.maps.example/styles/v1/acme/dark?access_token=secret-token", type: "fetch" },
      { method: "POST", url: "https://dev.example.com/api/prefs#frag", type: "xhr" },
    ],
  });
  assert.ok(observed, "an observation is left");
  assert.deepEqual(observed.requests, [
    { method: "GET", url: "https://api.maps.example/styles/v1/acme/dark", count: 2 },
    { method: "POST", url: "https://dev.example.com/api/prefs", count: 1 },
  ]);
  assert.equal(observed.yaml, TREE);
  assert.equal(observed.file, "map.spec.ts");
  assert.equal(observed.title, "map shell › applies the theme");
  assert.doesNotMatch(JSON.stringify(observed), /secret-token|frag/);
});

test("background traffic the page does not depend on (an image, a font, a beacon) is not an observed request, whatever its host", async () => {
  const { observed } = await leftBy({
    observe: true,
    sent: [
      { method: "GET", url: "https://tiles.example/12/1/2.png", type: "image" },
      { method: "POST", url: "https://errors.example/envelope", type: "ping" },
      { method: "GET", url: "https://dev.example.com/api/places", type: "xhr" },
    ],
  });
  assert.deepEqual(observed?.requests, [{ method: "GET", url: "https://dev.example.com/api/places", count: 1 }]);
});

test("the observation is bounded: past the distinct requests it keeps, a new one is not recorded", async () => {
  const sent = Array.from({ length: 150 }, (_, i): Sent => ({ method: "GET", url: `https://dev.example.com/api/item/${i}`, type: "fetch" }));
  const { observed } = await leftBy({ observe: true, sent });
  assert.equal((observed?.requests as unknown[]).length, 100);
});

test("a tree that cannot be read still leaves the requests", async () => {
  const { observed } = await leftBy({ observe: true, sent: [{ method: "GET", url: "https://dev.example.com/api/places", type: "fetch" }], tree: "throws" });
  assert.deepEqual(observed?.requests, [{ method: "GET", url: "https://dev.example.com/api/places", count: 1 }]);
  assert.equal(observed?.yaml, undefined);
});

test("a skipped test leaves no observation", async () => {
  const { observed } = await leftBy({ observe: true, sent: [{ method: "GET", url: "https://dev.example.com/api/places", type: "fetch" }], status: "skipped" });
  assert.equal(observed, undefined);
});

test("without PW_OBSERVE a passing test leaves nothing, as before", async () => {
  const { observed, files } = await leftBy({ observe: false, sent: [{ method: "GET", url: "https://dev.example.com/api/places", type: "fetch" }] });
  assert.equal(observed, undefined);
  assert.deepEqual(files, []);
});

test("under PW_OBSERVE a passing test leaves only its observation: the failure dump is still written for a failure alone", async () => {
  const passing = await leftBy({ observe: true });
  assert.deepEqual(passing.files.filter((n) => !n.startsWith("observed-")), []);
  const failing = await leftBy({ observe: true, status: "failed" });
  assert.ok(failing.files.some((n) => !n.startsWith("observed-")), "the failure dump of a failed test");
});

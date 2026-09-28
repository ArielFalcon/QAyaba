/* The benchmark's run command: cases go through the service one at a time and every run id is
   remembered under its label. A scripted fake service stands in for the orchestrator's control API. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, runBenchmark } from "./efficiency-benchmark.ts";

interface FakeService {
  fetch: typeof fetch;
  posts: Array<Record<string, unknown>>;
  /** The order in which the service saw run starts and run completions. */
  timeline: string[];
}

/** A control API that runs one run at a time and fails the moment a second run is submitted while another is unfinished. */
function fakeService(opts: { queue?: { pending: number; running: { id: string; app: string } | null }; neverFinish?: boolean } = {}): FakeService {
  const service: FakeService = { fetch: undefined as unknown as typeof fetch, posts: [], timeline: [] };
  let active: { id: string; polls: number } | null = null;
  let counter = 0;
  service.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v1/queue") {
      return new Response(JSON.stringify(opts.queue ?? { pending: 0, running: null }), { status: 200 });
    }
    if (method === "POST" && path === "/api/v1/runs") {
      assert.equal(active, null, "a case was submitted while the previous run was still unfinished");
      service.posts.push(JSON.parse(String(init!.body)));
      active = { id: `run-${++counter}`, polls: 0 };
      service.timeline.push(`start ${active.id}`);
      return new Response(JSON.stringify({ id: active.id }), { status: 202 });
    }
    const match = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (match && active && match[1] === active.id) {
      active.polls++;
      const done = !opts.neverFinish && active.polls >= 2;
      if (done) {
        service.timeline.push(`finish ${active.id}`);
        const id = active.id;
        active = null;
        return new Response(JSON.stringify({ id, status: "done", verdict: "pass", passed: 1, failed: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: active.id, status: "running" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return service;
}

function workspace(t: import("node:test").TestContext, cases: unknown): { casesPath: string; resultsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const casesPath = join(dir, "efficiency-cases.json");
  writeFileSync(casesPath, typeof cases === "string" ? cases : JSON.stringify(cases));
  return { casesPath, resultsDir: join(dir, "results") };
}

const threeCases = [
  { name: "auth-range", app: "demo", sha: "aaaaaaa", baseSha: "bbbbbbb", mode: "diff" },
  { name: "checkout", app: "demo", sha: "ccccccc" },
  { name: "search", app: "demo", sha: "ddddddd", guidance: "test the search box", mode: "manual", target: "code" },
];

test("cases run one at a time: each finishes before the next is submitted", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService();

  const result = await runBenchmark("after", { casesPath, resultsDir, service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1 } });

  assert.deepEqual(service.timeline, ["start run-1", "finish run-1", "start run-2", "finish run-2", "start run-3", "finish run-3"]);
  assert.deepEqual(result.completed.map((c) => c.caseName), ["auth-range", "checkout", "search"]);
  assert.equal(result.stopped, undefined);
});

test("each case is submitted with its own sha, range start, mode, target and guidance", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService();

  await runBenchmark("after", { casesPath, resultsDir, service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1 } });

  assert.equal(service.posts[0]!.sha, "aaaaaaa");
  assert.equal(service.posts[0]!.baseSha, "bbbbbbb");
  assert.equal(service.posts[0]!.mode, "diff");
  assert.equal("baseSha" in service.posts[1]!, false);
  assert.equal(service.posts[2]!.guidance, "test the search box");
  assert.equal(service.posts[2]!.target, "code");
});

test("every run id is remembered under the label, keyed by case name", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService();

  await runBenchmark("after", { casesPath, resultsDir, service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1 } });

  assert.deepEqual(readRegistry(resultsDir, "after"), { "auth-range": "run-1", checkout: "run-2", search: "run-3" });
});

test("a malformed case file fails loudly and nothing is submitted", async (t) => {
  const { casesPath, resultsDir } = workspace(t, JSON.stringify([{ name: "no-app-or-sha" }]));
  const service = fakeService();
  let calls = 0;
  const counting = ((...args: Parameters<typeof fetch>) => { calls++; return service.fetch(...args); }) as typeof fetch;

  await assert.rejects(
    runBenchmark("after", { casesPath, resultsDir, service: { fetch: counting, baseUrl: "http://svc", pollMs: 1 } }),
    /must be a JSON array of EfficiencyBenchmarkCase objects/,
  );
  assert.equal(calls, 0, "no request may reach the service before the case file validates");
});

test("a busy queue is refused before anything is submitted", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService({ queue: { pending: 0, running: { id: "run-other", app: "demo" } } });

  await assert.rejects(
    runBenchmark("after", { casesPath, resultsDir, service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1 } }),
    /queue is busy/,
  );
  assert.equal(service.posts.length, 0);
});

test("a queue with pending work is refused too", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService({ queue: { pending: 2, running: null } });

  await assert.rejects(
    runBenchmark("after", { casesPath, resultsDir, service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1 } }),
    /queue is busy/,
  );
  assert.equal(service.posts.length, 0);
});

test("a run that outlives the timeout stops the benchmark: its run id is kept and no later case is submitted", async (t) => {
  const { casesPath, resultsDir } = workspace(t, threeCases);
  const service = fakeService({ neverFinish: true });
  let clock = 0;

  const result = await runBenchmark("after", {
    casesPath,
    resultsDir,
    service: { fetch: service.fetch, baseUrl: "http://svc", pollMs: 1, timeoutMs: 5, now: () => (clock += 2) },
  });

  assert.equal(service.posts.length, 1, "the second case must not be submitted after a timeout");
  assert.deepEqual(result.stopped, { caseName: "auth-range", runId: "run-1", reason: "timeout" });
  assert.deepEqual(readRegistry(resultsDir, "after"), { "auth-range": "run-1" });
});

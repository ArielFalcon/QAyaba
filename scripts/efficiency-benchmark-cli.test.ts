/* The benchmark's command-line surface, driven through main() with its collaborators injected. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_TIER_NAMES } from "@contexts/generation/domain/diff-stat.ts";
import { main, readRegistry, readSnapshot, registerRun, writeSnapshot, takeSnapshot, type RunDataSource } from "./efficiency-benchmark.ts";
import type { RunOutcome, RunRecord } from "../src/types.ts";

function harness(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  return { dir, resultsDir: join(dir, "results"), casesPath: join(dir, "cases.json"), lines, out: (line: string) => lines.push(line) };
}

const source = (): RunDataSource => ({
  events: () => [{ type: "step.changed", step: "generate" }, { type: "agent.activity", kind: "writing", target: "t", status: "completed", callId: "c1" }],
  outcome: () => ({ runId: "r", app: "demo", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass", errorClass: null, gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 }, rulesRetrieved: [], at: "t" }) as RunOutcome,
  record: () => ({ id: "r", app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "done", passed: 1, failed: 0, cases: [], logs: [], at: "t" }) as RunRecord,
  turns: () => [],
});

test("without a command it prints the usage and exits 2", async (t) => {
  const h = harness(t);
  const code = await main([], { resultsDir: h.resultsDir, out: h.out });
  assert.equal(code, 2);
  assert.match(h.lines.join("\n"), /usage/i);
  assert.match(h.lines.join("\n"), /snapshot/);
});

test("register attaches an existing run to a case of a label", async (t) => {
  const h = harness(t);
  const code = await main(["register", "baseline", "checkout", "run-9"], { resultsDir: h.resultsDir, out: h.out });
  assert.equal(code, 0);
  assert.deepEqual(readRegistry(h.resultsDir, "baseline"), { checkout: "run-9" });
});

test("register with a missing argument or an unsafe label is refused", async (t) => {
  const h = harness(t);
  assert.equal(await main(["register", "baseline", "checkout"], { resultsDir: h.resultsDir, out: h.out }), 2);
  assert.equal(await main(["register", "../x", "checkout", "run-9"], { resultsDir: h.resultsDir, out: h.out }), 1);
  assert.match(h.lines.join("\n"), /invalid label/);
});

test("snapshot freezes the label's registered runs and says how many cases have data", async (t) => {
  const h = harness(t);
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");
  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => source(), now: () => "2026-09-28T12:00:00.000Z" });
  assert.equal(code, 0);
  assert.notEqual(readSnapshot(h.resultsDir, "baseline")!.cases.checkout!.data, null);
  assert.match(h.lines.join("\n"), /1 case.*measured/);
});

test("snapshot says how many runs had not finished, so they are not mistaken for pruned ones", async (t) => {
  const h = harness(t);
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");
  const going: RunDataSource = { ...source(), outcome: () => undefined, record: () => ({ id: "r", app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" }) as RunRecord };
  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => going, now: () => "2026-09-28T12:00:00.000Z" });
  assert.equal(code, 0);
  assert.match(h.lines.join("\n"), /1 not finished/);
  assert.equal(readSnapshot(h.resultsDir, "baseline")!.cases.checkout!.notFinished, true);
});

test("snapshot records the tier each case declares in the cases file, and none for a case the file does not name", async (t) => {
  const h = harness(t);
  writeFileSync(h.casesPath, JSON.stringify([
    { name: "checkout", app: "demo", sha: "abc1234", tier: DIFF_TIER_NAMES[0] },
    { name: "search", app: "demo", sha: "def5678" },
  ]));
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");
  registerRun(h.resultsDir, "baseline", "search", "run-2");
  registerRun(h.resultsDir, "baseline", "registered-by-hand", "run-3");

  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => source(), now: () => "2026-09-28T12:00:00.000Z" });

  assert.equal(code, 0);
  const { cases } = readSnapshot(h.resultsDir, "baseline")!;
  assert.equal(cases.checkout?.tier, DIFF_TIER_NAMES[0]);
  assert.equal(cases.search?.tier, undefined, "the case is in the file but declares no tier");
  assert.equal(cases["registered-by-hand"]?.tier, undefined, "the case is not in the file");
});

test("snapshot works without a cases file: runs registered by hand declare no tier", async (t) => {
  const h = harness(t);
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");

  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => source(), now: () => "2026-09-28T12:00:00.000Z" });

  assert.equal(code, 0);
  assert.equal(readSnapshot(h.resultsDir, "baseline")!.cases.checkout!.tier, undefined);
});

test("snapshot fails loudly on a cases file that declares a tier no size class names, and writes nothing", async (t) => {
  const h = harness(t);
  writeFileSync(h.casesPath, JSON.stringify([{ name: "checkout", app: "demo", sha: "abc1234", tier: "tinny" }]));
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");

  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => source() });

  assert.equal(code, 1);
  assert.match(h.lines.join("\n"), /case 'checkout'.*"tinny"/);
  assert.equal(existsSync(join(h.resultsDir, "baseline.snapshot.json")), false);
});

test("snapshot of a label with nothing registered is an error, not an empty snapshot", async (t) => {
  const h = harness(t);
  const code = await main(["snapshot", "empty"], { resultsDir: h.resultsDir, out: h.out, sourceFor: () => source() });
  assert.equal(code, 1);
  assert.match(h.lines.join("\n"), /no runs registered/);
  assert.equal(existsSync(join(h.resultsDir, "empty.snapshot.json")), false);
});

test("snapshot that would shrink an existing one exits 1 and says why", async (t) => {
  const h = harness(t);
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");
  writeSnapshot(h.resultsDir, takeSnapshot("baseline", h.resultsDir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  const gone: RunDataSource = { events: () => [], outcome: () => undefined, record: () => undefined, turns: () => [] };

  const code = await main(["snapshot", "baseline"], { resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out, sourceFor: () => gone });

  assert.equal(code, 1);
  assert.match(h.lines.join("\n"), /refusing to overwrite snapshot 'baseline'/);
});

test("report prints both labels' cases from their snapshots", async (t) => {
  const h = harness(t);
  for (const label of ["baseline", "after"]) {
    registerRun(h.resultsDir, label, "checkout", `${label}-run`);
    writeSnapshot(h.resultsDir, takeSnapshot(label, h.resultsDir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  }
  const code = await main(["report", "baseline", "after"], { resultsDir: h.resultsDir, out: h.out });
  assert.equal(code, 0);
  assert.match(h.lines.join("\n"), /case: checkout/);
});

test("report exits 0 and reads every figure it could not observe as unknown: the telemetry never gates", async (t) => {
  const h = harness(t);
  const unobserved: RunDataSource = {
    ...source(),
    turns: () => [{
      runId: "r", sessionId: "s1", role: "qa-generator", round: 0, isRepair: false, ts: "t", objective: null, promptText: "p", outputText: "o", promptBytes: 1,
      tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null,
    }],
  };
  for (const label of ["baseline", "after"]) {
    registerRun(h.resultsDir, label, "checkout", `${label}-run`);
    writeSnapshot(h.resultsDir, takeSnapshot(label, h.resultsDir, () => unobserved, () => "2026-09-28T12:00:00.000Z"));
  }

  const code = await main(["report", "baseline", "after"], { resultsDir: h.resultsDir, out: h.out });

  assert.equal(code, 0);
  assert.match(h.lines.join("\n"), /step use n\/a/);
  assert.match(h.lines.join("\n"), /mean n\/a/);
});

test("report names the label whose snapshot is missing instead of comparing against nothing", async (t) => {
  const h = harness(t);
  registerRun(h.resultsDir, "baseline", "checkout", "run-1");
  writeSnapshot(h.resultsDir, takeSnapshot("baseline", h.resultsDir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  const code = await main(["report", "baseline", "after"], { resultsDir: h.resultsDir, out: h.out });
  assert.equal(code, 1);
  assert.match(h.lines.join("\n"), /no snapshot for label 'after'/);
});

test("run submits the cases through the service and reports each verdict", async (t) => {
  const h = harness(t);
  writeFileSync(h.casesPath, JSON.stringify([{ name: "checkout", app: "demo", sha: "abc1234" }]));
  let polls = 0;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/queue") return new Response(JSON.stringify({ pending: 0, running: null }), { status: 200 });
    if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ id: "run-1" }), { status: 202 });
    polls++;
    return new Response(JSON.stringify({ id: "run-1", status: polls >= 2 ? "done" : "running", verdict: "pass", passed: 1, failed: 0 }), { status: 200 });
  }) as unknown as typeof fetch;

  const code = await main(["run", "after"], {
    resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out,
    service: { fetch: fetchStub, baseUrl: "http://svc", pollMs: 1 },
  });

  assert.equal(code, 0);
  assert.deepEqual(readRegistry(h.resultsDir, "after"), { checkout: "run-1" });
  assert.match(h.lines.join("\n"), /checkout/);
});

test("run exits 1 when the benchmark could not run (busy queue)", async (t) => {
  const h = harness(t);
  writeFileSync(h.casesPath, JSON.stringify([{ name: "checkout", app: "demo", sha: "abc1234" }]));
  const fetchStub = (async () => new Response(JSON.stringify({ pending: 1, running: null }), { status: 200 })) as unknown as typeof fetch;

  const code = await main(["run", "after"], {
    resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out,
    service: { fetch: fetchStub, baseUrl: "http://svc", pollMs: 1 },
  });

  assert.equal(code, 1);
  assert.match(h.lines.join("\n"), /queue is busy/);
});

/* A service whose run never finishes, on a clock that advances one minute per look at it: how many looks
   the benchmark makes before giving up shows how long it waits. */
async function looksBeforeGivingUp(t: import("node:test").TestContext, argv: string[]): Promise<{ code: number; looks: number }> {
  const h = harness(t);
  writeFileSync(h.casesPath, JSON.stringify([{ name: "checkout", app: "demo", sha: "abc1234" }]));
  let looks = 0;
  let clock = 0;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/queue") return new Response(JSON.stringify({ pending: 0, running: null }), { status: 200 });
    if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ id: "run-1" }), { status: 202 });
    looks++;
    return new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 200 });
  }) as unknown as typeof fetch;
  const code = await main(argv, {
    resultsDir: h.resultsDir, casesPath: h.casesPath, out: h.out,
    service: { fetch: fetchStub, baseUrl: "http://svc", pollMs: 1, now: () => (clock += 60_000) },
  });
  return { code, looks };
}

test("run waits longer for a case when given a longer per-case timeout, and keeps the default wait otherwise", async (t) => {
  const byDefault = await looksBeforeGivingUp(t, ["run", "after"]);
  const extended = await looksBeforeGivingUp(t, ["run", "after", "--timeout-minutes", "120"]);

  assert.equal(byDefault.code, 1);
  assert.equal(extended.code, 1);
  assert.ok(extended.looks > byDefault.looks * 2, `the default gave up after ${byDefault.looks} looks, the extended one after ${extended.looks}`);
});

test("run refuses a per-case timeout that is not a positive number of minutes", async (t) => {
  for (const bad of ["0", "-5", "soon", ""]) {
    const h = harness(t);
    const code = await main(["run", "after", "--timeout-minutes", bad], { resultsDir: h.resultsDir, out: h.out });
    assert.equal(code, 2, `--timeout-minutes ${JSON.stringify(bad)}`);
    assert.match(h.lines.join("\n"), /timeout-minutes/);
  }
});

/* The post-run hook (where the evaluation grader hangs) and the facts the runner stores with a run's final status. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun, cancelTrackedRun, finalizeInterruptedRuns, type RunnerDeps } from "./runner";
import { getRecord, getRunFacts, createRecord, updateRecord } from "./history";
import type { AppConfig } from "../orchestrator/config-loader";
import type { RunPipelinePort, RunInput } from "@contexts/run-orchestration/application/index.ts";
import type { RunOutcome } from "@kernel/run-outcome";
import { attachTraceFacts } from "@kernel/run-trace-facts";
import { traceHarness } from "../telemetry/trace-harness";

const cfg = (name: string): AppConfig => ({ name, repo: "org/demo", dev: { baseUrl: "https://dev" }, qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true }, report: { onFailure: "github-issue" } });

let n = 0;
const uniqueApp = (): string => `after-run-${(n += 1)}-${Math.random().toString(36).slice(2, 7)}`;

function port(patch: Partial<RunOutcome> = {}, facts?: Parameters<typeof attachTraceFacts>[1]): RunPipelinePort {
  return {
    run: async (input: RunInput) => {
      const outcome: RunOutcome = {
        runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target, verdict: "pass", errorClass: null,
        gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
        rulesRetrieved: [], at: new Date(0).toISOString(), ...patch,
      };
      return facts ? attachTraceFacts(outcome, facts) : outcome;
    },
  };
}

const req = (app: string) => ({ app, sha: "abc1234", target: "e2e" as const, mode: "diff" as const, source: "manual" as const });
const base = (p: RunPipelinePort, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({ loadApp: cfg, engineFactory: () => p, ...extra });

test("the post-run hook is told the run id once the record is final", async () => {
  const seen: Array<{ id: string; status: string | undefined; verdict: string | undefined }> = [];
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), { afterRun: (runId) => { const r = getRecord(runId); seen.push({ id: runId, status: r?.status, verdict: r?.verdict }); } }));
  await queue.drain();
  assert.deepEqual(seen, [{ id, status: "done", verdict: "pass" }]);
});

test("a post-run hook that throws changes nothing about the run", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), { afterRun: () => { throw new Error("grader exploded"); } }));
  await queue.drain();
  assert.equal(getRecord(id)?.verdict, "pass");
});

test("a post-run hook that rejects is contained", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), { afterRun: () => Promise.reject(new Error("grader rejected")) }));
  await queue.drain();
  await new Promise((r) => setImmediate(r));
  assert.equal(getRecord(id)?.status, "done");
});

test("a post-run hook that never finishes does not delay the queue or the next run", async () => {
  const queue = new JobQueue();
  let hangs = 0;
  const hanging: Partial<RunnerDeps> = { afterRun: () => { hangs += 1; return new Promise<void>(() => undefined); } };
  const first = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), hanging));
  const second = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), hanging));
  await queue.drain();
  assert.equal(getRecord(first)?.status, "done");
  assert.equal(getRecord(second)?.status, "done");
  assert.equal(hangs, 2);
});

test("a crashed run is handed to the post-run hook too", async () => {
  const seen: string[] = [];
  const queue = new JobQueue();
  const crashing: RunPipelinePort = { run: async () => { throw new Error("boom"); } };
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(crashing, { afterRun: (r) => { seen.push(r); } }));
  await queue.drain();
  assert.equal(getRecord(id)?.verdict, "infra-error");
  assert.deepEqual(seen, [id]);
});

test("the run's trace id, decision and the limit that ended it are stored with its final status", async () => {
  const h = traceHarness();
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port({ verdict: "infra-error", errorClass: "E-TIME-BUDGET" }, { decision: "none", limitFired: "run-deadline", limitRole: "qa-generator" }), { telemetry: h.telemetry, clock: h.clock }));
  await queue.drain();
  const facts = getRunFacts(id)!;
  assert.match(facts.traceId ?? "", /^[0-9a-f]{32}$/);
  assert.equal(facts.decision, "none");
  assert.equal(facts.limitFired, "run-deadline");
  assert.equal(facts.limitRole, "qa-generator");
});

test("a run with telemetry off stores no trace id", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port({}, { decision: "pr" })));
  await queue.drain();
  assert.equal(getRunFacts(id)?.traceId, null);
  assert.equal(getRunFacts(id)?.decision, "pr");
});

test("the engine's run-time decisions are stored with the run and nothing is recomputed later", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port({}, { decision: "pr", reviewRequired: true, coverage: { status: "fail", mode: "enforce", minRatio: 0.8 } })));
  await queue.drain();
  const f = getRunFacts(id)!;
  assert.deepEqual([f.reviewRequired, f.coverageStatus, f.coverageMode, f.coverageMinRatio], [true, "fail", "enforce", 0.8]);
});

test("a run whose engine measured no coverage stores no coverage decision", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port({}, { decision: "none", reviewRequired: false, coverage: { mode: "signal" } })));
  await queue.drain();
  const f = getRunFacts(id)!;
  assert.deepEqual([f.reviewRequired, f.coverageStatus, f.coverageMode], [false, null, "signal"]);
});

test("cancelling a run that is still enqueued marks it cancelled, hands it to the post-run hook and leaves the queue moving", async () => {
  const queue = new JobQueue();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const blocking: RunPipelinePort = { run: async (input) => { await gate; return port().run(input); } };
  const seen: Array<{ id: string; cancelled: boolean | null | undefined }> = [];
  const afterRun = (runId: string) => { seen.push({ id: runId, cancelled: getRunFacts(runId)?.cancelled }); };
  const h = traceHarness();
  const first = enqueueTrackedRun(queue, req(uniqueApp()), base(blocking, { afterRun, telemetry: h.telemetry, clock: h.clock }));
  const second = enqueueTrackedRun(queue, req(uniqueApp()), base(port(), { afterRun, telemetry: h.telemetry, clock: h.clock }));
  assert.equal(cancelTrackedRun(queue, second, { afterRun }), false);
  assert.deepEqual(seen[0], { id: second, cancelled: true });
  release();
  await queue.drain();
  assert.equal(getRecord(first)?.verdict, "pass");
  assert.equal(getRecord(second)?.verdict, "infra-error");
  assert.match(getRunFacts(second)?.traceId ?? "", /^[0-9a-f]{32}$/, "the job that found the run cancelled still stores its trace id");
  assert.equal(getRunFacts(second)?.cancelled, true, "writing the trace id leaves the cancelled mark alone");
});

test("cancelling a stale running record the queue no longer holds marks it cancelled and hands it to the hook", () => {
  const queue = new JobQueue();
  const r = createRecord({ app: uniqueApp(), sha: "abc1234", target: "e2e", mode: "diff" });
  updateRecord(r.id, { status: "running" });
  const seen: string[] = [];
  cancelTrackedRun(queue, r.id, { afterRun: (id) => { seen.push(id); } });
  assert.deepEqual(seen, [r.id]);
  assert.equal(getRunFacts(r.id)?.cancelled, true);
});

test("a run a restart interrupted is handed to the hook but is not marked cancelled", () => {
  const r = createRecord({ app: uniqueApp(), sha: "abc1234", target: "e2e", mode: "diff" });
  updateRecord(r.id, { status: "running" });
  const seen: string[] = [];
  finalizeInterruptedRuns({ afterRun: (id) => { seen.push(id); } });
  assert.ok(seen.includes(r.id));
  assert.equal(getRunFacts(r.id)?.cancelled, null);
});

test("the spec file of each case the run executed is stored with the case", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, req(uniqueApp()), base(port({ cases: [{ name: "login works", status: "pass", file: "login.spec.ts" }] })));
  await queue.drain();
  assert.equal(getRecord(id)?.cases[0]?.file, "login.spec.ts");
});

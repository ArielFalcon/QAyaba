import { test } from "node:test";
import assert from "node:assert/strict";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { LedgerSpanProcessor, type RunSpanStore } from "./ledger";
import { commitRunSpans, listRunSpans, pruneRunSpans, countRunSpans, type RunSpanRow } from "../server/history";

function fakeStore(): RunSpanStore & { commits: RunSpanRow[][]; failNext: boolean } {
  const store = {
    commits: [] as RunSpanRow[][],
    failNext: false,
    commit(rows: readonly RunSpanRow[]): void {
      if (store.failNext) {
        store.failNext = false;
        throw new Error("disk full");
      }
      store.commits.push(rows.map((r) => ({ ...r })));
    },
  };
  return store;
}

function setup(store: RunSpanStore, flushEvery = 200, extra: { now?: () => number } = {}) {
  const ledger = new LedgerSpanProcessor(store, { flushEvery, ...extra });
  const provider = new BasicTracerProvider({ spanProcessors: [ledger] });
  return { ledger, tracer: provider.getTracer("t") };
}

const T0 = 1_760_000_000_000;

test("a span is written when it starts, with no end, and updated when it ends", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const span = tracer.startSpan("qayaba.run", { startTime: T0, attributes: { "qayaba.run.id": "r1", "qayaba.app": "a" } });
  ledger.flush();
  assert.equal(store.commits.length, 1);
  const open = store.commits[0]![0]!;
  assert.equal(open.endNs, null);
  assert.equal(open.runId, "r1");
  assert.equal(open.startNs, BigInt(T0) * 1_000_000n);
  assert.deepEqual(JSON.parse(open.attrs), { "qayaba.run.id": "r1", "qayaba.app": "a" });

  span.setAttribute("qayaba.verdict", "pass");
  span.addEvent("retry", { n: 1 }, T0 + 5);
  span.setStatus({ code: SpanStatusCode.ERROR, message: "bad" });
  span.end(T0 + 1000);
  ledger.flush();
  const closed = store.commits[1]![0]!;
  assert.equal(closed.spanId, open.spanId);
  assert.equal(closed.endNs, BigInt(T0 + 1000) * 1_000_000n);
  assert.equal(closed.status, "error");
  assert.equal(JSON.parse(closed.attrs)["qayaba.verdict"], "pass");
  assert.equal(JSON.parse(closed.events)[0].name, "retry");
});

test("changes buffer until the threshold, then commit in one batch", () => {
  const store = fakeStore();
  const { tracer } = setup(store, 4);
  for (let i = 0; i < 3; i++) tracer.startSpan(`s${i}`, { startTime: T0 });
  assert.equal(store.commits.length, 0);
  tracer.startSpan("s3", { startTime: T0 });
  assert.equal(store.commits.length, 1);
  assert.equal(store.commits[0]!.length, 4);
});

test("a span that starts and ends between flushes is written once, complete", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  tracer.startSpan("quick", { startTime: T0 }).end(T0 + 10);
  ledger.flush();
  assert.equal(store.commits.length, 1);
  assert.equal(store.commits[0]!.length, 1);
  assert.notEqual(store.commits[0]![0]!.endNs, null);
});

test("flush with nothing buffered commits nothing", () => {
  const store = fakeStore();
  const { ledger } = setup(store);
  ledger.flush();
  assert.equal(store.commits.length, 0);
});

test("a write failure is counted and never thrown, and the next write recovers the row in full", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const span = tracer.startSpan("x", { startTime: T0 });
  store.failNext = true;
  assert.doesNotThrow(() => ledger.flush());
  assert.equal(ledger.stats().writeErrors, 1);
  assert.equal(ledger.stats().ok, false);
  span.end(T0 + 1);
  ledger.flush();
  assert.equal(ledger.stats().ok, true);
  const row = store.commits.at(-1)![0]!;
  assert.equal(row.name, "x");
  assert.notEqual(row.endNs, null);
});

test("a child inherits its run id from the parent's row, and a root takes it from its attribute", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const root = tracer.startSpan("root", { startTime: T0, attributes: { "qayaba.run.id": "run-9" } });
  const ctx = trace.setSpan(ROOT_CONTEXT, root);
  const child = tracer.startSpan("child", { startTime: T0 + 1 }, ctx);
  const grandchild = tracer.startSpan("grandchild", { startTime: T0 + 2 }, trace.setSpan(ROOT_CONTEXT, child));
  grandchild.end(T0 + 3);
  child.end(T0 + 4);
  root.end(T0 + 5);
  ledger.flush();
  const rows = store.commits.flat();
  for (const name of ["root", "child", "grandchild"]) assert.equal(rows.find((r) => r.name === name)!.runId, "run-9", name);
  assert.equal(rows.find((r) => r.name === "child")!.parentSpanId, root.spanContext().spanId);
});

test("a run id set after the span started is taken at its end", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const span = tracer.startSpan("late", { startTime: T0 });
  span.setAttribute("qayaba.run.id", "late-run");
  span.end(T0 + 1);
  ledger.flush();
  assert.equal(store.commits.flat().at(-1)!.runId, "late-run");
});

test("shutdown flushes what is buffered and a later flush is a no-op", async () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  tracer.startSpan("pending", { startTime: T0 });
  await ledger.shutdown();
  assert.equal(store.commits.flat().length, 1);
  await assert.doesNotReject(ledger.shutdown());
});

test("rows reach the history database, keyed by span, and update in place", () => {
  const { ledger, tracer } = setup({ commit: commitRunSpans });
  const span = tracer.startSpan("db-span", { startTime: T0, attributes: { "qayaba.run.id": "db-run-1" } });
  ledger.flush();
  assert.equal(listRunSpans("db-run-1").length, 1);
  assert.equal(listRunSpans("db-run-1")[0]!.endNs, null);
  span.end(T0 + 7);
  ledger.flush();
  const rows = listRunSpans("db-run-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.endNs, BigInt(T0 + 7) * 1_000_000n);
  assert.equal(countRunSpans() >= 1, true);
});

test("pruning removes spans older than the retention window and keeps newer ones", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const row = (spanId: string, startMs: number): RunSpanRow => ({ traceId: "t".padEnd(32, "0"), spanId, parentSpanId: null, runId: "prune-run", name: spanId, kind: "internal", startNs: BigInt(startMs) * 1_000_000n, endNs: null, status: "unset", statusMessage: null, attrs: "{}", events: "[]", links: "[]" });
  commitRunSpans([row("old", now - 31 * day), row("fresh", now - 1 * day)]);
  pruneRunSpans(30, now);
  assert.deepEqual(listRunSpans("prune-run").map((r) => r.spanId), ["fresh"]);
});

test("every span of a trace with more than 5000 spans gets the run id, none is left null", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store, 1_000_000);
  const root = tracer.startSpan("root", { startTime: T0, attributes: { "qayaba.run.id": "big-run" } });
  const ctx = trace.setSpan(ROOT_CONTEXT, root);
  for (let i = 0; i < 6000; i++) tracer.startSpan(`c${i}`, { startTime: T0 + 1 }, ctx).end(T0 + 2);
  root.end(T0 + 3);
  ledger.flush();
  const rows = store.commits.flat();
  assert.equal(rows.length, 6001);
  assert.equal(rows.filter((r) => r.runId !== "big-run").length, 0);
});

test("the trace's run id is released when its root ends, so a later trace without one stays null", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const root = tracer.startSpan("root", { startTime: T0, attributes: { "qayaba.run.id": "r-a" } });
  root.end(T0 + 1);
  const orphan = tracer.startSpan("orphan", { startTime: T0 + 2 }, trace.setSpan(ROOT_CONTEXT, root));
  orphan.end(T0 + 3);
  ledger.flush();
  const rows = store.commits.flat();
  assert.equal(rows.find((r) => r.name === "root")!.runId, "r-a");
  assert.equal(rows.find((r) => r.name === "orphan")!.runId, null);
});

test("a failed end batch is re-queued and the next flush closes the row", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const span = tracer.startSpan("x", { startTime: T0 });
  ledger.flush();
  span.end(T0 + 5);
  store.failNext = true;
  ledger.flush();
  assert.equal(ledger.stats().writeErrors, 1);
  ledger.flush();
  const last = store.commits.at(-1)![0]!;
  assert.equal(last.name, "x");
  assert.notEqual(last.endNs, null);
  assert.equal(ledger.stats().ok, true);
});

test("a re-queued row never overwrites a newer pending row for the same span", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  const span = tracer.startSpan("x", { startTime: T0 });
  store.failNext = true;
  ledger.flush();
  span.end(T0 + 5);
  ledger.flush();
  assert.notEqual(store.commits.flat().at(-1)!.endNs, null);
});

test("rows retained after failures are capped at ten batches and the overflow is counted", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store, 2);
  store.commit = () => { throw new Error("down"); };
  for (let i = 0; i < 100; i++) tracer.startSpan(`s${i}`, { startTime: T0 });
  assert.ok(ledger.stats().writeErrors > 0);
  let ok = 0;
  store.commit = (rows) => { ok = rows.length; };
  ledger.flush();
  assert.ok(ok <= 20, `retained ${ok}`);
});

test("an end before the start is clamped to the start", () => {
  const store = fakeStore();
  const { ledger, tracer } = setup(store);
  tracer.startSpan("back", { startTime: T0 + 1000 }).end(T0);
  ledger.flush();
  const row = store.commits.flat()[0]!;
  assert.equal(row.endNs, row.startNs);
});

test("pruning runs from the flush path at most once per hour", () => {
  const store = fakeStore() as ReturnType<typeof fakeStore> & { pruned: number[]; prune?: (nowMs: number) => void };
  store.pruned = [];
  store.prune = (nowMs) => { store.pruned.push(nowMs); };
  let now = T0;
  const { ledger, tracer } = setup(store, 200, { now: () => now });
  tracer.startSpan("a", { startTime: T0 });
  ledger.flush();
  now += 30 * 60 * 1000;
  tracer.startSpan("b", { startTime: T0 });
  ledger.flush();
  assert.equal(store.pruned.length, 1);
  now += 31 * 60 * 1000;
  tracer.startSpan("c", { startTime: T0 });
  ledger.flush();
  assert.equal(store.pruned.length, 2);
});

test("a prune that throws is counted and never reaches the caller", () => {
  const store = fakeStore() as ReturnType<typeof fakeStore> & { prune?: (nowMs: number) => void };
  store.prune = () => { throw new Error("locked"); };
  const { ledger, tracer } = setup(store);
  tracer.startSpan("a", { startTime: T0 });
  assert.doesNotThrow(() => ledger.flush());
  assert.equal(ledger.stats().writeErrors, 1);
});

test("pruning deletes in bounded chunks", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const row = (spanId: string): RunSpanRow => ({ traceId: "c".padEnd(32, "0"), spanId, parentSpanId: null, runId: "chunk-run", name: spanId, kind: "internal", startNs: BigInt(now - 40 * day) * 1_000_000n, endNs: null, status: "unset", statusMessage: null, attrs: "{}", events: "[]", links: "[]" });
  commitRunSpans([row("a"), row("b"), row("c")]);
  assert.equal(pruneRunSpans(30, now, 2), 2);
  assert.equal(listRunSpans("chunk-run").length, 1);
  assert.equal(pruneRunSpans(30, now, 2), 1);
});

test("a non-finite cutoff prunes nothing", () => {
  assert.equal(pruneRunSpans(Number.NaN, Date.now()), 0);
  assert.equal(pruneRunSpans(30, Number.POSITIVE_INFINITY), 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendHealthMonitor, resolveBackendHealthConfig, type BackendFetch } from "./backend-health";

const NOW = 1_760_000_000_000;

interface Reply { status: number; body?: string }
type Routes = Record<string, Reply | ((init: { method: string; body?: string }) => Reply)>;

/* A fake HTTP boundary keyed by "METHOD host/path"; an unlisted route answers 404. */
function fakeFetch(routes: Routes, calls: string[] = []): BackendFetch {
  return async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.host}${u.pathname}`;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) return { status: 404, text: async () => "" };
    const reply = typeof route === "function" ? route(init) : route;
    return { status: reply.status, text: async () => reply.body ?? "" };
  };
}

const lokiMetrics = (full: number, usage: number): string => `loki_ingester_wal_disk_full_failures_total ${full}\nloki_ingester_wal_disk_usage_percent ${usage}\n`;
const config = { lokiUrl: "http://lgtm:3100", tempoUrl: "http://lgtm:3200", collectorMetricsUrls: ["http://collector:8888/metrics"], serviceName: "qayaba-orchestrator" };

const healthyRoutes = (over: Routes = {}): Routes => ({
  "GET lgtm:3100/ready": { status: 200, body: "ready" },
  "POST lgtm:3100/loki/api/v1/push": { status: 204 },
  "GET lgtm:3100/metrics": { status: 200, body: lokiMetrics(0, 0.5) },
  "GET lgtm:3100/loki/api/v1/query_range": { status: 200, body: JSON.stringify({ data: { result: [{ values: [[`${BigInt(NOW - 60_000) * 1_000_000n}`, "line"]] }] } }) },
  "GET lgtm:3200/ready": { status: 200, body: "ready" },
  "GET lgtm:3200/api/search": { status: 200, body: JSON.stringify({ traces: [{ startTimeUnixNano: `${BigInt(NOW - 120_000) * 1_000_000n}` }] }) },
  "GET collector:8888/metrics": { status: 200, body: "otelcol_exporter_send_failed_log_records_total{exporter=\"otlphttp/lgtm\"} 0\notelcol_exporter_queue_size 0\notelcol_exporter_queue_capacity 1000\n" },
  ...over,
});

function monitor(routes: Routes, opts: { calls?: string[]; clock?: { t: number }; ttlMs?: number } = {}) {
  const clock = opts.clock ?? { t: NOW };
  return { clock, m: new BackendHealthMonitor({ config, fetch: fakeFetch(routes, opts.calls), now: () => clock.t, ttlMs: opts.ttlMs ?? 30_000 }) };
}

test("a healthy stack reports every backend ok with the newest line and trace times", async () => {
  const { m } = monitor(healthyRoutes());
  const h = await m.get();
  assert.equal(h?.ok, true);
  assert.equal(h?.loki.status, "ok");
  assert.equal(h?.loki.lastDataAt, new Date(NOW - 60_000).toISOString());
  assert.equal(h?.loki.diskUsedRatio, 0.5);
  assert.equal(h?.tempo.status, "ok");
  assert.equal(h?.tempo.lastDataAt, new Date(NOW - 120_000).toISOString());
  assert.equal(h?.collector.status, "ok");
});

test("Loki that is ready but rejects a write is down, with the rejection as the reason (the incident)", async () => {
  const { m } = monitor(healthyRoutes({ "POST lgtm:3100/loki/api/v1/push": { status: 500, body: "rpc error: code = Unknown desc = Ingester is shutting down" } }));
  const h = await m.get();
  assert.equal(h?.ok, false);
  assert.equal(h?.loki.status, "down");
  assert.match(h?.loki.reason ?? "", /Ingester is shutting down/);
  assert.equal(h?.tempo.status, "ok");
});

test("Loki that is not ready is down and no write is attempted", async () => {
  const calls: string[] = [];
  const { m } = monitor(healthyRoutes({ "GET lgtm:3100/ready": { status: 503, body: "Ingester not ready" } }), { calls });
  const h = await m.get();
  assert.equal(h?.loki.status, "down");
  assert.match(h?.loki.reason ?? "", /not ready/);
  assert.ok(!calls.includes("POST lgtm:3100/loki/api/v1/push"));
});

test("an unreachable backend is down without leaking its address", async () => {
  const fetch: BackendFetch = async () => {
    throw new Error("connect ECONNREFUSED 10.1.2.3:3100");
  };
  const h = await new BackendHealthMonitor({ config, fetch, now: () => NOW }).get();
  assert.equal(h?.loki.status, "down");
  assert.equal(h?.tempo.status, "down");
  assert.equal(h?.collector.status, "down");
  assert.doesNotMatch(JSON.stringify(h), /10\.1\.2\.3|lgtm/);
});

test("Loki's WAL disk guard counting a new failure since the last probe degrades it even when writes are still accepted", async () => {
  let full = 0;
  const routes = healthyRoutes({ "GET lgtm:3100/metrics": () => ({ status: 200, body: lokiMetrics(full, 0.5) }) });
  const { m, clock } = monitor(routes);
  assert.equal((await m.get())?.loki.status, "ok");
  full = 1;
  clock.t += 31_000;
  const h = await m.get();
  assert.equal(h?.loki.status, "degraded");
  assert.match(h?.loki.reason ?? "", /disk/i);
});

test("a lifetime disk-full count seen on the first probe is not judged, but high WAL disk usage is", async () => {
  const first = await monitor(healthyRoutes({ "GET lgtm:3100/metrics": { status: 200, body: lokiMetrics(3, 0.4) } })).m.get();
  assert.equal(first?.loki.status, "ok");
  const high = await monitor(healthyRoutes({ "GET lgtm:3100/metrics": { status: 200, body: lokiMetrics(0, 0.9) } })).m.get();
  assert.equal(high?.loki.status, "degraded");
  assert.equal(high?.loki.diskUsedRatio, 0.9);
});

test("collector exporter send failures that grew since the last probe degrade the collector; a full queue does too", async () => {
  let failed = 0;
  let queue = 0;
  const routes = healthyRoutes({
    "GET collector:8888/metrics": () => ({ status: 200, body: `otelcol_exporter_send_failed_log_records_total{exporter="otlphttp/lgtm"} ${failed}\notelcol_exporter_queue_size ${queue}\notelcol_exporter_queue_capacity 1000\n` }),
  });
  const { m, clock } = monitor(routes);
  assert.equal((await m.get())?.collector.status, "ok");
  failed = 40;
  clock.t += 31_000;
  const h = await m.get();
  assert.equal(h?.collector.status, "degraded");
  assert.match(h?.collector.reason ?? "", /send failures/);
  assert.equal(h?.ok, false);
  queue = 950;
  clock.t += 31_000;
  assert.match((await m.get())?.collector.reason ?? "", /queue/);
});

test("a quiet stack with no recent lines or traces is still ok", async () => {
  const { m } = monitor(healthyRoutes({
    "GET lgtm:3100/loki/api/v1/query_range": { status: 200, body: JSON.stringify({ data: { result: [] } }) },
    "GET lgtm:3200/api/search": { status: 200, body: JSON.stringify({ traces: [] }) },
  }));
  const h = await m.get();
  assert.equal(h?.ok, true);
  assert.equal(h?.loki.lastDataAt, undefined);
  assert.equal(h?.tempo.lastDataAt, undefined);
});

test("the newest trace is the latest start among those the search returns, whatever order Tempo answers in", async () => {
  const nanos = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const traces = [{ startTimeUnixNano: nanos(NOW - 3_600_000) }, { startTimeUnixNano: nanos(NOW - 30_000) }, { startTimeUnixNano: nanos(NOW - 600_000) }];
  const { m } = monitor(healthyRoutes({ "GET lgtm:3200/api/search": { status: 200, body: JSON.stringify({ traces }) } }));
  assert.equal((await m.get())?.tempo.lastDataAt, new Date(NOW - 30_000).toISOString());
});

test("Tempo that is ready but cannot answer a search is degraded", async () => {
  const { m } = monitor(healthyRoutes({ "GET lgtm:3200/api/search": { status: 500, body: "boom" } }));
  const h = await m.get();
  assert.equal(h?.tempo.status, "degraded");
});

test("the result is cached for the ttl, concurrent callers share one probe, and it is refreshed after the ttl", async () => {
  const calls: string[] = [];
  const { m, clock } = monitor(healthyRoutes(), { calls });
  const pushes = (): number => calls.filter((c) => c === "POST lgtm:3100/loki/api/v1/push").length;
  const metricsReads = (): number => calls.filter((c) => c === "GET lgtm:3100/metrics").length;
  await Promise.all([m.get(), m.get(), m.get()]);
  assert.equal(metricsReads(), 1);
  await m.get();
  assert.equal(metricsReads(), 1);
  clock.t += 31_000;
  await m.get();
  assert.equal(metricsReads(), 2);
  assert.equal(pushes(), 1);
});

test("the write path is proven by one push, not one per poll: later probes watch Loki's append-failure counter", async () => {
  const calls: string[] = [];
  let failures = 0;
  const routes = healthyRoutes({ "GET lgtm:3100/metrics": () => ({ status: 200, body: `${lokiMetrics(0, 0.5)}loki_distributor_ingester_append_failures_total{ingester="a"} ${failures}\n` }) });
  const { m, clock } = monitor(routes, { calls });
  const pushes = (): number => calls.filter((c) => c === "POST lgtm:3100/loki/api/v1/push").length;
  assert.equal((await m.get())?.loki.status, "ok");
  clock.t += 31_000;
  assert.equal((await m.get())?.loki.status, "ok");
  clock.t += 31_000;
  assert.equal((await m.get())?.loki.status, "ok");
  assert.equal(pushes(), 1);
  failures = 2;
  clock.t += 31_000;
  const h = await m.get();
  assert.equal(h?.loki.status, "degraded");
  assert.match(h?.loki.reason ?? "", /append/i);
  assert.equal(pushes(), 1);
});

test("a write probe that failed is tried again on the next poll until one is accepted", async () => {
  const calls: string[] = [];
  let status = 500;
  const { m, clock } = monitor(healthyRoutes({ "POST lgtm:3100/loki/api/v1/push": () => ({ status }) }), { calls });
  assert.equal((await m.get())?.loki.status, "down");
  status = 204;
  clock.t += 31_000;
  assert.equal((await m.get())?.loki.status, "ok");
  clock.t += 31_000;
  await m.get();
  assert.equal(calls.filter((c) => c === "POST lgtm:3100/loki/api/v1/push").length, 2);
});

test("peek never waits: it answers nothing before the first probe finishes, then the cached result", async () => {
  const { m } = monitor(healthyRoutes());
  assert.equal(m.peek(), undefined);
  await m.get();
  assert.equal(m.peek()?.ok, true);
});

test("backends that are not configured are reported unconfigured and do not make the stack unhealthy", async () => {
  const h = await new BackendHealthMonitor({ config: { collectorMetricsUrls: [], serviceName: "x" }, fetch: fakeFetch({}), now: () => NOW }).get();
  assert.equal(h?.loki.status, "unconfigured");
  assert.equal(h?.tempo.status, "unconfigured");
  assert.equal(h?.collector.status, "unconfigured");
  assert.equal(h?.ok, true);
});

test("the probes read their addresses from the environment, and none are set by default", () => {
  assert.equal(resolveBackendHealthConfig({}).lokiUrl, undefined);
  const cfg = resolveBackendHealthConfig({ QA_TELEMETRY_LOKI_URL: "http://a:1/", QA_TELEMETRY_TEMPO_URL: "http://b:2", QA_TELEMETRY_COLLECTOR_METRICS_URLS: "http://c:3/metrics, http://d:4/metrics", OTEL_SERVICE_NAME: "svc" });
  assert.deepEqual(cfg, { lokiUrl: "http://a:1", tempoUrl: "http://b:2", collectorMetricsUrls: ["http://c:3/metrics", "http://d:4/metrics"], serviceName: "svc" });
});

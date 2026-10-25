/* End-to-end verification of the stores behind the collectors, from the orchestrator's own network (docs/telemetry-local.md).

   The orchestrator's OTLP export only proves the collector accepted a batch; the collector -> Loki/Tempo leg fails on its own (a Loki WAL disk guard rejected every push for ~50 minutes while the export looked fine). This monitor asks the backends directly:
   - Loki: /ready, then ONE real push of a probe line (a ready ingester that rejects writes is down), then its /metrics (WAL disk usage, and whether the disk-full failure counter grew since the last probe), then the newest line of this service (informational).
   - Tempo: /ready, then a search for recent traces (the read path answering), informational newest trace time.
   - Collectors: their internal Prometheus metrics, when configured: growth of `otelcol_exporter_send_failed_*` since the last probe, and the exporter queue's fill.
   Counters are lifetime values, so a failure is judged only by growth between two probes; the first probe judges nothing from them.

   Bounded and cheap: every request has a timeout, the result is cached for a short ttl, concurrent callers share one probe, and `peek` never waits (it starts a background refresh when stale). Everything is fail-open: a fault becomes a `down` entry with an address-free reason, never a throw. Addresses come from the environment (QA_TELEMETRY_LOKI_URL, QA_TELEMETRY_TEMPO_URL, QA_TELEMETRY_COLLECTOR_METRICS_URLS); a backend with none is `unconfigured` and does not make the stack unhealthy. HTTP, the clock and the ttl are injected. */

import type { BackendHealth, BackendStatus, TelemetryBackendsHealth } from "@kernel/telemetry/telemetry-health";
import { DEFAULT_SERVICE_NAME } from "./config";

export const BACKEND_HEALTH_TTL_MS = 30_000;
export const BACKEND_PROBE_TIMEOUT_MS = 3_000;
/* A WAL disk at or above this share is about to trip the ingester's disk guard. */
export const DISK_USED_DEGRADED_RATIO = 0.85;
/* An exporter queue this full is about to drop data. */
export const QUEUE_FILL_DEGRADED_RATIO = 0.9;
const RECENT_WINDOW_MS = 24 * 3600 * 1000;
const MAX_REASON_CHARS = 160;

export interface BackendFetchInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface BackendResponse {
  status: number;
  text(): Promise<string>;
}
export type BackendFetch = (url: string, init: BackendFetchInit) => Promise<BackendResponse>;

export interface BackendHealthConfig {
  readonly lokiUrl?: string;
  readonly tempoUrl?: string;
  readonly collectorMetricsUrls: readonly string[];
  /* The service whose newest line and trace are looked for. */
  readonly serviceName: string;
}

export interface BackendHealthDeps {
  readonly config: BackendHealthConfig;
  readonly fetch: BackendFetch;
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
}

type Env = Record<string, string | undefined>;

const trimUrl = (raw: string | undefined): string | undefined => {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return v === "" ? undefined : v;
};

export function resolveBackendHealthConfig(env: Env): BackendHealthConfig {
  const lokiUrl = trimUrl(env.QA_TELEMETRY_LOKI_URL);
  const tempoUrl = trimUrl(env.QA_TELEMETRY_TEMPO_URL);
  const collectorMetricsUrls = (env.QA_TELEMETRY_COLLECTOR_METRICS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
  return {
    ...(lokiUrl ? { lokiUrl } : {}),
    ...(tempoUrl ? { tempoUrl } : {}),
    collectorMetricsUrls,
    serviceName: (env.OTEL_SERVICE_NAME ?? "").trim() || DEFAULT_SERVICE_NAME,
  };
}

/* Sum of the samples of every metric whose name matches. Labels are ignored; comments and unparsable lines are skipped. */
function sumMetric(text: string, name: RegExp): number | undefined {
  let sum: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m || !name.test(m[1]!)) continue;
    const value = Number(m[2]);
    if (Number.isFinite(value)) sum = (sum ?? 0) + value;
  }
  return sum;
}

const clip = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
const isoFromNanos = (nanos: unknown): string | undefined => {
  if (typeof nanos !== "string" || !/^\d+$/.test(nanos)) return undefined;
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
};

interface Verdict {
  status: BackendStatus;
  reasons: string[];
  diskUsedRatio?: number;
  lastDataAt?: string;
}
const rank: Record<BackendStatus, number> = { unconfigured: 0, ok: 1, degraded: 2, down: 3 };

export class BackendHealthMonitor {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private cached: { at: number; value: TelemetryBackendsHealth } | undefined;
  private inFlight: Promise<TelemetryBackendsHealth> | undefined;
  private readonly lastCounters = new Map<string, number>();

  constructor(private readonly deps: BackendHealthDeps) {
    this.ttlMs = deps.ttlMs ?? BACKEND_HEALTH_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? BACKEND_PROBE_TIMEOUT_MS;
  }

  /* The cached result, never waiting. Starts a background refresh when there is none or it is stale. */
  peek(): TelemetryBackendsHealth | undefined {
    if (!this.fresh()) void this.refresh();
    return this.cached?.value;
  }

  /* A fresh result: the cache inside the ttl, else one shared probe. */
  async get(): Promise<TelemetryBackendsHealth | undefined> {
    if (this.fresh() && this.cached) return this.cached.value;
    return this.refresh();
  }

  private fresh(): boolean {
    return this.cached !== undefined && this.deps.now() - this.cached.at < this.ttlMs;
  }

  private refresh(): Promise<TelemetryBackendsHealth> {
    this.inFlight ??= this.probeAll()
      .then((value) => {
        this.cached = { at: this.deps.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async probeAll(): Promise<TelemetryBackendsHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString();
    const [loki, tempo, collector] = await Promise.all([this.probeLoki(), this.probeTempo(), this.probeCollectors()]);
    const entry = (v: Verdict): BackendHealth => ({
      status: v.status,
      ...(v.reasons.length > 0 ? { reason: v.reasons.join("; ") } : {}),
      checkedAt,
      ...(v.diskUsedRatio !== undefined ? { diskUsedRatio: v.diskUsedRatio } : {}),
      ...(v.lastDataAt ? { lastDataAt: v.lastDataAt } : {}),
    });
    const all = [loki, tempo, collector];
    return { ok: all.every((v) => v.status === "ok" || v.status === "unconfigured"), loki: entry(loki), tempo: entry(tempo), collector: entry(collector) };
  }

  /* One bounded request. Never throws: a connection fault is a missing response. */
  private async call(url: string, init: BackendFetchInit): Promise<{ status: number; body: string } | undefined> {
    try {
      const res = await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      return { status: res.status, body: await res.text() };
    } catch {
      return undefined;
    }
  }

  /* Growth of a lifetime counter since the previous probe; undefined on the first sample. */
  private growth(key: string, value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    const previous = this.lastCounters.get(key);
    this.lastCounters.set(key, value);
    return previous === undefined ? undefined : value - previous;
  }

  private async probeLoki(): Promise<Verdict> {
    const base = this.deps.config.lokiUrl;
    if (!base) return { status: "unconfigured", reasons: [] };
    const ready = await this.call(`${base}/ready`, { method: "GET" });
    if (!ready) return { status: "down", reasons: ["Loki is unreachable"] };
    if (ready.status !== 200) return { status: "down", reasons: [`Loki is not ready (HTTP ${ready.status})`] };

    const nowMs = this.deps.now();
    const probeLine = JSON.stringify({ streams: [{ stream: { job: "qayaba-health-probe" }, values: [[`${BigInt(nowMs) * 1_000_000n}`, "telemetry health probe"]] }] });
    const push = await this.call(`${base}/loki/api/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: probeLine });
    if (!push) return { status: "down", reasons: ["Loki is ready but the write probe got no answer"] };
    if (push.status < 200 || push.status >= 300) return { status: "down", reasons: [`Loki is ready but rejects writes (HTTP ${push.status}): ${clip(push.body)}`] };

    const verdict: Verdict = { status: "ok", reasons: [] };
    const metrics = await this.call(`${base}/metrics`, { method: "GET" });
    if (metrics && metrics.status === 200) {
      const usage = sumMetric(metrics.body, /^loki_ingester_wal_disk_usage_percent$/);
      if (usage !== undefined) verdict.diskUsedRatio = usage;
      const grew = this.growth("loki.wal_disk_full", sumMetric(metrics.body, /^loki_ingester_wal_disk_full_failures_total$/));
      if (grew !== undefined && grew > 0) {
        verdict.status = "degraded";
        verdict.reasons.push(`WAL disk-full guard tripped ${grew} time(s) since the last probe`);
      }
      if (usage !== undefined && usage >= DISK_USED_DEGRADED_RATIO) {
        verdict.status = "degraded";
        verdict.reasons.push(`WAL disk ${Math.round(usage * 100)}% used`);
      }
    }
    const since = BigInt(nowMs - RECENT_WINDOW_MS) * 1_000_000n;
    const query = new URLSearchParams({ query: `{service_name="${this.deps.config.serviceName}"}`, limit: "1", direction: "backward", start: `${since}` });
    const recent = await this.call(`${base}/loki/api/v1/query_range?${query}`, { method: "GET" });
    if (recent && recent.status === 200) {
      try {
        const values = (JSON.parse(recent.body) as { data?: { result?: Array<{ values?: Array<[string, string]> }> } }).data?.result?.[0]?.values;
        const at = isoFromNanos(values?.[0]?.[0]);
        if (at) verdict.lastDataAt = at;
      } catch {
        /* an unreadable answer only means no informational time */
      }
    }
    return verdict;
  }

  private async probeTempo(): Promise<Verdict> {
    const base = this.deps.config.tempoUrl;
    if (!base) return { status: "unconfigured", reasons: [] };
    const ready = await this.call(`${base}/ready`, { method: "GET" });
    if (!ready) return { status: "down", reasons: ["Tempo is unreachable"] };
    if (ready.status !== 200) return { status: "down", reasons: [`Tempo is not ready (HTTP ${ready.status})`] };
    const nowMs = this.deps.now();
    const query = new URLSearchParams({
      tags: `service.name=${this.deps.config.serviceName}`,
      limit: "1",
      start: `${Math.floor((nowMs - RECENT_WINDOW_MS) / 1000)}`,
      end: `${Math.floor(nowMs / 1000)}`,
    });
    const search = await this.call(`${base}/api/search?${query}`, { method: "GET" });
    if (!search || search.status !== 200) return { status: "degraded", reasons: [`Tempo is ready but cannot search traces${search ? ` (HTTP ${search.status})` : ""}`] };
    const verdict: Verdict = { status: "ok", reasons: [] };
    try {
      const at = isoFromNanos((JSON.parse(search.body) as { traces?: Array<{ startTimeUnixNano?: string }> }).traces?.[0]?.startTimeUnixNano);
      if (at) verdict.lastDataAt = at;
    } catch {
      verdict.status = "degraded";
      verdict.reasons.push("Tempo answered a search with an unreadable body");
    }
    const metrics = await this.call(`${base}/metrics`, { method: "GET" });
    const discarded = metrics && metrics.status === 200 ? this.growth("tempo.discarded_spans", sumMetric(metrics.body, /^tempo_discarded_spans_total$/)) : undefined;
    if (discarded !== undefined && discarded > 0) {
      verdict.status = "degraded";
      verdict.reasons.push(`Tempo discarded ${discarded} span(s) since the last probe`);
    }
    return verdict;
  }

  private async probeCollectors(): Promise<Verdict> {
    const urls = this.deps.config.collectorMetricsUrls;
    if (urls.length === 0) return { status: "unconfigured", reasons: [] };
    const merged: Verdict = { status: "ok", reasons: [] };
    for (const [index, url] of urls.entries()) {
      const label = urls.length > 1 ? `collector ${index + 1}` : "collector";
      const res = await this.call(url, { method: "GET" });
      let status: BackendStatus = "ok";
      const reasons: string[] = [];
      if (!res || res.status !== 200) {
        status = "down";
        reasons.push(`${label} metrics are unreachable${res ? ` (HTTP ${res.status})` : ""}`);
      } else {
        const failed = this.growth(`collector.${index}.send_failed`, sumMetric(res.body, /^otelcol_exporter_send_failed_[a-z_]+$/));
        if (failed !== undefined && failed > 0) {
          status = "degraded";
          reasons.push(`${label} exporter send failures grew by ${failed} since the last probe`);
        }
        const size = sumMetric(res.body, /^otelcol_exporter_queue_size$/);
        const capacity = sumMetric(res.body, /^otelcol_exporter_queue_capacity$/);
        if (size !== undefined && capacity !== undefined && capacity > 0 && size / capacity >= QUEUE_FILL_DEGRADED_RATIO) {
          status = "degraded";
          reasons.push(`${label} exporter queue ${Math.round((size / capacity) * 100)}% full`);
        }
      }
      if (rank[status] > rank[merged.status]) merged.status = status;
      merged.reasons.push(...reasons);
    }
    return merged;
  }
}

/* The real HTTP boundary: Node's fetch. */
export const systemBackendFetch: BackendFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  return { status: res.status, text: () => res.text() };
};

/* Composition of the telemetry stack, once per process (src/index.ts and src/cli.ts). The only place that builds an OpenTelemetry provider.

   `off` (or OTEL_SDK_DISABLED) returns the null object and creates nothing. `local` (the default) builds a NodeTracerProvider by hand, not NodeSDK, so no auto-instrumentation patches any module: the span ledger always, plus an OTLP/proto batch exporter only when an endpoint is configured. NodeSDK would also read the OTEL_BSP_*, resource and OTEL_SDK_DISABLED variables itself; without it they are mapped here (config.ts). Nothing here throws at runtime: a bad configuration throws once, at composition, and shutdown never throws. */

import { context as apiContext, type ContextManager } from "@opentelemetry/api";
import { W3CTraceContextPropagator, ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AggregationType, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import type { TelemetryHealth } from "@kernel/telemetry/telemetry-health";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { resolveCampaignFreeze } from "../server/campaign-freeze";
import { commitRunSpans, pruneRunSpans } from "../server/history";
import { sanitizeText } from "../orchestrator/sanitizer";
import { resolveTelemetryConfig } from "./config";
import { LedgerSpanProcessor, type RunSpanStore } from "./ledger";
import { EVENT_LOOP_DELAY_BOUNDARIES_MS, SUSPEND_DURATION_BOUNDARIES_S } from "./host-health";
import { OtelTelemetry, type CaptureMode } from "./otel-telemetry.adapter";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const METRIC_EXPORT_INTERVAL_MS = 60_000;
/* Run and phase durations last 60-9000 s; the semconv advisory buckets stop near 82 s and would make p50/p95 meaningless. */
const LONG_DURATION_BOUNDARIES = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 2400, 3600, 5400, 9000];
const MAX_ERROR_CHARS = 200;

export interface BootstrapDeps {
  readonly env: Record<string, string | undefined>;
  readonly clock?: TelemetryClock;
  /* Where the ledger writes. Default: the history database. */
  readonly store?: RunSpanStore;
  /* Default: read from QA_CAMPAIGN_FREEZE. */
  readonly campaignFreeze?: boolean;
  readonly captureMode?: CaptureMode;
  /* Builds the OTLP trace exporter for a url. Default: OTLP/proto over HTTP. */
  readonly traceExporterFactory?: (url: string) => SpanExporter;
  /* Builds the OTLP metric exporter for a url. Default: OTLP/proto over HTTP. Return undefined for no metrics. */
  readonly metricExporterFactory?: (url: string) => PushMetricExporter | undefined;
  /* Register the provider and propagator as the process-wide OpenTelemetry globals. The composition roots do; tests do not. */
  readonly registerGlobal?: boolean;
}

export interface TelemetryHandle {
  readonly telemetry: TelemetryPort;
  /* The wall clock the telemetry was built on. The engine's phase cursor and the runner's enqueue marks read this same clock, so every span time and every duration of a run agree. */
  readonly clock: TelemetryClock;
  health(): TelemetryHealth;
  /* Flushes the ledger, then the exporters, then stops them, all raced against `timeoutMs`. Never throws. */
  shutdown(timeoutMs?: number): Promise<void>;
}

interface ExporterStatus {
  lastExportAt?: string;
  lastError?: string;
  dropped: number;
}

/* Observes an exporter without changing what it does, so health can say when it last succeeded and what it lost. */
class ObservedExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter, private readonly status: ExporterStatus, private readonly clock: TelemetryClock, private readonly timeoutMs: number) {}

  /* The batch processor gives up on an export after its own timeout and never learns what became of it, so an exporter still retrying then would lose the batch unseen. A timer at that same timeout counts it, once, whichever of the timer and the exporter answers first. */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.fail(spans.length, new Error(`export timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    timer.unref?.();
    const finish = (result: ExportResult): void => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (result.code === ExportResultCode.SUCCESS) this.status.lastExportAt = new Date(this.clock.now()).toISOString();
      else this.fail(spans.length, result.error);
      resultCallback(result);
    };
    try {
      this.inner.export(spans, finish);
    } catch (error) {
      finish({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  private fail(count: number, error: unknown): void {
    this.status.dropped += count;
    const text = error instanceof Error ? error.message : String(error ?? "export failed");
    this.status.lastError = sanitizeText(text, "issue").text.slice(0, MAX_ERROR_CHARS);
  }
}

function offHandle(freeze: boolean, clock: TelemetryClock): TelemetryHandle {
  const health: TelemetryHealth = {
    mode: "off",
    campaignFreeze: freeze,
    otlp: { configured: false, dropped: 0 },
    ledger: { ok: true, spans: 0, writeErrors: 0 },
    scoreSink: { configured: false },
    droppedAttributes: 0,
  };
  return { telemetry: new NoopTelemetry(), clock, health: () => health, shutdown: async () => {} };
}

export function createTelemetry(deps: BootstrapDeps): TelemetryHandle {
  const config = resolveTelemetryConfig(deps.env);
  const freeze = deps.campaignFreeze ?? resolveCampaignFreeze(deps.env);
  const clock = deps.clock ?? { now: () => Date.now() };
  if (config.mode === "off") return offHandle(freeze, clock);

  const resource = resourceFromAttributes({ ...config.resourceAttributes, "service.name": config.serviceName });
  const ledger = new LedgerSpanProcessor(deps.store ?? { commit: commitRunSpans, prune: (nowMs) => void pruneRunSpans(config.retentionDays, nowMs) });
  const exporterStatus: ExporterStatus = { dropped: 0 };
  const spanProcessors: Array<LedgerSpanProcessor | BatchSpanProcessor> = [ledger];

  if (config.otlp) {
    const inner = (deps.traceExporterFactory ?? ((url: string) => new OTLPTraceExporter({ url })))(config.otlp.url);
    spanProcessors.push(new BatchSpanProcessor(new ObservedExporter(inner, exporterStatus, clock, config.otlp.batch.exportTimeoutMillis), config.otlp.batch));
  }

  const provider = new NodeTracerProvider({ resource, spanProcessors });
  const contextManager: ContextManager = new AsyncLocalStorageContextManager().enable();
  if (deps.registerGlobal) provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

  let meterProvider: MeterProvider | undefined;
  if (config.otlp?.metricsUrl) {
    const exporter = (deps.metricExporterFactory ?? ((url: string) => new OTLPMetricExporter({ url })))(config.otlp.metricsUrl);
    if (exporter) {
      meterProvider = new MeterProvider({
        resource,
        readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS })],
        views: [
          ...["qayaba.run.duration", "qayaba.phase.duration"].map((instrumentName) => ({ instrumentName, boundaries: LONG_DURATION_BOUNDARIES })),
          { instrumentName: "qayaba.host.suspend.duration", boundaries: SUSPEND_DURATION_BOUNDARIES_S },
          { instrumentName: "qayaba.host.event_loop.delay", boundaries: EVENT_LOOP_DELAY_BOUNDARIES_MS },
        ].map(({ instrumentName, boundaries }) => ({
          instrumentName,
          aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [...boundaries] } },
        })),
      });
    }
  }

  const adapter = new OtelTelemetry({
    tracer: provider.getTracer("qayaba"),
    contextManager,
    clock,
    captureMode: deps.captureMode,
    meter: meterProvider?.getMeter("qayaba"),
    flush: () => ledger.flush(),
  });

  const health = (): TelemetryHealth => {
    const ledgerStats = ledger.stats();
    return {
      mode: "local",
      campaignFreeze: freeze,
      otlp: {
        configured: config.otlp !== undefined,
        ...(exporterStatus.lastExportAt ? { lastExportAt: exporterStatus.lastExportAt } : {}),
        ...(exporterStatus.lastError ? { lastError: exporterStatus.lastError } : {}),
        dropped: exporterStatus.dropped,
      },
      ledger: { ok: ledgerStats.ok, spans: ledgerStats.spans, writeErrors: ledgerStats.writeErrors },
      scoreSink: { configured: false },
      droppedAttributes: adapter.stats().droppedAttributes,
    };
  };

  const shutdown = async (timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> => {
    /* The ledger is local and synchronous: commit it before anything that can hang. */
    ledger.flush();
    const stop = async (): Promise<void> => {
      await provider.forceFlush();
      await provider.shutdown();
      await meterProvider?.shutdown();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([stop(), deadline]);
    } catch (error) {
      console.error(`[telemetry] shutdown failed: ${sanitizeText(error instanceof Error ? error.message : String(error), "issue").text}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (deps.registerGlobal) apiContext.disable();
    }
  };

  return { telemetry: adapter, clock, health, shutdown };
}

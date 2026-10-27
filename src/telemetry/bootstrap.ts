/* Composition of the telemetry stack, once per process (src/server/wire-app.ts and src/cli.ts). The only place that builds an OpenTelemetry provider.

   `off` (or OTEL_SDK_DISABLED) returns the null object and creates nothing. `local` (the default) builds a NodeTracerProvider by hand, not NodeSDK, so no auto-instrumentation patches any module: the span ledger always, plus an OTLP/proto batch exporter only when an endpoint is configured. NodeSDK would also read the OTEL_BSP_*, resource and OTEL_SDK_DISABLED variables itself; without it they are mapped here (config.ts). Nothing here throws at runtime: a bad configuration throws once, at composition, and shutdown never throws. */

import { appLogger, installLogShipper } from "../integrations/redacting-logger";
import { context as apiContext, type ContextManager } from "@opentelemetry/api";
import { W3CTraceContextPropagator, ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AggregationType, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry";
import type { TelemetryHealth } from "./telemetry-health";
import type { TelemetryClock, TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { resolveCampaignFreeze } from "../server/campaign-freeze";
import { getHistory, getHistoryDatabase } from "../server/persistence/index";
import { pruneRunPlans, pruneRunSpans, pruneSpecSnapshots } from "../server/persistence/retention";
import { sanitizeText } from "../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { resolveTelemetryConfig, type TelemetryConfig } from "./config";
import { LedgerSpanProcessor, type RunSpanStore } from "./ledger";
import { EVENT_LOOP_DELAY_BOUNDARIES_MS, SUSPEND_DURATION_BOUNDARIES_S } from "./host-health";
import { OtelTelemetry, type CaptureMode } from "./otel-telemetry.adapter";
import { createLogShipper } from "./log-shipper";
import { PromptBodyExporter } from "./prompt-body-logs";
import { registerPromptBodyHost } from "./with-prompt-bodies";

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
  /* Builds the OTLP log exporter for a url. Default: OTLP/proto over HTTP. */
  readonly logExporterFactory?: (url: string) => LogRecordExporter;
  /* Register the provider and propagator as the process-wide OpenTelemetry globals. The composition roots do; tests do not. */
  readonly registerGlobal?: boolean;
  /* Ship the logging port's explanatory lines to the log store. The composition roots set it; tests stay quiet. */
  readonly shipLogs?: boolean;
}

export interface TelemetryHandle {
  readonly telemetry: TelemetryPort;
  /* The wall clock the telemetry was built on. The engine's phase cursor and the runner's enqueue marks read this same clock, so every span time and every duration of a run agree. */
  readonly clock: TelemetryClock;
  health(): TelemetryHealth;
  /* Stops shipping log lines to the log store. Safe to call more than once. */
  stopLogShipping(): void;
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
  return { telemetry: new NoopTelemetry(), clock, health: () => health, stopLogShipping: () => {}, shutdown: async () => {} };
}

type PruneFn = (days: number, nowMs: number, limit?: number, campaignDays?: number) => number;

export interface PruneFns {
  pruneRunSpans: PruneFn;
  pruneSpecSnapshots: PruneFn;
  pruneRunPlans: PruneFn;
}

/* The ledger tables of the process's history database, opened on first use. */
const historyPruneFns: PruneFns = {
  pruneRunSpans: (...args) => pruneRunSpans(getHistoryDatabase(), ...args),
  pruneSpecSnapshots: (...args) => pruneSpecSnapshots(getHistoryDatabase(), ...args),
  pruneRunPlans: (...args) => pruneRunPlans(getHistoryDatabase(), ...args),
};

/* The ledger's periodic prune: the ordinary window, with a campaign run's records kept for the campaign window (R4). */
export function retentionPrune(config: Pick<TelemetryConfig, "retentionDays" | "campaignRetentionDays">, fns: PruneFns = historyPruneFns): (nowMs: number) => void {
  return (nowMs) => {
    fns.pruneRunSpans(config.retentionDays, nowMs, undefined, config.campaignRetentionDays);
    fns.pruneSpecSnapshots(config.retentionDays, nowMs, undefined, config.campaignRetentionDays);
    fns.pruneRunPlans(config.retentionDays, nowMs, undefined, config.campaignRetentionDays);
  };
}

export function createTelemetry(deps: BootstrapDeps): TelemetryHandle {
  const config = resolveTelemetryConfig(deps.env);
  const freeze = deps.campaignFreeze ?? resolveCampaignFreeze(deps.env);
  const clock = deps.clock ?? { now: () => Date.now() };
  if (config.mode === "off") return offHandle(freeze, clock);

  const resource = resourceFromAttributes({ ...config.resourceAttributes, "service.name": config.serviceName });
  const ledger = new LedgerSpanProcessor(deps.store ?? { commit: (rows) => getHistory().telemetry.commitRunSpans(rows), prune: retentionPrune(config) });
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
    maxCaptureMode: config.maxCapture,
    meter: meterProvider?.getMeter("qayaba"),
    flush: () => ledger.flush(),
  });

  let loggerProvider: LoggerProvider | undefined;
  let stopLogShipping: () => void = () => {};
  if (config.otlp?.logsUrl) {
    const exporter = (deps.logExporterFactory ?? ((url: string) => new OTLPLogExporter({ url })))(config.otlp.logsUrl);
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({ exporter, ...config.otlp.batch })],
    });
    if (deps.shipLogs) {
      /* Turn bodies share the log pipeline and its gate: the composition roots only. */
      registerPromptBodyHost({
        exporter: new PromptBodyExporter({ logger: loggerProvider.getLogger("qayaba"), redact: (text) => adapter.redactIn(adapter.logTarget()?.context, text, Number.POSITIVE_INFINITY) }),
        activeMode: () => adapter.logTarget()?.mode,
      });
      installLogShipper(
        createLogShipper({
          logger: loggerProvider.getLogger("qayaba"),
          target: () => adapter.logTarget(),
          processMode: () => adapter.processCaptureMode,
          redact: (context, text, cap) => adapter.redactIn(context, text, cap),
        }),
      );
      stopLogShipping = () => installLogShipper(undefined);
    }
  }

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
    /* Stop mirroring first, then commit the local ledger before anything that can hang. */
    stopLogShipping();
    stopLogShipping = () => {};
    registerPromptBodyHost(undefined);
    ledger.flush();
    const stop = async (): Promise<void> => {
      await provider.forceFlush();
      await provider.shutdown();
      await loggerProvider?.forceFlush();
      await loggerProvider?.shutdown();
      await meterProvider?.shutdown();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([stop(), deadline]);
    } catch (error) {
      appLogger.error(`[telemetry] shutdown failed: ${sanitizeText(error instanceof Error ? error.message : String(error), "issue").text}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (deps.registerGlobal) apiContext.disable();
    }
  };

  return { telemetry: adapter, clock, health, stopLogShipping: () => stopLogShipping(), shutdown };
}

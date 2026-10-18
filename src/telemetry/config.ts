/* Telemetry configuration, read once from the environment at composition. No OpenTelemetry import: the history store reads the retention window from here too. A mistyped value fails loudly, as the other operator switches do. */

import { DEFAULT_CAPTURE_MODE, isCaptureMode, type CaptureMode } from "@kernel/telemetry/capture-mode";

export const DEFAULT_SPAN_RETENTION_DAYS = 30;
export const DEFAULT_CAMPAIGN_RETENTION_DAYS = 180;
export const DEFAULT_SERVICE_NAME = "qayaba-orchestrator";

export type TelemetryMode = "off" | "local";

export interface BatchProcessorOptions {
  readonly scheduledDelayMillis: number;
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
  readonly exportTimeoutMillis: number;
}

export interface TelemetryConfig {
  readonly mode: TelemetryMode;
  readonly serviceName: string;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly retentionDays: number;
  /* How long a campaign-tagged run keeps its turns and spans (R4). */
  readonly campaignRetentionDays: number;
  /* The most content a run's trace may carry, whatever a request asks for (QA_TELEMETRY_MAX_CAPTURE, default metadata). */
  readonly maxCapture: CaptureMode;
  /* Present only when an OTLP endpoint is configured. */
  readonly otlp?: { readonly url: string; readonly metricsUrl?: string; readonly batch: BatchProcessorOptions };
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(env[name])}`);
  return Number(raw);
}

export const MAX_SPAN_RETENTION_DAYS = 3650;

export function parseRetentionDays(raw: string | undefined): number {
  const days = positiveInt({ QA_TELEMETRY_RETENTION_DAYS: raw }, "QA_TELEMETRY_RETENTION_DAYS", DEFAULT_SPAN_RETENTION_DAYS);
  if (days > MAX_SPAN_RETENTION_DAYS) throw new Error(`QA_TELEMETRY_RETENTION_DAYS must be at most ${MAX_SPAN_RETENTION_DAYS}, got ${days}`);
  return days;
}

export function parseCampaignRetentionDays(raw: string | undefined): number {
  const days = positiveInt({ QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS: raw }, "QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS", DEFAULT_CAMPAIGN_RETENTION_DAYS);
  if (days > MAX_SPAN_RETENTION_DAYS) throw new Error(`QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS must be at most ${MAX_SPAN_RETENTION_DAYS}, got ${days}`);
  return days;
}

/* The server's ceiling on content capture. A mistyped value fails loudly, as the other operator switches do. */
export function parseMaxCapture(raw: string | undefined): CaptureMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_CAPTURE_MODE;
  if (isCaptureMode(value)) return value;
  throw new Error(`QA_TELEMETRY_MAX_CAPTURE must be off, metadata or full, got ${JSON.stringify(raw)}`);
}

function resolveMode(env: Env): TelemetryMode {
  const raw = (env.QA_TELEMETRY ?? "").trim().toLowerCase();
  let mode: TelemetryMode;
  if (raw === "" || raw === "local") mode = "local";
  else if (raw === "off") mode = "off";
  else throw new Error(`QA_TELEMETRY must be off or local, got ${JSON.stringify(env.QA_TELEMETRY)}`);
  /* Only NodeSDK honors OTEL_SDK_DISABLED; this composition builds the provider by hand, so it honors it here. */
  if ((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return "off";
  return mode;
}

function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

function resolveOtlp(env: Env): TelemetryConfig["otlp"] {
  const traces = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "").trim();
  const generic = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (traces === "" && generic === "") return undefined;
  const base = generic.replace(/\/+$/, "");
  const url = traces !== "" ? traces : `${base}/v1/traces`;
  const metrics = (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? "").trim();
  const metricsUrl = metrics !== "" ? metrics : generic !== "" ? `${base}/v1/metrics` : undefined;
  return {
    url,
    ...(metricsUrl ? { metricsUrl } : {}),
    batch: {
      scheduledDelayMillis: positiveInt(env, "OTEL_BSP_SCHEDULE_DELAY", 5000),
      maxQueueSize: positiveInt(env, "OTEL_BSP_MAX_QUEUE_SIZE", 2048),
      maxExportBatchSize: positiveInt(env, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512),
      exportTimeoutMillis: positiveInt(env, "OTEL_BSP_EXPORT_TIMEOUT", 30000),
    },
  };
}

export function resolveTelemetryConfig(env: Env): TelemetryConfig {
  const mode = resolveMode(env);
  const parsed = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const { "service.name": fromAttrs, ...resourceAttributes } = parsed;
  const serviceName = (env.OTEL_SERVICE_NAME ?? "").trim() || fromAttrs || DEFAULT_SERVICE_NAME;
  const retentionDays = parseRetentionDays(env.QA_TELEMETRY_RETENTION_DAYS);
  const otlp = mode === "local" ? resolveOtlp(env) : undefined;
  const campaignRetentionDays = parseCampaignRetentionDays(env.QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS);
  const maxCapture = parseMaxCapture(env.QA_TELEMETRY_MAX_CAPTURE);
  return { mode, serviceName, resourceAttributes, retentionDays, campaignRetentionDays, maxCapture, ...(otlp ? { otlp } : {}) };
}

/* Where the telemetry backends' health probes look (src/telemetry/backend-health.ts), read once from the environment. None is set by default. */

import { DEFAULT_SERVICE_NAME } from "./telemetry-config";

export interface BackendHealthConfig {
  readonly lokiUrl?: string;
  readonly tempoUrl?: string;
  readonly collectorMetricsUrls: readonly string[];
  /* The service whose newest line and trace are looked for. */
  readonly serviceName: string;
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

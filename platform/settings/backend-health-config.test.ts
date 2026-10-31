import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackendHealthConfig } from "./backend-health-config";

test("the probes read their addresses from the environment, and none are set by default", () => {
  assert.equal(resolveBackendHealthConfig({}).lokiUrl, undefined);
  const cfg = resolveBackendHealthConfig({ QA_TELEMETRY_LOKI_URL: "http://a:1/", QA_TELEMETRY_TEMPO_URL: "http://b:2", QA_TELEMETRY_COLLECTOR_METRICS_URLS: "http://c:3/metrics, http://d:4/metrics", OTEL_SERVICE_NAME: "svc" });
  assert.deepEqual(cfg, { lokiUrl: "http://a:1", tempoUrl: "http://b:2", collectorMetricsUrls: ["http://c:3/metrics", "http://d:4/metrics"], serviceName: "svc" });
});

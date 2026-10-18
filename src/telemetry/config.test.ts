import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTelemetryConfig, parseRetentionDays, parseMaxCapture, DEFAULT_SPAN_RETENTION_DAYS } from "./config";

test("telemetry defaults to local with no exporter and the default service name", () => {
  const c = resolveTelemetryConfig({});
  assert.equal(c.mode, "local");
  assert.equal(c.otlp, undefined);
  assert.equal(c.serviceName, "qayaba-orchestrator");
  assert.equal(c.retentionDays, DEFAULT_SPAN_RETENTION_DAYS);
});

test("QA_TELEMETRY accepts off and local in any case and rejects anything else naming the variable", () => {
  assert.equal(resolveTelemetryConfig({ QA_TELEMETRY: "OFF" }).mode, "off");
  assert.equal(resolveTelemetryConfig({ QA_TELEMETRY: " local " }).mode, "local");
  assert.equal(resolveTelemetryConfig({ QA_TELEMETRY: "" }).mode, "local");
  assert.throws(() => resolveTelemetryConfig({ QA_TELEMETRY: "full" }), /QA_TELEMETRY/);
  assert.throws(() => resolveTelemetryConfig({ QA_TELEMETRY: "true" }), /QA_TELEMETRY/);
});

test("OTEL_SDK_DISABLED turns telemetry off whatever QA_TELEMETRY says", () => {
  assert.equal(resolveTelemetryConfig({ OTEL_SDK_DISABLED: "true" }).mode, "off");
  assert.equal(resolveTelemetryConfig({ OTEL_SDK_DISABLED: "TRUE", QA_TELEMETRY: "local" }).mode, "off");
  assert.equal(resolveTelemetryConfig({ OTEL_SDK_DISABLED: "false" }).mode, "local");
});

test("the generic endpoint gets the traces path appended, the traces endpoint is used as given", () => {
  assert.equal(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }).otlp?.url, "http://collector:4318/v1/traces");
  assert.equal(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }).otlp?.url, "http://collector:4318/v1/traces");
  assert.equal(
    resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:1", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b:2/custom" }).otlp?.url,
    "http://b:2/custom",
  );
});

test("the metrics endpoint follows the same rule with its own path", () => {
  assert.equal(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }).otlp?.metricsUrl, "http://collector:4318/v1/metrics");
  assert.equal(
    resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:1", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://m:2/x" }).otlp?.metricsUrl,
    "http://m:2/x",
  );
  assert.equal(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b:2/t" }).otlp?.metricsUrl, undefined);
});

test("a blank endpoint means no exporter", () => {
  assert.equal(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }).otlp, undefined);
});

test("batch processor variables map to its options, with SDK defaults when unset", () => {
  assert.deepEqual(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1" }).otlp?.batch, {
    scheduledDelayMillis: 5000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    exportTimeoutMillis: 30000,
  });
  const c = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1",
    OTEL_BSP_SCHEDULE_DELAY: "100",
    OTEL_BSP_MAX_QUEUE_SIZE: "10",
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "5",
    OTEL_BSP_EXPORT_TIMEOUT: "200",
  });
  assert.deepEqual(c.otlp?.batch, { scheduledDelayMillis: 100, maxQueueSize: 10, maxExportBatchSize: 5, exportTimeoutMillis: 200 });
});

test("a malformed batch variable stops the composition naming it", () => {
  assert.throws(() => resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1", OTEL_BSP_MAX_QUEUE_SIZE: "lots" }), /OTEL_BSP_MAX_QUEUE_SIZE/);
  assert.throws(() => resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:1", OTEL_BSP_SCHEDULE_DELAY: "0" }), /OTEL_BSP_SCHEDULE_DELAY/);
});

test("resource attributes parse as comma-separated percent-decoded pairs and the service name wins", () => {
  const c = resolveTelemetryConfig({ OTEL_SERVICE_NAME: "svc", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev, team=a%20b,service.name=ignored,broken" });
  assert.equal(c.serviceName, "svc");
  assert.deepEqual(c.resourceAttributes, { "deployment.environment": "dev", team: "a b" });
});

test("the resource service name falls back to the resource attribute before the default", () => {
  assert.equal(resolveTelemetryConfig({ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" }).serviceName, "from-attrs");
});

test("retention days parse as a positive whole number and reject the rest", () => {
  assert.equal(parseRetentionDays(undefined), DEFAULT_SPAN_RETENTION_DAYS);
  assert.equal(parseRetentionDays(""), DEFAULT_SPAN_RETENTION_DAYS);
  assert.equal(parseRetentionDays("7"), 7);
  for (const bad of ["0", "-1", "1.5", "week", "3651"]) assert.throws(() => parseRetentionDays(bad), /QA_TELEMETRY_RETENTION_DAYS/, bad);
});

test("retention days are capped at ten years", () => {
  assert.equal(parseRetentionDays("3650"), 3650);
});

test("the capture ceiling defaults to metadata and a mistyped value stops the boot", () => {
  assert.equal(parseMaxCapture(undefined), "metadata");
  assert.equal(parseMaxCapture(""), "metadata");
  assert.equal(parseMaxCapture("FULL"), "full");
  assert.equal(parseMaxCapture(" off "), "off");
  assert.throws(() => parseMaxCapture("everything"), /QA_TELEMETRY_MAX_CAPTURE/);
  assert.equal(resolveTelemetryConfig({}).maxCapture, "metadata");
  assert.equal(resolveTelemetryConfig({ QA_TELEMETRY_MAX_CAPTURE: "full" }).maxCapture, "full");
});

/* Security properties of the opt-in Langfuse profile (docs/observability-design.md §9.2, §10): which networks its services are on, what is published, where the keys go and that the collector config differs from the plain one only by the Langfuse exporter. Parsed from the real files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

type Service = { networks?: string[]; ports?: string[]; profiles?: string[]; image?: string; environment?: Record<string, string>; command?: string | string[]; volumes?: string[]; read_only?: boolean; cap_drop?: string[] };
type Compose = { services: Record<string, Service>; networks?: Record<string, { internal?: boolean }> };
type Collector = { extensions?: Record<string, unknown>; exporters: Record<string, unknown>; service: { extensions?: string[]; pipelines: Record<string, { exporters: string[] }> } };

const langfuseText = read("docker-compose.langfuse.yml");
const langfuse = parse(langfuseText, { merge: true }) as Compose;
const telemetry = parse(read("docker-compose.telemetry.yml"), { merge: true }) as Compose;
const NEW_SERVICES = ["langfuse-web", "langfuse-worker", "clickhouse", "postgres", "redis", "minio", "langfuse-proxy"];
const STORES = ["clickhouse", "postgres", "redis", "minio"];
const svc = (name: string): Service => {
  const found = langfuse.services[name];
  if (!found) throw new Error(`missing service ${name}`);
  return found;
};
/* The networks of a service as compose merges the two files: the telemetry file's list, then the Langfuse file's. */
const mergedNetworks = (name: string): string[] => [...new Set([...(telemetry.services[name]?.networks ?? []), ...(langfuse.services[name]?.networks ?? [])])];
const allNames = [...new Set([...Object.keys(telemetry.services), ...Object.keys(langfuse.services)])];
const internal = (network: string): boolean => (langfuse.networks?.[network] ?? telemetry.networks?.[network])?.internal === true;

test("every Langfuse service runs only under the langfuse profile", () => {
  for (const name of NEW_SERVICES) assert.deepEqual(svc(name).profiles, ["langfuse"], name);
});

test("images are pinned to an exact version tag and a digest", () => {
  for (const name of NEW_SERVICES) {
    const image = String(svc(name).image);
    assert.match(image, /@sha256:[0-9a-f]{64}$/, `${name}: ${image} has no digest`);
    assert.match(image, /:(\d+\.\d+(\.\d+)?(-[a-z]+)?|latest)@/, `${name}: ${image} has no exact tag`);
    assert.doesNotMatch(image, /:\d+@/, `${name}: ${image} is a bare major tag`);
  }
});

test("only the Langfuse proxy publishes a port, on 127.0.0.1:3002", () => {
  const published = NEW_SERVICES.flatMap((name) => (svc(name).ports ?? []).map((port) => ({ name, port })));
  assert.deepEqual(published, [{ name: "langfuse-proxy", port: "127.0.0.1:3002:8080" }]);
  for (const name of ["collector", "orchestrator"]) assert.equal(svc(name).ports, undefined, name);
});

test("the stores and the worker are on langfuse-internal only, which is internal", () => {
  assert.equal(internal("langfuse-internal"), true);
  for (const name of [...STORES, "langfuse-worker"]) assert.deepEqual(svc(name).networks, ["langfuse-internal"], name);
});

test("langfuse-web is on internal networks only, and the only way in is langfuse-api, which three services share", () => {
  const web = svc("langfuse-web").networks ?? [];
  assert.deepEqual([...web].sort(), ["langfuse-api", "langfuse-internal"]);
  for (const network of web) assert.equal(internal(network), true, network);
  assert.equal(internal("langfuse-api"), true);
  assert.deepEqual(allNames.filter((name) => mergedNetworks(name).includes("langfuse-api")).sort(), ["collector", "langfuse-web", "orchestrator"]);
  const onTelemetry = NEW_SERVICES.filter((name) => (svc(name).networks ?? []).includes("telemetry-internal"));
  assert.deepEqual(onTelemetry, [], "no Langfuse service is on telemetry-internal");
  assert.ok(!mergedNetworks("orchestrator").includes("langfuse-internal"), "the orchestrator must not reach the stores");
  assert.ok(!mergedNetworks("collector").includes("langfuse-internal"), "the collector must not reach the stores");
});

test("the untrusted collector shares no network with any Langfuse service", () => {
  const untrusted = mergedNetworks("collector-agents");
  assert.ok(untrusted.length > 0);
  for (const name of NEW_SERVICES) {
    const shared = mergedNetworks(name).filter((network) => untrusted.includes(network));
    assert.deepEqual(shared, [], `${name} shares ${shared.join(",")} with collector-agents`);
  }
});

test("the proxy is the only member of the non-internal langfuse-ui network", () => {
  assert.notEqual(langfuse.networks?.["langfuse-ui"]?.internal, true);
  const members = allNames.filter((name) => mergedNetworks(name).includes("langfuse-ui"));
  assert.deepEqual(members, ["langfuse-proxy"]);
  assert.equal(svc("langfuse-proxy").read_only, true);
  assert.deepEqual(svc("langfuse-proxy").cap_drop, ["ALL"]);
});

test("the agents container shares no network with any Langfuse service and receives no Langfuse variable", () => {
  const agents = mergedNetworks("agents");
  assert.ok(agents.length > 0);
  for (const name of NEW_SERVICES) {
    const shared = (svc(name).networks ?? []).filter((network) => agents.includes(network));
    assert.deepEqual(shared, [], `${name} shares ${shared.join(",")} with the agents`);
  }
  assert.equal(langfuse.services.agents, undefined);
  assert.equal(svc("collector").command?.toString().includes("collector-agents"), false);
});

test("the untrusted collector is not touched by the Langfuse file and its config never mentions Langfuse exporters", () => {
  assert.equal(langfuse.services["collector-agents"], undefined);
  assert.doesNotMatch(read("config/otel/collector-agents.yaml"), /otlphttp\/langfuse|basicauth/);
});

test("every secret is read from the environment with a required marker and no default", () => {
  assert.doesNotMatch(langfuseText, /\$\{[A-Z_]+:-/, "a variable has a default");
  assert.doesNotMatch(langfuseText, /(PASSWORD|SECRET|API_KEY|_KEY|SALT|REDIS_AUTH)\s*:\s*["']?(?!\$\{)[A-Za-z0-9]/, "a literal secret value");
  for (const [name, service] of Object.entries(langfuse.services)) {
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      if (/PASSWORD|SECRET|_KEY$|SALT|ENCRYPTION|REDIS_AUTH/.test(key) && !/^LANGFUSE_INIT_(ORG|PROJECT)_(ID|NAME)$/.test(key) && key !== "MINIO_ROOT_USER") {
        assert.match(String(value), /^\$\{[A-Z_]+:\?[^}]+\}$/, `${name}.${key} is not a required variable`);
      }
    }
  }
  assert.match(String(svc("redis").command?.[2]), /^\$\{LANGFUSE_REDIS_AUTH:\?[^}]+\}$/);
});

test("the project keys reach the orchestrator, the collector and the Langfuse web service from the same two variables", () => {
  for (const name of ["orchestrator", "collector"]) {
    assert.match(String(svc(name).environment?.LANGFUSE_PUBLIC_KEY), /^\$\{LANGFUSE_PUBLIC_KEY:\?/, name);
    assert.match(String(svc(name).environment?.LANGFUSE_SECRET_KEY), /^\$\{LANGFUSE_SECRET_KEY:\?/, name);
  }
  assert.match(String(svc("langfuse-web").environment?.LANGFUSE_INIT_PROJECT_PUBLIC_KEY), /^\$\{LANGFUSE_PUBLIC_KEY:\?/);
  assert.match(String(svc("langfuse-web").environment?.LANGFUSE_INIT_PROJECT_SECRET_KEY), /^\$\{LANGFUSE_SECRET_KEY:\?/);
  assert.equal(svc("orchestrator").environment?.LANGFUSE_BASE_URL, "http://langfuse-web:3000");
  /* The store secrets are never handed to the orchestrator. */
  const names = Object.keys(svc("orchestrator").environment ?? {}).sort();
  assert.deepEqual(names, ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
});

test("Langfuse's own telemetry is off and signup is closed", () => {
  assert.equal(String(svc("langfuse-web").environment?.TELEMETRY_ENABLED), "false");
  assert.equal(String(svc("langfuse-web").environment?.AUTH_DISABLE_SIGNUP), "true");
});

test("the Langfuse collector config is the plain one plus the Langfuse exporter, and nothing else", () => {
  assert.deepEqual(svc("collector").command, ["--config=/etc/otelcol/collector-langfuse.yaml"]);
  assert.ok((svc("collector").volumes ?? []).includes("./config/otel/collector-langfuse.yaml:/etc/otelcol/collector-langfuse.yaml:ro"));
  const plain = parse(read("config/otel/collector.yaml")) as Collector;
  const withLangfuse = parse(read("config/otel/collector-langfuse.yaml")) as Collector;
  const { "otlphttp/langfuse": exporter, ...otherExporters } = withLangfuse.exporters as Record<string, unknown>;
  assert.ok(exporter, "no langfuse exporter");
  assert.deepEqual(otherExporters, plain.exporters);
  assert.deepEqual(withLangfuse.service.extensions, ["basicauth/langfuse"]);
  assert.deepEqual(Object.keys(withLangfuse.extensions ?? {}), ["basicauth/langfuse"]);
  const stripped = structuredClone(withLangfuse);
  for (const pipeline of Object.values(stripped.service.pipelines)) pipeline.exporters = pipeline.exporters.filter((name) => name !== "otlphttp/langfuse");
  assert.deepEqual(stripped.service.pipelines, plain.service.pipelines);
  assert.ok(withLangfuse.service.pipelines["traces/orchestrator"]!.exporters.includes("otlphttp/langfuse"));
  assert.ok(!withLangfuse.service.pipelines["metrics/orchestrator"]!.exporters.includes("otlphttp/langfuse"), "Langfuse discards OTLP metrics");
});

test("the Langfuse exporter targets the OTLP path over HTTP with ingestion version 4 and keys from the environment", () => {
  const exporter = (parse(read("config/otel/collector-langfuse.yaml")) as { exporters: Record<string, { endpoint: string; headers: Record<string, string>; auth: { authenticator: string } }> }).exporters["otlphttp/langfuse"]!;
  assert.equal(exporter.endpoint, "http://langfuse-web:3000/api/public/otel");
  assert.equal(exporter.headers["x-langfuse-ingestion-version"], "4");
  assert.equal(exporter.auth.authenticator, "basicauth/langfuse");
  const text = read("config/otel/collector-langfuse.yaml");
  assert.match(text, /username: \$\{env:LANGFUSE_PUBLIC_KEY\}/);
  assert.match(text, /password: \$\{env:LANGFUSE_SECRET_KEY\}/);
});

test("plain compose, the override and the telemetry file carry no Langfuse service, network or variable", () => {
  for (const file of ["docker-compose.yml", "docker-compose.override.yml", "docker-compose.telemetry.yml"]) assert.doesNotMatch(read(file), /langfuse/i, file);
  assert.doesNotMatch(read("config/otel/collector.yaml"), /langfuse/i);
});

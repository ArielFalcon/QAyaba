/* Security properties of the opt-in local telemetry stack (docs/observability-design.md §9.2, §10): which networks exist, which ports are published, which receiver the agents reach and what its pipeline strips. Parsed from the real files, so a later edit that weakens one fails here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

type Service = { networks?: string[] | Record<string, unknown>; ports?: string[]; profiles?: string[]; image?: string; user?: string; environment?: Record<string, string>; volumes?: string[]; depends_on?: Record<string, { condition?: string }>; read_only?: boolean; network_mode?: string; cap_drop?: string[] };
type Compose = { services: Record<string, Service>; networks?: Record<string, { internal?: boolean }> };
type Pipeline = { receivers: string[]; processors: string[]; exporters: string[] };
type TransformEntry = { context: string; statements: string[] };
type Collector = {
  receivers: Record<string, { protocols: { http: { endpoint: string } } }>;
  processors: Record<string, { error_mode?: string; trace_statements?: TransformEntry[] }>;
  exporters: Record<string, { rotation?: { max_megabytes: number; max_backups: number }; endpoint?: string }>;
  service: { pipelines: Record<string, Pipeline> };
};

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

const telemetryText = read("docker-compose.telemetry.yml");
const telemetry = parse(telemetryText, { merge: true }) as Compose;
const base = parse(read("docker-compose.yml")) as Compose;
const svc = (name: string): Service => must(telemetry.services[name], `service ${name}`);
const networksOf = (service: Service | undefined): string[] => (Array.isArray(service?.networks) ? service.networks : Object.keys(service?.networks ?? {}));

/* The collector config a service mounts, if it mounts one from config/otel. */
function collectorConfigOf(service: Service): { file: string; text: string; config: Collector } | undefined {
  const mount = (service.volumes ?? []).find((volume) => /^\.\/config\/otel\/collector[^:]*\.yaml:/.test(volume));
  if (!mount) return undefined;
  const file = mount.split(":")[0]!.replace("./", "");
  const text = read(file);
  return { file, text, config: parse(text) as Collector };
}
const collectorFiles = Object.entries(telemetry.services).flatMap(([name, service]) => {
  const found = collectorConfigOf(service);
  return found ? [{ name, ...found }] : [];
});
const trusted = must(collectorFiles.find((entry) => entry.name === "collector"), "collector config");
const untrusted = must(collectorFiles.find((entry) => entry.name === "collector-agents"), "collector-agents config");

const PUBLISHED = Object.entries(telemetry.services).flatMap(([name, service]) => (service.ports ?? []).map((port) => ({ name, port })));

test("neither collector publishes a host port", () => {
  assert.equal(svc("collector").ports, undefined);
  assert.equal(svc("collector-agents").ports, undefined);
});

test("every published port of the telemetry file binds loopback", () => {
  assert.ok(PUBLISHED.length > 0);
  for (const { port } of PUBLISHED) assert.match(port, /^127\.0\.0\.1:/, `${port} is not loopback`);
});

test("only the Grafana proxy is published, on 127.0.0.1:3001", () => {
  assert.deepEqual(PUBLISHED, [{ name: "grafana-proxy", port: "127.0.0.1:3001:8080" }]);
});

test("both telemetry networks are internal", () => {
  assert.equal(telemetry.networks?.["telemetry-internal"]?.internal, true);
  assert.equal(telemetry.networks?.["agent-otlp"]?.internal, true);
});

test("lgtm is on telemetry-internal only: no route out, no published port", () => {
  assert.deepEqual(networksOf(svc("lgtm")), ["telemetry-internal"]);
  assert.equal(svc("lgtm").ports, undefined);
  for (const network of networksOf(svc("lgtm"))) assert.equal(telemetry.networks?.[network]?.internal, true, network);
});

test("the proxy is the only member of the non-internal telemetry-ui network", () => {
  assert.notEqual(telemetry.networks?.["telemetry-ui"]?.internal, true);
  const members = Object.entries(telemetry.services).filter(([, service]) => networksOf(service).includes("telemetry-ui")).map(([name]) => name);
  assert.deepEqual(members, ["grafana-proxy"]);
  assert.ok(networksOf(svc("grafana-proxy")).includes("telemetry-internal"));
});

test("the agents container is on agent-otlp and never on a telemetry network that reaches the trusted side or the viewer", () => {
  const agents = networksOf(svc("agents"));
  assert.ok(agents.includes("agent-otlp"));
  assert.ok(agents.includes("default"));
  assert.ok(!agents.includes("telemetry-internal"));
  assert.ok(!agents.includes("telemetry-ui"));
});

test("the orchestrator keeps the default network and joins telemetry-internal only", () => {
  const orchestrator = networksOf(svc("orchestrator"));
  assert.deepEqual([...orchestrator].sort(), ["default", "telemetry-internal"]);
});

test("the trusted collector is on telemetry-internal only, so the agents can never reach it", () => {
  assert.deepEqual(networksOf(svc("collector")), ["telemetry-internal"]);
});

test("the untrusted collector is the only service that shares a non-default network with the agents", () => {
  const agentNetworks = networksOf(svc("agents")).filter((network) => network !== "default");
  const sharing = Object.entries(telemetry.services)
    .filter(([name, service]) => name !== "agents" && networksOf(service).some((network) => agentNetworks.includes(network)))
    .map(([name]) => name);
  assert.deepEqual(sharing, ["collector-agents"]);
});

test("any collector reachable from the agents hosts only the agents receiver and strips and stamps in every pipeline", () => {
  const agentNetworks = networksOf(svc("agents")).filter((network) => network !== "default");
  const reachable = collectorFiles.filter((entry) => networksOf(svc(entry.name)).some((network) => agentNetworks.includes(network)));
  assert.ok(reachable.length > 0);
  for (const { name, config } of reachable) {
    assert.deepEqual(Object.keys(config.receivers), ["otlp/agents"], `${name} exposes a receiver the agents must not use`);
    for (const [pipelineName, pipeline] of Object.entries(config.service.pipelines)) {
      assert.deepEqual(pipeline.receivers, ["otlp/agents"], `${name}/${pipelineName}`);
      assert.ok(pipeline.processors.includes("transform/agents"), `${name}/${pipelineName} has no strip and stamp`);
      assert.ok(pipeline.processors.indexOf("transform/agents") < pipeline.processors.indexOf("redaction"), `${name}/${pipelineName}`);
    }
    assertStripsAndStamps(config);
  }
});

test("the trusted collector hosts only the orchestrator receiver, on its own port", () => {
  assert.deepEqual(Object.keys(trusted.config.receivers), ["otlp/orchestrator"]);
  assert.equal(trusted.config.receivers["otlp/orchestrator"]?.protocols.http.endpoint, "0.0.0.0:4318");
  assert.equal(untrusted.config.receivers["otlp/agents"]?.protocols.http.endpoint, "0.0.0.0:4319");
  for (const pipeline of Object.values(trusted.config.service.pipelines)) {
    assert.deepEqual(pipeline.receivers, ["otlp/orchestrator"]);
    assert.ok(!pipeline.processors.includes("transform/agents"));
  }
  assert.equal(untrusted.config.service.pipelines["metrics/agents"], undefined);
});

test("the telemetry services run only under the telemetry profile", () => {
  for (const name of ["otel-debug-init", "collector", "collector-agents", "lgtm", "grafana-proxy"]) assert.deepEqual(svc(name).profiles, ["telemetry"], name);
});

test("Grafana has anonymous access off and a required admin password with no default", () => {
  const env = svc("lgtm").environment ?? {};
  assert.equal(String(env.GF_AUTH_ANONYMOUS_ENABLED), "false");
  assert.match(String(env.GF_SECURITY_ADMIN_PASSWORD), /^\$\{GRAFANA_ADMIN_PASSWORD:\?[^}]*\}$/);
  assert.equal(String(env.GF_PLUGINS_PREINSTALL_DISABLED), "true");
  assert.equal(String(env.GF_NEWS_NEWS_FEED_ENABLED), "false");
  assert.equal(String(env.GF_ANALYTICS_FEEDBACK_LINKS_ENABLED), "false");
});

test("both collectors run as a non-root uid, read-only, with no capability, after the volume is prepared", () => {
  for (const name of ["collector", "collector-agents"]) {
    const service = svc(name);
    assert.match(String(service.user), /^[1-9][0-9]*:[1-9][0-9]*$/, `${name} runs as root`);
    assert.equal(service.read_only, true, name);
    assert.deepEqual(service.cap_drop, ["ALL"], name);
    assert.equal(service.depends_on?.["otel-debug-init"]?.condition, "service_completed_successfully", name);
  }
  assert.equal(svc("otel-debug-init").network_mode, "none");
});

test("no literal secret or default password appears in the telemetry files", () => {
  const texts = [telemetryText, trusted.text, untrusted.text, read("config/otel/grafana-proxy.conf")];
  for (const text of texts) {
    assert.doesNotMatch(text, /\$\{[A-Z_]*(PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*:-[^}]/, "a secret variable has a default");
    assert.doesNotMatch(text, /(PASSWORD|SECRET|TOKEN|API_KEY)\s*[:=]\s*["']?(?!\$\{)[A-Za-z0-9]/i, "a literal secret value");
  }
  assert.doesNotMatch(telemetryText, /LANGFUSE/i);
  for (const text of [trusted.text, untrusted.text]) assert.doesNotMatch(text, /langfuse\s*:|otlphttp\/langfuse/i);
});

test("the orchestrator is pointed at the trusted receiver and the agents get no OTEL variable", () => {
  assert.equal(svc("orchestrator").environment?.OTEL_EXPORTER_OTLP_ENDPOINT, "http://collector:4318");
  assert.equal(svc("orchestrator").environment?.OTEL_SERVICE_NAME, "qayaba-orchestrator");
  assert.equal(svc("agents").environment, undefined);
});

test("each collector config is mounted read-only", () => {
  assert.ok((svc("collector").volumes ?? []).includes("./config/otel/collector.yaml:/etc/otelcol/collector.yaml:ro"));
  assert.ok((svc("collector-agents").volumes ?? []).includes("./config/otel/collector-agents.yaml:/etc/otelcol/collector-agents.yaml:ro"));
});

test("the base compose file carries no telemetry service, network or variable", () => {
  for (const name of ["collector", "collector-agents", "lgtm", "grafana-proxy"]) assert.equal(base.services[name], undefined);
  assert.equal(base.networks, undefined);
  assert.doesNotMatch(read("docker-compose.yml"), /telemetry|OTEL_|GRAFANA/i);
  assert.doesNotMatch(read("docker-compose.override.yml"), /telemetry|OTEL_|GRAFANA/i);
});

test("every pipeline of both collectors redacts, limits memory first and batches", () => {
  for (const { name, config } of collectorFiles) {
    for (const [pipelineName, pipeline] of Object.entries(config.service.pipelines)) {
      for (const processor of ["memory_limiter", "redaction", "batch"]) assert.ok(pipeline.processors.includes(processor), `${name}/${pipelineName} lacks ${processor}`);
      assert.equal(pipeline.processors[0], "memory_limiter", `${name}/${pipelineName}`);
    }
  }
});

test("redaction keys are anchored and gen_ai.usage.* is left alone", () => {
  for (const { config } of collectorFiles) {
    const redaction = config.processors.redaction as unknown as { blocked_key_patterns: string[]; ignored_key_patterns: string[] };
    const blocks = (key: string): boolean => redaction.blocked_key_patterns.some((pattern) => new RegExp(pattern.replace(/^\(\?i\)/, ""), "i").test(key));
    for (const key of ["http.request.header.authorization", "db.password", "api_key", "cookie", "set-cookie", "auth_token"]) assert.ok(blocks(key), `${key} should be blocked`);
    for (const key of ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "max_tokens", "author", "tokenizer", "secretary"]) assert.ok(!blocks(key), `${key} must not be blocked`);
    assert.ok(redaction.ignored_key_patterns.some((pattern) => new RegExp(pattern).test("gen_ai.usage.input_tokens")));
    const values = (config.processors.redaction as unknown as { blocked_values: string[] }).blocked_values;
    const hit = (text: string): boolean => values.some((pattern) => new RegExp(pattern.replace(/^\(\?i\)/, ""), pattern.startsWith("(?i)") ? "i" : "").test(text));
    for (const secret of ["Bearer abcdefghijklmnop12345", "postgres://admin:hunter2pw@db:5432/x", `AIza${"a".repeat(35)}`, "xoxb-1234567890-abcdef", `npm_${"a".repeat(36)}`]) assert.ok(hit(secret), `${secret} should be masked`);
    assert.ok(!hit("https://example.com/path"));
  }
});

test("the debug exporter is declared but used by no pipeline, and the file exporters rotate into different files", () => {
  const paths: string[] = [];
  for (const { config } of collectorFiles) {
    assert.ok(!Object.values(config.service.pipelines).some((pipeline) => pipeline.exporters.includes("debug")));
    assert.deepEqual(config.exporters["file/debug"]?.rotation, { max_megabytes: 100, max_backups: 3 });
    assert.equal(config.exporters["otlphttp/lgtm"]?.endpoint, "http://lgtm:4318");
    paths.push(String((config.exporters["file/debug"] as unknown as { path: string }).path));
  }
  assert.equal(new Set(paths).size, paths.length);
});

/* Every key the untrusted pipeline must remove, in every OTTL context that carries attributes, then the stamp. */
function assertStripsAndStamps(config: Collector): void {
  const transform = must(config.processors["transform/agents"], "transform/agents");
  assert.equal(transform.error_mode, "propagate", "a failing statement must drop the batch, not let a forged key through");
  const entries = transform.trace_statements ?? [];
  const FORBIDDEN = [
    "qayaba.run.id", "qayaba.trust", "langfuse.trace.name", "langfuse.observation.type",
    "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result",
    "ai.prompt", "ai.prompt.messages", "ai.response.text", "ai.toolCall.args", "ai.toolCall.result",
  ];
  const SURVIVORS = ["gen_ai.request.model", "gen_ai.usage.input_tokens", "service.name"];
  for (const context of ["resource", "scope", "span", "spanevent"]) {
    const statements = entries.filter((entry) => entry.context === context).flatMap((entry) => entry.statements);
    assert.ok(statements.length > 0, `${context} context not covered`);
    const deletes = statements.filter((statement) => statement.startsWith("delete_matching_keys("));
    const patterns = deletes.map((statement) => new RegExp(must(statement.match(/, "(.*)"\)$/)?.[1], "regex literal").replaceAll("\\\\", "\\")));
    for (const statement of deletes) assert.ok(statement.startsWith(`delete_matching_keys(${context}.attributes,`), `${statement} is not on ${context}.attributes`);
    const deleted = (key: string): boolean => patterns.some((pattern) => pattern.test(key));
    for (const key of FORBIDDEN) assert.ok(deleted(key), `${context}: ${key} is not deleted`);
    for (const key of SURVIVORS) assert.ok(!deleted(key), `${context}: ${key} must survive`);
    if (context === "resource" || context === "span") {
      const stamp = statements.findIndex((statement) => statement === `set(${context}.attributes["qayaba.trust"], "agent")`);
      assert.ok(stamp >= 0, `${context}: qayaba.trust=agent is not set`);
      assert.ok(stamp > Math.max(...statements.map((statement, at) => (statement.startsWith("delete_matching_keys(") ? at : -1))), `${context}: the stamp must come after every delete`);
    }
  }
  /* The collector has no OTTL context for span links, so the span context drops them whole: their attributes could otherwise carry forged keys. */
  assert.ok(entries.filter((entry) => entry.context === "span").some((entry) => entry.statements.includes("set(span.links, nil)")), "span links are not dropped");
}

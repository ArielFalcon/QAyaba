/* The one list of environment variables the orchestrator reads. Each entry names a variable, its type and default, whether it holds a secret and what it does; docs/settings.md is generated from it and the compose/.env.example parity test is held to it. */

import { DEFAULT_LISTEN_HOST, DEFAULT_PORT } from "../server/port";
import { DEFAULT_TOOLS_PORT } from "../server/tools-endpoint";
import { DEFAULT_JUDGE_DAILY_TOKENS } from "../server/judge-settings";
import { DEFAULT_CAMPAIGN_RETENTION_DAYS, DEFAULT_SERVICE_NAME, DEFAULT_SPAN_RETENTION_DAYS } from "../telemetry/config";
import { resolveRunTimeBudgets } from "@contexts/run-orchestration/application/index";

import { DEFAULT_REVIEWER_TIMEOUT_MS, DEFAULT_SELF_REPO, DEFAULT_SESSION_TTL_SECONDS, DEFAULT_STALL_MS } from "./defaults";

export const SETTING_GROUPS = ["server", "auth", "webhook", "agent", "git", "paths", "sandbox", "run", "telemetry", "retention", "maintainer", "judges"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export type SettingType = "string" | "integer" | "boolean" | "url" | "path" | "enum" | "list";

export interface SettingDef {
  /* The environment variable. */
  readonly env: string;
  /* The field in `Settings[group]` that carries the parsed value, or "-" when the variable is read live from `Settings.environment` or only a child process reads it. */
  readonly key: string;
  readonly group: SettingGroup;
  readonly type: SettingType;
  /* The value in effect when the variable is unset or empty, as an operator reads it. Never present for a secret. */
  readonly default?: string;
  readonly required?: true;
  readonly secret?: true;
  /* The accepted values of an `enum`. */
  readonly values?: readonly string[];
  readonly description: string;
}

/* The built-in wall time of each kind of run: the engine's own table, read through the parser with an empty environment. */
const RUN_TIME_BUDGET_MS = resolveRunTimeBudgets({});

const entry = (def: SettingDef): SettingDef => def;

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  /* server */
  entry({ env: "PORT", key: "port", group: "server", type: "integer", default: String(DEFAULT_PORT), description: "TCP port the control plane listens on (0-65535). An empty value counts as unset." }),
  entry({ env: "LISTEN_HOST", key: "listenHost", group: "server", type: "string", default: DEFAULT_LISTEN_HOST, description: "Interface the control plane listens on. A bare start listens on loopback only; the container image sets 0.0.0.0." }),
  entry({ env: "QA_TOOLS_PORT", key: "toolsPort", group: "server", type: "integer", default: String(DEFAULT_TOOLS_PORT), description: "TCP port of the agents' tools endpoint (1-65535), a second listener that is never published." }),
  entry({ env: "QA_TOOLS_LISTEN_HOST", key: "toolsListenHost", group: "server", type: "string", description: "Interface the tools endpoint binds. Unset, it follows LISTEN_HOST and narrows a wildcard to the container's one non-loopback IPv4 address." }),
  entry({ env: "QA_TOOLS_TOKEN", key: "-", group: "server", type: "string", secret: true, description: "Service token the agents service authenticates to the tools endpoint with (at least 32 characters; the same value on both services). Unset, a random one is generated for the boot and the tools are refused." }),
  entry({ env: "QAYABA_REPO", key: "selfRepo", group: "server", type: "string", default: DEFAULT_SELF_REPO, description: "The repository (owner/name) that holds this orchestrator's own code, which the self-maintainer opens fix pull requests against." }),
  entry({ env: "NO_COLOR", key: "noColor", group: "server", type: "boolean", description: "When set to any non-empty value the command-line client prints no ANSI colors." }),

  /* auth */
  entry({ env: "QA_API_TOKEN", key: "apiToken", group: "auth", type: "string", secret: true, description: "Machine bearer token of the control-plane API. Unset, one is generated once and kept in the data directory." }),
  entry({ env: "AUTH_SIGNING_KEY", key: "signingKey", group: "auth", type: "string", secret: true, description: "Key that signs user session tokens. Unset, the API token signs them." }),
  entry({ env: "AUTH_SESSION_TTL_SECONDS", key: "sessionTtlSeconds", group: "auth", type: "integer", default: String(DEFAULT_SESSION_TTL_SECONDS), description: "Lifetime in seconds of a user session token (a positive whole number)." }),
  entry({ env: "GITHUB_OAUTH_CLIENT_ID", key: "githubOAuthClientId", group: "auth", type: "string", description: "Client id of the GitHub OAuth app the web console signs users in with. Unset, the console's GitHub sign-in is off." }),
  entry({ env: "QA_WEB_AUTO_LOGIN", key: "-", group: "auth", type: "boolean", default: "false", description: "When the exact value true, the same-origin web console signs in without a token for any TCP peer (a loopback peer is always accepted); the Host header must still name a loopback host or an allowlist entry. Read live on each login." }),
  entry({ env: "QA_WEB_LOGIN_HOST_ALLOWLIST", key: "-", group: "auth", type: "list", description: "Comma-separated Host header names the automatic console sign-in accepts in addition to the loopback names (the DNS-rebinding check). Read live on each login." }),

  /* webhook */
  entry({ env: "WEBHOOK_SECRET", key: "secret", group: "webhook", type: "string", secret: true, description: "Shared secret that signs deployment webhooks. Unset, webhooks are refused unless WEBHOOK_ALLOW_UNSIGNED is true." }),
  entry({ env: "WEBHOOK_ALLOW_UNSIGNED", key: "allowUnsigned", group: "webhook", type: "boolean", default: "false", description: "Accept webhooks that carry no signature when no secret is configured. Only the exact value true enables it." }),

  /* agent */
  entry({ env: "OPENCODE_SERVE_URL", key: "serveUrl", group: "agent", type: "url", default: "http://agents:4096", description: "Address of the agent runtime's server." }),
  entry({ env: "OPENCODE_SERVER_PASSWORD", key: "-", group: "agent", type: "string", secret: true, required: true, description: "Basic-auth password of the agent runtime's server; the same value on the orchestrator and agents services. The orchestrator refuses every agent call without it." }),
  entry({ env: "OPENCODE_API_KEY", key: "-", group: "agent", type: "string", secret: true, description: "Provider key of the agent runtime. Read live, because the onboarding surface can set it while the service runs." }),
  entry({ env: "OPENCODE_CONFIG", key: "configPath", group: "agent", type: "path", default: "<root>/agents/opencode.json", description: "Path of the agent runtime's role and model configuration." }),
  entry({ env: "OPENCODE_TIMEOUT_MS", key: "timeoutMs", group: "agent", type: "integer", description: "Overrides the generator session budget of every run mode, in milliseconds. A value that is not a positive number is ignored." }),
  entry({ env: "OPENCODE_REVIEWER_TIMEOUT_MS", key: "reviewerTimeoutMs", group: "agent", type: "integer", default: String(DEFAULT_REVIEWER_TIMEOUT_MS), description: "Reviewer session budget in milliseconds. A value that is not a positive number is ignored." }),
  entry({ env: "OPENCODE_STALL_MS", key: "stallMs", group: "agent", type: "integer", default: String(DEFAULT_STALL_MS), description: "Milliseconds without any agent activity before the stall watchdog fires. A value that is not a positive number is ignored." }),
  entry({ env: "AGENT_SUPERVISOR_URL", key: "-", group: "agent", type: "url", description: "Address of the agents service's supervisor, used to reload the runtime's configuration." }),
  entry({ env: "AGENT_PRIMARY_MODEL", key: "-", group: "agent", type: "string", description: "Overrides the model of the generator role (provider/model). Unset, the role's default applies." }),
  entry({ env: "AGENT_REVIEWER_MODEL", key: "-", group: "agent", type: "string", description: "Overrides the model of the reviewer role (provider/model). Unset, the role's default applies." }),
  entry({ env: "AGENT_CHAT_MODEL", key: "-", group: "agent", type: "string", description: "Overrides the model of the chat role (provider/model). Unset, the role's default applies." }),
  entry({ env: "COORDINATION_ESCALATED_MODEL", key: "coordinationEscalatedModel", group: "agent", type: "string", description: "Model a sidekick escalates to when its first attempt is judged insufficient (provider/model). Unset, no escalation model is configured." }),
  entry({ env: "COORDINATION_TELEMETRY_PATH", key: "coordinationTelemetryPath", group: "agent", type: "path", default: "<data>/coordination-events.jsonl", description: "File that records the lead's coordination events." }),
  entry({ env: "REFLECTOR_TIMEOUT_MS", key: "reflectorTimeoutMs", group: "agent", type: "integer", description: "Time budget of the reflection pass in milliseconds. Unset, or a value that is not a positive number, the reflection adapter's own budget (one minute) applies." }),
  entry({ env: "QA_REFLECTOR_ENABLED", key: "reflectorEnabled", group: "agent", type: "boolean", default: "false", description: "Turns the cross-run reflection pass on (1 or true) or off (0, false or empty). Any other value stops the boot." }),

  /* git */
  entry({ env: "GITHUB_TOKEN", key: "-", group: "git", type: "string", secret: true, description: "Token for clone, fetch, push and pull-request calls. Read live, because the onboarding surface can set it while the service runs." }),
  entry({ env: "GIT_REMOTE_BASE", key: "remoteBase", group: "git", type: "url", default: "https://github.com", description: "Base URL repositories are cloned from." }),
  entry({ env: "GIT_AUTHOR_NAME", key: "authorName", group: "git", type: "string", default: "qayaba", description: "Author name on the commits the orchestrator makes." }),
  entry({ env: "GIT_AUTHOR_EMAIL", key: "authorEmail", group: "git", type: "string", default: "qayaba@users.noreply.github.com", description: "Author email on the commits the orchestrator makes." }),
  entry({ env: "MIRROR_DIR", key: "mirrorDir", group: "git", type: "path", default: "<cwd>/.mirrors", description: "Directory that holds the working copies of the watched repositories (the shared mirrors volume in the container)." }),

  /* paths */
  entry({ env: "QAYABA_ROOT", key: "root", group: "paths", type: "path", default: "<cwd>", description: "The orchestrator's root (config/, data/, .env). Read before the settings load, because it locates the directories the settings report." }),
  entry({ env: "QAYABA_LOG_DIR", key: "logDir", group: "paths", type: "path", default: "<root>/data/logs", description: "Directory of the structured log files. Read before the settings load." }),
  entry({ env: "HISTORY_DB_PATH", key: "historyDbPath", group: "paths", type: "path", default: "<root>/data/qayaba.db", description: "Path of the run-history SQLite file." }),

  /* sandbox */
  entry({ env: "CODE_SANDBOX", key: "-", group: "sandbox", type: "string", description: "Set to off to run agent-influenced code as the orchestrator's own user instead of the sandbox uid." }),
  entry({ env: "CODE_SANDBOX_UID", key: "-", group: "sandbox", type: "integer", default: "1001", description: "Uid of the sandbox user that agent-influenced code runs as. Must match the image." }),
  entry({ env: "CODE_SANDBOX_GID", key: "-", group: "sandbox", type: "integer", default: "<CODE_SANDBOX_UID>", description: "Gid of the sandbox user." }),
  entry({ env: "CODE_SANDBOX_HOME", key: "-", group: "sandbox", type: "path", default: "/home/sandbox", description: "Home directory of the sandbox user." }),
  entry({ env: "QA_EXEC_SANDBOX", key: "execSandboxMode", group: "sandbox", type: "enum", values: ["required", "best-effort"], default: "required where the sandbox uid can exist, else best-effort", description: "required refuses to run agent code without the sandbox uid (the run ends E-SANDBOX); best-effort runs it as the current user with a warning." }),
  entry({ env: "QA_EXEC_ROOT", key: "execRoot", group: "sandbox", type: "path", default: "<tmpdir>/qa-exec", description: "Directory of the per-run work directories of sandboxed children." }),
  entry({ env: "QA_EGRESS_MODE", key: "egressMode", group: "sandbox", type: "enum", values: ["enforce", "warn"], default: "enforce", description: "enforce ends a run that would execute agent code without the egress filter; warn lets it run unfiltered and says so in the run's gate signals." }),
  entry({ env: "QA_EGRESS_STATUS_FILE", key: "-", group: "sandbox", type: "path", default: "/run/qa-egress.status", description: "File the container's egress setup writes its result to." }),
  entry({ env: "QA_FILE_BOUNDARY_STATUS_FILE", key: "-", group: "sandbox", type: "path", default: "/run/qa-file-boundary.status", description: "File the boot-time file-boundary check writes its result to." }),
  entry({ env: "DEV_ENV_USER", key: "-", group: "sandbox", type: "string", secret: true, description: "User name of the DEV site's HTTP Basic gate, when it has one." }),
  entry({ env: "DEV_ENV_PASS", key: "-", group: "sandbox", type: "string", secret: true, description: "Password of the DEV site's HTTP Basic gate." }),
  entry({ env: "DEV_TEST_USER", key: "-", group: "sandbox", type: "string", secret: true, description: "Login of the test account the orchestrator signs in with. Never forwarded to the agents container." }),
  entry({ env: "DEV_TEST_PASS", key: "-", group: "sandbox", type: "string", secret: true, description: "Password of the test account. Never forwarded to the agents container." }),
  entry({ env: "DEV_CLIENT_CERT_PASS", key: "-", group: "sandbox", type: "string", secret: true, description: "Passphrase of the DEV site's client certificate." }),

  /* run */
  entry({ env: "QA_E2E_TIMEOUT_MS", key: "-", group: "run", type: "integer", description: "Time a Playwright execution may take, in milliseconds. Unset, or a value that is not a positive number, the engine's default of fifteen minutes applies. Read live." }),
  entry({ env: "PW_ACTION_TIMEOUT_MS", key: "pwActionTimeoutMs", group: "run", type: "string", description: "Overrides Playwright's per-action timeout for the suite (milliseconds, passed through unchanged)." }),
  entry({ env: "QA_CAMPAIGN_FREEZE", key: "campaignFrozen", group: "run", type: "boolean", default: "false", description: "When 1 or true, a run reads and writes no cross-run learning state. 0, false or empty turn it off; any other value stops the boot." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_DIFF_TINY", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS["diff-tiny"]), description: "Wall time of a tiny diff run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS["diff-focused"]), description: "Wall time of a focused diff run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_DIFF_BROAD", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS["diff-broad"]), description: "Wall time of a broad diff run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_MANUAL", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS.manual), description: "Wall time of a manual run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_COMPLETE", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS.complete), description: "Wall time of a complete run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_EXHAUSTIVE", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS.exhaustive), description: "Wall time of an exhaustive run, in milliseconds." }),
  entry({ env: "QA_RUN_TIME_BUDGET_MS_CONTEXT", key: "-", group: "run", type: "integer", default: String(RUN_TIME_BUDGET_MS.context), description: "Wall time of a context-map run, in milliseconds." }),
  entry({ env: "QA_DIFF_TIME_BUDGET_MS_TINY", key: "-", group: "run", type: "integer", description: "Time of the first generation pass of a tiny diff, in milliseconds. Unset, the tier's built-in value applies." }),
  entry({ env: "QA_DIFF_TIME_BUDGET_MS_FOCUSED", key: "-", group: "run", type: "integer", description: "Time of the first generation pass of a focused diff, in milliseconds. Unset, the tier's built-in value applies." }),
  entry({ env: "QA_DIFF_TIME_BUDGET_MS_BROAD", key: "-", group: "run", type: "integer", description: "Time of the first generation pass of a broad diff, in milliseconds. Unset, the tier's built-in value applies." }),

  /* telemetry */
  entry({ env: "QA_TELEMETRY", key: "-", group: "telemetry", type: "enum", values: ["local", "off"], default: "local", description: "off turns telemetry export off." }),
  entry({ env: "OTEL_SDK_DISABLED", key: "-", group: "telemetry", type: "boolean", default: "false", description: "When true, telemetry is off whatever QA_TELEMETRY says." }),
  entry({ env: "OTEL_SERVICE_NAME", key: "-", group: "telemetry", type: "string", default: DEFAULT_SERVICE_NAME, description: "Service name on the exported telemetry." }),
  entry({ env: "OTEL_RESOURCE_ATTRIBUTES", key: "-", group: "telemetry", type: "list", description: "Comma-separated key=value resource attributes on the exported telemetry." }),
  entry({ env: "OTEL_EXPORTER_OTLP_ENDPOINT", key: "-", group: "telemetry", type: "url", description: "Base OTLP endpoint; traces, metrics and logs go to its /v1 paths. Unset, nothing is exported." }),
  entry({ env: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", key: "-", group: "telemetry", type: "url", description: "Full OTLP traces endpoint; wins over the base endpoint." }),
  entry({ env: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", key: "-", group: "telemetry", type: "url", description: "Full OTLP metrics endpoint; wins over the base endpoint." }),
  entry({ env: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", key: "-", group: "telemetry", type: "url", description: "Full OTLP logs endpoint; wins over the base endpoint." }),
  entry({ env: "OTEL_BSP_SCHEDULE_DELAY", key: "-", group: "telemetry", type: "integer", default: "5000", description: "Milliseconds between span batch exports." }),
  entry({ env: "OTEL_BSP_MAX_QUEUE_SIZE", key: "-", group: "telemetry", type: "integer", default: "2048", description: "Most spans queued for export." }),
  entry({ env: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", key: "-", group: "telemetry", type: "integer", default: "512", description: "Most spans in one export." }),
  entry({ env: "OTEL_BSP_EXPORT_TIMEOUT", key: "-", group: "telemetry", type: "integer", default: "30000", description: "Milliseconds an export may take." }),
  entry({ env: "QA_TELEMETRY_MAX_CAPTURE", key: "-", group: "telemetry", type: "enum", values: ["off", "metadata", "full"], default: "metadata", description: "The most content a run's trace may carry, whatever a request asks for. `full` also sends each agent turn's prompt and output bodies to Loki (never to Tempo)." }),
  entry({ env: "QA_TELEMETRY_LOKI_URL", key: "-", group: "telemetry", type: "url", description: "Address of the log store, probed by the telemetry health check." }),
  entry({ env: "QA_TELEMETRY_TEMPO_URL", key: "-", group: "telemetry", type: "url", description: "Address of the trace store, probed by the telemetry health check." }),
  entry({ env: "QA_TELEMETRY_COLLECTOR_METRICS_URLS", key: "-", group: "telemetry", type: "list", description: "Comma-separated collector metrics addresses, probed by the telemetry health check." }),
  entry({ env: "QA_TRACE_URL_TEMPLATE", key: "traceUrlTemplate", group: "telemetry", type: "string", description: "URL template that links a run to its trace; it contains {traceId}." }),
  entry({ env: "LANGFUSE_BASE_URL", key: "-", group: "telemetry", type: "url", description: "Address of the Langfuse server that receives run scores. The sink is configured only when this and both keys are set." }),
  entry({ env: "LANGFUSE_PUBLIC_KEY", key: "-", group: "telemetry", type: "string", secret: true, description: "Public key of the Langfuse project." }),
  entry({ env: "LANGFUSE_SECRET_KEY", key: "-", group: "telemetry", type: "string", secret: true, description: "Secret key of the Langfuse project." }),
  entry({ env: "LANGFUSE_ALLOW_EXTERNAL", key: "-", group: "telemetry", type: "boolean", default: "false", description: "Allow a Langfuse address that is neither langfuse-web, loopback nor https. Only the exact value true enables it." }),

  /* retention */
  entry({ env: "QA_TELEMETRY_RETENTION_DAYS", key: "spanDays", group: "retention", type: "integer", default: String(DEFAULT_SPAN_RETENTION_DAYS), description: "Days run spans, plans and snapshots are kept (1-3650)." }),
  entry({ env: "QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS", key: "campaignDays", group: "retention", type: "integer", default: String(DEFAULT_CAMPAIGN_RETENTION_DAYS), description: "Days the turns and spans of a campaign-tagged run are kept (1-3650)." }),

  /* maintainer */
  entry({ env: "SELF_MAINTAINER_AUTOMERGE", key: "autoMerge", group: "maintainer", type: "boolean", default: "false", description: "Let the self-maintainer merge and deploy its own fix pull requests. Only the exact value true enables it." }),
  entry({ env: "SELF_MAINTAINER_CI_CHECK", key: "ciCheck", group: "maintainer", type: "string", default: "ci", description: "Name of the check the maintainer requires to pass before it promotes a fix." }),

  /* judges */
  entry({ env: "QA_JUDGES_ENABLED", key: "-", group: "judges", type: "boolean", default: "false", description: "Turns the LLM judges on (true) or off (false or empty). Any other value stops the boot." }),
  entry({ env: "QA_JUDGES_DAILY_TOKENS", key: "-", group: "judges", type: "integer", default: String(DEFAULT_JUDGE_DAILY_TOKENS), description: "Tokens the judges may spend per day (a positive whole number)." }),
];

const BY_ENV: ReadonlyMap<string, SettingDef> = new Map(SETTINGS_REGISTRY.map((def) => [def.env, def]));

export function settingDef(env: string): SettingDef {
  const def = BY_ENV.get(env);
  if (!def) throw new Error(`${env} is not in the settings registry (src/settings/registry.ts)`);
  return def;
}

export function isRegisteredSetting(env: string): boolean {
  return BY_ENV.has(env);
}

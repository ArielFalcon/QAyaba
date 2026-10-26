# Settings

Generated from `src/settings/registry.ts` by `npm run settings:gen`; do not edit by hand. `npm run settings:check` fails when this file is stale.

The orchestrator reads its environment once, in `loadSettings(env)`. An empty value counts as unset. A value that cannot be parsed stops the start with one error that lists every offending variable (never a secret's value). The field column is the path in the typed `Settings` object; `-` marks a variable that is read live from `Settings.environment` (a child's environment, a secret redacted by value) or only by a child process. A secret never appears in a dump of the settings: it shows as `[set]`.

## Server

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `PORT` | `server.port` | integer | `458` | - | TCP port the control plane listens on (0-65535). An empty value counts as unset. |
| `LISTEN_HOST` | `server.listenHost` | string | `127.0.0.1` | - | Interface the control plane listens on. A bare start listens on loopback only; the container image sets 0.0.0.0. |
| `QA_TOOLS_PORT` | `server.toolsPort` | integer | `459` | - | TCP port of the agents' tools endpoint (1-65535), a second listener that is never published. |
| `QA_TOOLS_LISTEN_HOST` | `server.toolsListenHost` | string | - | - | Interface the tools endpoint binds. Unset, it follows LISTEN_HOST and narrows a wildcard to the container's one non-loopback IPv4 address. |
| `QA_TOOLS_TOKEN` | - | string | - | secret | Service token the agents service authenticates to the tools endpoint with (at least 32 characters; the same value on both services). Unset, a random one is generated for the boot and the tools are refused. |
| `QAYABA_REPO` | `server.selfRepo` | string | `ArielFalcon/qayaba` | - | The repository (owner/name) that holds this orchestrator's own code, which the self-maintainer opens fix pull requests against. |
| `NO_COLOR` | `server.noColor` | boolean | - | - | When set to any non-empty value the command-line client prints no ANSI colors. |

## Authentication

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_API_TOKEN` | `auth.apiToken` | string | - | secret | Machine bearer token of the control-plane API. Unset, one is generated once and kept in the data directory. |
| `AUTH_SIGNING_KEY` | `auth.signingKey` | string | - | secret | Key that signs user session tokens. Unset, the API token signs them. |
| `AUTH_SESSION_TTL_SECONDS` | `auth.sessionTtlSeconds` | integer | `86400` | - | Lifetime in seconds of a user session token (a positive whole number). |
| `GITHUB_OAUTH_CLIENT_ID` | `auth.githubOAuthClientId` | string | - | - | Client id of the GitHub OAuth app the web console signs users in with. Unset, the console's GitHub sign-in is off. |
| `QA_WEB_AUTO_LOGIN` | - | boolean | `false` | - | When the exact value true, the same-origin web console signs in without a token for any TCP peer (a loopback peer is always accepted); the Host header must still name a loopback host or an allowlist entry. Read live on each login. |
| `QA_WEB_LOGIN_HOST_ALLOWLIST` | - | list | - | - | Comma-separated Host header names the automatic console sign-in accepts in addition to the loopback names (the DNS-rebinding check). Read live on each login. |

## Webhook

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `WEBHOOK_SECRET` | `webhook.secret` | string | - | secret | Shared secret that signs deployment webhooks. Unset, webhooks are refused unless WEBHOOK_ALLOW_UNSIGNED is true. |
| `WEBHOOK_ALLOW_UNSIGNED` | `webhook.allowUnsigned` | boolean | `false` | - | Accept webhooks that carry no signature when no secret is configured. Only the exact value true enables it. |

## Agent runtime

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `OPENCODE_SERVE_URL` | `agent.serveUrl` | url | `http://agents:4096` | - | Address of the agent runtime's server. |
| `OPENCODE_SERVER_PASSWORD` | - | string | - | required, secret | Basic-auth password of the agent runtime's server; the same value on the orchestrator and agents services. The orchestrator refuses every agent call without it. |
| `OPENCODE_API_KEY` | - | string | - | secret | Provider key of the agent runtime. Read live, because the onboarding surface can set it while the service runs. |
| `OPENCODE_CONFIG` | `agent.configPath` | path | `<root>/agents/opencode.json` | - | Path of the agent runtime's role and model configuration. |
| `OPENCODE_TIMEOUT_MS` | `agent.timeoutMs` | integer | - | - | Overrides the generator session budget of every run mode, in milliseconds. A value that is not a positive number is ignored. |
| `OPENCODE_REVIEWER_TIMEOUT_MS` | `agent.reviewerTimeoutMs` | integer | `360000` | - | Reviewer session budget in milliseconds. A value that is not a positive number is ignored. |
| `OPENCODE_STALL_MS` | `agent.stallMs` | integer | `180000` | - | Milliseconds without any agent activity before the stall watchdog fires. A value that is not a positive number is ignored. |
| `AGENT_SUPERVISOR_URL` | - | url | - | - | Address of the agents service's supervisor, used to reload the runtime's configuration. |
| `AGENT_PRIMARY_MODEL` | - | string | - | - | Overrides the model of the generator role (provider/model). Unset, the role's default applies. |
| `AGENT_REVIEWER_MODEL` | - | string | - | - | Overrides the model of the reviewer role (provider/model). Unset, the role's default applies. |
| `AGENT_CHAT_MODEL` | - | string | - | - | Overrides the model of the chat role (provider/model). Unset, the role's default applies. |
| `COORDINATION_ESCALATED_MODEL` | `agent.coordinationEscalatedModel` | string | - | - | Model a sidekick escalates to when its first attempt is judged insufficient (provider/model). Unset, no escalation model is configured. |
| `COORDINATION_TELEMETRY_PATH` | `agent.coordinationTelemetryPath` | path | `<data>/coordination-events.jsonl` | - | File that records the lead's coordination events. |
| `REFLECTOR_TIMEOUT_MS` | `agent.reflectorTimeoutMs` | integer | - | - | Time budget of the reflection pass in milliseconds. Unset, or a value that is not a positive number, the reflection adapter's own budget (one minute) applies. |
| `QA_REFLECTOR_ENABLED` | `agent.reflectorEnabled` | boolean | `false` | - | Turns the cross-run reflection pass on (1 or true) or off (0, false or empty). Any other value stops the boot. |

## Git and mirrors

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | - | string | - | secret | Token for clone, fetch, push and pull-request calls. Read live, because the onboarding surface can set it while the service runs. |
| `GIT_REMOTE_BASE` | `git.remoteBase` | url | `https://github.com` | - | Base URL repositories are cloned from. |
| `GIT_AUTHOR_NAME` | `git.authorName` | string | `qayaba` | - | Author name on the commits the orchestrator makes. |
| `GIT_AUTHOR_EMAIL` | `git.authorEmail` | string | `qayaba@users.noreply.github.com` | - | Author email on the commits the orchestrator makes. |
| `MIRROR_DIR` | `git.mirrorDir` | path | `<cwd>/.mirrors` | - | Directory that holds the working copies of the watched repositories (the shared mirrors volume in the container). |

## Paths

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QAYABA_ROOT` | `paths.root` | path | `<cwd>` | - | The orchestrator's root (config/, data/, .env). Read before the settings load, because it locates the directories the settings report. |
| `QAYABA_LOG_DIR` | `paths.logDir` | path | `<root>/data/logs` | - | Directory of the structured log files. Read before the settings load. |
| `HISTORY_DB_PATH` | `paths.historyDbPath` | path | `<root>/data/qayaba.db` | - | Path of the run-history SQLite file. |

## Execution sandbox

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `CODE_SANDBOX` | - | string | - | - | Set to off to run agent-influenced code as the orchestrator's own user instead of the sandbox uid. |
| `CODE_SANDBOX_UID` | - | integer | `1001` | - | Uid of the sandbox user that agent-influenced code runs as. Must match the image. |
| `CODE_SANDBOX_GID` | - | integer | `<CODE_SANDBOX_UID>` | - | Gid of the sandbox user. |
| `CODE_SANDBOX_HOME` | - | path | `/home/sandbox` | - | Home directory of the sandbox user. |
| `QA_EXEC_SANDBOX` | `sandbox.execSandboxMode` | enum: required \| best-effort | `required where the sandbox uid can exist, else best-effort` | - | required refuses to run agent code without the sandbox uid (the run ends E-SANDBOX); best-effort runs it as the current user with a warning. |
| `QA_EXEC_ROOT` | `sandbox.execRoot` | path | `<tmpdir>/qa-exec` | - | Directory of the per-run work directories of sandboxed children. |
| `QA_EGRESS_MODE` | `sandbox.egressMode` | enum: enforce \| warn | `enforce` | - | enforce ends a run that would execute agent code without the egress filter; warn lets it run unfiltered and says so in the run's gate signals. |
| `QA_EGRESS_STATUS_FILE` | - | path | `/run/qa-egress.status` | - | File the container's egress setup writes its result to. |
| `QA_FILE_BOUNDARY_STATUS_FILE` | - | path | `/run/qa-file-boundary.status` | - | File the boot-time file-boundary check writes its result to. |
| `DEV_ENV_USER` | - | string | - | secret | User name of the DEV site's HTTP Basic gate, when it has one. |
| `DEV_ENV_PASS` | - | string | - | secret | Password of the DEV site's HTTP Basic gate. |
| `DEV_TEST_USER` | - | string | - | secret | Login of the test account the orchestrator signs in with. Never forwarded to the agents container. |
| `DEV_TEST_PASS` | - | string | - | secret | Password of the test account. Never forwarded to the agents container. |
| `DEV_CLIENT_CERT_PASS` | - | string | - | secret | Passphrase of the DEV site's client certificate. |

## Runs

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_E2E_TIMEOUT_MS` | - | integer | - | - | Time a Playwright execution may take, in milliseconds. Unset, or a value that is not a positive number, the engine's default of fifteen minutes applies. Read live. |
| `PW_ACTION_TIMEOUT_MS` | `run.pwActionTimeoutMs` | string | - | - | Overrides Playwright's per-action timeout for the suite (milliseconds, passed through unchanged). |
| `QA_CAMPAIGN_FREEZE` | `run.campaignFrozen` | boolean | `false` | - | When 1 or true, a run reads and writes no cross-run learning state. 0, false or empty turn it off; any other value stops the boot. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_TINY` | - | integer | `1500000` | - | Wall time of a tiny diff run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED` | - | integer | `2400000` | - | Wall time of a focused diff run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_BROAD` | - | integer | `3600000` | - | Wall time of a broad diff run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_MANUAL` | - | integer | `2700000` | - | Wall time of a manual run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_COMPLETE` | - | integer | `5400000` | - | Wall time of a complete run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_EXHAUSTIVE` | - | integer | `9000000` | - | Wall time of an exhaustive run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_CONTEXT` | - | integer | `3600000` | - | Wall time of a context-map run, in milliseconds. |
| `QA_DIFF_TIME_BUDGET_MS_TINY` | - | integer | - | - | Time of the first generation pass of a tiny diff, in milliseconds. Unset, the tier's built-in value applies. |
| `QA_DIFF_TIME_BUDGET_MS_FOCUSED` | - | integer | - | - | Time of the first generation pass of a focused diff, in milliseconds. Unset, the tier's built-in value applies. |
| `QA_DIFF_TIME_BUDGET_MS_BROAD` | - | integer | - | - | Time of the first generation pass of a broad diff, in milliseconds. Unset, the tier's built-in value applies. |

## Telemetry

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_TELEMETRY` | - | enum: local \| off | `local` | - | off turns telemetry export off. |
| `OTEL_SDK_DISABLED` | - | boolean | `false` | - | When true, telemetry is off whatever QA_TELEMETRY says. |
| `OTEL_SERVICE_NAME` | - | string | `qayaba-orchestrator` | - | Service name on the exported telemetry. |
| `OTEL_RESOURCE_ATTRIBUTES` | - | list | - | - | Comma-separated key=value resource attributes on the exported telemetry. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | - | url | - | - | Base OTLP endpoint; traces, metrics and logs go to its /v1 paths. Unset, nothing is exported. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | - | url | - | - | Full OTLP traces endpoint; wins over the base endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | - | url | - | - | Full OTLP metrics endpoint; wins over the base endpoint. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | - | url | - | - | Full OTLP logs endpoint; wins over the base endpoint. |
| `OTEL_BSP_SCHEDULE_DELAY` | - | integer | `5000` | - | Milliseconds between span batch exports. |
| `OTEL_BSP_MAX_QUEUE_SIZE` | - | integer | `2048` | - | Most spans queued for export. |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | - | integer | `512` | - | Most spans in one export. |
| `OTEL_BSP_EXPORT_TIMEOUT` | - | integer | `30000` | - | Milliseconds an export may take. |
| `QA_TELEMETRY_MAX_CAPTURE` | - | enum: off \| metadata \| full | `metadata` | - | The most content a run's trace may carry, whatever a request asks for. |
| `QA_TELEMETRY_LOKI_URL` | - | url | - | - | Address of the log store, probed by the telemetry health check. |
| `QA_TELEMETRY_TEMPO_URL` | - | url | - | - | Address of the trace store, probed by the telemetry health check. |
| `QA_TELEMETRY_COLLECTOR_METRICS_URLS` | - | list | - | - | Comma-separated collector metrics addresses, probed by the telemetry health check. |
| `QA_TRACE_URL_TEMPLATE` | `telemetry.traceUrlTemplate` | string | - | - | URL template that links a run to its trace; it contains {traceId}. |
| `LANGFUSE_BASE_URL` | - | url | - | - | Address of the Langfuse server that receives run scores. The sink is configured only when this and both keys are set. |
| `LANGFUSE_PUBLIC_KEY` | - | string | - | secret | Public key of the Langfuse project. |
| `LANGFUSE_SECRET_KEY` | - | string | - | secret | Secret key of the Langfuse project. |
| `LANGFUSE_ALLOW_EXTERNAL` | - | boolean | `false` | - | Allow a Langfuse address that is neither langfuse-web, loopback nor https. Only the exact value true enables it. |

## Retention

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_TELEMETRY_RETENTION_DAYS` | `retention.spanDays` | integer | `30` | - | Days run spans, plans and snapshots are kept (1-3650). |
| `QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS` | `retention.campaignDays` | integer | `180` | - | Days the turns and spans of a campaign-tagged run are kept (1-3650). |

## Self-maintainer

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `SELF_MAINTAINER_AUTOMERGE` | `maintainer.autoMerge` | boolean | `false` | - | Let the self-maintainer merge and deploy its own fix pull requests. Only the exact value true enables it. |
| `SELF_MAINTAINER_CI_CHECK` | `maintainer.ciCheck` | string | `ci` | - | Name of the check the maintainer requires to pass before it promotes a fix. |

## Judges

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_JUDGES_ENABLED` | - | boolean | `false` | - | Turns the LLM judges on (true) or off (false or empty). Any other value stops the boot. |
| `QA_JUDGES_DAILY_TOKENS` | - | integer | `200000` | - | Tokens the judges may spend per day (a positive whole number). |

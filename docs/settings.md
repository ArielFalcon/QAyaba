# Settings

Generated from `src/settings/registry.ts` by `npm run settings:gen`; do not edit by hand. `npm run settings:check` fails when this file is stale.

The orchestrator reads its environment once, in `loadSettings(env)`. An empty value counts as unset. A value that cannot be parsed stops the start with one error that lists every offending variable (never a secret's value). The field column is the path in the typed `Settings` object; `-` marks a variable that is read live from `Settings.environment` (a child's environment, a secret redacted by value) or only by a child process. A secret never appears in a dump of the settings: it shows as `[set]`. One field has no variable: `server.drainMs` is the fixed window a cancelled run gets to unwind on shutdown (see `DEFAULT_DRAIN_MS`).

## Server

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `PORT` | `server.port` | integer | `458` | - | TCP port the control plane listens on (0-65535). An empty value counts as unset. |
| `LISTEN_HOST` | `server.listenHost` | string | `127.0.0.1` | - | Interface the control plane listens on. A bare start listens on loopback only; the container image sets 0.0.0.0. |
| `QA_TOOLS_PORT` | `server.toolsPort` | integer | `459` | - | TCP port of the agents' tools endpoint (1-65535), a second listener that is never published. |
| `QA_TOOLS_LISTEN_HOST` | `server.toolsListenHost` | string | - | - | Interface the tools endpoint binds. Unset, it follows LISTEN_HOST and narrows a wildcard to the container's one non-loopback IPv4 address. |
| `QA_TOOLS_TOKEN` | - | string | - | secret | Service token the agents service authenticates to the tools endpoint with (at least 32 characters; the same value on both services). Unset, a random one is generated for the boot and the tools are refused. |
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
| `AGENT_PRIMARY_MODEL` | - | string | - | - | Overrides the model of every agent of its tier (the lead, author and proposer) as provider/model. Unset, each agent runs on the model its agents/opencode.json entry declares, and on the model the tier's namesake agent declares when it declares none. |
| `AGENT_REVIEWER_MODEL` | - | string | - | - | Overrides the model of every agent of its tier (the reviewer) as provider/model. Unset, each agent runs on the model its agents/opencode.json entry declares, and on the model the tier's namesake agent declares when it declares none. |
| `AGENT_CHAT_MODEL` | - | string | - | - | Overrides the model of every agent of its tier (the assistant) as provider/model. Unset, each agent runs on the model its agents/opencode.json entry declares, and on the model the tier's namesake agent declares when it declares none. |
| `COORDINATION_TELEMETRY_PATH` | `agent.coordinationTelemetryPath` | path | `<data>/coordination-events.jsonl` | - | File that records the lead's coordination events. |

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
| `QA_CAMPAIGN_FREEZE` | `run.campaignFrozen` | boolean | `false` | - | When 1 or true, a run starts from a fixed state: the suite store is read-only, the context map is not rebuilt, no automatic login bootstrap runs and no process audit is wired. 0, false or empty turn it off; any other value stops the boot. |
| `QA_RUN_TIME_BUDGET_MS_DIFF` | - | integer | `3600000` | - | Wall time of a diff run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_TINY` | - | integer | - | - | Deprecated, read for one more release: use QA_RUN_TIME_BUDGET_MS_DIFF. Applies, with the other two per-size names, only while QA_RUN_TIME_BUDGET_MS_DIFF is unset, and the largest value set wins. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED` | - | integer | - | - | Deprecated, read for one more release: use QA_RUN_TIME_BUDGET_MS_DIFF. Applies, with the other two per-size names, only while QA_RUN_TIME_BUDGET_MS_DIFF is unset, and the largest value set wins. |
| `QA_RUN_TIME_BUDGET_MS_DIFF_BROAD` | - | integer | - | - | Deprecated, read for one more release: use QA_RUN_TIME_BUDGET_MS_DIFF. Applies, with the other two per-size names, only while QA_RUN_TIME_BUDGET_MS_DIFF is unset, and the largest value set wins. |
| `QA_RUN_TIME_BUDGET_MS_MANUAL` | - | integer | `2700000` | - | Wall time of a manual run, in milliseconds. |
| `QA_RUN_TIME_BUDGET_MS_CONTEXT` | - | integer | `3600000` | - | Wall time of a context-map run, in milliseconds. |

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
| `QA_TELEMETRY_MAX_CAPTURE` | - | enum: off \| metadata \| full | `metadata` | - | The most content a run's trace may carry, whatever a request asks for. `full` also sends each agent turn's prompt and output bodies to Loki (never to Tempo). |
| `QA_TELEMETRY_LOKI_URL` | - | url | - | - | Address of the log store, probed by the telemetry health check. |
| `QA_TELEMETRY_TEMPO_URL` | - | url | - | - | Address of the trace store, probed by the telemetry health check. |
| `QA_TELEMETRY_COLLECTOR_METRICS_URLS` | - | list | - | - | Comma-separated collector metrics addresses, probed by the telemetry health check. |
| `QA_TRACE_URL_TEMPLATE` | `telemetry.traceUrlTemplate` | string | - | - | URL template that links a run to its trace; it contains {traceId}. |

## Retention

| Variable | Field | Type | Default | Flags | Description |
| --- | --- | --- | --- | --- | --- |
| `QA_TELEMETRY_RETENTION_DAYS` | `retention.spanDays` | integer | `30` | - | Days run spans, plans and snapshots are kept (1-3650). |
| `QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS` | `retention.campaignDays` | integer | `180` | - | Days the turns and spans of a campaign-tagged run are kept (1-3650). |

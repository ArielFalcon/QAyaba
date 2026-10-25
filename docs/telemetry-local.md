# Local telemetry stack

An opt-in pair of collectors plus Grafana, Tempo, Prometheus and Loki (`grafana/otel-lgtm`) for looking at the
orchestrator's traces, metrics and logs. Plain `docker compose up` does not include it. Design:
`docs/observability-design.md` (§9.2, §10, R6).

## Start and stop

```bash
export GRAFANA_ADMIN_PASSWORD=<choose one>   # or Doppler / .env
F="-f docker-compose.yml -f docker-compose.override.yml -f docker-compose.telemetry.yml"

docker compose $F --profile telemetry up --build      # start
docker compose $F --profile telemetry ps              # status
docker compose $F --profile telemetry down            # stop (keeps the volumes)
```

**The telemetry file is only ever used with `--profile telemetry`, and every command that loads it needs
`GRAFANA_ADMIN_PASSWORD`**, including `down`, `ps`, `logs` and `config`: compose interpolates the whole file, so a
missing password fails the command before anything runs (that is intended; there is no default password in the repo).
Loading the file without the profile is a mistake: the orchestrator would be pointed at a collector that is never
started. Its exporter then fails open (runs are unaffected; the loss shows in `/api/health` as `otlp.dropped` and
`otlp.lastError`, reported after the exporter's retries, about 8 seconds per batch), but nothing is recorded.

For production drop `docker-compose.override.yml`, as for the base stack.

## Environment variables (names only)

| Name | Where | Purpose |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | host env, Doppler or `.env` | Required for every command that loads the file. No default exists. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | set by the telemetry file on the orchestrator (`http://collector:4318`) and the agents (`http://collector-agents:4319`) | Where each side exports. On the agents side OpenCode reads it and exports its logs and traces; the collector keeps the logs and drops its rootless process trace. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `.env` | Optional logs URL; when unset the generic endpoint gets `/v1/logs`. It does not enable the exporter by itself (the generic endpoint or a traces endpoint must exist). |
| `OTEL_SERVICE_NAME` | set by the telemetry file (`qayaba-orchestrator`) | Resource service name. |
| `QA_TELEMETRY` | `.env` | `local` (default) or `off`. |
| `QA_AGENT_OTLP_ENDPOINT` | set by the telemetry file on the agents service (`http://collector-agents:4319`) | The supervisor then gives Codex a trace exporter (`[otel]` in its `config.toml`) pointed at the untrusted receiver, and the orchestrator passes the attempt's `traceparent` so Codex's spans hang under it. Unset (plain compose): Codex exports nothing and its config is unchanged. |
| `QA_TELEMETRY_MAX_CAPTURE` | `.env` | The most content any run's trace may carry: `off`, `metadata` (default) or `full`. A request's `captureMode` is capped at it. Turning `full` on is a deliberate operator act: it exports message bodies. The console tap reads the run's mode under the same ceiling. |
| `QA_TELEMETRY_RETENTION_DAYS`, `QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS` | `.env` | How long an ordinary run keeps its spans and agent turns (30) and how long a campaign-tagged run does (180). Loki logs use the campaign window (180) globally: a log cannot carry the campaign tag. |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_RESOURCE_ATTRIBUTES` | `.env` | Optional exporter tuning. |

## Where to look

Grafana: <http://127.0.0.1:3001>, user `admin`, the password you set. Anonymous access is disabled. The Tempo
datasource shows traces (search by `service.name = qayaba-orchestrator`); the Prometheus datasource shows metrics; the
**Loki** datasource shows logs. Nothing else is published: Tempo, Prometheus, Loki and the OTLP ports are reachable only
inside the compose networks.

Loki examples (the OTLP receiver stores `service_name` and `service_instance_id` as labels; the rest is structured
metadata, with dots replaced by underscores):

```logql
{service_name="opencode"} | severity_text="ERROR"
{service_name="opencode"} | session_id="ses_..."        # only the lines that carry it
{service_name="qayaba-orchestrator"} | trace_id="..."   # copy the id from the run's trace in Tempo
```

The orchestrator's console lines (`[qa] ...`, the grounding bridges' warnings) are exported only while a span is active
and under the run's capture mode: `off` sends nothing, `metadata` caps a line at 1 KB, `full` at 4 KB. Boot,
`/api/health` polling and any line outside a span stay in docker's json-file log. Loki is a viewing aid: nothing reads it
programmatically, and `runs.logs`/`run_events` remain the API's record.

A rotating copy of each collector's traces is written to the `otel-debug` volume (`/var/lib/otel-debug/traces.jsonl` for
the trusted collector, `agents-traces.jsonl` for the untrusted one; 100 MB x 3 files each). The `debug` exporter is
declared but off; add it to a pipeline in the collector's config to print spans to its log.

## Evaluations (scores) in Grafana

Every grading, and every regrade, mirrors the run's scores to Prometheus through the evaluation context's sink
(`src/telemetry/score-metrics-sink.ts`). The scores themselves stay stored in `run_scores` first; `GET
/api/v1/runs/:id/evaluation` and the optional Langfuse profile are unchanged. The sink is fail-open: a lookup or
measurement fault is logged and never changes a grade.

Dashboard **QAYABA evaluations** (uid `qayaba-evaluations`, folder `QAYABA`) is provisioned from `config/grafana/`:
the provider at `config/grafana/qayaba-evaluations.yaml` is mounted into the image's own provisioning tree
(`/otel-lgtm/grafana/conf/provisioning/dashboards/`) and the JSON in `config/grafana/dashboards/` at
`/otel-lgtm/qayaba-dashboards`. Panels: latest `spec_validity_rate` and `spec_pass_rate` per app, `empty_output_guard`
and `approval_consistent` as 0/1, `furthest_phase` and `infra_error` classes, the `step_intent_mix` family, budget
exhaustion and the run count by verdict.

Prometheus names (the collector turns dots into underscores and suffixes counters with `_total`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `qayaba_eval_score` | gauge | `qayaba_eval_name`, `qayaba_eval_source`, `qayaba_eval_data_type`, `qayaba_app`, `qayaba_verdict` | One numeric or boolean score; a boolean is `1` (true) or `0` (false). Families appear as `<base>.<suffix>` (`step_intent_mix.auth`, …). |
| `qayaba_eval_class_total` | counter | `qayaba_eval_name`, `qayaba_eval_value` | One closed-set categorical score: `furthest_phase`, `change_coverage` or `infra_error`. An unknown class value becomes `other`; any other categorical score is not emitted. |
| `qayaba_budget_exhausted_total` | counter | `qayaba_limit_fired`, `qayaba_agent_role` | The limit that ended a run. `budget_exhaustion` is deliberately not a score label: its value is a free string. |
| `qayaba_runs_total` | counter | `qayaba_app`, `qayaba_verdict`, … | Runs by verdict (the existing run metric). |

Regrade semantics: `qayaba_eval_score` is a last-value instrument, so a regrade replaces the series for the same
labels (no double counting). `qayaba_eval_class_total` counts grading events, so a regrade adds one more class count
for the run — use it as a share of graded runs, not as a run count. A score a regrade stops emitting keeps its last
gauge value until Prometheus staleness removes it. A grader that says nothing (no data) emits no measurement.

The reviewer's own quality and cost are exported beside the scores: `qayaba_review_total` counts one verdict per
review round (labels `qayaba_review_outcome`, `qayaba_review_decided_by`, `qayaba_review_correction_class`) and
`qayaba_review_duration_*` is the review duration histogram in seconds. The correction class is the closed tag of the
round's blocking correction (`false-positive`, `wrong-objective`, `fragile-selector`, `no-cleanup`, `other`; `none`
when there is none). The dashboard's **Reviewer outcomes by decision**, **Reviewer duration p95** and **Reviewer
rejections by correction class** panels show them; the same figures are persisted in `gateSignals.reviewer` on the run
outcome (`rounds`, `modelRounds`, `preCheckRejects`, `skippedRounds`, `correctionClass`, `outputTokens`, `costUsd`,
`steps`).

The per-round `qayaba.review.decision` span is the trace record behind the metric: it carries `qayaba.review.targets`
(the specs this run delivered), `qayaba.review.existing_specs` (the existing suite, context only), the bounded
`qayaba.review.corrections` and `qayaba.review.rationale`, the blocking count and the correction class. The reviewer
judges only the delivered specs; an existing suite file is never a wrong-objective target.

For ad-hoc questions use **Explore → Prometheus**, for example
`qayaba_eval_score{qayaba_eval_name="spec_pass_rate"}`,
`qayaba_eval_score{qayaba_eval_name=~"step_intent_mix[.].*"}` or
`sum by (qayaba_eval_value) (increase(qayaba_eval_class_total{qayaba_eval_name="furthest_phase"}[$__range]))`.
Grafana is a view, never the source: a grade that exists in `run_scores` but not here is a telemetry gap, not a
missing score.

## Trust model: one receiver per collector

Network isolation is per container, so a single collector holding both receivers on both networks would expose the
trusted port to the agents. Each receiver is therefore its own service with its own config:

| Service | Config | Receiver | Networks | Who writes to it | Pipeline |
|---|---|---|---|---|---|
| `collector` | `config/otel/collector.yaml` | `otlp/orchestrator` :4318 | `telemetry-internal` only | the orchestrator | trusted; secret redaction only; traces, metrics and logs |
| `collector-agents` | `config/otel/collector-agents.yaml` | `otlp/agents` :4319 | `agent-otlp` + `telemetry-internal` (the latter only to export to lgtm) | the agents container (OpenCode's logs and traces, Codex's traces) | untrusted; deletes `qayaba.*`, `langfuse.*` and prompt/response content keys from spans and logs, then sets `qayaba.trust=agent`; drops `service.name=opencode` traces |

- The agents container is on `agent-otlp` and **not** on `telemetry-internal`, so it can reach `collector-agents` and
  nothing else of the stack: not the trusted receiver, not Grafana, not lgtm. The `qayaba.trust=agent` tag therefore
  cannot be spoofed. OpenCode exports its own logs and traces to this receiver; the trace pipeline drops
  `service.name=opencode` (one process-wide trace with no root; 1.17.7 ignores an inbound `traceparent`) and the log
  pipeline keeps the logs. `experimental.openTelemetry` stays off.
- The strip and the stamp run on the resource, the scope, every span, every span event and every log record, with
  `error_mode: propagate` (a failing statement drops the batch rather than passing a forged key). The collector has no
  OTTL context for span links, so the span context drops the links whole.
- `lgtm` is on `telemetry-internal` only: it has no route out and no published port. `grafana-proxy` (unprivileged
  nginx, read-only) is the one process also on `telemetry-ui`, the only non-internal network, because a container
  attached only to an internal network cannot publish a port. It forwards `127.0.0.1:3001` to `lgtm:3000` and nothing else.
- Both telemetry networks are `internal: true`.
- The sandbox uid is unaffected: its closed egress (`bin/egress-init.sh`) is unchanged and no collector is an allowed origin.
- Both collectors run as uid 10001 with a read-only root filesystem, no capabilities and no host port. The one-shot
  `otel-debug-init` (busybox, no network, only `CHOWN`) hands the debug volume to that uid before they start.
- Every pipeline also runs a coarse `redaction` pass: credential-looking keys (anchored on separators, so
  `gen_ai.usage.input_tokens` and `max_tokens` are untouched) and values (bearer and basic tokens, connection URLs with a
  password, GitHub, Google, Slack, npm and AWS keys, JWTs, private keys). It is a second layer behind the orchestrator's
  own sanitizer, not a replacement. A log body is a message, not a prompt; Loki truncates any line over 64 KB.
- The orchestrator's log record inherits the active span's `trace_id` and `span_id`, so Tempo and Loki can be read side by
  side. OpenCode's logs carry its own process trace ids, which are not a qayaba trace; the session id, where present, is
  the only join to a run. The orchestrator's `invoke_agent` span carries the same id as `gen_ai.conversation.id`, and
  `agent_turns.session_id` stores it, so a log line with `session_id` joins to its turn. That is correlation, not a
  connected trace: OpenCode 1.17.7 exports one process-wide trace with no root and ignores an inbound `traceparent`.

## Footprint and log filtering

Measured on a stack after several days of probing (`docker exec ai-pipeline-lgtm-1 du -sh ...`, `docker system df -v`):
Loki `/data/loki` 1.7 MB on disk (9 MB of raw bytes over 7 days, 30.6k entries), Tempo 21 MB, Prometheus 113 MB, the
`otel-debug` volume 14.6 MB (rotating traces dumps), `lgtm-data` 238 MB in total. The telemetry stack is not what fills a
disk: the large consumers on a dev machine are Docker's build cache and images.

What Loki held: 94% of its bytes were OpenCode's own INFO chatter (`evaluated`, `tracking`, `loop`, `stream`, `touching
file`, `llm runtime selected`, ... 22.9k lines against 18 errors). The orchestrator's lines were 1.7k (962 info, 364 warn,
10 error). Filtering, by layer:

| Layer | Rule |
|---|---|
| `collector-agents` (`filter/drop_opencode_info_logs`) | Drops OpenCode log records with a severity above 0 and below WARN. WARN, ERROR, FATAL and records with no severity are kept. |
| Orchestrator container log | A successful GET/HEAD control-plane request (`/api/health`, run polling) is not logged (`src/server/api-request-log.ts`); POSTs and every status >= 400 are. The `scrubEnv dropped N env var(s)` warning prints once per distinct dropped set instead of on every spawn. |
| Docker `json-file` | `orchestrator` and `agents`: `max-size: 10m`, `max-file: 3` (was 50m x 5), so at most 30 MB each. |

The debug dumps stay 100 MB x 3 per collector as a ceiling; they were 14.6 MB in practice. Errors, warnings, run
lifecycle lines and everything the orchestrator exports under a span are untouched.

## Retention

Spans are kept 30 days (R4). The `grafana/otel-lgtm` image has no retention key in its Tempo config (Tempo's default is
14 days), but its start script appends `TEMPO_EXTRA_ARGS` to the Tempo command line, so the compose file sets
`-backend-worker.compaction.block-retention=720h` (the Tempo 3.x flag). Re-check the flag name when the image pin moves.

Logs are kept 180 days (R6), the campaign window. Loki's retention is YAML-only and the image's own config has none, so
`config/otel/loki-config.yaml` shadows it: the same config plus `limits_config.retention_period: 4320h`, the compactor and a
64 KB line cap. A log cannot be tagged with the campaign it belongs to, so the only window that never cuts a campaign's
logs early is the longest one; ordinary spans keep their own 30. `npm test` pins the window to
`DEFAULT_CAMPAIGN_RETENTION_DAYS` and the mount. Validate the copy before starting it:

```bash
docker run --rm --entrypoint /otel-lgtm/loki/loki \
  -v "$PWD/config/otel/loki-config.yaml:/loki.yaml:ro" grafana/otel-lgtm:0.37.0 \
  -config.file=/loki.yaml -verify-config
```

The collector image is pinned to `0.163.1`: the `0.163.0` tag was never published to Docker Hub.

## Langfuse (optional second profile)

Langfuse v4 (self-hosted) adds the evaluation workflow (scores, annotation queues, datasets) to the same traces. It is
`docker-compose.langfuse.yml`, loaded **in addition to** the telemetry file and with **both** profiles:

```bash
F="-f docker-compose.yml -f docker-compose.override.yml -f docker-compose.telemetry.yml -f docker-compose.langfuse.yml"
docker compose $F --profile telemetry --profile langfuse up --build
```

UI: <http://127.0.0.1:3002> (user `LANGFUSE_INIT_USER_EMAIL`, password `LANGFUSE_INIT_USER_PASSWORD`; signup is closed).
Plan for about 5.5 GiB of containers (Langfuse recommends 4 cores and 16 GiB for the host): use it for campaign review
sessions, not always-on. Scores never depend on it (they are stored in `run_scores` first), so stopping it loses nothing.

Variables (names only; no default exists for any of them, and compose refuses to start without them):

| Name | Purpose |
|---|---|
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | The project key pair (`pk-lf-...` / `sk-lf-...`; pick them, Langfuse creates the project with them at first boot through `LANGFUSE_INIT_*`). The orchestrator signs API calls with them (score sink, score configs, label import) and the trusted collector signs OTLP exports with them. |
| `LANGFUSE_INIT_USER_EMAIL`, `LANGFUSE_INIT_USER_PASSWORD` | The first (headless) user. |
| `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY` (`openssl rand -hex 32`) | Langfuse's own secrets. |
| `LANGFUSE_POSTGRES_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_AUTH`, `LANGFUSE_MINIO_ROOT_PASSWORD` | The stores. |
| `LANGFUSE_BASE_URL` | Set by the file on the orchestrator (`http://langfuse-web:3000`). The score sink is configured only when this and both keys are set. |

How the keys flow: Doppler/`.env` -> compose -> (a) `langfuse-web` as `LANGFUSE_INIT_PROJECT_*`, (b) the orchestrator as
`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` (Basic auth to `/api/public/*`), (c) the trusted `collector` (the
`basicauth/langfuse` extension encodes `pk:sk` for the exporter). They are not in the agents container, `LANGFUSE_` is a blocked
prefix in `scrub-env.ts` and on no sandbox profile's allowlist, and the sink never logs them.

Networks: the stores, the worker and the web service share the internal `langfuse-internal`, which the orchestrator and the
collector are **not** on. `langfuse-web` is also on the dedicated internal `langfuse-api`, joined only by `langfuse-web`, the
orchestrator and the trusted `collector`: that is the one path to Langfuse's port 3000. It is deliberately **not** on
`telemetry-internal`, which the untrusted `collector-agents` shares, so the agent-facing receiver cannot reach Langfuse.
`langfuse-proxy` is the only member of the non-internal `langfuse-ui`, publishing `127.0.0.1:3002`. The agents container shares
no network with any of it. Every image is pinned by tag and digest.

The score sink sends the project keys only to the `langfuse-web` host, loopback or an https address. Any other host leaves the
sink unconfigured with a startup warning, unless `LANGFUSE_ALLOW_EXTERNAL=true` is set.

Traces: the file swaps the trusted collector's config for `config/otel/collector-langfuse.yaml` (the plain config plus an
`otlphttp/langfuse` exporter to `/api/public/otel`, header `x-langfuse-ingestion-version: 4`). A compose file cannot make a
pipeline conditional, hence a second config; a test pins that the two differ only by that exporter. Metrics stay in LGTM
(Langfuse discards OTLP metrics). Agent-origin traces (`collector-agents`) never go to Langfuse.
If the file is loaded without `--profile langfuse`, the collector exports to a Langfuse that is not running: the exporter fails open.

Image pins: `langfuse` and `langfuse-worker` 4.63.0 (latest 4.x checked 2026-10-18), ClickHouse 25.12.11, Postgres 17.11,
Redis 7.4.11, MinIO by digest (MinIO no longer publishes community images; this is the image Langfuse's own compose uses).

Human labels: annotate in Langfuse (annotation queues), then `npm run langfuse:labels -- --session <id>` (inside the
orchestrator container) copies them into `run_scores` as `source=human` rows, so calibration never reads Langfuse live.

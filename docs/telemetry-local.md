# Local telemetry stack

An opt-in pair of collectors plus Grafana, Tempo and Prometheus (`grafana/otel-lgtm`) for looking at the orchestrator's
traces and metrics. Plain `docker compose up` does not include it. Design: `docs/observability-design.md` (§9.2, §10).

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | set by the telemetry file on the orchestrator (`http://collector:4318`) | Where the orchestrator exports. |
| `OTEL_SERVICE_NAME` | set by the telemetry file (`qayaba-orchestrator`) | Resource service name. |
| `QA_TELEMETRY` | `.env` | `local` (default) or `off`. |
| `QA_AGENT_OTLP_ENDPOINT` | set by the telemetry file on the agents service (`http://collector-agents:4319`) | The supervisor then gives Codex a trace exporter (`[otel]` in its `config.toml`) pointed at the untrusted receiver, and the orchestrator passes the attempt's `traceparent` so Codex's spans hang under it. Unset (plain compose): Codex exports nothing and its config is unchanged. |
| `QA_TELEMETRY_OBSERVE_UNWATCHED` | set by the telemetry file on the orchestrator (`true`) | Track the explorer's calls for its trace without registering, watching or waiting for its session. Off when unset. |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_RESOURCE_ATTRIBUTES` | `.env` | Optional exporter tuning. |

## Where to look

Grafana: <http://127.0.0.1:3001>, user `admin`, the password you set. Anonymous access is disabled. The Tempo
datasource shows traces (search by `service.name = qayaba-orchestrator`); the Prometheus datasource shows metrics.
Nothing else is published: Tempo, Prometheus and the OTLP ports are reachable only inside the compose networks.

A rotating copy of each collector's traces is written to the `otel-debug` volume (`/var/lib/otel-debug/traces.jsonl` for
the trusted collector, `agents-traces.jsonl` for the untrusted one; 100 MB x 3 files each). The `debug` exporter is
declared but off; add it to a pipeline in the collector's config to print spans to its log.

## Trust model: one receiver per collector

Network isolation is per container, so a single collector holding both receivers on both networks would expose the
trusted port to the agents. Each receiver is therefore its own service with its own config:

| Service | Config | Receiver | Networks | Who writes to it | Pipeline |
|---|---|---|---|---|---|
| `collector` | `config/otel/collector.yaml` | `otlp/orchestrator` :4318 | `telemetry-internal` only | the orchestrator | trusted; secret redaction only |
| `collector-agents` | `config/otel/collector-agents.yaml` | `otlp/agents` :4319 | `agent-otlp` + `telemetry-internal` (the latter only to export to lgtm) | the agents container (later slice) | untrusted; deletes `qayaba.*`, `langfuse.*` and prompt/response content keys, then sets `qayaba.trust=agent` |

- The agents container is on `agent-otlp` and **not** on `telemetry-internal`, so it can reach `collector-agents` and
  nothing else of the stack: not the trusted receiver, not Grafana, not lgtm. The `qayaba.trust=agent` tag therefore
  cannot be spoofed. The network is prepared; the agents emit nothing yet.
- The strip and the stamp run on the resource, the scope, every span and every span event, with `error_mode: propagate`
  (a failing statement drops the batch rather than passing a forged key). The collector has no OTTL context for span
  links, so the span context drops the links whole.
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
  own sanitizer, not a replacement.

## Retention

Spans are kept 30 days (R4). The `grafana/otel-lgtm` image has no retention key in its Tempo config (Tempo's default is
14 days), but its start script appends `TEMPO_EXTRA_ARGS` to the Tempo command line, so the compose file sets
`-backend-worker.compaction.block-retention=720h` (the Tempo 3.x flag). Re-check the flag name when the image pin moves.

The collector image is pinned to `0.163.1`: the `0.163.0` tag was never published to Docker Hub.

## Later

Langfuse arrives as a separate `langfuse` profile that adds its exporter to the same collectors (slice S4b). No Langfuse
key or exporter exists in this stack.

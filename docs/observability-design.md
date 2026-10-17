# qayaba observability: architecture design

> **Status:** decisions resolved (§17); adversarial review incorporated (§18); the R3 deviation was approved by the owner on 2026-10-17. No code yet.
> **Inputs:** `docs/observability-context.md` (what to measure and why), the external
> "qayaba-observability" brief (how to build it), a code survey of `feat/plan-v4` (2026-10-17),
> and a survey of the current OpenTelemetry, Langfuse, OpenCode and Codex docs and source.
> **Scope:** tracing, metrics, host health, graders, evals and the public contract. Implementation
> follows in the slices of §14, after this document is approved.

## 0. Decisions at a glance

Read this table first. Each row is defended later in the section it names.

| # | Decision | Section |
|---|---|---|
| D1 | One trace per run. The run root starts at **dequeue**, on `ROOT_CONTEXT`, and has a **span link** to the enqueue request. | §4.1 |
| D2 | The engine sees a `TelemetryPort` with **no SDK types**. The OpenTelemetry SDK is imported only in `src/telemetry/`. A cruiser rule enforces this. | §3 |
| D3 | **The run store stays the system of record.** Spans are also written, metadata-only, to a local SQLite span ledger (`run_spans`). OTLP export is optional. Graders and the public API read the ledger, never Langfuse. | §3.3 |
| D4 | Phases are tracked by a **phase cursor** in `RunQaUseCase`: `phase.enter(x)` closes the previous phase. There are no closures around the 1500-line `execute()`. `furthest_phase` and `phaseTimings` are persisted on `run_outcomes`. | §4.2 |
| D5 | Agent turns: the orchestrator **synthesizes** `invoke_agent` / `chat` / `execute_tool` spans at the **`AgentDeps` facade** (covering both runtimes) and in `codex-strategy.ts`. Each limit records itself in the layer that fires it. | §5 |
| D6 | `run_spec` and `authbrowser_*` callbacks are joined **in-process** by session id. They are opened with an **explicit parent** (`withParent`) inside the run-context snapshot those ports restore. | §5.5 |
| D14 | **One clock.** Every span gets explicit wall-clock `startTime`/`endTime` from an injected `Clock`, never the SDK's monotonic delta. So native and synthesized spans agree across a host suspend. | §3.1, §7 |
| D7 | Sandboxed children get **no `TRACEPARENT`**. They cannot reach a collector by design. The launcher records an orchestrator-side span per child, and Playwright per-test spans are synthesized from the JSON report. | §6 |
| D8 | **No sampling in v1.** Runs are sequential and few, so we keep 100%. Volume is controlled by `captureMode` (`off \| metadata \| full`), never by dropping runs. A/B arms stay identical. | §8 |
| D9 | Host suspend and event-loop stalls are first-class signals: a heartbeat that compares wall time with monotonic time, plus `monitorEventLoopDelay`. | §7 |
| D10 | Local stack in a compose profile that is off by default. Collector plus `grafana/otel-lgtm` (traces and metrics) by default. **Langfuse v4 is a second, optional profile** (it needs ClickHouse, Postgres, Redis and MinIO, with 16 GiB recommended). | §10 |
| D11 | GenAI semconv is "Development" and moved to its own repo in 2026. All `gen_ai.*` keys go through **one mapping module**, so a rename is a one-file change. | §5.1 |
| D12 | Graders are pure functions in a new `evaluation` context, over a `RunEvidence` read model. Scores go to SQLite (`run_scores`) first and are pushed to Langfuse fail-open. | §11 |
| D13 | Telemetry that comes **from the agents container is untrusted**. Graders and verdicts never read agent-emitted OTLP, only orchestrator-recorded evidence. | §9 |

---

## 1. Problem and success criteria

Today, a failed run takes hours of cross-container forensics to explain. `observability-context.md`
§1 and §7 list 16 real failures (F1–F16). Every one of them was at a **seam**: host sleep, provider
reasoning drift, quota, an egress-refused stylesheet, an unrendered element. None was inside a unit.

**Done means:** each of the 12 questions in `observability-context.md` §8 and each of the 8 in the
brief §0 can be answered from traces and metrics alone, in minutes. Nobody needs a container shell,
SQLite or the OpenCode log. §13 maps every question to the data that answers it.

**North-star metric** (from the context doc): the share of runs that reach `execute`, and of those,
the share that pass and stay valid on a no-retry re-run. It is computed from the `furthest_phase`
attribute (§4.3) and the campaign re-run graders (§12).

**Non-goals for v1:**
- Alerting and paging.
- Multi-host collectors.
- Upgrading OpenCode, Codex or Playwright for telemetry. The pins stay.
- Changing any verdict rule. The only planned gate change is gated behind evidence (§11.2).

---

## 2. What exists today (verified)

Reuse this before adding anything.

| Asset | Where | Useful for | Gap |
|---|---|---|---|
| `ObserverPort.onStep/onEvent` | `qa-run-orchestration/application/ports/index.ts:627` | Coarse phase transitions | `RunStep` has no `ground`, `review` or `publish` |
| `run_events` table | `src/server/history.ts:241` | Ingest-time `ts` per event; probe-report derives phases from it | Unstructured for tracing |
| `gateSignals.phaseTimings` | `run-outcome.ts:35` | A slot for phase durations | **Declared and persisted, never written** |
| `AgentTurnEvent` | `agent-transport-policy.ts:24-50` | Session id, role, round, repair, tokens (incl. reasoning and cache), cost, `sectionSizes`, call metrics, `ended`, duration | No requested or answered model, no provider, attempt, fallback flag or error class. `sectionSizes` is dropped before persistence |
| `CallEfficiencyTracker` | `generation/infrastructure/sse/call-efficiency-tracker.ts` | Per-step tokens, tool calls, buckets, time to first call and first write | Ignores `part.state.time`. Per-step tokens are summed and discarded. Explorer is excluded (`liveObservation:false`) |
| `agent_turns` table | `history.ts:309` | Redacted prompt and output text, turn metrics | 30-day retention. No model or attempt columns |
| Section abstraction | `context-assembler.ts:11-49` | `AssembledPrompt.sectionSizes` per section id | No section or prompt hash |
| `SandboxReport` / exec scope (ALS) | `process-sandbox/exec-scope.ts` | Denied hosts per run, `openDeniedWindow` per login attempt, refusal reason | Denials keep the host but drop the port. Not per child |
| `RunDeadlineExceededError` | `shared-kernel/run-deadline.ts:20` | `budgetMs`, `label`, `role`, `stop` | Only on the deadline path. Other limits are implicit |
| Run-secret redaction (ALS) | `shared-infrastructure/run-secret-redaction.ts` | `redactByValue` inside the run scope | **No-op outside the run's async context** |
| `/api/metrics` | `src/server/metrics.ts`, `src/index.ts:775` | Prometheus text: queue depth, sessions, verdict counts | Not OTel. Raw path only |
| `probe-report`, `efficiency-benchmark`, campaign runner | `scripts/` | The acceptance baselines | Campaign identity exists only client-side; the server cannot tag a run |

There is **no** `@opentelemetry/*` dependency, no logger abstraction (~270 raw `console.*` sites
with a `[qa]` prefix), and nothing measures event-loop lag or host suspend.

---

## 3. Architecture

### 3.1 Layers

```
qa-engine/src (engine, no SDK)                      src/ (shell)
┌───────────────────────────────────────────┐      ┌──────────────────────────────────────────┐
│ shared-kernel/telemetry/                  │      │ src/telemetry/   ← ONLY place that        │
│   telemetry.port.ts   (TelemetryPort)     │◄─────┤   otel-telemetry.adapter.ts  imports      │
│   attribute-registry.ts (typed keys)      │      │   sqlite-span-exporter.ts    @opentelemetry│
│   genai-semconv.ts    (gen_ai.* mapping)  │      │   bootstrap.ts (providers, flush)        │
│   noop-telemetry.ts                       │      │   host-health.ts (heartbeat, ELD)        │
│ contexts/*/infrastructure/telemetry/      │      │   metrics.ts (instruments)               │
│   *-port.traced.ts  (decorators)          │      └──────────────────────────────────────────┘
│ contexts/evaluation/  (graders, pure)     │           wired in rewritten-engine-factory.ts,
└───────────────────────────────────────────┘           src/index.ts, src/cli.ts
```

- **`TelemetryPort`** is a minimal tracing facade:
  - `startSpan(name, {kind, attrs, links, startTime, parent})` returns a handle with
    `setAttrs`, `addEvent`, `recordError`, `end(endTime?)` and `context()`.
  - `withSpan(name, opts, fn)` binds the active context for `fn` and always ends the span, on every path.
  - `activeContext()` and `inject(carrier)`.
  - Instruments: `counter`, `histogram`.

  Attribute keys are **typed by the registry**, which includes template keys such as
  `prompt.section.<id>.bytes`, `calls.<bucket>` and `campaign.variant.<k>`. An unregistered key
  fails at compile time. At run time an unknown key is **dropped and counted**, never thrown.
- `withParent(handle, fn)` runs `fn` under an explicit parent. It is needed wherever the ambient
  context is a restored snapshot (§5.5) or a stream callback (§5.4).
- **Times are explicit (D14).** Every `startSpan`/`end` call passes wall-clock time from an injected
  `Clock`. The SDK would otherwise compute end as start plus a `performance.now()` delta, and that
  delta stops while the Docker Desktop VM is paused. Synthesized spans (OpenCode `state.time`,
  Playwright `startTime`) are wall-clock too, so mixing the two would misplace children by the
  length of a suspend. The injected clock also keeps tests free of real time.
- **Every port method is total.** An adapter error is caught, counted in `/telemetry/health`, and
  swallowed. A test makes every method throw and asserts the verdict does not change.
- **Decorators** follow the `RunDeadlineRuntime` precedent: a class in `infrastructure/` that
  implements a port, delegates, and records. Removing telemetry means removing the decorators, the
  phase-boundary calls (D4) and the bootstrap.
- **No-op default.** Composition passes `NoopTelemetry` unless the shell builds a real one. This
  follows the repo's "optional port" convention: the dep is omitted, and the use case uses `?.` or the null object.

### 3.2 Boundary rules (machine-enforced)

| Rule | Enforcement |
|---|---|
| `qa-engine/src` never imports `@opentelemetry/*` or `langfuse*` | New dependency-cruiser rule `no-telemetry-sdk-in-engine` |
| In `src/`, the SDK appears only under `src/telemetry/` | A small grep test (cruiser does not scan `src/`) |
| Every emitted attribute key is in the registry | Typed keys plus an in-memory-exporter test (§15) |
| Metric attributes come only from a closed set | A cardinality test over instrument definitions (§8.3) |

### 3.3 Where spans go (D3)

```
TelemetryPort ──► OTel TracerProvider (src/telemetry)
                    ├─ SimpleSpanProcessor → SqliteSpanExporter   (always, when mode ≠ off)
                    └─ BatchSpanProcessor  → OTLP/HTTP → collector (only when OTEL_EXPORTER_OTLP_ENDPOINT is set)
```

**Why a local span ledger** (`run_spans`: trace_id, span_id, parent_id, run_id, name, kind,
start_ns, end_ns, status, attrs JSON, events JSON, links JSON):
- **Retroactive graders** (brief principle 8) must work when the collector was down, or was never
  configured. Langfuse cannot be the source of truth for that.
- **The public API** must not depend on Langfuse (brief §10).
- **The probe report** becomes a query over `run_spans`. That is the acceptance test in context §6.
- Volume is small: one run at a time, around 10³ spans per run in metadata mode (inferred). Retention
  is set in R4.

**Ledger write path.** A synchronous insert per span would put an fsync on the event loop, and the
event-loop monitor of §7 would then measure its own writes. So the ledger is written like this:
- Spans are buffered in memory and committed **one transaction per phase change, or every 200 spans**.
- It uses the history DB's handle and WAL, with `synchronous=NORMAL`.
- A row is written when a span **starts** (`end_ns` null) and updated when it ends. A hung run (F2)
  is then visible while it hangs, and a crashed run leaves its open spans behind as evidence. Spans
  still open when a run ends are closed with `qayaba.span.orphaned=true`.
- A ledger write failure is counted and dropped. It never fails the run.

The bootstrap maps `OTEL_BSP_*` and resource env vars itself. Without `NodeSDK`, the SDK v2
`BatchSpanProcessor` takes options only and ignores those env vars.

**Tradeoff to approve.** Brief principle 2 says "no endpoint → zero overhead". This design keeps
**zero network** with no endpoint, but writes locally by default. `QA_TELEMETRY=off` restores true
zero. The recommended default is `local`.

| `QA_TELEMETRY` | Ledger | OTLP | Use |
|---|---|---|---|
| `off` | no | no | Opt-out, and the overhead benchmark baseline |
| `local` (default) | yes | only if the endpoint is set | Normal |

Standard OTel env vars drive everything else: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`,
`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_BSP_*` and `OTEL_SDK_DISABLED`. We gate on `OTEL_SDK_DISABLED`
ourselves, because only `NodeSDK` honors it.

### 3.4 Versions (checked 2026-10-17, pinned exactly per repo rule)

Every telemetry component below is the latest release as of 2026-10-17. The agent runtimes are
**not** upgraded: see R5 in §17.

| Package | Version |
|---|---|
| `@opentelemetry/api` | 1.9.1 |
| `sdk-trace-node`, `sdk-trace-base`, `sdk-metrics`, `context-async-hooks`, `resources`, `core` | 2.12.0 |
| `exporter-trace-otlp-proto`, `exporter-metrics-otlp-proto` | 0.223.0 |
| `semantic-conventions` | 1.43.0 (stable keys only; `gen_ai.*` comes from our own mapping) |

We use `NodeTracerProvider` and `AsyncLocalStorageContextManager`, not `NodeSDK`, so that no
auto-instrumentation patches modules. `sdk-trace-base` 2.12 is now a shim over `sdk-trace`, so we
import from the shim's public API only.

---

## 4. Trace model: the run

### 4.1 Root and queue (D1)

The run executes later than it was requested, on a different async chain (`JobQueue` tail). That
makes it a **new trace**. Per the OTel messaging guidance, a consumer that runs later links to the
producer instead of being its child.

```
[request trace]  POST /api/v1/runs  or  webhook  or  cli  ── span "qayaba.run.enqueue" (SERVER/INTERNAL)
                                                                     ▲ link
[run trace]      qayaba.run  (root, INTERNAL, starts at dequeue)  ───┘
                   attrs: qayaba.queue.wait_ms, qayaba.onboarding.wait_ms
```

- The runner captures `enqueuedAt` and the enqueue span context at `runner.ts:~305`. It opens the
  root inside the job callback, **explicitly on `ROOT_CONTEXT` with `root: true`**.
  `JobQueue.enqueue` chains `tail.then(...)` inside the caller (`queue.ts:17`), so the job inherits
  the enqueuer's AsyncLocalStorage. Without that, the "new trace" would silently become a child of
  the HTTP request span.
- The wait is an **attribute on the root**, not a span that pre-dates it. Waits up to the 6 min
  before a run is dequeued stay visible without distorting the run's own duration.
- The trigger kind is a **new `RunRequest.trigger`** field: `webhook | api | cli | campaign | continuation | context | login-bootstrap`.
  Today `source` is only `webhook | manual`, and API, webhook and campaign runs cannot be told apart.
- **Cancellation** ends the root with status UNSET and `qayaba.run.cancelled=true`. An operator
  cancel is never ERROR (context §3.1).

### 4.2 Phase spans (D4)

`RunQaUseCase.execute()` has no phase methods, and it returns early (`return this.terminalResult(…)`)
from dozens of places. Wrapping those regions in closures would put verdict logic at risk.

The design uses a **phase cursor** instead, a small domain object owned by the use case:
- `phases.enter("generate")` ends the open phase span and starts the next one. It is placed at the
  existing `onStep` sites and at the points that have none (workspace, ground, review, publish, learn).
- `runInScope`'s `finally` ends whatever is open. So every exit path ends every phase, and there is
  nothing to forget.
- The cursor is pure engine code (domain state plus an optional `TelemetryPort`). It fills
  `gateSignals.phaseTimings`, which is declared and never written today, and `furthestPhase`.
- **Both are persisted on `run_outcomes`, whether or not telemetry is on.** The north-star funnel
  then comes from the system of record, not from a root-span attribute that a crash would never
  write.
- As built in S1a, the record lives on the `runs` row (`furthest_phase`, `phase_timings`), written by the runner
  in the same statement that sets the final status, so a run is never seen finished without it. `run_outcomes`
  carries none of it. `gateSignals.phaseTimings` and `furthestPhase` are on the returned outcome, not on the saved one.
- Semantics of the record:
  - A timing is time spent inside a region of the run, not the pure cost of a phase. A review-round regeneration
    counts under `review`; `coverage` is a region only in diff mode; the reflect and audit of a terminal path count
    under whichever phase was open.
  - `generate` is also entered by a regression run that generates nothing, because the existing suite is run there.
  - `learn` is entered only on the mainline decided path, after the outcome is saved. A terminal exit (invalid,
    infra-error, deadline) keeps the phase it was in as its furthest phase.
  - A context run executes nothing and persists no outcome, so it ends at `publish`.
  - An error nothing handles reaches the runner with the cursor's record attached, so a crash still has a furthest phase.

```
qayaba.run
├─ qayaba.phase.gate              deploy verified | unverified | skipped-no-version-url
├─ qayaba.phase.workspace         checkout, mirror, index sync
├─ qayaba.phase.classify          action, archetypes, tier
├─ qayaba.phase.setup
│  ├─ qayaba.suite_store.restore  restored, overlaid, tracked_wins, auth_restored
│  ├─ qayaba.setup.seed
│  ├─ qayaba.exec install         (npm ci, §6)
│  ├─ qayaba.setup.orphan_cleanup
│  └─ qayaba.auth.login           attempt n: outcome kind, denied hosts, demoted?
├─ qayaba.phase.ground
│  ├─ invoke_agent qa-explorer    (§5)
│  ├─ qayaba.context.<source>     (§4.4) learning, curriculum, context-map, route-ranking,
│  │                               dom-capture (per route: events), context-pack, stitcher,
│  │                               structural-signal, cross-repo-impact
│  └─ qayaba.exec offline|suite   (DOM capture child)
├─ qayaba.phase.generate
│  ├─ invoke_agent qa-generator   round=first|repair|static-fix|pre-exec|fix-loop|coverage-regen|review-correction
│  ├─ plan qa-generator           (lead+sidekicks: read-only plan turn)
│  ├─ qayaba.fanout               children: invoke_agent qa-sidekick (overlapping)
│  └─ qayaba.merge                links → each delivering sidekick span
├─ qayaba.phase.validate          per check: typecheck | lint | list | manifest; catalog gate; ambiguity advisory
├─ qayaba.phase.health
├─ qayaba.phase.execute           qayaba.spec.execute per spec, qayaba.test per case (synthesized, §6.2)
├─ qayaba.phase.fix_loop          rounds as children: regenerate → validate → execute
├─ qayaba.phase.coverage          status, ratio, changed/covered lines, policy; coverage regen child
├─ qayaba.phase.review            invoke_agent qa-reviewer per round, review-dom grounding
├─ qayaba.phase.decide            verdict, decision pr|issue|shadow|none
├─ qayaba.phase.publish           suite_store.capture, PR/Issue
└─ qayaba.phase.learn             fold, curriculum fold, reflect, process audit
```

Rules, from the brief §2.1 and the OTel spec:
- Span names are **low cardinality**. Variable data goes in attributes.
- Phases use kind INTERNAL. Outbound HTTP uses CLIENT. The tools listener uses SERVER.
- ERROR status plus `error.type` is used **only for infrastructure failures**. A `fail` verdict is a
  product outcome, recorded as `qayaba.verdict`, and the span status stays UNSET.
- Point occurrences are **span events**: `retry`, `strict_mode_violation`, `step_budget_exhausted`,
  `circuit_opened`, `fallback_model_used`, `truncation_applied`, `redaction_applied`,
  `host_suspended`, `egress_denied`, `deadline_armed`.

### 4.3 Root attributes

Grouped. The full list lives in the registry (§9.3).

| Group | Attributes |
|---|---|
| Identity | `qayaba.run.id`, `qayaba.app`, `qayaba.commit.sha`, `qayaba.trigger`, `qayaba.mode`, `qayaba.target`, `qayaba.parent_run.id`, `qayaba.trigger_repo`, `qayaba.shadow` |
| Config in effect | `qayaba.runtime` (opencode\|codex), `qayaba.coordination.mode`, `qayaba.closed_loop.enabled`, `qayaba.agent_browser.enabled`, `qayaba.coverage.policy`, `qayaba.reflector.enabled`, `qayaba.campaign.freeze`, `qayaba.prompt.static_hash` (hash of `agents/AGENTS.md` plus role files), `qayaba.capture_mode` |
| Campaign | `qayaba.campaign.id`, `qayaba.campaign.variant.<key>`, `qayaba.campaign.replicate` |
| Budgets | `qayaba.deadline.label`, `qayaba.deadline.budget_ms`, `qayaba.tier`, `qayaba.tier.budget_ms` |
| Outcome | `qayaba.verdict`, `qayaba.error_class`, `qayaba.generation.end`, `qayaba.decision`, `qayaba.furthest_phase`, `qayaba.specs.generated/valid/passed`, `qayaba.reviewer.turn_happened`, `qayaba.limit.fired` |
| Totals | `gen_ai.usage.*` sums, `qayaba.cost.total`, `qayaba.agent.turns`, `qayaba.agent.steps` |
| Host | `qayaba.host.suspended_ms`, `qayaba.host.event_loop.max_ms` (§7) |
| Langfuse | `langfuse.trace.name`=`qayaba.run`, `langfuse.session.id`=campaign id or app, `langfuse.trace.tags`=[app, runtime, variant…], `langfuse.environment` |

`qayaba.furthest_phase` drives the funnel (F1). It is the last phase entered, set by the phase
wrapper, so a run that throws still carries it.

**The limit that ended the run** is `qayaba.limit.fired`. It also appears on turns (§5.3), with
the values `tier-budget | run-deadline | repair-cap | explorer-timeout | host-cap | stall | step-cap | cancel | none`.

### 4.4 Context spans and stable item ids (brief §3)

Each grounding source produces one `qayaba.context.<source>` span with these attributes:
- `qayaba.context.source`, `.items.count`, `.bytes`, `.truncated`, `.truncated_items`
- `qayaba.context.item_ids`: a string array, capped at 200, with the overflow counted

The prompt's assembly is recorded on the turn (§5.4), not here. **IDs are assigned where the item is
produced**, are deterministic, and are identical across runs:

| Source | ID form | Origin |
|---|---|---|
| Route (map, ranking, capture) | `route:<template-path>` | `ArchitectureContext.routes[].path` |
| DOM element | `dom:<template-path>#<testid>` (falls back to `#role:<role>:<name-hash8>`) | `RouteSnapshot.testIds` |
| API operation | `op:<operationId>` | OpenAPI ingress |
| FE↔BE link | `link:<route>→<operationId>` | `feBe[]` |
| Flow | `flow:<id>` | `flows[].id` |
| Learned rule | `rule:<ruleId>` | `learning_rules.id` (stable for the rule's life) |
| Exemplar | `exemplar:<id>` | `scenario-catalog.ts` literals |
| Explorer brief claim | `brief:<kind>:<hash8 of normalized claim>` | `ExplorationBrief` |
| Provided file | `file:<repo-relative path>` | `AssembledPrompt.providedPaths` |
| Changed value fact | `fact:<route>#<testid>:<present\|absent>` | the pack's "Changed values" |

The **referenced** ids are extracted later by a pure function (§11.1), never self-reported by the agent.

---

## 5. Trace model: agent turns (D5, D11)

### 5.1 Semconv status, and how we stay safe

- The GenAI conventions moved to `open-telemetry/semantic-conventions-genai`. They are all
  "Development", have no release, and their schema URL is TODO.
- The metric names changed from `gen_ai.client.token.usage` to `gen_ai.client.inference.usage.*`.
- `gen_ai.usage.input_tokens` now **includes** cached tokens. The cache and reasoning attributes are subsets.

So:
- `shared-kernel/telemetry/genai-semconv.ts` is the **only** module that spells a `gen_ai.*` key.
  It records the repo commit it follows in `qayaba.semconv.genai_rev`.
- We emit the current names only. We do not double-emit legacy names.
- `gen_ai.conversation.id` is set **only** to OpenCode's real session id. Per the spec, it is never
  synthesized from a run id. Codex has no session id we can see, so it gets none.

### 5.2 Shape

```
invoke_agent qa-generator               INTERNAL  one per prompt (turn)
├─ qayaba.agent.attempt                 one per attempt: primary, then fallback model
│  ├─ chat <model>                      CLIENT, synthesized, one per step (step-start → step-finish)
│  │  └─ (step tokens, reasoning, cache, cost, finish reason)
│  ├─ execute_tool read                 INTERNAL, synthesized from tool part state.time (real times)
│  ├─ execute_tool run_spec ──link──► qayaba.tool.run_spec (SERVER, orchestrator-side, §5.5)
│  └─ …
└─ events: host_suspended, stall_warning, circuit_opened, fallback_model_used, step_budget_exhausted
```

**Where it is built.** The review checked this against the code, and it is spread over four layers:
- **The turn span lives at the `AgentDeps` facade.** That is the level `RunDeadlineRuntime` and the
  stall watchdog wrap (`rewritten-engine-factory.ts:851, :1381`). It sees the role, the session, the
  prompt options and the result for **both** runtimes. The raw transport below it sees only
  `{id, cwd, agent, text, model}`.
- **Attempt spans** come from a new `AgentDepsCollaborators` hook (`onAttempt`), next to the
  existing `prepareAttempt`, inside `createAgentDeps`. That is where primary and fallback are known.
- **Codex** never goes through `createAgentDeps`. `codex-strategy.ts` opens the same attempt span
  shape itself.
- **Each limit records itself in the layer that fires it.** `RunDeadlineRuntime` sets
  `run-deadline` or `tier-budget`, the stall watchdog sets `stall`, `withTimeout` sets `host-cap`
  or `repair-cap` or `explorer-timeout`, and the tracker sets `step-cap`. Each writes
  `qayaba.limit.fired` on the turn span through the port.
- **A watchdog abort rejects only the outer promise.** The inner attempt keeps running until its
  own `withTimeout`. The attempt span therefore ends when the attempt really ends, carrying
  `qayaba.agent.abandoned=true`, and it is part of the "every span ended" test.

### 5.3 Turn attributes

| Group | Attributes |
|---|---|
| Identity | `gen_ai.operation.name`=`invoke_agent`, `gen_ai.agent.name` (qa-generator…), `gen_ai.conversation.id`, `qayaba.agent.role`, `qayaba.agent.round`, `qayaba.agent.repair`, `qayaba.delegation.id` |
| Model | `gen_ai.provider.name`, `gen_ai.request.model` (what we asked, or the agent's configured model), `gen_ai.response.model` (**from `AssistantMessage.modelID/providerID`**, which today is discarded at `opencode-client.ts:573`), `gen_ai.request.reasoning.level` (the role's `reasoningEffort`), `qayaba.agent.fallback_used` |
| Tokens | `gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens`, `.cache_write.input_tokens`, `.reasoning.output_tokens`, summed over steps. `qayaba.usage.source`=`steps\|final-message\|none` says how complete the sum is |
| Time | `qayaba.agent.ms_to_first_step`, `qayaba.agent.ms_to_first_call` (existing `timeToFirstCallMs`), `.ms_to_first_write`, `qayaba.agent.reasoning_tokens_before_first_call` (F3) |
| Work | `qayaba.agent.steps.used`, `.steps.limit` (live from `GET /agent`), `qayaba.agent.calls.<bucket>` per `CALL_BUCKETS`, `.calls.denied`, `.reads.redundant`, `.reads.prompt_provided`, `.writes` |
| Limits | `qayaba.limit.applied` (the smallest that applied), `qayaba.limit.applied_ms`, `qayaba.limit.fired`, `qayaba.agent.end` (`completed\|exhausted\|timeout\|aborted`) |
| Verdict | `qayaba.agent.verdict.specs`, `.noop_kind` (`not-worth\|unobservable\|unspecified`), `.parse` (`ok\|repaired\|unreadable`) |
| Prompt | `qayaba.prompt.hash`, `qayaba.prompt.bytes`, `qayaba.prompt.section.<id>.bytes` and `.hash`, `qayaba.prompt.sections.dropped`, `qayaba.prompt.tools_offered.count` and `.bytes` (§5.6) |
| Rules | `qayaba.context.item_ids` for the rules and exemplars this prompt carried (F16) |
| Error | `error.type`=`quota_exceeded\|rate_limited\|auth\|socket_closed\|provider_5xx\|output_length\|aborted\|timeout\|circuit_open\|unknown`. Added to `agentErrorToInfra` and the transport throw path, where today only the message carries it |

**Answering Q4 ("same prompt?").** `context-assembler` computes a sha256 of the **redacted** text
per section and for the whole prompt. Two turns whose `qayaba.prompt.hash` match had the same
prompt. If they differ, comparing `section.<id>.hash` names the sections that changed, and the
`.bytes` values give the sizes. This needs no content capture (context §4, "Content capture").

### 5.4 Tracker changes (behaviour-neutral)

1. Read `part.state.time.start/end` for tool parts. These are real epoch ms from OpenCode. Keep the
   per-call start, end and status.
2. Keep per-step records: the receive time of `step-start` and `step-finish`, tokens, cost and
   finish reason. **Step parts carry no timestamps** in the 1.17.7 SDK. So `chat` spans use the
   receive time and are marked `qayaba.span.synthesized=true` and `qayaba.time.source=receive`.
3. **Explorer observation: a latent bug comes first.**
   - `withStallWatchdog` wraps **every** non-self-timed session, the explorer included
     (`agent-transport-policy.ts:515-545`).
   - `liveObservation:false` skips SSE registration, so nothing ever feeds the explorer's watchdog.
   - With the default `OPENCODE_STALL_MS` (180 s, `opencode-client.ts:458`) below the explorer's
     240 s timeout, every explorer turn longer than 180 s is aborted as "stalled", whatever it is
     doing. The owner's env sets 600 s, which masks this. The context doc's premise ("no stall
     watchdog for the explorer") is false in code.
   - **Fix it as its own root-cause commit before S2:** the explorer's watchdog either is not armed
     or is fed. Then add explorer tracking as an opt-in path that does **not** call
     `notifySessionActivity` and does **not** add the `prepareAttempt` wait.
   - Prove with a test that the explorer's turn outcome is unchanged with tracking on and off. A/B
     arm parity depends on it.
4. Persist `sectionSizes`, model, attempt and error class on `agent_turns`. These are new columns,
   so `probe-report` keeps working from SQLite.

### 5.5 Cross-container callbacks: `run_spec` and `authbrowser_*` (D6)

The tool runs inside OpenCode and POSTs `{sessionID, agent, …}` to `:459`. OpenCode does not
propagate trace context into a tool, and `ToolContext` has none.

The join is **in-process**:
1. `withSessionRegistration` already binds `sessionID → run` (`ClosedLoopRegistry`).
2. The telemetry decorator also binds `sessionID → live attempt span context`.
3. `tools-endpoint.ts` resolves the session as it does today. The call then runs inside
   `AsyncLocalStorage.snapshot()`, taken when the loop opened during setup
   (`bridges/closed-loop-port.adapter.ts:92`, `bridges/agent-browser-port.adapter.ts:90`).
   - That snapshot restores **every** store, OTel's context included. Ambient parenting would put
     every `run_spec` execution under the long-ended `setup` span.
   - So the port opens `qayaba.tool.run_spec` / `qayaba.tool.authbrowser` (kind SERVER) **inside**
     `inRunContext`, with `withParent(attemptSpan)`, and runs `useCase.run` under it.
   - A test asserts that a `qayaba.exec suite` span inside a `run_spec` call is a grandchild of the
     calling attempt.
4. Attributes on that span:
   - `qayaba.lease.wait_ms`: the new wait measurement around `AccountLock.withLock`
   - `qayaba.lease.refused` (DEV busy)
   - `qayaba.namespace`, the spec path and its sha256
   - the outcome and `qayaba.egress.denied`
   - for authbrowser: the route-guard block reason, the HTTP status and `qayaba.auth.invalidated`
5. When the SSE tool part for that call completes, the synthesized `execute_tool run_spec` span
   gets a **link** to the server span. They are matched by session id, `messageID` and time overlap.
   `messageID` is in `ToolContext`; adding it to the POST body is a two-line change in
   `agents/lib/*-client.mjs` and the parsers. The smokes are re-run per the CLAUDE.md rule.

Why not a `traceparent` header? The tool would need the span context of its own call, and OpenCode
does not give it one. The session-id join is exact, and it does not change the tool's trust surface.

### 5.6 Offered tool schemas

The tool schemas are about 60% of the context (context §4). Today the orchestrator never sees the
resolved tool list.

OpenCode 1.17.7 already exposes `GET /experimental/tool?provider=&model=`, which returns
`{id, description, parameters}` per tool (confirmed in source). The list is resolved **per model,
not per agent**. So the orchestrator:
1. reads it once per run and model, with the same live read as `stepLimits`;
2. applies the agent's `tools` and `permission` config;
3. applies the per-prompt deny map it builds itself (`openCodePromptBody`);
4. computes `tools_offered.count` and `.bytes` from the `JSON.stringify` of the remaining
   `description` and `parameters`.

**Spike S0.4** now only confirms that steps 2–3 reproduce what the model actually receives. Compare
against the AI SDK span's tool list from §5.7. If they disagree, the attribute is emitted with
`qayaba.tools_offered.source=estimated`.

### 5.7 Hidden calls, provider retries, quota (F7, F8, F15)

The orchestrator cannot see OpenCode's `title` agent or the provider's internal retries.
- **Content risk, which applies to both options.** AI SDK telemetry records inputs and outputs by
  default: `ai.prompt.messages`, `ai.response.text`, `ai.toolCall.args/result`. That includes repo
  files, MCP page content and engram. It bypasses `captureMode` and in-process redaction.
  - So Option A is **off by default**.
  - S0.2 must establish OpenCode's `recordInputs`/`recordOutputs`.
  - The agent receiver's pipeline (§9.2) **deletes** `ai.prompt*`, `ai.response.*` and
    `ai.toolCall.{args,result}` unless the server-side capture ceiling is `full`. Even then, it
    redacts them with the collector's secret patterns.
- **Option A (behind spike S0.2, and deferred to after S2).** Enable OpenCode's `experimental.openTelemetry`, which is
  present in 1.17.7 and gated on `OTEL_EXPORTER_OTLP_ENDPOINT`. It emits AI SDK spans:
  `ai.streamText` and `ai.toolCall`, with `ai.*` attributes plus `session.id`, including title calls
  and retries.
  - OpenCode's source never mentions `traceparent`. However, its HTTP server is Effect's
    `HttpRouter.serve`, whose default `HttpMiddleware.tracer` takes the parent of the request span
    from the W3C `traceparent` header. This is inferred from the Effect source and is unverified.
  - **S0.2 tests both levels:**
    1. Send `traceparent` (the attempt span) on `POST /session/:id/message` through the shared
       client's `headers`/`fetch` hook (`opencode-client.ts:221`), and check that the HTTP server
       span is parented.
    2. Check whether the AI SDK spans (which run in separate Effect fibers) inherit that parent.
  - If (2) holds, OpenCode's spans are **connected** children of the attempt span.
  - If not, they land in separate traces with `service.name=opencode`. The collector copies
    `session.id` into `gen_ai.conversation.id`, so viewers join them to the run's turn: **correlated,
    not connected**, stated plainly.
  - The title agent passes `experimental_telemetry` too (`agent/agent.ts:376`), so its hidden call
    is visible either way.
- **Option B (fallback).** The supervisor tails `opencode.log` and ships provider-error and title
  lines as OTel logs with the session id. This is more brittle, but works whatever the OTel support.

Either way, the turn span's `error.type` (§5.3) already covers what reaches the orchestrator.

### 5.8 Codex parity

- **Same span shape.** `invoke_agent` plus `qayaba.agent.attempt`, built by the same decorator.
- **Usage.** `codex exec --json` at the pinned 0.139.0 already emits `turn.completed` with
  `usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` (confirmed in
  source). The supervisor discards it today and returns only `{message}`. It will return
  `{message, usage}`, so Codex turns get `qayaba.usage.source=final-message` instead of `none`.
- **Native child spans.** These are confirmed in 0.139.0 source:
  - `codex exec` parents its root span on `TRACEPARENT`/`TRACESTATE` from its environment
    (`otel/src/trace_context.rs`, `exec/src/lib.rs:511`).
  - `[otel] trace_exporter="otlp-http"` exists, and its spans carry `gen_ai.usage.*` attributes.
    They are not full GenAI span naming.

  The wiring:
  1. the orchestrator injects `traceparent` in the `/codex/exec` POST header;
  2. the supervisor passes it as `TRACEPARENT` in the child env (`CODEX_EXEC_ENV_PREFIX` allowlist);
  3. Codex spans become **real children** of the attempt span.

  S0.3 shrinks to a live smoke of that hop.
- **Persisted rows.** Codex turn rows in `agent_turns` now also carry what the OpenCode funnel's carry: tokens (input without the cache, as every row holds it), prompt hash, section hashes, applied and fired limits, `ended`, the requested model and provider. Cost, cache writes, model answered, step budget and call metrics stay null. Run-level `gateSignals.usage` is still not fed by Codex.
- **Assumption to verify live.** A `turn.completed` usage is read as the spend of that turn alone (a delta). One exec is one turn, so the sum over an exec's events is right either way; the fixture-level check against a real capture is still open.
- Set `metrics_exporter="none"`, because the default is `statsig`, an OpenAI endpoint, which would
  break the "no SaaS" rule.

---

## 6. Sandbox, egress, execution (D7)

### 6.1 Exec children

The launcher (`exec-sandbox.ts` `spawn`) is the one place every agent-influenced child passes
through. It opens `qayaba.exec <profile>` (INTERNAL) at spawn and ends it on `close`. Attributes:
- `qayaba.exec.profile`
- `qayaba.exec.command_class` (`tsc|eslint|playwright-list|playwright-test|npm-ci|login|dom-capture|browser|code-test`, a closed set taken from the call site)
- `process.exit.code`, `qayaba.exec.signal`, `qayaba.exec.timed_out`
- `qayaba.reaper.killed`
- `qayaba.egress.denied_cotemporal`: hosts denied **while this child was alive**, via a per-child
  denied window like the login one. We also keep the port, which today is dropped.
  - Every child shares uid 1002, and the agent-browser Chromium and sidekick flows overlap other
    children. So the attribution is **co-temporal, not causal**, and the name says so.
  - Exact attribution (the proxy resolving socket → pid) is out of scope for v1.

**No `TRACEPARENT` into children.** The sandbox uid cannot reach a collector, and that is by design:
the iptables chain rejects every port but the proxy and DNS listeners. Widening `EXTRA_ENV_ALLOWED`
for an id nobody can export would be noise. This deviates from brief §4.2, deliberately.

### 6.2 Playwright results

- **Per spec and per case.** We synthesize `qayaba.spec.execute` and `qayaba.test` spans from the
  JSON report (`results[].startTime`, `duration`, `retry`, `status`, `error.message`).
  - Report times are real, so the spans are marked `synthesized` and not `time.source=receive`.
  - Attempts are child spans with `qayaba.attempt`.
- **Failure category.** This is a pure classifier over the redacted error text, plus the
  failure-DOM capture and denied hosts:
  - categories: `selector | auth | data_state | timeout | assertion | infra | egress`
  - `strict_mode_violation` is an event carrying `qayaba.selector.match_count`, parsed from
    Playwright's "resolved to N elements"
- **Validation.** One child per check: `typecheck|lint|list|manifest`, with an ok flag and an error
  count. Also the catalog gate (fabricated test-id count) and the ambiguity advisory
  (`preExecAmbiguityCatches`).

### 6.3 Login and DOM capture (F5, F11)

- **`qayaba.auth.login`, one per attempt.** It records:
  - the outcome `LOGIN_STATUS` and `PRECONDITION_KIND`
  - the duration
  - `qayaba.egress.denied` from `openDeniedWindow` (already collected), with intentionally blocked
    hosts flagged
  - `qayaba.auth.restored`, `qayaba.auth.demoted` and the reason
  - page console errors from the login child, when the script reports them (spike: the login
    script's output already carries them for CSS preload failures)
- **`qayaba.context.dom-capture`.** One span event per route:
  - status (`captured|degraded`), the degrade reason, `settled`, node count, test-id count and
    runtime-error count
  - `qayaba.route.ms`, where per-route timing is available
  - **the changed-value facts present or absent** (Q8)

---

## 7. Host health (D9, F2, F11, F12)

A process-wide `HostHealth` in `src/telemetry/host-health.ts` runs even with no run active.

| Signal | How | Output |
|---|---|---|
| Event-loop delay | `perf_hooks.monitorEventLoopDelay({resolution: 20})`, read every 10 s | Histogram metric `qayaba.host.event_loop.delay` (p50, p99, max). A span event `event_loop_blocked` on the active run when max exceeds 1 s |
| Suspend | A 5 s heartbeat compares `Δ Date.now()` with `Δ process.hrtime.bigint()`. Linux `CLOCK_MONOTONIC` does not advance while the VM is paused, but wall time is corrected on resume | Counter `qayaba.host.suspend.count`, histogram `.suspend.duration`. Event `host_suspended {ms}` on the run root **and** on the active turn span. Run attribute `qayaba.host.suspended_ms` |
| Heartbeat gap | The same timer: an expected 5 s tick that arrives N s late with no wall gap means a blocked loop, not a suspend | Distinguishes the two |
| Sandbox zombies | Count `<defunct>` processes of the sandbox uid in `/proc` every 60 s | Gauge `qayaba.sandbox.zombies` |
| Sandbox health | The existing `/api/health` sandbox status | Gauge per dimension (`isolation`, `egress`, `files`) |

**Spike S0.1 is mandatory before trusting the suspend signal.** On Docker Desktop for Mac, prove
that a lid-close produces a measurable wall-versus-monotonic gap inside the VM. If the guest wall
clock is not resynced promptly, fall back to comparing against the host's time over
`host.docker.internal`. This rests on a recollection, so it gets checked, not assumed.

---

## 8. Metrics, sampling and capture

### 8.1 Metrics (OTel SDK → collector → Prometheus in LGTM)

| Instrument | Type | Attributes (closed sets only) |
|---|---|---|
| `qayaba.runs` | counter | app, verdict, error_class, runtime, mode, furthest_phase |
| `qayaba.run.duration` | histogram s | app, verdict, mode |
| `qayaba.phase.duration` | histogram s | phase, app |
| `qayaba.budget.exhausted` | counter | limit, role |
| `qayaba.infra_errors` | counter | error_class, app |
| `qayaba.agent.steps` | histogram | role |
| `qayaba.agent.cost` | counter USD | role, model, app |
| `gen_ai.client.inference.duration` | histogram s | provider, model, error.type |
| `gen_ai.client.inference.usage.{input,output,cache_read.input,cache_write.input,reasoning.output}_tokens` | counter | provider, model, role |
| `gen_ai.invoke_agent.duration` / `.tool_calls` / `.inference_calls` | histogram | agent.name |
| `qayaba.provider.errors` | counter | provider, model, error.type |
| `qayaba.egress.denied` | counter | profile (never the host: hosts go on spans) |
| `qayaba.host.*`, `qayaba.sandbox.zombies` | see §7 | none |

The existing `/api/metrics` Prometheus endpoint stays as is. It has no OTel coupling.

**Histogram Views are declared explicitly.** The semconv advisory buckets stop around 82 s, which
makes p50/p95 meaningless for runs and phases lasting 60–9000 s. Run and phase durations use
`[1, 5, 15, 30, 60, 120, 300, 600, 1200, 2400, 3600, 5400, 9000]` s.

**Metrics are for dashboards only.** Every cross-run answer in Q12 (funnel, verdict mix, p50/p95,
tokens and cost per role) is computed **from the ledger and `run_outcomes`**. That way it exists
even when no collector ran.

### 8.2 Cardinality guard

Every instrument is declared in one table with its allowed attribute keys. A test fails when:
- an instrument is used with an undeclared key, or
- a key is in the denylist: `*.id`, `sha`, `url`, `path`, `selector`, `host`.

`app` and `model` are allowed because they are configured sets. `run.id` never is.

### 8.3 Sampling (D8)

- **Keep 100% at the source.** No `tail_sampling`.
- Runs last 25–150 min, and spans export on **end**, so the root arrives **last**. A
  `decision_wait` of 30 s decides on partial traces. Waiting longer than 150 min per trace in the
  collector is fragile.
- One run at a time keeps the volume small.
- Determinism across A/B arms is automatic: there is no sampler decision to differ.
- If volume ever matters, drop **content** (`captureMode`), not spans. Or decide at run end in-process
  and mark `qayaba.keep`, which needs no collector state.

### 8.4 Content capture

| `captureMode` | What leaves the process | Default |
|---|---|---|
| `off` | Structure only: names, timings, counts, ids. No hashes of content | — |
| `metadata` | Plus prompt and section **hashes and sizes**, tool targets (sanitized and capped, as `toolSequence` already does), error messages (redacted, capped at 1 KB) | **default** |
| `full` | Plus `gen_ai.input.messages`, `gen_ai.output.messages` and tool arguments/results, capped at 32 KB per attribute, redacted. Also mapped explicitly to `langfuse.observation.input/output`: Langfuse documents no mapping for the new `gen_ai.*.messages` keys | campaigns, on request |

The full text is **already** stored redacted in `agent_turns`. In `metadata` mode, the span carries
`qayaba.content.ref=agent_turn:<id>`. This is the spec's "store externally and reference" option.
Q3 and Q4 need no content at all; F3's "62k reasoning" replay needs `full`, or the reference.

---

## 9. Security and trust

### 9.1 Redaction (brief principle 6)

- **Redact when the attribute is created, with the run's scope bound explicitly.**
  - Ambient AsyncLocalStorage is not enough. The secret scope opens inside `RunQaUseCase.run`
    (`:497`), while the root span lives in the runner job around it. The tools-endpoint handler
    runs in the HTTP server's context, and the exporter runs in neither.
  - So each span handle carries the run's `RunSecretScope`, given at creation (root, phases,
    server spans). `setAttrs` and `addEvent` redact through **that** scope, not through `activeRunSecretScope()`.
- **Policy:** the outbound one (`src/orchestrator/sanitizer.ts`, `"issue"` mode, which includes
  by-value redaction). CLAUDE.md requires it for data leaving the system. It is applied **only to keys
  whose registry class is `redacted-text` or `content`**. Ids, hosts and enums are not run through
  PII and private-IP patterns, which would corrupt them.
- Span status descriptions and exception events are text too, so they get the same treatment.
- A test seeds the run scope with fake account, session-cookie and storage secrets. It asserts that
  none appears in any exported attribute, event, status, exception or link, in either sink.
- **Second layer:** the collector's `redaction` processor with the secret patterns, and the
  `attributes` processor deleting `gen_ai.*.messages` when a pipeline must be metadata-only.

### 9.2 Boundaries

- **Networks.** Today `docker-compose.yml` defines none, so every service shares the default
  network, and the agents container (including the generator's Playwright MCP browser) could reach
  any telemetry UI. The telemetry compose file adds:
  - `telemetry-internal` (`internal: true`), joined by the orchestrator, the collector, LGTM and Langfuse.
  - `agent-otlp`, joined **only** by the agents container and the collector, with the collector
    exposing a **separate receiver** (`:4319`) on it.
  - Every UI (Grafana, Langfuse) bound to `127.0.0.1` on the host. Grafana runs with anonymous
    access disabled.
- **Keys.** The orchestrator **does** hold the Langfuse public and secret keys, because the score
  sink (§11), score-config bootstrap and label import call the Langfuse API. They come from Doppler,
  are scrubbed from every sandbox env (they are not on any profile allowlist), and are never logged.
  The collector holds its own copy for OTLP ingestion. Neither key is ever in the agents container.
- **Sandbox uid.** It cannot reach the collector, and no change is made there.
- **Agent-emitted telemetry (D13).**
  - What the agents side emits (OpenCode AI SDK spans, Codex spans) is **untrusted**. A
    shell-capable agent holds the trace id, through `TRACEPARENT`, and could forge spans into the
    run's trace.
  - The `:4319` pipeline therefore deletes every `langfuse.*`, `qayaba.*` and content key, and
    inserts `qayaba.trust=agent`. It is a separate receiver, so the tag cannot be spoofed.
  - It is a viewing aid only. Graders, labels, the API and verdicts read the orchestrator-written ledger.
- **Capture ceiling.** `captureMode` from the API is capped by server config
  (`QA_TELEMETRY_MAX_CAPTURE`, default `metadata`). A caller with a token cannot turn `full` content
  export on by itself, because that would be an exfiltration lever. Within a campaign, all arms are
  forced to the same mode.
- **Codex env.** `TRACEPARENT`/`TRACESTATE` go into the **exact-name** allowlist
  `CODEX_EXEC_ENV_EXACT`, mirrored in `agents/agent-supervisor.mjs:29` and `codex-strategy.ts:165`.
  The prefix list would not match them.
- **No SaaS.** Codex `metrics_exporter="none"`. No exporter points outside the compose network.
- **Governance (own commits, per CLAUDE.md and the owner's one-branch rule):**
  - the compose networks and receiver split;
  - the `tools-endpoint` parser change (`messageID`);
  - the Codex env allowlist;
  - enabling OpenCode content export;
  - the capture ceiling.

### 9.3 Attribute registry

- `shared-kernel/telemetry/attribute-registry.ts` is a typed const. Each key records:
  - its type
  - a one-line meaning
  - the `cardinality` (`low|high`; metrics may use only low)
  - its `content` class: `none`, `redacted-text` or `content` (dropped below `full`)
- `docs/telemetry-attributes.md` is generated from it, and contract-checked like `openapi.json`.

---

## 10. Infrastructure (D10)

```yaml
# docker-compose.telemetry.yml  (opt-in: docker compose --profile telemetry up)
services:
  collector:   otel/opentelemetry-collector-contrib:0.163.0   # profile: telemetry
               receivers: otlp(http :4318)
               processors: memory_limiter, redaction, attributes, batch
               exporters: otlphttp/lgtm, otlphttp/langfuse (only with profile langfuse), file (rotating, debug)
  lgtm:        grafana/otel-lgtm:0.37.0     # profile: telemetry — Tempo + Prometheus + Grafana 127.0.0.1:3001, /data volume, anonymous off, Tempo retention = R4
  langfuse-*:  langfuse 4.x web + worker, postgres 17, clickhouse 25.12, redis 7, minio
               # profile: langfuse — follows Langfuse's own compose; ports bound to 127.0.0.1
```

- **Off by default.** Plain `docker compose up` is unchanged. The orchestrator gets
  `OTEL_EXPORTER_OTLP_ENDPOINT` only when the profile is used, via the override.
- **Langfuse ingestion:** `POST /api/public/otel/v1/traces`, HTTP only (no gRPC), Basic
  `pk:sk`, header `x-langfuse-ingestion-version: 4`. Without that header, ingestion can lag up to
  10 minutes. Langfuse **discards OTLP metrics**, so metrics go to LGTM only.
- **Cost in Langfuse:**
  - Send the provider-reported cost (`info.cost`) as `langfuse.observation.cost_details`.
  - Send token buckets as explicit `usage_details`, because Langfuse buckets are **exclusive** while
    OTel `input_tokens` is **inclusive**. Without this, cost is double-counted.
  - Cost attaches only to `generation` observations, so `chat` spans set
    `langfuse.observation.type=generation`.
- **Resources.** The Langfuse docs recommend 4 cores and 16 GiB. On the owner's Mac, Langfuse is
  for campaign review sessions, not always-on.
- **Score configs** are created idempotently at boot by the score sink (§11.3).

---

## 11. Evaluation: graders and scores (D12)

### 11.1 Model

```
qa-engine/src/contexts/evaluation/
  domain/       run-evidence.ts (read model), graders/*.ts (pure), score.ts, context-refs.ts (extraction)
  application/  grade-run.use-case.ts, regrade.use-case.ts, ports (EvidencePort, ScoreStorePort, ScoreSinkPort)
  infrastructure/ evidence.sqlite.adapter (run_outcomes + agent_turns + run_spans + specs),
                  score-store.sqlite.adapter (run_scores), langfuse-score-sink.adapter (fail-open)
```

- A grader is `(RunEvidence) → Score[]`. A `Score` has:
  - `name`, `value`, `dataType` (`NUMERIC|BOOLEAN|CATEGORICAL`)
  - `source` (`deterministic|llm_judge|human`)
  - `graderVersion`, `comment?`, `observationId?` (the span id)
- **When it runs.** After a run's root ends, **off the queue path**: a background job that never
  delays the next run. It can also be triggered by `regrade`.
- **Idempotent.** The store key is `(runId, name, graderVersion)`. The Langfuse score id is
  `sha256(runId:name:graderVersion)`, with timestamp = run end. Langfuse needs id, name and date to
  match before it replaces a score.
- The read model is named `RunEvaluationEvidence`, because `RunEvidence` already exists in
  `run-decision.service.ts`.
- **Spec snapshots make retroactive grading possible.**
  - The `specs` table stores only `name`, `objective` and `flow` (`history.ts:198`). The mirror is
    wiped on every checkout, and the suite store keeps only accepted suites.
  - So the validate phase writes a **per-run snapshot of every delivered spec**: path, sha256 and
    the redacted text, capped at 64 KB per spec, into `run_spec_snapshots`.
  - It has the ledger's retention. Without it, nothing can re-grade an invalid or failed run (F10).
- **Referenced-id extraction** (`context-refs.ts`, pure). Each source is declared **extractable or
  not**, and non-extractable sources report `n/a`, never 0:

  | Source | Extractable from | Notes |
  |---|---|---|
  | `route:` | `goto`/URL literals, navigation tool targets | |
  | `dom:` | `getByTestId`, plus `getByRole(role, {name})` matched to the capture's role/name | |
  | `op:` | contract paths in `waitForResponse`/URL literals | rare under the UI-only policy; low recall is expected |
  | `file:` | read tool-call targets | reported separately as `prompt_provided_reread`, a **waste** signal, not as use |
  | `brief:`, `rule:`, `fact:`, `exemplar:` | **not extractable** | `n/a`. Exemplar tags in the manifest are agent self-report (brief §3 forbids that); brief-claim hashes are not stable across runs |
- **`context_utilization` measures recall over change-relevant items**: items tied to the diff's
  ranked routes, not every provided test id. Hundreds of incidental ids would otherwise push the
  ratio toward 0.

### 11.2 Deterministic graders (first)

| Name | Type | Definition (precise) | Note |
|---|---|---|---|
| `empty_output_guard` | BOOLEAN | FAIL if `decision=pr` or `isAccepted` with `specs.valid=0`, or with no reviewer turn when review is required | **Already an invariant** ("approved is never a no-op"; zero specs → `E-NO-DECISION`). The grader is a regression tripwire. A product gate is added **only if** the grader ever fails on real data. That would be a governance change in its own commit |
| `furthest_phase` | CATEGORICAL | The last phase entered | The F1 funnel |
| `spec_validity_rate` | NUMERIC 0..1 | valid / generated | |
| `spec_pass_rate` | NUMERIC 0..1 | passed / valid; absent when valid=0 | |
| `selector_stability` | NUMERIC 0..1 | 1 − strict-mode failures / failures; comment lists the match counts | F10 |
| `budget_exhaustion` | CATEGORICAL | `none` or `<limit>@<phase>/<role>/<intent>` | |
| `step_intent_mix` | NUMERIC per intent (`step_intent_mix.<intent>`) | Share of steps per intent: `auth\|explore\|write_spec\|run_spec\|review\|other` | Classified from the step's tool calls by a pure rule table **fed by config, never by names**. A write under the app's `specRelDir` → write_spec (so code-target runs classify correctly). Navigation to the app's **declared** login URL or origin, or a read of `auth.setup.ts` → auth. OpenCode only: Codex has no steps, so this is `n/a` for it |
| `auth_overhead` | NUMERIC 0..1 | auth steps / steps | `n/a` for Codex |
| `approval_consistent` | BOOLEAN | `false` when accepted while a deterministic signal said no: coverage `fail` under `enforce`, catalog gate fail-closed, or static failure | B6 |
| `context_utilization` | NUMERIC 0..1, per source and overall | \|referenced ∩ provided\| / \|provided\|; comment lists referenced-but-not-provided ids | Brief §3 |
| `context_complete` | BOOLEAN | `true` when no source was truncated; comment lists what was lost | |
| `noop_consistent` | BOOLEAN | `false` when a no-op declared `unobservable` while the pack facts show the changed element **present**, or the reverse | Q10, F4 |
| `change_coverage` | CATEGORICAL | `pass\|fail\|unknown` (unknown is its own class, never pass) | Existing signal |
| `mutation_value` | NUMERIC | Killed / mutants, when the oracle ran | Existing |
| `infra_error` | CATEGORICAL | `error_class` × sub-cause (deploy-unverified, egress-denied, quota, suspend, sandbox…) | |
| `cost_per_useful_spec` | NUMERIC USD | cost / useful specs. **Useful** = valid ∧ passed on the run ∧ passed on the campaign's no-retry re-run ∧ (killed ≥ 1 mutant when the oracle ran) | Absent outside campaigns that do the re-run |

### 11.3 LLM-as-judge and human labels (last)

These follow Hamel Husain's evals practice.
- **Error analysis first.** Open-code 30 or more real traces before writing any judge.
- **Binary pass/fail plus a critique.** One judge per failure mode.
- **The judge runs on a different provider or model** than the generator. Its model and prompt
  version are recorded on the score.
- **Judges share the provider quota** (F7). So they run **on the sequential queue**, as a
  low-priority job kind, never concurrently with a run. They draw on a per-day token budget.
- The judge is a new tool-less role, `qa-judge`, in `agents/opencode.json`. Its `tools` deny
  everything, so it carries no `read` block (per the credentials invariant). Its prompt lives in
  `agents/agent/qa-judge.md`, versioned.
- **Calibrate** against human labels on a train/dev/test split and report TPR and TNR.
  Uncalibrated judges are `experimental` and gate nothing.
- **Human labels** use Langfuse annotation queues (OSS). Imported labels are stored as
  `source=human` in `run_scores`, so calibration does not depend on Langfuse being up.
- First judges: `spec_relevance` and `failure_root_cause`.

---

## 12. Evals and campaigns

- **Trigger.** `POST /api/v1/runs` accepts `campaign {id, variant: Record<string,string>, replicate}` and `captureMode`.
  - These are persisted on the run, which closes the "campaign identity is client-side only" gap.
  - `scripts/campaign.ts` sends them. `QA_CAMPAIGN_FREEZE` is still required.
- **Dataset.** `config/benchmarks/datasets/<name>@<version>.json`: items `(app, sha, description, expected labels?)`.
  - Seeded from real failures: the F-catalog runs and `reference-cases.json`.
  - Versioned by file name.
- **Replicates.** N ≥ 3 per item and variant. Comparison reports mean ± a bootstrap 95% CI per
  grader, plus the difference against the baseline arm with its CI. A single-run difference is never
  reported as a lift.
- **KPIs** derived from scores:
  - useful-spec yield per run
  - cost per useful spec
  - time to verdict
  - false-approval rate (accepted ∧ human-labeled bad)
  - infra-error rate
  - real-bug catch rate
  - per-feature lift
- **Known confound.** engram is not isolated between replicates (context §6). The campaign report
  states this until it is fixed.

---

## 13. Acceptance: question → evidence

| Question (source) | Answered by |
|---|---|
| Phase time, and which limit ended it (C1, B1–2) | phase spans; `qayaba.limit.applied/fired` on turns and root |
| Suspend or blocked loop, and for how long (C2) | `host_suspended` / `event_loop_blocked` events; `qayaba.host.suspended_ms` |
| Time to first call, reasoning before it, the model that answered (C3) | turn attrs `ms_to_first_call`, `reasoning_tokens_before_first_call`, `gen_ai.response.model`, `fallback_used` |
| Same prompt? Which sections? (C4) | `qayaba.prompt.hash`, `section.<id>.hash/bytes` |
| Provider errors, retries, title calls (C5) | `error.type` on turns; `qayaba.provider.errors`; OpenCode AI SDK spans (§5.7, correlated) |
| Egress denials in login and in each execution (C6) | `qayaba.egress.denied` on `auth.login` and `exec` spans |
| Suite store actions and why (C7) | `suite_store.restore/capture` spans; `auth.demoted` with reason |
| DOM capture per route, changed element present (C8) | `context.dom-capture` route events; `fact:` ids |
| Tool calls by family, prompt-provided reads, wasted navigations (C9) | `calls.<bucket>`, `reads.prompt_provided`; `execute_tool` status/HTTP status (F9) |
| No-op kind versus pack facts (C10) | `noop_kind`; `noop_consistent` grader |
| Sidekicks: steps, calls, writes, lease wait, escalation (C11) | sidekick `invoke_agent` under `qayaba.fanout` (overlap visible); `lease.wait_ms`; escalation events |
| Funnel, verdict mix, p50/p95, tokens and cost per role, schema share (C12) | metrics §8.1; `tools_offered.bytes / prompt.bytes` |
| Context provided versus used (B3–4) | `context.*` spans and the `context_utilization` grader |
| Why a spec failed (B5) | `qayaba.test` failure category, `strict_mode_violation` events |
| Verdict trustworthy (B6) | `empty_output_guard`, `reviewer.turn_happened` |
| Feature lift beyond noise (B7) | §12 comparison with CI |
| Cost of a useful spec (B8) | `cost_per_useful_spec` |

**Reconciliation test.** For a set of recorded runs, `probe-report` computed from `run_spans` must
match today's SQLite-derived report on phases, turns, tokens and cost, within the rounding of event
ingest times.

---

## 14. Public contract (brief §10)

- **Base URL:** `http://<host>:458/api/v1`, with `PORT` default 458.
- **Auth:** `Authorization: Bearer <QA_API_TOKEN or session JWT>`.
- **Versioning:** each response carries `schemaVersion: 1`. A breaking change means version 2.
- **Source of truth:** the zod schemas in `qa-engine/src/shared-kernel/contract/`. Regenerate
  `contract/openapi.json` and the SDK, which `contract:check` enforces.

**Every JSON response of the endpoints below carries `schemaVersion: 1`**: 2xx bodies and their
4xx/5xx error bodies (`{schemaVersion, error}`). That includes `POST /runs`.

| # | Endpoint | Shape (summary) |
|---|---|---|
| 1 | `POST /runs` (extended) | Adds `campaign?: {id, variant: Record<string,string>, replicate: int≥1}` and `captureMode?: off\|metadata\|full` to the zod `CreateRunInputSchema`, and so to `openapi.json`. Returns 202 `{schemaVersion, id, …, status:"enqueued"}` |
| 2 | `GET /runs/:id` (extended) | Adds `telemetry: {traceId, traceUrl?} \| null`, `campaign?`, `phases: [{name, durationMs}]` (in canonical order), `furthestPhase`, `usage: {inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, costUsd}`, `specCounts: {generated, valid, passed}`, `decision`, `budgets: {exhausted: bool, limit?, role?}` and `effectiveConfig` (below) |
| 3 | `GET /runs/:id/evaluation[?versions=all]` | `{schemaVersion, runId, traceId, status: "pending"\|"complete"\|"failed", scores: [{name, value, dataType, polarity, source, graderVersion, comment?, observationId?}]}`. By default only the **latest `graderVersion` per name** is returned; `?versions=all` returns every stored version |
| 4 | `GET /campaigns/:id/runs?variant.<k>=<v>` | `{schemaVersion, campaignId, runs: [{id, variant, replicate, status, verdict?, evaluationStatus}], complete: bool}` |
| 5 | `POST /evaluations/regrade` | Body `{runIds?\|campaignId?\|since?, graders?: string[]}`. Returns 202 `{schemaVersion, jobId, runs: n}` |
| 5b | `GET /evaluations/regrade/:jobId` | `{schemaVersion, jobId, status: "pending"\|"running"\|"complete"\|"failed", runs: n, graded: n, failed: [{runId, error}], startedAt, finishedAt?}` |
| 6 | `GET /evaluations/catalog` | `{schemaVersion, phases: string[]` (canonical `RUN_PHASES` order)`, scores: [{name, dataType, polarity, range?, categories?, suffixes?, graderVersion}]}`. The machine-readable source of phase order and score polarity |
| 7 | `GET /telemetry/health` | `{schemaVersion, mode: off\|local, campaignFreeze: bool, otlp: {configured, lastExportAt?, lastError?, dropped}, ledger: {ok, spans}, scoreSink: {configured, lastError?}}`. Also summarized under `/api/health.telemetry` |

**Facts the graders read.** A grader only reads what the run recorded. Facts the engine decides at run time are stored on the run and never recomputed from the app's current configuration: `review_required`, `coverage_status` (pass|fail|unknown as the objective-signal service decided), `coverage_mode`, `coverage_min_ratio`, `decision`, `limit_fired`/`limit_role`, `trace_id`, `cancelled`, and each case's spec `file`. Where a fact is missing the score is omitted (`change_coverage` is `unknown` only when the engine recorded `unknown`; `infra_error` exists only for `infra-error` runs, `unclassified` when no class was recorded, and `cancelled` for cancels):
- `specCounts.valid` is **null** until the run got past the `validate` phase (validation gates the whole suite); an `invalid` run has `valid = 0`. `specCounts.passed` is null when `valid` is unknown or a delivered spec cannot be tied to its cases by exact spec path (a run-level `pass` implies all passed).
- `spec_pass_rate` exists only for a run that reached `execute` with a `pass|fail|flaky` verdict and a known `passed`.
- `empty_output_guard` emits nothing when validity, `review_required` or the reviewer history is unknown.
- A cancelled run is graded `infra_error = cancelled` and nothing else.
- `budget_exhaustion` is `<limit>@<phase>/<role>/<intent>`; any segment the run did not record is `unknown`.
- A regrade deletes the run's rows it supersedes in the same transaction (all rows of the current `graderVersion`, or only the named base names with their suffixes), so a name no grader emits any more disappears. A failed regrade never turns a `complete` evaluation into `failed`; the failure is listed on the job.
- Regrade bounds: `since` must be ISO-8601; at most 500 runs per job (and 500 `runIds`); progress is written every 10 runs; a grader that is declared but not graded yet is refused with 400 naming it; an unknown run id is listed in the job's `failed` as `unknown run`; job errors are redacted and capped at 500 chars, and score comments are capped at 500 chars.

**Name deviation.** The counts are `specCounts`, not `specs`: `specs` already exists on `RunRecord` as the list of delivered specs (`SpecRecord[]`, read by the TUI), and a field cannot be both. Everything else in row 2 is additive.

**Contract rules:**
- **Variant labels never change behaviour.** `campaign.variant` is stored and echoed as data. The
  engine never reads it, because a label that silently switched behaviour would be hidden coupling.
  What makes an arm behave differently is **only** the explicit request levers (`closedLoop`,
  `agentBrowser`, `coordinationMode`, `captureMode`) and the deployment's config.
  - Every run returns `effectiveConfig`: the levers actually applied, the agent models per role,
    `prompt.static_hash`, the stitcher, structural-signal, explorer and curriculum settings, and
    `campaignFreeze`.
  - A consumer verifies that its arms really differed by comparing `effectiveConfig`, not labels.
  - Exact shape. Every key is always present; a setting that does not apply is `null`:
    ```json
    "effectiveConfig": {
      "levers": { "closedLoop": true, "agentBrowser": false, "coordinationMode": "single", "captureMode": "metadata" },
      "campaignFreeze": true,
      "runtime": "opencode",
      "agents": {
        "qa-generator": { "provider": "opencode-go", "model": "glm-5.3-flash", "reasoningEffort": "low", "stepLimit": 50 },
        "qa-reviewer":  { "provider": "opencode-go", "model": "minimax-m3", "reasoningEffort": null, "stepLimit": 25 }
      },
      "prompt": { "staticHash": "sha256:…" },
      "grounding": { "explorer": true, "stitcher": "signal", "structuralSignal": "signal", "curriculum": "frozen" },
      "coverage": { "mode": "signal", "minRatio": 0.7 },
      "reflector": false
    }
    ```
    `agents` lists only the roles the run actually invoked. Each entry is the resolved value read
    live from the runtime, not the repo copy of the config.
  - Model and prompt-version variants are config changes, made between arms. They are not request fields.
- **`captureMode`** is capped by the server's `QA_TELEMETRY_MAX_CAPTURE` (§9.2). The applied value
  is in `effectiveConfig`.
- **`telemetry`** is `null` only when `QA_TELEMETRY=off`. In `local` mode `traceId` is always
  present: the ledger mints it whether or not an exporter is configured. `traceUrl` is present only
  when `QA_TRACE_URL_TEMPLATE` is set (a Grafana or Langfuse URL containing `{traceId}`).
- **Score polarity.** Every score carries `polarity: higher_better | lower_better | none`.
  - Every BOOLEAN score is pass-oriented: `true` means the check passed and the problem is absent.
  - Score names, types, ranges and polarities are those of §11.2 and `/evaluations/catalog`. They
    are frozen per `graderVersion`. Comparing scores across different `graderVersion`s is invalid.
  - **Expanded names.** The catalog lists only **base** names. A family entry also declares its
    closed set of `suffixes`:
    - `context_utilization`: `route`, `dom`, `op`, `file`
    - `step_intent_mix`: `auth`, `explore`, `write_spec`, `run_spec`, `review`, `other`

    A score named `<base>.<suffix>` inherits its base's `dataType`, `polarity`, `range` and
    `graderVersion`. The bare base name (`context_utilization`) is the overall value.

| Score | Polarity |
|---|---|
| `spec_validity_rate`, `spec_pass_rate`, `selector_stability`, `context_utilization[.<source>]`, `mutation_value` | higher_better |
| `empty_output_guard`, `approval_consistent`, `context_complete`, `noop_consistent` (BOOLEAN, `true` = pass) | higher_better |
| `auth_overhead`, `cost_per_useful_spec` | lower_better |
| `furthest_phase` (ordinal by `phases`), `budget_exhaustion` (`none` is the clean value), `change_coverage` (`unknown` is its own class), `infra_error`, `step_intent_mix.<intent>` | none |

- **Dataset items.** `description` is metadata only and is never sent to a run. An item that needs
  focused guidance declares an explicit `guidance` and runs in `manual` mode.
- **Campaign tooling.** The canonical consumer for pipeline-variant A/B is the external control
  plane, through this API. `scripts/campaign.ts` remains for the plain-agent baseline arm
  (`baseline-agent`), which has no API surface. When it triggers pipeline runs, it sends the same
  `campaign` fields.

---

## 15. Testing strategy (tests first, `docs/testing-standards.md`)

| Test | Seam |
|---|---|
| Tree shape of a full run: root, phases, turns, tools; one connected tree; no orphans | `RunQaUseCase` with fakes plus a real `TelemetryPort` over `InMemorySpanExporter` |
| Every span ended on success, throw, `RunDeadlineExceededError`, abort and cancel | same, parameterized over exits |
| Concurrency: sidekick spans parented to `qayaba.fanout`, overlapping; merge links | `FanOutDispatcher` with fake timers |
| Queue link: the run root links to the enqueue span | `enqueueTrackedRun` with the fake queue |
| Session join: a `run_spec` server span is a child of the bound attempt span | `tools-endpoint` handler plus the registry |
| Synthesis: tool spans from SSE fixtures carry `state.time`; step spans are marked receive-time | tracker over recorded SSE fixtures |
| Registry compliance and redaction (seeded fake secrets absent everywhere) | exporter assertions |
| Cardinality guard | instrument table |
| Disabled: `QA_TELEMETRY=off` → no spans, no ledger rows, the same verdict | composition |
| Failing exporter: throws or hangs → the run completes with the same verdict within its budget | exporter double |
| Host health: a wall jump with flat monotonic time → `host_suspended`; a late tick with no wall jump → blocked | injected clocks (no real time) |
| Graders on fixture evidence, including the F-catalog cases | pure functions |
| Reconciliation with `probe-report` | fixture DB |
| Cross-boundary: Codex child spans parent to the attempt (if S0.3 passes) | an in-container smoke, like the existing `agents/smoke/*` |
| Overhead: a representative run in `off` versus `metadata` versus `full`, reported, not gated | a script, like `efficiency-benchmark` |

Mutation presets are added for the pure modules: graders, `context-refs`, the failure classifier,
the step-intent classifier and host-health detection.

---

## 16. Delivery plan

The order is driven by the context doc's priority: **diagnose the seams first**, evaluate second.
Each slice is a reviewable unit of commits on the current branch. Governance-sensitive pieces are
their own commits.

| Slice | Content | Unblocks |
|---|---|---|
| **S0 Spikes** (no product code) | S0.1 suspend detection inside Docker Desktop; S0.2 OpenCode 1.17.7 export, and whether an inbound `traceparent` parents its spans (Effect server tracer); S0.3 a live smoke of the Codex `TRACEPARENT` hop through the supervisor; S0.4 that the reconstructed tool set matches what the model received; S0.5 Langfuse v4 mapping of our attributes, checked on a real instance | Removes the remaining unverified assumptions |
| **S1a Phase cursor** (engine only, no SDK) | Phase cursor; `phaseTimings` and `furthestPhase` persisted on `run_outcomes`; funnel query over `run_outcomes` | F1 and the north star, with no telemetry stack |
| **S1b SDK and ledger** | Port, registry, semconv module, injected clock, no-op; SDK adapter with manual env mapping; buffered ledger with rows on start; root on `ROOT_CONTEXT` plus queue link; phase spans from the cursor; exec spans; scoped redaction; `/telemetry/health`; tests (tree, ended spans, throwing port, secrets, cardinality, disabled) | C1 (partial) |
| **S1c Host health** (after S0.1) | Heartbeat, event-loop delay, zombies, sandbox gauges | F2, F11, F12, C2 |
| **S1d Compose** (governance commit) | `telemetry` profile, networks, receiver split, 127.0.0.1 binds, Grafana auth | Local viewing |
| **S2-pre Explorer watchdog** (root-cause commit) | Fix the starved explorer watchdog (§5.4.3), with a test | A correct baseline for S2 |
| **S2 Agent turns** | Facade turn spans; `onAttempt` hook; Codex spans and usage; tracker `state.time` plus per-step records; model answered; error classes; per-layer limits; section hashes over the bytes sent; explorer tracking (opt-in, parity test); `run_spec`/`authbrowser` server spans via `withParent` with lease wait; Codex native spans (S0.3) | F3, F4, F7, F8, F9, F13, F14, F15, C3–C5, C9, C11 |
| **S3 Grounding and execution** | Context spans and item ids; login attempts; suite-store spans; validation and test spans; failure classifier (pinned to Playwright 1.60 message fixtures); **spec snapshots** | F5, F6, F10, F16, C6, C7, C10 |
| **S3b DOM capture per route** | The capture script reports per-route timing and state (its output changes) | C8, F11 |
| **S4 Evaluation** | `evaluation` context; deterministic graders; `run_scores`; API #2–#6 | B3–B6, B8 |
| **S4b Langfuse** | `langfuse` profile, score sink, score configs, usage/cost mapping | Eval UI |
| **S2b OpenCode native spans** (deferred, after S0.2) | Option A behind the content-dropping receiver | F7/F8 detail, title calls |
| **S5 Campaigns** | Trigger metadata (API #1), datasets, replicate comparison report | B7 |
| **S6 Judges** | Annotation queues, human-label import, LLM judges, calibration | Trusted LLM scores |

**S2a status (OpenCode agent turns).** Delivered: the `invoke_agent` / `qayaba.agent.attempt` / synthesized `chat` and
`execute_tool` tree at the `AgentDeps` facade (`generation/infrastructure/telemetry/`), the `onAttempt` hook, per-layer limit
names (`AgentPromptOpts.timeLimit`, the stall watchdog's `onStall`), the error classifier, section and prompt hashes over the bytes
sent (a new `metadata` content class: exported in `metadata` and `full`, never in `off`), the `agent_turns` columns (read back
through `getAgentTurnTraces`, not through the public turn view) and the turn metrics. Not in S2a: Codex attempts and usage
(S2c), explorer tracking (S2c), the verdict-shape attributes (`qayaba.agent.verdict.*`: the verdict is parsed above the facade),
`run_spec`/`authbrowser` server spans, tool schema bytes (§5.6), and the S3 attributes of W16 (`context.item_ids.referenced`,
`selector.strategy`). Reasoning effort and the configured model are read from the orchestrator's copy of `agents/opencode.json`
(what is configured, not what the server proved it used; the model that answered comes from the answer). OpenCode's
`tokens.input` is read as excluding the cache and `tokens.output` as including reasoning; both stay unconfirmed against its source
until spike S0.4, and live in one function (`normalizeOpenCodeUsage`).

**S2b status (tool callbacks).** Delivered: the registry lookup `sessionId -> live attempt span` (`AgentTurnTraces.attemptSpan`), the
`qayaba.tool.run_spec` / `qayaba.tool.authbrowser` SERVER spans opened inside `inRunContext` with the attempt as explicit parent
(`bridges/tool-call-trace.ts`), and a scope whose child-parent is the call's span (`withExecScopeParent`), so the launcher's
`qayaba.exec` spans are grandchildren of the attempt. Lease wait, namespace, spec path and sha256, outcome, refusal code, DEV-busy,
co-temporal egress denials, browser action, guard block reasons, document status and session invalidation are attributes; no secret
and no page content. The synthesized `execute_tool run_spec|authbrowser_*` span carries a span LINK to the server span, matched by
session, tool, message id (when both sides carry it) and time overlap (`generation/domain/tool-link.ts`, pure); a match that cannot
be made without a guess is not made. The attempt-to-tool-span edge is **connected** (parent/child); the tool-span-to-agent
`execute_tool` edge is a **link** (correlated by the join above, not by propagated context).

**S2c status (Codex parity, explorer tracking).** Delivered: the supervisor returns `{message, usage}` from the `turn.completed` events
of `codex exec --json` (`extractCodexUsage`, summed, a field that is not a plain count read as none), the direct and the supervised
transport hand it to the strategy through `onUsage`, and `CodexRuntimeStrategy` opens the same attempt events the OpenCode funnel does
(`start`, `end`, `turn` into the registry the turn decorator fills), so a Codex prompt is `invoke_agent` plus `qayaba.agent.attempt`
with `qayaba.usage.source=final-message`. Codex's input is inclusive of its cache and OpenCode's is not; the strategy puts Codex's
usage in OpenCode's shape (`codexUsageAsRuntime`) so the one normalization serves both and the persisted row holds one convention.
Cost and cache writes are not reported by Codex and are left absent, never zero. `error.type` comes from `classifyCodexFault`, which
reads the same signals as `codexErrorToInfra` from the exec's own text. The explorer's session can be observed without being watched
(`descriptor.observeUnwatched`, set by the host through `QA_TELEMETRY_OBSERVE_UNWATCHED=true`, **off by default**): its calls reach the
call tracker, it is not registered for the live feed, never feeds a watchdog and its attempts never wait for the stream; a parity test
runs the same explorer turn with tracking on and off.

**Codex native spans (S0.3 status).** Wired, not yet proven live: the orchestrator sends the attempt's `traceparent` as a header on
`POST /codex/exec` (only when the attempt span is real), the supervisor validates it and gives the child `TRACEPARENT`/`TRACESTATE`
(both names are in the exact-name allowlist of the supervisor and of the orchestrator's builder, pinned equal by a test; an ambient value
in either process is dropped), and `QA_AGENT_OTLP_ENDPOINT` (set only in `docker-compose.telemetry.yml`) makes the supervisor write
an `[otel]` table with `trace_exporter = otlp-http`, `exporter = "none"`, `metrics_exporter = "none"` and `log_user_prompt = false`.
Whether Codex 0.139.0 parents its spans on the environment's `TRACEPARENT` and exports them to the untrusted receiver is the
S0.3 smoke; until it runs, Codex spans are neither connected nor correlated by anything but the trace id the header carries.

---

## 17. Resolved decisions

The owner delegated these on 2026-10-17. Each is resolved by the project's own priorities: stable,
reliable, deterministic; trust over features; local operability on a Mac.

| # | Decision | Resolution | Why |
|---|---|---|---|
| R1 | Is the local ledger on by default? | **Yes.** `QA_TELEMETRY=local` is the default. `off` is the opt-out and the overhead baseline. | Retroactive graders and the public API must work when no collector ran. That matches the brief's own principle 8, which outranks the "zero overhead" wording of principle 2. Network stays at zero without an endpoint. The ledger write is one synchronous SQLite insert per span, on a sequential queue. |
| R2 | Which viewer is the default? | **`telemetry` profile = collector + LGTM.** `langfuse` is a second profile that adds Langfuse to the same collector. | LGTM is one container and answers the diagnostic questions (C1–C12) with traces and metrics. Langfuse carries the eval workflow (scores UI, annotation queues, datasets), but needs about 6 containers and 16 GiB. Scores never depend on it (D12), so turning it on later loses nothing. |
| R3 | Does `empty_output_guard` gate? | **Grader only.** It becomes a gate only if it ever fails on real data, and then as a governance-sensitive change in its own commit. | The invariant already exists (no-op → `skipped`, zero specs → `E-NO-DECISION`, "approved is never a no-op"). A second gate on the same condition adds a path that can disagree with the first, and CLAUDE.md rules out piling up LLM-free gates without evidence. |
| R5 | Do we upgrade OpenCode (1.17.7 → 1.19.3) or Codex (0.139.0 → 0.163.0) for better telemetry? | **No.** The telemetry components (OTel JS 2.12 / 0.223, Collector 0.163.0, otel-lgtm 0.37.0, Langfuse 4.63.0) are adopted at their latest versions. | A source diff of both tags found no telemetry gain in OpenCode: the same `ai` 6.0.168, the same `experimental.openTelemetry`, no step timestamps, the same tool-list API, no trace context in `ToolContext`. Codex 0.139.0 already has `TRACEPARENT`, OTLP traces and per-turn usage; 0.163.0 only adds `cache_write` tokens. Moving a pin costs a re-recorded agent-list fixture, re-run smokes and new behaviour risk on the execution path, for no telemetry gain. Revisit when either runtime ships GenAI semconv or step timestamps. |
| R4 | How long are records kept? | **`run_spans` 30 days, like `agent_turns`. Campaign-tagged runs keep both for 180 days.** `QA_TELEMETRY_RETENTION_DAYS` and `QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS` override them. `run_scores` are never pruned (they are tiny). | Campaign runs are the eval baselines that later graders and judges re-score (principle 8). Ordinary runs are diagnostic and lose value fast. |

## 18. Adversarial review resolution (2026-10-17)

An independent reviewer (fresh context) returned **APPROVE-WITH-CHANGES**, with 8 critical
findings, 16 warnings and 11 suggestions. The load-bearing claims were re-verified in code
(`AsyncLocalStorage.snapshot()` in the run_spec and browser bridges, the watchdog wrapping the
explorer, `tail.then` inside `enqueue`, the `specs` table schema). Body sections were edited in place.

| Finding | Resolution | Where |
|---|---|---|
| C1 snapshot context breaks D6 parenting | `withParent` inside `inRunContext`, plus a grandchild test | §3.1, §5.5 |
| C2 mixed clocks across a suspend | D14: explicit wall-clock times from an injected clock | §0, §3.1 |
| C3 turn decorator at the wrong layer; Codex bypasses it | Facade turn span, `onAttempt` hook, Codex instrumented, per-layer limits | §5.2 |
| C4 explorer watchdog starved; tracking not neutral | A root-cause fix first (S2-pre); opt-in tracking with a parity test | §5.4, §16 |
| C5 security claims (keys, networks, agent spans, UIs) | Networks, receiver split, key ownership stated, 127.0.0.1, governance list | §9.2, §10 |
| C6 OpenCode content export bypasses capture and redaction | Off by default; agent pipeline deletes `ai.*` content; deferred | §5.7 |
| C7 retroactive grading lacks spec text | `run_spec_snapshots` | §11.1 |
| C8 redaction holes, wrong policy | Scope bound to handles, issue policy, by registry class | §9.1 |
| W1 queue inherits the enqueue context | Root on `ROOT_CONTEXT` | §4.1 |
| W2 phase closures, crash-lost funnel, hung runs invisible | Phase cursor, persisted on `run_outcomes`, ledger rows on start | §4.2, §3.3 |
| W3 synchronous ledger cost | Buffered transactions, `synchronous=NORMAL` | §3.3 |
| W4 duplicate stores, retention | Agent-turn fields: **columns on `agent_turns` are the record**; spans mirror them. The prune at `history.ts:462-472` becomes campaign-aware per R4 | §5.4, §17 |
| W5 abandoned fan-out flows | The flow span ends on `TIMED_OUT`; added to the ended-span matrix | §15 |
| W6 egress attribution | Renamed co-temporal | §6.1 |
| W7 context utilization validity | Extractable vs n/a per source; recall over change-relevant items; no self-report | §11.1 |
| W8 step intent via names | Config-fed rules; `specRelDir`; n/a for Codex | §11.2 |
| W9 wasted navigations | An in-process classifier over Playwright MCP tool output emits `qayaba.nav.outcome` (`ok\|auth_challenge\|http_error\|blocked\|unknown`) in every capture mode | §5.3 (S2) |
| W10 per-route capture timing missing | Its own slice, S3b | §16 |
| W11 MCP tools are not in `/experimental/tool` | S0.4 must check MCP tools. Where they are missing, `tools_offered.source=estimated` covers registry tools only, and the gap is stated | §5.6 |
| W12 token semantics, Langfuse double cost | Per-runtime normalization to semconv (inclusive) in the mapping module; Langfuse gets exclusive `usage_details`; `invoke_agent` and root set `langfuse.observation.type` (agent/span) and keep sums under `qayaba.usage.*` | §5.1, §10 |
| W13 histogram buckets, Q12 without a collector | Explicit Views; Q12 from the ledger | §8.1 |
| W14 judges and the quota | On the queue, budgeted, tool-less `qa-judge` role | §11.3 |
| W15 governance list, Codex env name | Completed; `CODEX_EXEC_ENV_EXACT` | §9.2 |
| W16 dropped requirements | `chat` spans carry `qayaba.agent.step`, `qayaba.step.intent` and `qayaba.agent.step_budget.remaining`. `execute_tool` spans that write or run a spec carry `qayaba.context.item_ids.referenced`. Spec spans carry `qayaba.selector.strategy` (`testid\|role\|text\|css`, parsed from the locator). The root records the effective explorer, stitcher, structural-signal and curriculum flags. Turns record `qayaba.prompt.budget_bytes` vs `.bytes`. `approved_against_signals` grader added. Tests add required-attributes and a real `run_spec` hop smoke. `--target code` runs use the same tree, with `qayaba.phase.execute` holding one `qayaba.exec code-test` and no per-case spans. `specs.valid` = specs delivered **by this run** that passed validation | §4–§6, §11, §15 |
| S1 BSP env vars ignored without NodeSDK | Manual mapping | §3.3 |
| S2 `ToolContext.callID` | Checked live in S0.2. If present at runtime, it replaces the messageID plus time-overlap join | §5.5 |
| S3 hash over the bytes sent; stale static hash | `prompt.hash` over the bytes sent after redaction and the Codex preamble. `static_hash` read from the agents side | §5.3 |
| S4 template keys; never throw | Done | §3.1 |
| S5 suspend fallback clock | The fallback uses the HTTP `Date` header of an outbound call from the root process, not `host.docker.internal` | §7 |
| S6 Langfuse trace attrs on the late root | `langfuse.trace.*` is also set on the first exported span of the run. Tempo and Langfuse retention follow R4 | §4.3, §10 |
| S7 contract gaps | Per-source and per-intent score names are `<grader>.<source\|intent>`. A campaign is `complete` when every requested (item × variant × replicate) has a `done` run and `evaluationStatus=complete`. `GET /evaluations/regrade/:jobId` reports regrade status. With `QA_TELEMETRY=off`, `telemetry` is `null` and `phases` still comes from `run_outcomes` | §14 |
| S8 simplify | Adopted: the funnel ships first from `run_outcomes` (S1a); Langfuse is split into S4b; Option A deferred; same capture mode across arms | §16 |
| S9 split S1 | Done | §16 |
| S10 `RunEvidence` name clash | Renamed | §11.1 |
| S11 the classifier pinned to Playwright messages | Fixtures, plus an entry in the "when Playwright moves" checklist | §6.2 |

**One deviation, approved by the owner on 2026-10-17.** The brief states that `empty_output_guard`
MUST also be a product gate. R3 keeps it a grader, because the invariant already exists:
- `accept-delivered-specs` turns zero specs into `skipped`;
- `decide()` returns `none` when nothing was generated;
- a run with zero specs and no declared no-op ends `E-NO-DECISION`.

A gate is added, as a governance-sensitive commit of its own, only if the grader ever fails on real
data. This is the one place the design overrides an input document. Everything else complies with
both.

## 19. Known gaps (stated, not hidden)

- `chat` (step) spans have **receive-time** timestamps. OpenCode 1.17.7 step parts carry none.
- OpenCode's own spans (title calls, provider retries) are connected only if S0.2 proves that
  Effect's server tracer parents them. Otherwise they are **correlated by session id**.
- Codex turns have per-turn usage, but per-step and per-tool detail exists only in Codex's native
  spans.
- The offered tool schema bytes are reconstructed by the orchestrator. S0.4 checks that they match
  what the model received.
- Sandbox children are traced from the orchestrator's side only.
- Suspend detection on Docker Desktop is unproven until S0.1.
- LLM judges stay `experimental` until calibrated.

# Second agent runtime

Objective: qayaba's agents run on either of two agent runtimes, chosen by configuration, without a second owner of any fact, and no layer above infrastructure names a runtime. This document is the implementation specification: every task below is decided, with its files, its rule, its test and its commit.
Records: [RFC-0020](../../docs/architecture/rfc/0020-second-agent-runtime-beside-opencode.md) (proposal and options), [ADR-0027](../../docs/architecture/adr/0027-agent-runtime-choice-is-a-setting.md) (scope), [ADR-0028](../../docs/architecture/adr/0028-rfc-0020-answers.md) (Q1-Q5 and the layering rule).
Branch: feature branch off `main` at `a56d9a64`. Delivery: ask-on-risk. Runner: `npm test` (node:test via tsx). No task below is started; no result is claimed.

## Specs

- **S1** Owner request, verbatim (2026-11-01): "deja escrito los RFC y ADR necesarios relacionados con esta implementacion. debe adherirse a la arquitectura hexagonal y DDD que existe, para acoplarse bien como un nuevo consumidor y no duplicar logica ni responsabilidades. Por ahora no se re implementa el modo dual que se borro, solo la opcion de elegir entre opencode o codex para ejecutar qayaba".
- **S2** Owner rule, verbatim: "el codigo solo debe acoplarse a las implementaciones en las capas de infraestructura, las otras capas son agnosticas al runtime que usa el agente". Read as: a runtime's behaviour lives under `platform/agent-runtime/`, `agents/` and each context's `infrastructure/`; the kernel may own the runtimes' *names* as a closed vocabulary (as it owns `AgentRole`) and no behaviour; `platform/composition/` wires and decides no policy by name; `engine/` `domain/` and `application/`, the rest of `platform/entrypoints/` and every prompt or roster fact name no runtime.
- **S3 (Q1)** One setting for the process: `AGENT_PROVIDER`, `opencode` by default, read in `configFromEnv`. Every assignment it builds carries it. A value no registered strategy serves is refused at boot with a message naming the served values, never defaulted.
- **S4 (Q2)** The second runtime authenticates with a stored login under its own home directory (`CODEX_HOME`). Configuration status is `needs_config` until the binary and a stored login are both present, and it is reported by the strategy's `health()`, not by a key-presence map. A key present in the child's environment never outranks a stored login: `CODEX_API_KEY` and `OPENAI_API_KEY` are removed from the child's environment when a login exists.
- **S5 (Q3)** Read-only roles run the runtime with its read-only sandbox; roles that write run it with its documented escape for externally sandboxed environments. The agents container stays unprivileged and gains no capability.
- **S6 (Q4)** One roster (`agents/roster.json`) is the single owner of which granted tools each agent may call. The existing runtime's tool map is asserted against it and the new runtime's tool server advertises from it; a drift fails a test.
- **S7 (Q5)** No live activity stream for a run on the second runtime: `startEventStream` is absent from its strategy and the console shows the run from its record.
- **S8** The runtime lands as one unit: union member, setting, strategy, client, supervisor route, image pin and registration in one commit (a strategy without a registration is dormant; a registration without a strategy is a runtime an operator can select and cannot run).
- **S9** A run records which runtime produced it (`primaryProvider` / `reviewerProvider`), reports tokens for both, reports a cost only when one was reported, and `complete` means "every role that ran reported a snapshot". Two runtimes are never pooled in one campaign.
- **S10 (S2, today)** At `a56d9a64` the layering rule does not hold. The sites are in "Found state" below; each is a task.
- **S11** The answers do not fork: both runtimes deliver a turn's answer through the same `submit_*` tool, judged by the same reader inside the turn, with the same one continuation.
- **S12** A `codex` turn that a role's time or the run's deadline cuts ends as the same typed end an `opencode` turn does (`AgentTimeoutError`, `AllotmentSpentError`, `RunDeadlineExceededError`); a provider fault (auth, quota, model unavailable) ends the run `infra-error` through the same classification.
- **S13** The gates that name the retired runtime move with the runtime: the banned-term rule is retired, its allow-list entries are removed, and the two tests that pin "the retired provider is gone" become tests that pin the two providers.
- **S14** Out of scope: a third runtime; mixing runtimes inside one run; per-turn model escalation; a step cap the runtime does not enforce; a cost model for a subscription-billed turn; any change to the run's time budget, the deploy gate, the coverage gates or a grader.

## Found state (read at a56d9a64)

The engine's run flow, ports, verdict, gates and graders are already agnostic; these six sites are not.

| # | Site | What couples | Task |
|---|---|---|---|
| 1 | `platform/composition/run-engine-factory.ts:1097`, `:1121`, `:1136` | Whether a role's runtime can call a granted tool is `provider === "opencode"`. | S10.1 -> T2 |
| 2 | `engine/src/contexts/coordination/application/lead-sidekicks.ts:339`, `:420`, `:1308`; `engine/src/contexts/app-catalog/application/app-config.schema.ts:358-360` (doc at `:350-352`) | The application layer reads a flow budget keyed by the runtime's name. | T3 |
| 3 | `platform/entrypoints/onboarding/onboarding-job.ts:144-146`, `:460` | Onboarding is gated on one runtime's key and agent. | T4 |
| 4 | `platform/entrypoints/api/use-cases/ask.ts:6`, `platform/entrypoints/api/handlers/system.ts:6`, `platform/composition/cli.ts:38`, `platform/composition/wire-app.ts:48` | The control plane imports one runtime's raw client. | T5 |
| 5 | `platform/entrypoints/api/handlers/agent.ts:61`, `platform/entrypoints/contract/openapi.ts:460` | The provider is named in an API error and in the OpenAPI enum, which duplicates the schema by hand. | T6 |
| 6 | `engine/src/contexts/agent-tools/domain/submission.ts:12`, `engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts:27` | Vocabulary only: two comments say the runtime's name. | T6 |

## Tasks

### T1 — the records (done)

RFC-0020, ADR-0027, ADR-0028, this document, the index. No code.

### T2 — the capability is not decided by a name (S10.1)

- **Files:** `platform/composition/run-engine-factory.ts` (three lambdas), `engine/src/contexts/agent-tools/infrastructure/adapters/{closed-loop,agent-browser,code-graph-tools}-port.adapter.ts` (the `generatorRuntimeCanCall` dep and its warning), the three adapters' tests.
- **Rule:** delete the fact, do not abstract it. Both runtimes can call a granted tool, so the flag has no false case; keeping a capability boolean for a hypothetical third runtime is speculative (placement rule row 2). The wiring stops passing it and the adapters stop reading it.
- **Test:** `engine/test/contexts/agent-tools/**` loses the warning cases; a test that opening the loop with a granted session on either runtime takes the same path replaces them.
- **Done when** no module under `platform/composition/` or `engine/` compares a provider to a literal.
- **Commit:** with T7 (C3).

### T3 — one flow budget, not one per runtime (S2, config format)

- **Files:** `engine/src/contexts/app-catalog/application/app-config.schema.ts` (`flowBudgetMs` becomes `z.number().int().min(60_000).max(3_600_000).optional()`; the map is refused with the advice "a flow budget is one number: `flowBudgetMs: 600000`"; the block's doc sentence stops naming a runtime), `engine/src/contexts/coordination/application/lead-sidekicks.ts` (three readers), `engine/src/contexts/coordination/application/flow-capacity.ts` (types already take a number), the schema and coordination tests.
- **Rule:** the run's budget depends on the change, never on which runtime serves it. No shim: an app file that still carries the map fails validation with the advice, as every retired key does.
- **Test:** a config with the map is refused naming the replacement; a config with a number reaches `flowCapacity` unchanged; the three readers see the same number.
- **Done when** `grep -rn "flowBudgetMs\.opencode" engine platform` is empty.
- **Commit:** C1 alone (Risk item 3: a config format others consume).

### T4 — onboarding asks the runtime, not a key (S2)

- **Files:** `platform/entrypoints/onboarding/onboarding-job.ts:144-146`, `:460` (the two dep functions), its wiring in `platform/composition/wire-app.ts`, `onboarding-job.test.ts`.
- **Rule:** the gate asks the facade whether the proposing role can run and reports the runtime's own reason; no key name and no agent-count detail of one runtime crosses the boundary.
- **Test:** with a facade whose proposer is unavailable the job fails naming the facade's reason; with one available it proceeds. No test names a provider.
- **Commit:** C2.

### T5 — the control plane goes through the facade (S2)

- **Files:** `platform/entrypoints/api/use-cases/ask.ts:6`, `platform/entrypoints/api/handlers/system.ts:6`, `platform/composition/cli.ts:38`, `platform/composition/wire-app.ts:48`; `platform/agent-runtime/` (a provider-neutral module for what they import).
- **Rule:** two things move, not copy: the assistant's session entry and the open-session count become providers-neutral (`AgentFacade.deps().open` and a per-strategy `openSessions()` summed by the facade, which `AgentRuntimeManager.hasOpenSessions()` already asks for). `opencode-client.ts` keeps only that runtime's raw transport. No behavior changes.
- **Test:** the assistant answers through the facade on the stub runtime; the session count sums two strategies.
- **Done when** no module under `platform/entrypoints/` imports a file whose name is a runtime's.
- **Commit:** C2.

### T6 — the surface comes from the contract, and the vocabulary stops naming (S2)

- **Files:** `platform/entrypoints/contract/openapi.ts:460` (enum from `AgentProviderSchema.options`, not typed twice), `platform/entrypoints/api/handlers/agent.ts:61` (the message names the values the schema accepts), `engine/src/contexts/agent-tools/domain/submission.ts:12` and `engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts:27` (comments say "the runtime's").
- **Rule:** one closed set, the contract's; a message or an enum that re-types it is a second truth.
- **Test:** the OpenAPI parameter's enum equals `AgentProviderSchema.options`; the 400's message lists them.
- **Commit:** C2.

### T7 — the layering rule as a test (S2)

- **Files:** `engine/test/arch/runtime-name-layering.test.ts` (new).
- **Rule:** the names `opencode` and `codex` appear only under `platform/agent-runtime/`, `platform/persistence/`, `platform/telemetry/`, `platform/composition/`, `agents/`, `client/`, the generated contract and `engine/src/shared-kernel/agent-role.ts`; the test strips comments before matching so a prose mention is not a coupling; its exception list is a frozen array with a reason each and a second test fails an entry that matches nothing (it may only shrink).
- **Test:** it fails on a provider literal added to `engine/src/contexts/generation/application/` and on one added to `platform/entrypoints/api/`.
- **Commit:** C3.

### T8 — the runtime (S3, S4, S5, S7, S8, S12)

One commit, filenames are the plan:

| File | What it holds |
|---|---|
| `engine/src/shared-kernel/agent-role.ts:7` | `AgentProvider = "opencode" \| "codex"`; the comment says the kernel owns the names and no behaviour (S2). |
| `platform/agent-runtime/types.ts:12` | `AGENT_PROVIDERS = ["opencode", "codex"]`. |
| `platform/settings/registry.ts` | `AGENT_PROVIDER`: group `agent`, type `string`, default `opencode`, description naming the served values. Never secret. |
| `platform/agent-runtime/config.ts` | `configFromEnv` reads it and refuses a value outside `AGENT_PROVIDERS` with the served list. `KEY_NAME`/`keyPresence` stop deciding configuration: the map keeps reporting "a credential is present" for the providers that have one, and `validateAgentRuntimeConfig` asks the health map `currentPublicConfig` already awaits. |
| `platform/agent-runtime/codex-client.ts` (new) | The raw transport: `POST {AGENT_SUPERVISOR_URL}/codex/exec` with `{ cwd, agent, model, prompt, timeoutMs, sessionId }`, reads the JSONL answer, returns the turn's text, usage and tool calls. HTTP only, no `child_process` (`no-child-process-outside-launchers`, `engine/.dependency-cruiser.cjs:98-102`). |
| `platform/agent-runtime/codex-strategy.ts` (new) | `AgentRuntimeStrategy`. `health()` = binary present and a stored login reported by the supervisor, else `needs_config` with its reason. `listModels()` reads what the server lists. `openSession(role, cwd, opts)` returns a session whose `prompt` posts one turn with the role, model, `timeoutMs`, `submit` arming and `round`, and maps the answer to `{ output, submission }` and the turn's `AgentTurnEvent`. `stepLimits`, `modelWindows`, `startEventStream`, `cleanupOrphans`: absent (statements of absence, S7). `restart` re-reads health. |
| `platform/agent-runtime/usage.ts` | `UsageSnapshot.cost` optional; `RunUsage.cost` present only when a snapshot carried one; `complete` = every role that ran reported. |
| `platform/composition/wire-app.ts:276`, `platform/composition/cli.ts:60` | `strategies: { opencode, codex }`. |
| `platform/entrypoints/contract/commands.ts:432` | `AgentProviderSchema` gains the member; `KeyPresenceSchema`, `AgentHealthMapSchema` and `AgentConfigUpdateSchema.apiKeys` become per-provider (a record keyed by the enum, not a hand-written `{ opencode }`). |
| `agents/agent-supervisor.mjs` | `PROVIDERS = ["opencode", "codex"]`; the turn route; `codexExecEnv(env, { hasStoredLogin })` (pure, strips both keys), `codexSandboxArgs(role)` (pure, `--sandbox read-only` or the escape, from `capabilitiesForRole`), `ensureCodexConfig(home, ...)` (writes `[mcp_servers.qayaba]` and repairs a malformed file), health via `codex login status`. |
| `agents/Dockerfile` | `ARG CODEX_VERSION` pinned exactly, installed beside the other CLI; the comment says a bump re-runs the smokes. |
| `docker-compose.yml` | A `codex-home` volume mounted at the runtime's home, and `CODEX_HOME` for the agents service only. Not in `.env.example` (the orchestrator does not read it). |
| `docs/settings.md` | Regenerated (`npm run settings:gen`). |

Turn arguments (fixed): `exec --json --cd <cwd> --skip-git-repo-check --color never --model <model> <sandbox args> -c mcp_servers.qayaba.env.QAYABA_AGENT="<agent>" -c mcp_servers.qayaba.env.QAYABA_SESSION="<session>" -`, prompt on stdin, environment from `codexExecEnv`.

- **Tests:** `platform/agent-runtime/config.test.ts` (the setting reaches every assignment; an unknown value is refused naming the served ones; a stored-login provider is configured without a key), `codex-strategy.test.ts` (new: health's two states; a write role's args carry the escape and a read role's carry `read-only`; a failed turn maps to the integration error class; `stepLimits` absent; a turn reports tokens and no cost), `strategies.test.ts` (dispatch per assignment), `agents/agent-supervisor.test.mjs` (the env strip both ways; `ensureCodexConfig` idempotent and valid with two `[projects.*]` blocks; the route answers the turn's facts), `usage` test (a mixed run), and the contract tests.
- **Ripples this commit owns:** `scripts/check-previous-forms.ts:55` — the `codex` rule is **deleted** (the name is live code again) and its six entries leave `scripts/previous-forms.allow.json` (an entry that matches nothing fails the gate); `platform/settings/compose-parity.test.ts:21` — `CODEX_API_KEY` leaves `ASSIGNED_BUT_UNREAD`; `agents/agent-supervisor.test.mjs`, `client/cmd/qayaba/main_test.go`, `client/internal/ui/model_test.go`, `engine/test/contexts/app-catalog/application/app-config.schema.test.ts` — the four tests that pin "the retired provider is gone" are rewritten to pin the two providers (the Go client shows the provider the API reports, no hardcoded row); `npm run contract:gen` regenerates `contract/openapi.json`, `packages/sdk` and the Go types.
- **Done when** `AGENT_PROVIDER=codex` boots, `GET /api/health` reports the provider `needs_config` before a login and `healthy` after one, and a prompt returns a recorded turn.
- **Risk:** items 2 (auth and the agents' write authority), 3 (the wire), 5 (image and compose).
- **Commit:** C4.

### T9 — the tool layer (S6, S11)

| File | What it holds |
|---|---|
| `agents/roster.json` (new) | One entry per agent name (`qa-lead`, `qa-author`, `qa-reviewer`, `qa-assistant`, `qa-proposer`), each the list of granted tools by their identifiers (`run_spec`, `authbrowser_*`, `codegraph_explore`, `set_geolocation`, `submit_*`). Nothing else: models stay in `agents/opencode.json`, prompts in `agents/agent/*.md`, capabilities in the kernel. |
| `agents/lib/tool-schemas.mjs` (new) | One JSON Schema per argument set of the four non-submit families, the source both renderings read. |
| `agents/tool/*.ts` | Each file keeps its description and its call, and takes its arguments from `tool-schemas.mjs` through the existing `argsShapeOf` conversion; no argument is declared twice. |
| `agents/mcp/qayaba-tools.mjs` (new) | A stdio MCP server: reads `QAYABA_AGENT`, `QAYABA_SESSION`, `QA_TOOLS_PORT`, `QA_TOOLS_TOKEN`; advertises exactly the roster's tools for that agent; `inputSchema` from `submit-contracts.json` (submit tools) or `tool-schemas.mjs`; `execute` calls `agents/lib/*-client.mjs` with the agent and session from its environment, never from the model's arguments. |
| `platform/agent-tool-surface.test.ts` | Derives the resolved surface twice, from `agents/opencode.json` and from the roster, and fails on drift. |

- **Tests:** the drift test; `agents/lib/tool-schemas.test.mjs` (each schema converts and round-trips); an MCP server test that a session the run did not arm is refused by the orchestrator's existing registries, unchanged.
- **Done when** a `codex` turn sees exactly its roster's tools and a `submit_*` call is judged by the same reader the `opencode` turn uses.
- **Risk:** item 2 (the tool surface is the agent's authority).
- **Commit:** C5.

### T10 — the measurement (S9)

`npm run campaign-report` / `campaign-compare`, one arm per runtime, one app and one case set, read on `mutation_kill_rate`, `change_coverage_ratio`, `branch_coverage_ratio`, `defect_found`, `survivors_routed`, `review_verdict`, plus wall time and turns per run. Never pooled: `gateSignals.usage.primaryProvider` separates them. The public capability index is a prior, not a measurement. No code.

## Order and commits

| Slice | Tasks | Risk line | Why alone |
|---|---|---|---|
| C1 | T3 | Risk item 3 (a config format others consume) | An app file changes shape; the advice and the schema ship together. |
| C2 | T4, T5, T6 | Risk item 3 (API error text and the OpenAPI enum are the wire) | The control plane stops naming a runtime; the contract regenerates. |
| C3 | T2, T7 | Risk: none (a deleted constant and a new test) | The rule becomes enforceable before the runtime tests it. |
| C4 | T8 | Risk items 2, 3, 5 (auth, the wire, image and compose) | S8: the runtime is one unit. |
| C5 | T9 | Risk item 2 (the tool surface) | The roster lands with its only second consumer, never dormant. |
| — | T10 | none (no code) | Measures after C5. |

## Definition of done

1. `AGENT_PROVIDER` selects the runtime for the process, both values boot, an unknown value is refused with the served list.
2. A run on either runtime produces the same verdict vocabulary from the same engine code; nothing under `engine/src` except the kernel's type names a runtime (T7's test).
3. The tool surface has one owner (the roster) and one declaration per argument set; a drift fails a test.
4. The subscription path needs no API key, and a key in the environment never outranks a stored login.
5. `npm run typecheck`, `npm run arch:check`, `npm run contract:check`, `npm run settings:check`, `npm run submit-contracts:check`, `npm run previous-forms:check` and `npm test` are green, and `(cd client && go vet ./... && go test ./...)` is green.
6. The image smokes run in the built image: the four existing ones plus the turn smoke added by T8.

## Log

- **L1** (2026-11-01) Owner, verbatim: "aplica las recomendaciones de q1-q5. el codigo solo debe acoplarse a las implementaciones en las capas de infraestructura, las otras capas son agnosticas al runtime que usa el agente". Earlier the same day, the scope: "Por ahora no se re implementa el modo dual que se borro, solo la opcion de elegir entre opencode o codex para ejecutar qayaba".
- **L2** (2026-11-01) Found state: six couplings above, read at `a56d9a64`. The engine's run flow, ports, verdict, gates and graders are already agnostic.
- **L3** (2026-11-01) Ordering per ADR-0028: the neutrality slices first, then the runtime as one unit (S8), then the roster with its second consumer, then the measurement.
- **L4** (2026-11-01) The records, their links and the gate are verified. No code task is started; no test result is claimed for T2-T10.
- **L5** (2026-11-01) Operational constraint, recorded so T10 reads it: a subscription allows a bounded number of messages per rolling window, shared with the operator's other use of the same account, while one run spends dozens of turns. A run that hits the window ends as a provider fault (`infra-error`); that verdict is correct and nothing waits for the window to reset.
- **L6** (2026-11-01) Final-state pass, the ripples the runtime commit owes and this document now states: the banned-term rule for the retired name (`scripts/check-previous-forms.ts:55`) must be deleted and its six allow-list entries removed (an entry that matches nothing fails the gate); `CODEX_API_KEY` leaves `ASSIGNED_BUT_UNREAD` (`platform/settings/compose-parity.test.ts:21`); four tests that pin "the retired provider is gone" become tests that pin two providers, two of them in the Go client; the OpenAPI enum at `platform/entrypoints/contract/openapi.ts:460` is a hand-typed copy of the schema and becomes the schema's own options. Each is in T8's or T6's file list.

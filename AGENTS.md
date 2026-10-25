# AGENTS.md

> **On-demand reference.** This file is the always-loaded contract: golden rule, repo map,
> commands, architecture, invariants, conventions. Deep detail lives in
> [`docs/agent-reference.md`](docs/agent-reference.md) — the full run-flow decision
> semantics, what the agent receives from every grounding surface, and the suite store.
> Read that file before changing run decisions, prompt assembly or the suite store.

## Golden rule — project-agnostic, model-agnostic, root-cause fixes

qayaba is built to test **any** project. The current declared scope is **Java and
JavaScript/TypeScript**, and it is designed to be extended to other languages through
the language registry (`qa-engine/src/contexts/change-analysis/domain/language-id.ts`)
and `config/`, never through special cases.

- **Never fix a problem only for the project where it showed up.** The apps under
  `config/apps/*` are interchangeable test targets, not design inputs. Reproduce on one,
  find the root cause, and fix it transversally so it cannot happen on any project.
  If a fix only makes sense for one app's stack, layout or naming, it is the wrong fix.
- **Never tune code or prompts to a specific AI model.** Role → provider/model assignments
  are configuration (`agents/opencode.json`, the runtime role config). Nothing in `src/`,
  `qa-engine/`, prompts or docs may assume or name the model currently in use.
- The only legitimate project-shaped constraint is **declared scope** (e.g. which
  languages the structural signal covers), and it lives in `config/` or the language
  registry, never as an app-specific branch in code.
- When a "bug" might be a deliberate guard from a past fix, confirm the change improves
  the root cause without regressing that guard.

## What this is

An **AI-assisted E2E QA engine** (a template — no app is bundled). It watches a team's
repos; when a commit is deployed to DEV, an agent (OpenCode and/or Codex runtime)
generates Playwright tests for the change's blast radius, runs them **against the live
DEV site** (the app is never built or started here), and — when green, reviewer-approved
and covering the change — publishes them to the app repo's `e2e/` via a **PR with
auto-merge**. Failures open an Issue. The suite lives in git and improves run after run.

**Priority above features: stable, reliable, deterministic.** The hardest problem is
*trust*, not engineering — see [The value/trust risk](#the-valuetrust-risk).

## Repo map

| Path | What |
|---|---|
| `qa-engine/src/` | The engine: bounded contexts (`change-analysis`, `generation`, `test-execution`, `objective-signal`, `cross-run-learning`, `qa-run-orchestration`, …), hexagonal. New engine logic goes here. |
| `src/` | The permanent shell around the engine (see [Boundary](#boundary-qa-engine--src)). |
| `agents/` | `agents` container: OpenCode config (`opencode.json`), prompts (`AGENTS.md`, `agent/*.md`, `skill/`), MCPs (Serena, Playwright). |
| `agent/` | Provider-neutral prompt mirror consumed by the Codex runtime (`roles/`, `skills/`). Keep it in sync with `agents/`. |
| `config/apps/` | Watched-app YAMLs (gitignored user data; template: `example.yaml`). `config/e2e/` is the seed copied into a repo's `e2e/`. |
| `client/` | Go TUI. `web/` web console. `packages/sdk` + `contract/openapi.json` the API contract. |
| `scripts/` | Mutation testing, efficiency benchmark, onboarding, contract generation, `sandbox-smoke` (in-container isolation check). |
| `bin/` | `qa`/`qayaba` clients and the container's root-only boot steps (`container-entrypoint.sh`, `egress-init.sh`). |

## Commands

No build step — TypeScript runs via `tsx`.

```bash
npm ci
npm test                    # node:test via tsx; network/agent runtimes/Playwright stubbed
npm run typecheck
node --import ./test-setup.mjs --import tsx --test path/to/file.test.ts [--test-name-pattern="..."]

# Full CI gate (.github/workflows/ci.yml) — all must stay green:
npm run typecheck && npm run arch:check && npm run seed:lint && npm run sdk:typecheck && npm run contract:check && npm test
(cd client && go vet ./... && go test ./...)

npm run seed:lint           # the e2e seed (config/e2e/) against its own ESLint config, as an app's static gate runs it
npm run mutate -- <preset>  # mutation testing per preset (scripts/mutate.ts)
npm run sandbox:smoke       # IN the running orchestrator container: proves the execution sandbox holds (docs/execution-sandbox.md)
npm run judge-calibrate -- --judge <name> [--min-n 20] # calibrate an LLM judge against human labels and persist the report (inside the orchestrator container; docs/observability-design.md §11.3)
npm run label -- --run <id> (--show | --name <score> --value <v>) # label one run by hand against the use-case reference set (inside the orchestrator container)
npm run efficiency-benchmark # agent step/call telemetry over real runs; never a gate (needs the stack up; docs/efficiency-benchmark.md)
npm run probe-report -- <runId...> # one run's phases, turns, tool use, tokens and cost (inside the orchestrator container)
npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> # experiment only: a plain agent on a throwaway copy, same metrics as probe-report

# One run, same pipeline as the webhook (--mode diff|complete|exhaustive|manual, --target e2e|code):
npm run qa -- --app my-app --sha <sha> [--mode manual --guidance "test the contact form"]
npm run start               # webhook + queue service
```

Stack: `doppler run -- docker compose up --build` (or `.env` from `.env.example`). The
orchestrator listens on `PORT` (default **458**, `src/server/port.ts`); trigger with
`curl -X POST localhost:458 -H 'content-type: application/json' -d '{"repo":"<owner>/<repo>","sha":"<sha>"}'`.

## Architecture

Two services (`docker-compose.yml`) sharing the `mirrors` volume (repo working copies):
- `orchestrator` — **deterministic infrastructure**: webhook, sequential queue, deploy
  gate, working copy, harness (validate + execute), publish/report.
- `agents` — **the non-deterministic agent**: a supervisor fronting both runtimes
  (OpenCode `serve`, Codex `exec`) + MCPs. Writes `.spec.ts` files into the working copy.

Keep the two rigorously separate.

### Boundary: qa-engine ↔ src

`qa-engine/src` never imports from `src/` — enforced by `npm run arch:check`
(dependency-cruiser `no-src-import-in-qa-engine`). `src/` has four permanent roles:
- **Composition root** — `src/server/rewritten-engine-factory.ts` maps each app's
  `AppConfig` into a qa-engine `CompositionConfig`.
- **Control plane** — `src/server/*` (webhook, queue, API, TUI surface) and `client/`.
- **Provider I/O edges** — `src/integrations/opencode-client.ts` (raw SDK primitives
  only) and `src/agent-runtime/*` (provider-agnostic facade + OpenCode/Codex strategies).
- **Persistence** — `src/server/run-history-sqlite-adapter.ts` + `history.ts`.

Seams are pinned by `qa-engine/test/contract/seam-parity.contract.test.ts`.

### The run flow — start here

`RunQaUseCase` (`qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`)
is the only engine; webhook (`src/index.ts`) and CLI (`src/cli.ts`) both enter through
`enqueueTrackedRun`. `diff` mode:

1. **Gate** — wait until DEV serves this SHA (`dev.versionUrl`; skipped when absent).
2. **Classify** — checkout, diff + message, `classifyCommit` (Conventional Commits
   cross-checked against the diff). `skip` → `skipped` without spending a token.
3. **Setup** — restore the app's accepted suite from the suite store (rules: `docs/agent-reference.md`), seed `e2e/` from
   `config/e2e/` for whatever is still missing, install deps.
4. **Ground** — assemble what the agent receives (`docs/agent-reference.md` names every
   surface and what each one contributes).
5. **Generate** — agent writes/improves specs + `e2e/.qa/manifest.json`; an independent
   reviewer judges. Declared `noop` + zero specs → `skipped`. Zero specs without `noop`
   → `infra-error E-NO-DECISION`; step budget exhausted → `infra-error E-STEP-BUDGET`; a diff run's
   first pass stopped by its tier's time budget, or any agent turn of the run stopped by the run's
   wall-clock deadline → `infra-error E-TIME-BUDGET`. With the closed loop on (`docs/agent-reference.md`) the generator may also
   execute a spec it wrote while it authors; a run whose every delivered spec was seen passing in its final bytes
   skips the static-fix rounds, the pre-exec corrective regeneration and the fix loop's regeneration.
6. **Validate** — `tsc` + ESLint (`eslint-plugin-playwright`) + `playwright --list` +
   manifest. A failure first gets ESLint's own fixes on the delivered specs (computed in the sandbox with
   `--fix-dry-run`, written by the orchestrator through the confined writer); what they leave goes to at most
   `MAX_STATIC_FIX_ROUNDS` repair turns, run while the run has delivered specs to repair. Still failing → `invalid`.
7. **Execute** — Playwright against DEV → `pass`/`fail`/`flaky` (pass only on retry =
   flaky → quarantine). DEV down → `infra-error`.
8. **Change-coverage** — did the green run exercise the diff's changed lines? (below)
9. **Decide** — green + approved + coverage not blocking → PR. Rejected/`fail`/`invalid`
   → Issue. `shadow: true` replaces every PR/Issue with a log line. An accepted run
   (`isAccepted`: `pass`, generated, approved or review not required, coverage not blocking;
   shadow ignored) first captures its suite into the suite store, before publication.
   Verdicts: `pass | fail | flaky | invalid | infra-error | skipped`
   (`qa-engine/src/shared-kernel/run-verdict.ts`).

   The rest of this step is decision-load-bearing and lives in the reference: the reviewer's
   evidence-bound findings and typed rebuttals (`E-REVIEW-DISPUTED`, `E-REVIEWER-UNAVAILABLE`),
   `E-PRECONDITION`, and the failure triage. Read
   [`docs/agent-reference.md`](docs/agent-reference.md) before changing any of them.

**Modes** (`--mode`): `diff` (default, the only one that classifies), `complete`
(analyze repo + suite, `e2e/.qa/analysis.json`, cover important gaps), `exhaustive`
(re-evaluate and regenerate the whole suite), `manual` (focused by `--guidance`). Prompts
are assembled in `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts`.

**Targets** (`--target`): `e2e` (above) or `code` — the agent writes tests in the repo's
own framework, the orchestrator runs the repo's test suite and classifies by exit code
(no browser, no deploy/static gate). Ecosystem detection:
`qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts`.

**Cross-repo runs.** An e2e app may declare `services[]`. A service repo's post-deploy
webhook triggers the app's suite: diff/classify/gate from the service mirror, suite from
the primary mirror. Issues open in the service repo; PRs target the primary repo.
Change-coverage is `unknown` for these runs.

### The agent and its prompts

Provider-agnostic runtime (`src/agent-runtime/`): each role (generator, reviewer, chat, …)
is assigned a provider + model, `single` or `dual` mode (two runtimes = independent
judgment). `agents/opencode.json` is the source of truth for the roster, models and
per-role step limits (`maxSteps`). Prompt layers: `agents/AGENTS.md` (shared rules) →
`agents/agent/*.md` (per-role procedure + JSON contract) → `agents/skill/` (on-demand
craft); Codex gets the mirror in `agent/` via `withCodexRolePreamble`. Static layers are
linted against assembled prompts (prompt-contract lint) and size-budgeted.

The static layers are **consume-first**: use what the prompt supplies at the confidence it
states and look up only what it lacks; to change a flow, find its existing spec, read it, and
update it. The generator is done once its specs are written or it has decided nothing is worth a
test, and the verdict is its last action.

`qa-maintainer` self-repairs THIS repo via fix PRs; auto-deploy only with
`SELF_MAINTAINER_AUTOMERGE="true"`, behind `src/server/merge-guard.ts` (read its
threat-model header first) and a canary-before-promote hot-swap.

### Persistence & onboarding

- The suite's source of truth is **git** (app repo `e2e/`). Run history and the learning ledger
  (`qa-data` volume) are the only non-regenerable data; Serena index and mirrors are caches.
- Onboarding an app = `config/apps/<app>.yaml` + `.env`. `${VARS}` expand from the env.

- **Suite store** — the accepted suite of an app git does not hold yet
  (`workspace-and-publication/infrastructure/suite-store.adapter.ts`, `data/suites/<app>/`,
  never mounted into the agents container). Capture, restore and reconcile rules live in
  [`docs/agent-reference.md`](docs/agent-reference.md).

## Invariants — do not break these

- **The golden rule above.** Nothing app-specific in `src/` or `qa-engine/`; app
  specifics only in `config/`; agents/models only in `agents/`.
- **Security boundary:** the agent is **read-only** on watched repos. Only the
  deterministic orchestrator writes to git (push/PR). Never give the agent, or any
  chat/operator layer, write access to a watched repo.
- **No role reads credentials.** Every role that reads declares a `permission.read` block in
  `agents/opencode.json` that denies env files, the suite's `e2e/.auth/`, `storageState*.json`, `client.p12` and `cert.pass`
  after its catch-all allow (the orchestrator's auth directory is not mounted into the agents container, so no rule names it,
  and an app's own `auth/` or `.auth/` source folders stay readable) (the runtime's own `*.env` default is `ask`, which a later `read *: allow`
  shadows, and a run has nobody to answer an `ask`). A role that cannot read keeps the `read: deny` its `tools`
  map gives it, so it carries no `read` block. `agent-tool-surface.test.ts` checks the resolved rules against
  `src/integrations/fixtures/opencode-agent-list.json`: re-record it (its README) whenever a role or a block changes.
- **`opencode serve` is never open.** The supervisor always starts it with `OPENCODE_SERVER_PASSWORD` (the value
  compose gives the `agents` and `orchestrator` services, or a random one when unset, with a loud warning), and the
  orchestrator's clients (`src/integrations/opencode-server-auth.ts`) send it as Basic auth, refuse to be built
  without it and throw on a 401. The value is never logged, is scrubbed from untrusted spawns and from supervisor
  responses, and must be identical on both services.
- **The agents container never holds the test account.** `DEV_TEST_USER`/`DEV_TEST_PASS` are not in its compose
  environment and the Codex exec env (`CODEX_EXEC_ENV_PREFIX`, in the supervisor and `codex-strategy.ts`) does not
  forward them: the app login is the orchestrator's (`AuthSessionAdapter`) and the agent only gets the saved session.
  `DEV_ENV_*` (the DEV HTTP Basic gate) stays, for the baseline arm's Playwright config and a Codex shell.
- **A watched repo cannot configure the agent.** OpenCode merges a session directory's `opencode.json` and
  `.opencode/` (permission overrides, plugins that run code, MCP servers) over `agents/opencode.json`; a mirror is a
  watched repo's working copy. The supervisor starts `opencode serve` with `OPENCODE_DISABLE_PROJECT_CONFIG=true`
  (verified live: a hostile `opencode.json` raised `qa-generator` to `bash: allow` and a `.opencode/plugin` ran code
  just by listing agents, both gone with the flag), and drops any Codex `[projects.*]` trust at boot, so a repo's
  `.codex/config.toml` is never loaded. Only the baseline experiment opts back in (`AGENT_ALLOW_PROJECT_CONFIG=true`).
  A repo's `AGENTS.md`/`CLAUDE.md` stay prompt text, the same trust class as the source the agent reads.
- **`run_spec` does not give the agent a way to run code.** The agent asks; the orchestrator, which owns every limit, runs a
  spec file the agent wrote in the sandbox. A call is served only for a session the transport bound to the generator of a live
  run, behind a service token on an unpublished port the sandbox uid cannot reach; the path is confined to `*.spec.ts` of the
  suite (never `auth.setup.ts`, never outside `e2e/`), read with the strict reader, and answered without raw process output.
  Never widen the tool to another agent, a Codex role, a free-form command or a path outside the spec directory.
- **The authenticated browser never gives an agent the session, and never writes.** The agent asks; the orchestrator's browser, in
  the run's sandbox, holds the session in memory and reads. The surface is four actions (no evaluate, no script injection, no file
  chooser, no download); every request passes the route guard, which fails closed; service workers are blocked; the saved session is
  never staged to the browser's process nor written by it (`npm run arch:check` fails on a file API in the browser modules and on
  `playwright-core` outside its loader). A call is served only for a session the transport bound to `qa-generator` or `qa-sidekick` of
  a live run, behind the service token; every other role denies the tools (`agents/opencode.json`, pinned by a test) and Codex has none.
  Never widen the tools to another role, add an action that runs script or sends a file, or let a mutating request through without an
  `allowMutating` entry the app's config names.
- **The code-graph tool reads one app's index, and only through the orchestrator.** The agent names terms; the orchestrator
  admits them, names the repo and the workspace, sets the file cap and runs the engine. Never forward a project, a path or an option
  the agent names, let a term start with `-`, add a free graph query or an action that indexes, deletes or writes, mount the graph store
  into the agents container, or widen the tool beyond `qa-generator`.
- **Agent-influenced code runs only through the execution launcher**
  (`qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts`, profiles `offline | suite | login | install`).
  Specs, the e2e project's `tsc`/`eslint`/`playwright --list`/`npm ci`, the login scripts, the DOM capture, a code-mode
  repo's install/test and the mutation oracle all start there: the sandbox uid, an environment built from an explicit
  allowlist per profile (never `scrubEnv(process.env)`), a per-run work dir (`/tmp/qa-exec/<runId>`) for Playwright's
  output, report and dumps, read back through the strict readers. **Only the `login` profile carries the test account**
  (a suite gets it only for an app that sets `e2e.specCredentials: account`); a suite gets a per-spawn copy of the saved
  session and never the auth dir. A new module that
  imports `child_process` is a build failure (`npm run arch:check`, rule `no-child-process-outside-launchers`); add a
  spawn site by adding a profile call, not an exception. `QA_EXEC_SANDBOX=required` (compose) refuses to run agent code
  without the sandbox uid, or with a file boundary the boot check did not prove (`infra-error E-SANDBOX`, never learned from, no Issue).
- **The sandbox uid's network is closed by default.** An iptables chain matched on that uid redirects its DNS and TCP to a
  DNS filter and a transparent proxy that allow only the origins declared in config (`dev.allowedOrigins`, the app's own
  origin, `egress.installOrigins`, `config/egress/registries.yaml`); everything else, IPv6 and the other loopback ports
  included, is rejected. `QA_EGRESS_MODE=enforce` (default) ends a run `E-SANDBOX` when the filter is not active. Origins are
  data: never add a host in code. Denied hosts land in `gateSignals.sandbox.denied`.
- **File permissions are the boundary for secrets, and they are proven, not assumed.** `bin/container-entrypoint.sh` closes
  `/app/data` (0700, which holds the API token `data/.api_token`), `/app/.host` (0700, the root-only parent of the host's config
  folder; `/app/config` is a link to `.host/config`) and the mirrors at every boot; the sandbox uid reads one mirror at a time
  (the run opens it to its group and seals it again) and writes none of it. A host bind mount may not enforce permissions
  (Docker Desktop's `fakeowner`), so secrets never live in one the sandbox uid can reach and code is mounted read-only. Then
  `src/server/file-boundary-check.ts` tries, as the sandbox uid, to read the token and `/proc/1/environ`, list the closed
  directories and write the app root, every mount under it (from `/proc/self/mountinfo`) and the orchestrator's code and config;
  any success, or no result, is a breach: `/api/health` reports the sandbox degraded and `QA_EXEC_SANDBOX=required` refuses agent
  code (`infra-error E-SANDBOX`). Do not give the sandbox uid, or a path it can write, a way to the API token, `/app/data`, the
  app configs or another mirror, and never add a rw bind mount under `/app` the sandbox uid can write.
- **What the agent writes or reports is untrusted input.** Orchestrator code that reads, lists
  or writes a path the agent can influence (a reported spec path, the manifest, the context
  map, files setup replaces, what a test run leaves) goes through the confined reader,
  `qa-engine/src/shared-infrastructure/spec-path-confinement.ts` (nothing outside the spec
  directory is reached through a link, only regular files are read, a named pipe is never waited
  on, reads are capped; its header lists what it covers), never a bare `fs` call.
- **Governance-sensitive changes ship alone** — security invariants, agent write
  authority, production activation switches: their own PR.
- **Sequential queue** — one run at a time; runs never overlap against DEV. Within a run, every DEV action (a spec
  execution or an authenticated agent-browser action) holds its test account's lease from the orchestrator: actions on
  one account are serialized; actions run concurrently only on distinct accounts and only under the proxy's read-only
  enforcement; an action that may write holds DEV exclusively. Agent-declared tags never decide isolation.
- **Honor the explicit no-op.** Declared `noop` + reason + zero specs is a valid
  `skipped`. Silence is not a decision (`E-NO-DECISION` / `E-STEP-BUDGET` / `E-TIME-BUDGET`). `approved`
  is never a no-op signal.
- **Surface integration errors loudly** — never swallow agent-runtime, runner or git
  errors into an empty result. Throw and log.
- **Sanitize data leaving the system** — logs → Issue via `src/orchestrator/sanitizer.ts`
  (`RedactionPortAdapter`); diff/commit text → prompts via
  `qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts`. The run's own account
  secrets (login, DEV gate, certificate passphrase, session cookie and storage values) are
  also redacted **by value** (`shared-infrastructure/run-secret-redaction.ts`: one scope per run,
  applied in both sanitizers and at both agent transports before the patterns look).
- **Everything in English**; comments describe the final state, not the process.

## Conventions & gotchas

- **Dependency injection is the testing strategy.** `RunQaUseCase` runs on ports
  (`qa-run-orchestration/application/ports/index.ts`) wired in `composition-root.ts`;
  orchestration is unit-tested with fakes. Real integrations (agent runtime, Playwright,
  git) are the deliberately uncovered boundaries; each exports `*Deps` + `default*Deps`.
  Follow that pattern for new side-effecting code.
- **No build step** — `tsx` is a devDependency; install ALL deps in Docker.
- **When the OpenCode pin or `@opencode-ai/plugin` moves**, re-run `agents/smoke/run-spec-tool.smoke.mjs` and
  `agents/smoke/authbrowser-tool.smoke.mjs` and `agents/smoke/codegraph-tool.smoke.mjs` in the new image (the plugin's `ToolContext` and the naming of a file's exports are what the
  tools depend on) next to re-recording the agent-list fixture. **When Playwright moves**, `playwright-core` in `package.json` moves with
  it, and `npx tsx scripts/agent-browser-smoke.ts` is re-run in the new orchestrator image (see `docs/execution-sandbox.md`).
- **Pin exact versions on the execution path** — Playwright `1.60.0` matches the
  `playwright:v1.60.0-noble` image. Never use `^`. The OpenCode build is pinned in
  `agents/Dockerfile`: when the pin moves, re-record
  `src/integrations/fixtures/opencode-agent-list.json` (the `GET /agent` capture the step-limit
  reader is tested against) on the new build; its README says which build it came from.
- **`.env` comments on their own line** — compose `env_file` keeps an inline `# comment`
  as part of the value.
- Secrets come from **Doppler** at runtime; `.env` is local-only.
- **Tests that assert git output assume English** — on a non-English git locale run
  `LC_ALL=C npm test`.
- **OpenAPI is agent-resolved authoring context** (optional `openapi:` glob hint in the
  app YAML): the agent reads the matching operation only for a contract fact the prompt lacks
  (fields, enums, error responses) and exercises the backend **through the UI**, never the API
  directly.
- **Long agent turns:** `src/util/net.ts` raises undici's header/body timeouts above the
  agent timeout so `withTimeout` is the real deadline.
- **Serena needs a language server per watched language** — add it in `agents/Dockerfile`
  when extending the language scope.

## Testing standards

Read [`docs/testing-standards.md`](docs/testing-standards.md) before writing or changing a test.

1. Test behavior through the public seam (exported function, use case, port) — never a
   private helper, exact prompt wording, or a whole internal object.
2. A bug fix starts with a test that fails for the bug's reason; a test gap starts by
   showing the mutant survives (`npm run mutate -- <preset>`).
3. Name tests by the behavior they check — no ticket/batch/review ids.
4. Fakes for injected ports, doubles only at the process boundary; import production
   constants instead of re-typing literals.
5. Write only under `os.tmpdir()`; no real time or network.
6. Never kill a mutant by asserting its literal; restructure an equivalent one away or
   list it as a documented survivor. No `// Stryker disable`. Thresholds are per preset.
   Keep preset line ranges in `scripts/mutate.ts` in sync when editing the code they cover.

## The value/trust risk

The quality loop is circular: one LLM generates, another reviews, and the harness checks
that a test *runs*, not that it is *meaningful* — left alone it drifts into a large suite
that catches nothing. The objective signal that breaks the circle is **change-coverage**
(`qa-engine/src/contexts/objective-signal/domain/`):

- `qa.coveragePolicy.mode`: `off` | `signal` (default, record only) | `enforce` (gate);
  `minRatio` default `0.7`.
- `DecideCoverageService.blocks(status)` is the single source of truth for blocking.
  **`unknown` never blocks.**
- In `enforce`, a `fail` triggers **exactly one** regeneration at the uncovered lines,
  re-measured under its own `${runId}-coverage-regen` namespace. Only that second
  measurement can change the decision; a failed or empty regen keeps the first result.

- The changed lines are the change's own code: the repo's test files a commit carries (the language
  registry's `isTestFile`) are neither collected nor counted.
- A browser run maps covered bundle bytes to repository files only through source maps the page's
  scripts carry (inline, fetched from the URL their `sourceMappingURL` names, or `<script>.map` when
  they name none), fetched through the browser context so a DEV gate's credentials reach them. When the dumps held
  scripts and none carried a map, the measurement ends `unknown` with `unmeasured: no-source-maps`
  (span `qayaba.coverage.unmeasured`), distinct from `no-changed-file-mapped` (maps existed, none
  reached a changed file). It is an app/DEV build property, fixed by serving maps, never by a guess.
- **Branch coverage** (signal, never a gate): the decisions of the scripts the page ran (if/else with the
  implicit else, `?:`, `&&`/`||`/`??`, switch clauses) are placed through the same maps, and an arm is
  taken when V8's block counts say it ran. The arms on changed lines go on the coverage span
  (`qayaba.coverage.changed_branches`/`taken_branches`) and `gateSignals.branchCoverage`; the ones that
  never ran join the enforce regeneration's gap. A happy-path suite shows a high line ratio and a low
  branch one.
- **Bundle mutation** (signal, never a gate; on with `qa.valueOracle`): up to three mutants of the changed
  code in the served script (a negated condition, a swapped comparison or logical operator), each one
  re-run of the spec files whose tests reached it, through the seed's `_mutate` fixture (`PW_MUTANT`).
  A mutant is judged only when it reached a page; it is killed when a passing test fails.
  `gateSignals.bundleMutation` holds `{ applied, killed, survived[] }` beside the response oracle's
  `valueScore`, whose meaning is unchanged.

New "quality" logic should strengthen this signal (better line mapping, moving apps from
`signal` to `enforce`), not add another LLM proxy.

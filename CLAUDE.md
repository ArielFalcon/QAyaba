# CLAUDE.md

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
| `agents/` | `agents` container: OpenCode config (`opencode.json`), prompts (`AGENTS.md`, `agent/*.md`, `skill/`), MCPs (Serena, engram). |
| `agent/` | Provider-neutral prompt mirror consumed by the Codex runtime (`roles/`, `skills/`). Keep it in sync with `agents/`. |
| `config/apps/` | Watched-app YAMLs (gitignored user data; template: `example.yaml`). `config/e2e/` is the seed copied into a repo's `e2e/`. |
| `client/` | Go TUI. `web/` web console. `packages/sdk` + `contract/openapi.json` the API contract. |
| `scripts/` | Mutation testing, efficiency benchmark, onboarding, contract generation. |

## Commands

No build step — TypeScript runs via `tsx`.

```bash
npm ci
npm test                    # node:test via tsx; network/agent runtimes/Playwright stubbed
npm run typecheck
node --import ./test-setup.mjs --import tsx --test path/to/file.test.ts [--test-name-pattern="..."]

# Full CI gate (.github/workflows/ci.yml) — all must stay green:
npm run typecheck && npm run arch:check && npm run sdk:typecheck && npm run contract:check && npm test
(cd client && go vet ./... && go test ./...)

npm run mutate -- <preset>  # mutation testing per preset (scripts/mutate.ts)
npm run efficiency-benchmark # agent step/call telemetry over real runs; never a gate (needs the stack up; docs/efficiency-benchmark.md)

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
3. **Setup** — seed `e2e/` from `config/e2e/` if missing, install deps.
4. **Ground** — assemble what the agent receives (see below).
5. **Generate** — agent writes/improves specs + `e2e/.qa/manifest.json`; an independent
   reviewer judges. Declared `noop` + zero specs → `skipped`. Zero specs without `noop`
   → `infra-error E-NO-DECISION`; step budget exhausted → `infra-error E-STEP-BUDGET`.
6. **Validate** — `tsc` + ESLint (`eslint-plugin-playwright`) + `playwright --list` +
   manifest. Fail → `invalid`.
7. **Execute** — Playwright against DEV → `pass`/`fail`/`flaky` (pass only on retry =
   flaky → quarantine). DEV down → `infra-error`.
8. **Change-coverage** — did the green run exercise the diff's changed lines? (below)
9. **Decide** — green + approved + coverage not blocking → PR. Rejected/`fail`/`invalid`
   → Issue. `shadow: true` replaces every PR/Issue with a log line.

Verdicts: `pass | fail | flaky | invalid | infra-error | skipped`
(`qa-engine/src/shared-kernel/run-verdict.ts`). `E-PRECONDITION` = login could not be
completed: recorded, never learned from, no Issue.

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

### What the agent receives: grounding and learning

The harness pre-computes context so the agent does not have to rediscover it. Any change
to the agent's behaviour must make it **consume** this context, not re-derive it:
- **Pre-generation grounding** —
  `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts`
  (fail-open): explorer brief (blast radius; `qa.explorer`, default on when `services[]`),
  context pack (live DOM per route, redirect advisory, relevant API contracts, routes not
  capturable — `generation/infrastructure/context-pack.ts`), harness facts
  (`generation/domain/harness-facts.ts`), existing-suite manifest.
- **Pre-exec / review grounding** — `pre-exec-grounding-port.adapter.ts`,
  `review-dom-grounding-port.adapter.ts` (same folder).
- **Step limit and milestone** — the generator, explorer and reviewer prompts state the cap
  their runtime enforces (facts-only `step-limit` section): one live read per run of the
  OpenCode server's resolved agents (`steps`, the legacy `maxSteps` mapped into it; `stepLimits`
  in `src/agent-runtime/`), never the orchestrator's own copy of `agents/opencode.json`, which
  only classifies exhaustion for a prompt that stated none. A role with no resolved limit
  (failed read, uncapped agent, or Codex, which has no step budget) states none. The
  generator's test-writing turns (diff/manual first passes, every regeneration) add a
  `step-milestone` directive, counted by the prompt-contract lint, at half the limit: the first
  spec or a reasoned no-op; on a regeneration, the first correction or why none applies (the
  verdict's `noop.reason`). Exhaustion is classified against the number the prompt stated.
  Whether the runtime's count resets every turn is still open (the statement holds either way;
  see `docs/efficiency-benchmark.md`).
- **Effort tier** — an e2e `diff` first pass gets the diff's real size and the effort its tier
  warrants (`generation/domain/diff-stat.ts`: tiny ≤2 files and 40 lines, focused ≤8 and 400,
  broad above): always an upper bound, and every tier admits the reasoned no-op.
- **Regeneration listing** — a regeneration lists the suite as that turn knows it (the specs
  the suite had before a diff/manual run, plus those this run delivered, each only while its
  file is still there): the specs it must change under "Editable" (all those a signal names;
  the ones taken because nothing names a spec are capped), the rest under "Do NOT rewrite"
  (capped); what a cap leaves out is counted. One sanitized, capped line per spec, never
  inlined source (`generation/domain/suite-listing.ts`). The "state the outcome" question is
  asked unless every spec to change has an objective its lead declared and no correction
  disputes it; the rule against weakening a test is stated on every test-writing turn, whether
  or not the question is asked.
- **Diff-ranked map routes** — before the live-DOM capture cut, the routes the orchestrator
  derived are ordered by the links the context map declares to the changed files, and only
  those: a route's `implementationFiles`, then its `source`, then the `spec` of an API
  operation it joins (`generation/domain/route-ranking.ts`). Brief routes keep their place in
  front, nothing is inferred from names, and a cross-repo run ranks only by the spec of an
  operation under the service's staged root.
- **Cross-run learning** — `qa-engine/src/contexts/cross-run-learning/`: deterministic
  rule fold, rule governance, curriculum, and the `qa-reflector` pass (distils
  `candidate`/`low`-confidence rules only; flaky/infra verdicts excluded). engram holds
  agent memory across runs.

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
test, and the verdict is its last action. engram's `mem_session_summary` is denied to the
generator and explorer by runtime config, not prompt wording: per agent in `agents/opencode.json`,
and for every Codex role as `disabled_tools` in `agents/agent-supervisor.mjs`.

`qa-maintainer` self-repairs THIS repo via fix PRs; auto-deploy only with
`SELF_MAINTAINER_AUTOMERGE="true"`, behind `src/server/merge-guard.ts` (read its
threat-model header first) and a canary-before-promote hot-swap.

### Persistence & onboarding

- The suite's source of truth is **git** (app repo `e2e/`). engram (`engram-data`
  volume) is the only non-regenerable data; Serena index and mirrors are caches.
- Onboarding an app = `config/apps/<app>.yaml` + `.env`. `${VARS}` expand from the env.

## Invariants — do not break these

- **The golden rule above.** Nothing app-specific in `src/` or `qa-engine/`; app
  specifics only in `config/`; agents/models only in `agents/`.
- **Security boundary:** the agent is **read-only** on watched repos. Only the
  deterministic orchestrator writes to git (push/PR). Never give the agent, or any
  chat/operator layer, write access to a watched repo.
- **What the agent writes or reports is untrusted input.** Orchestrator code that reads, lists
  or writes a path the agent can influence (a reported spec path, the manifest, the context
  map, files setup replaces, what a test run leaves) goes through the confined reader,
  `qa-engine/src/shared-infrastructure/spec-path-confinement.ts` (nothing outside the spec
  directory is reached through a link, only regular files are read, a named pipe is never waited
  on, reads are capped; its header lists what it covers), never a bare `fs` call.
- **Governance-sensitive changes ship alone** — security invariants, agent write
  authority, production activation switches: their own PR.
- **Sequential queue** — one run at a time; never concurrent QA against DEV.
- **Honor the explicit no-op.** Declared `noop` + reason + zero specs is a valid
  `skipped`. Silence is not a decision (`E-NO-DECISION` / `E-STEP-BUDGET`). `approved`
  is never a no-op signal.
- **Surface integration errors loudly** — never swallow agent-runtime, runner or git
  errors into an empty result. Throw and log.
- **Sanitize data leaving the system** — logs → Issue via `src/orchestrator/sanitizer.ts`
  (`RedactionPortAdapter`); diff/commit text → prompts via
  `qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts`.
- **Everything in English**; comments describe the final state, not the process.

## Conventions & gotchas

- **Dependency injection is the testing strategy.** `RunQaUseCase` runs on ports
  (`qa-run-orchestration/application/ports/index.ts`) wired in `composition-root.ts`;
  orchestration is unit-tested with fakes. Real integrations (agent runtime, Playwright,
  git) are the deliberately uncovered boundaries; each exports `*Deps` + `default*Deps`.
  Follow that pattern for new side-effecting code.
- **No build step** — `tsx` is a devDependency; install ALL deps in Docker.
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

New "quality" logic should strengthen this signal (better line mapping, moving apps from
`signal` to `enforce`), not add another LLM proxy.

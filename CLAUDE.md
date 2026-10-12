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
npm run typecheck && npm run arch:check && npm run sdk:typecheck && npm run contract:check && npm test
(cd client && go vet ./... && go test ./...)

npm run mutate -- <preset>  # mutation testing per preset (scripts/mutate.ts)
npm run sandbox:smoke       # IN the running orchestrator container: proves the execution sandbox holds (docs/execution-sandbox.md)
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
3. **Setup** — restore the app's accepted suite from the suite store (below), seed `e2e/` from
   `config/e2e/` for whatever is still missing, install deps.
4. **Ground** — assemble what the agent receives (see below).
5. **Generate** — agent writes/improves specs + `e2e/.qa/manifest.json`; an independent
   reviewer judges. Declared `noop` + zero specs → `skipped`. Zero specs without `noop`
   → `infra-error E-NO-DECISION`; step budget exhausted → `infra-error E-STEP-BUDGET`; a diff run's
   first pass stopped by its tier's time budget, or any agent turn of the run stopped by the run's
   wall-clock deadline (below) → `infra-error E-TIME-BUDGET`. With the closed loop on (below) the generator may also
   execute a spec it wrote while it authors; a run whose every delivered spec was seen passing in its final bytes
   skips the static-fix rounds, the pre-exec corrective regeneration and the fix loop's regeneration.
6. **Validate** — `tsc` + ESLint (`eslint-plugin-playwright`) + `playwright --list` +
   manifest. Fail → `invalid`.
7. **Execute** — Playwright against DEV → `pass`/`fail`/`flaky` (pass only on retry =
   flaky → quarantine). DEV down → `infra-error`.
8. **Change-coverage** — did the green run exercise the diff's changed lines? (below)
9. **Decide** — green + approved + coverage not blocking → PR. Rejected/`fail`/`invalid`
   → Issue. A reviewer that could not be reached (its session failed, or it returned nothing) judged
   nothing, which is not a rejection: the run ends as a persisted `infra-error` `E-REVIEWER-UNAVAILABLE`
   (the reviewer's reason on the run record and in the log, no PR and no Issue, nothing learned; three in
   a row log an observe-only audit finding). A reviewer that answered unreadably is still a fail-closed
   parse miss. `shadow: true` replaces every PR/Issue with a log line. An accepted run (`isAccepted`:
   `pass`, generated, approved or review not required, coverage not blocking; shadow ignored) first
   captures its suite into the suite store, before publication.

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
  (fail-open): explorer brief (blast radius; `qa.explorer`, default on when `services[]`) on diff and manual runs,
  context pack (live DOM per route, redirect advisory, relevant API contracts, routes not
  capturable — `generation/infrastructure/context-pack.ts`), harness facts
  (`generation/domain/harness-facts.ts`), existing-suite manifest.
- **Pre-exec / review grounding** — `pre-exec-grounding-port.adapter.ts`,
  `review-dom-grounding-port.adapter.ts` (same folder).
  The pre-exec selector-ambiguity check is a regex over the spec text and **advisory**: its findings
  are counted (`preExecAmbiguityCatches`) and logged as a warning, never fold the verdict, request a
  regeneration or feed the FixLoop; execution decides. Only the catalog gate's fabricated test-ids
  (a captured, settled route) feed the one-shot corrective regeneration.
- **Closed loop (`run_spec`)** — off unless `qa.closedLoop.enabled` (or a run asks: `--closed-loop on|off`, `closedLoop` on
  `POST /api/v1/runs`). The OpenCode generator gets one custom tool, `agents/tool/run_spec.ts`, that POSTs its session id and
  agent name to the orchestrator's internal listener (`src/server/tools-endpoint.ts`, `QA_TOOLS_PORT`, not published, behind
  `QA_TOOLS_TOKEN`); the orchestrator runs the spec once (sandbox profile `suite`, retries 0, a fresh session copy, namespace
  `<runId>-rs<n>`, a cleanup pass after every call, per-account lock) and answers with a bounded, redacted report, never raw
  output. The capability (`test-execution/domain/run-spec-capability.ts`) is the orchestrator's, bound to the generator
  sessions the agent transport reports for the run (`ClosedLoopRegistry`): caps on calls, time per call (also bounded by the
  run deadline) and DEV writes (counted by the capture block's ledger in `fixtures.ts`, a spec must import its `test` from
  there), a ledger of every call's sha256, revoked when the run ends. Scratch specs live in `e2e/.qa-probe/` and are swept
  after every generation: never delivered, stored or validated. When `loopClosed` (every delivered spec's current bytes are those
  whose last call passed) the regenerations that only repeat that work are skipped; the declared no-op, `E-NO-DECISION` /
  `E-STEP-BUDGET` / `E-TIME-BUDGET` and the single enforce-mode coverage regeneration are unchanged. The `Run spec budget` prompt
  section (facts only) exists only when granted; Codex is never granted it. `gateSignals.closedLoop { calls, devWrites, closed }`.
- **Authenticated browser (`authbrowser_*`)** — off unless `qa.agentBrowser.enabled` (or a run asks: `--agent-browser on|off`,
  `agentBrowser` on `POST /api/v1/runs`). The authoring roles (`qa-generator`, `qa-sidekick`) get four custom tools
  (`agents/tool/authbrowser.ts`: navigate, snapshot, click, type) that POST to the same internal listener as `run_spec`
  (`/internal/authbrowser`, `QA_TOOLS_TOKEN`). The orchestrator owns the browser: Chromium started through the execution launcher
  (sandbox uid, the egress lease of the app's origins; the protocol over a pipe, behind a loopback WebSocket on a random path) and
  driven by `playwright-core` (pinned to the image's Playwright version) over one context per run, built from the saved session **held
  in memory**: cookies reach the browser as data, nothing is written, nothing it refreshes is saved. Every request of the context
  passes the route guard (`test-execution/domain/agent-browser-route-guard.ts`, pure): scheme, declared origin, `qa.agentBrowser.denyRoutes`,
  and any method that writes unless `allowMutating` names it; a block is reported in the answer, and `gateSignals.agentBrowser
  { calls, blocks, invalidations, renewals }` counts them. A page that says the session is gone (login path, 401 document, a password
  field on a page that was not asked for) makes the tool error with `session invalidated`, asks the auth port to sign in again (at
  most twice per run) and resets the browser. Each call holds the test account's lease (`AccountLock`, the same key as `run_spec`)
  and a bounded wait answers `DEV busy`. The session is bound by `AgentBrowserRegistry` to the sessions the agent transport reports
  for an authoring role of the run; the capability is revoked, the browser closed and its work dir removed when the run ends, and
  a boot sweep ends a browser a previous process left. A prompt of an authoring session the run did not grant hides the tools
  (a per-prompt `tools` map, `openCodePromptBody`). The `Authenticated browser budget` prompt section (facts only) exists only
  when granted; Codex is never granted it (a custom tool is OpenCode's).
- **Lead and sidekicks (`qa.coordination`)** — `mode: single` (default) is the lead authoring the change alone, exactly the call
  sequence a run without this mode makes; `mode: lead-sidekicks` (the app's `qa.coordination`, or a run's own choice: `--coordination
  single|lead-sidekicks`, `coordinationMode` on `POST /api/v1/runs`, the campaign's `--coordination`; the run's choice wins and is recorded
  in the probe report) has the lead return a **plan** instead of specs (`GenerationPort.plan`, a read-only turn, `plan` in the generator's
  verdict) and each flow authored by a sidekick in parallel. The plan is untrusted: `admitLeadPlan` keeps only what its shape and the
  run's limits allow (`maxFlows`, a deterministic spec path `e2e/flows/<slug>.spec.ts` per flow, the lead's own write lists ignored) and
  downgrades to `single` with a recorded reason otherwise. Each sidekick works in a plain bounded copy of what the run may read
  (`<mirrors>/.qa-delegations/<run>/<delegation>`, `DelegationWorkspacePort`); only the files its brief names (`writablePaths`) are taken
  back, through `spec-path-confinement`, and anything else it changed is listed as a proposal and never applied. A pool of at most
  `maxParallel` flows runs under `FanOutDispatcher` (a signal and a time per flow, a throwing flow isolated); each flow closes its own
  `run_spec` loop (`ClosedLoopHandle.openFlow`, the same `AccountLock` lease, its own caps and namespace) and, with a login, reads DEV
  through the orchestrator's authenticated browser with a share of the run's caps. What a sidekick may author with is
  `sidekickAuthoring`: authenticated browser, `run_spec` only, the plain browser for an app with no login (one flow at a time), or
  excluded (a Codex sidekick, or a login with neither grant): the lead then authors alone and the log says why. A flow climbs the
  escalation ladder (a second attempt, then the lead takes it back) on what the orchestrator saw of its `run_spec` calls, never on the
  sidekick's word. Flows that deliver are added up like a generation (`aggregateFlowOutcomes`), and the rest of the run (validate,
  execute, coverage, review, decide) is unchanged. DEV access: every action holds its account's lease (`DevLease`, an `AccountLock`
  whose read-only concurrency is gated by the proxy; the proxy has no read-only mode yet, so today every action is exclusive).
  Workspaces are removed in a `finally` and swept at boot. `gateSignals.coordination { mode, plan, downgrade, flows, delivered,
  incomplete, takeover, authoring }`. `docs/lead-sidekicks.md`.
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
  broad above): always an upper bound, and every tier admits the reasoned no-op. The same tiers bound
  the first pass's wall time (`DIFF_TIME_BUDGET_MS`: tiny 6 min, focused 12 min, broad none), because a
  step can be arbitrarily long and the step cap alone never ends a turn spent on a few slow ones. The
  budget covers the whole first pass: the session carries it and each prompt, the repair included, is
  given only what is left of it as its own `timeoutMs` (both runtimes); a repair with none left is not
  sent. A tier whose time the transport's own deadline (`agentPromptCapMs`) does not exceed sets no
  budget, since that deadline would fire first. A turn the budget stops ends `time-budget`, unless the
  main turn already delivered specs or declared a no-op, which stand when only the repair was cut.
  The tiers' times are operator-tunable without a rebuild: `QA_DIFF_TIME_BUDGET_MS_TINY`,
  `_FOCUSED` and `_BROAD` (a positive whole number of milliseconds, or `none` for no bound beyond the
  host's deadline; blank or unset keeps the default; anything else fails the composition loudly). They
  are resolved once in the composition root (`resolveDiffTimeBudgets`, qa-engine never reads the
  environment) and stay clamped by `agentPromptCapMs`: a value at or above it sets no budget.
  `E-TIME-BUDGET` is never learned from (DEV latency confounds it).
- **Run deadline** — one wall-clock deadline bounds the whole run, so no tier, mode, regeneration or
  repair is unbounded (`qa-run-orchestration/domain/run-time-budget.ts`, one named table:
  `diff-tiny` 25 min, `diff-focused` 40, `diff-broad` 60, `manual` 45, `complete` 90, `exhaustive` 150,
  `context` 60; override per row with `QA_RUN_TIME_BUDGET_MS_DIFF_TINY|DIFF_FOCUSED|DIFF_BROAD|MANUAL|COMPLETE|EXHAUSTIVE|CONTEXT`,
  a positive whole number of milliseconds, there is deliberately no `none`; a mistyped value fails the
  composition). The use case arms it once after classification (`RunDeadlinePort.arm`), because a diff
  run's row follows its change's size; it counts from there, so the deploy-gate wait is not on it. Every
  agent turn goes through `RunDeadlineRuntime`, a decorator over the agent runtime: a turn finding no time
  left is not sent, and every other runs under the smaller of its own limit and what is left (the tier
  budget above still applies, inside it). A turn the deadline itself ended (not one that hit a limit of
  its own) raises `RunDeadlineExceededError`, which the fail-open catches around agent turns rethrow
  (`rethrowIfRunDeadline`) and `RunQaUseCase.run` turns into a persisted `infra-error E-TIME-BUDGET` with
  a note naming the budget and the turn, nothing published and nothing learned. Deterministic phases
  (validation, a Playwright execution) are not cut: they have their own timeouts and the next agent turn
  meets the deadline. This is separate from `WallClockBudget` (`wallClockBudgetMs`), which only decides,
  before a fix-loop regeneration, whether another agent turn may start; it never stops a
  turn. An audit signal, not a lesson: a streak of `E-TIME-BUDGET` ends reaches the process audit alone
  (`observesOperatingSignal`), which logs an observe-only `recurring-time-exhaustion` finding; it never
  folds, reflects, opens a maintainer incident or changes a rule.
- **Contract repair** — the re-prompt that only restates a verdict (generator or reviewer) runs with tools
  disabled (`AgentPromptOpts.withoutTools`; OpenCode sends a per-prompt `tools` deny map, Codex has no
  per-prompt tool control and ignores it) and under its own short timeout (`REPAIR_TURN_TIMEOUT_MS`,
  2 min, further cut to the time left). A repair that outlasts its cap leaves the first answer standing:
  the generation then ends `no-verdict` (loudly noted) and an unreadable review fails closed. A timeout
  in a run with no tier budget (broad, other modes, a regeneration) is still the integration error it was,
  unless it is the run deadline.
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
  operation it joins (`generation/domain/route-ranking.ts`). A route's `implementationFiles`
  also gain the non-code files they declare by relative path literal (a page's template and
  style sheets), read strictly from the working copy (`infrastructure/bridges/implementation-resources.ts`).
  Brief routes keep their place in
  front, nothing is inferred from names, and a cross-repo run ranks only by the spec of an
  operation under the service's staged root.
- **Templated routes** — a route template of the map (`/shops/:province/:city`) is opened through a real
  link: the first capture renders the routes that are pages, and also the app root for the links it shows;
  `generation/domain/route-instantiation.ts` matches those same-origin pathnames to the template segment by
  segment (a template needs at least one literal segment), the cut is made on pages in rank order, not on
  templates, and the pages found are captured in a second pass labelled with both address and template. A
  template counts as opened only when the capture grounded its page at its own address; otherwise it is
  listed as not capturable, with why. The explorer is shown the map's route paths so its brief names pages
  by them.
- **Cross-run learning** — `qa-engine/src/contexts/cross-run-learning/`: deterministic
  rule fold, rule governance, curriculum, and the `qa-reflector` pass (distils
  `candidate`/`low`-confidence rules only; flaky/infra verdicts excluded). engram holds
  agent memory across runs. **The reflector is OFF by default** (`QA_REFLECTOR_ENABLED=true`
  turns it back on; `src/server/reflector-switch.ts`): it was handed a fragment of a run without its
  real error text and invented a cause from a false-positive gate signal, and the resulting rule
  told a shell-less generator to run `tsc`. With it off, no reflection is asked of an agent, and the
  composition root builds `SqliteLearningRepository` with `{ reflectorUnproven: false }`, so a rule the
  reflector authored reaches a prompt only once proven (active, confidence above low, earned from measured
  outcomes); no reflector candidate or "experimental" rule is injected or credited. A rule whose `source`
  carries the deterministic-distiller prefix keeps its normal governance (exploration slots included); every
  other rule, those stored before authorship was recorded too, counts as the reflector's. The fold, governance and the process audit
  stay on. **Quarantine**: `npm run learning:quarantine -- --app <app> --since <ISO date> [--dry-run]`
  (inside the orchestrator container) marks every in-force rule the app learned at or after the date
  (`learning_rules.quarantined_at`; `QuarantineLearnedRulesUseCase`). It deletes nothing, is idempotent,
  and a quarantined rule is excluded from governance retrieval, the live ledger and
  `recordRuleOutcome`; `ledger-cli show` lists it under QUARANTINED and `ledger-cli release <ruleId>`
  lifts it.

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
- **Suite store** (`qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts`,
  `data/suites/<app>/` in the qa-data volume, never mounted into the agents container): the accepted
  suite of an app that git does not hold yet. Shadow mode never publishes and a PR may not be merged
  yet, while every run's checkout wipes the untracked `e2e/`; without the store each run starts cold,
  re-seeds the stock login and orders the agent to author it again. An accepted run captures (specs
  that ran green *with the bytes that executed* (fingerprinted right after the final execution, so a
  reviewer-round or coverage regeneration never enters unproven), support files, the app's `auth.setup.ts`
  only when it actually signed in, and never a file byte-equal to the engine's seed in `config/e2e/`); the
  next run restores before setup (into a cold working copy it starts from the seed, then lays the stored
  files over it, so seed upgrades reach apps) and reconciles with git (untracked: store wins; tracked and
  unchanged since the entry was admitted: unpublished change overlaid; tracked and different: git wins,
  except a warm-seeded entry, which is pinned and wins over git). A stored copy that no longer matches its
  hash is rewritten by the next capture that holds the file. A restored
  login that fails to sign in is demoted and the stock seed takes its place. Store faults are off-path
  (logged, never a verdict). Context-map, session state, credentials and `.qa-probe/` never enter it.
  `deleteApp` with purge removes it (`suite:<name>`); a plain delete keeps it, like the mirror. Under
  `QA_CAMPAIGN_FREEZE` it is read-only; `warm-suite seed-store` loads an experiment snapshot into it
  (`docs/efficiency-benchmark.md`).

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
- **Agent-influenced code runs only through the execution launcher**
  (`qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts`, profiles `offline | suite | login | install`).
  Specs, the e2e project's `tsc`/`eslint`/`playwright --list`/`npm ci`, the login scripts, the DOM capture, a code-mode
  repo's install/test and the mutation oracle all start there: the sandbox uid, an environment built from an explicit
  allowlist per profile (never `scrubEnv(process.env)`), a per-run work dir (`/tmp/qa-exec/<runId>`) for Playwright's
  output, report and dumps, read back through the strict readers. **Only the `login` profile carries the test account**
  (a suite gets it only for an app that sets `e2e.specCredentials: account`); a suite gets a per-spawn copy of the saved
  session and never the auth dir. A new module that
  imports `child_process` is a build failure (`npm run arch:check`, rule `no-child-process-outside-launchers`); add a
  spawn site by adding a profile call, not an exception. `QA_EXEC_SANDBOX=required` (compose, and the default for root on Linux) refuses to run agent code
  without the sandbox uid (`infra-error E-SANDBOX`, never learned from, no Issue). Whatever a child leaves running is killed by uid
  (`sandbox-reaper.ts`) and nothing a child writes lands in the mirror the agent reads (the dump folders go through
  `run-dump-bridge.ts`).
- **The sandbox uid's network is closed by default.** An iptables chain matched on that uid redirects its DNS and TCP to a
  DNS filter and a transparent proxy that allow only the origins declared in config (`dev.allowedOrigins`, the app's own
  origin, `egress.installOrigins`, `config/egress/registries.yaml`); everything else, IPv6 and the other loopback ports
  included, is rejected. `QA_EGRESS_MODE=enforce` (default) ends a run `E-SANDBOX` when the filter is not active, and also when there is no sandbox uid to filter. Origins are
  data: never add a host in code. Denied hosts land in `gateSignals.sandbox.denied`.
- **File permissions are the boundary for secrets.** `bin/container-entrypoint.sh` closes `/app/data` (0700), `/app/config`
  (0750) and the mirrors at every boot; the sandbox uid reads one mirror at a time (the run opens it to its group and seals
  it again) and writes none of it. Do not give the sandbox uid, or a path it can write, a way to the API token, `/app/data`
  or another mirror.
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
  `agents/smoke/authbrowser-tool.smoke.mjs` in the new image (the plugin's `ToolContext` and the naming of a file's exports are what the
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

New "quality" logic should strengthen this signal (better line mapping, moving apps from
`signal` to `enforce`), not add another LLM proxy.

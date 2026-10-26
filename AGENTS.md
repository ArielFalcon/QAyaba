# AGENTS.md

## Golden rule — project-agnostic, model-agnostic, root-cause fixes

qayaba is built to test **any** project. The current declared scope is **Java and
JavaScript/TypeScript**, and it is designed to be extended to other languages through
the language registry (`qa-engine/src/shared-kernel/language-id.ts`)
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
repos; when a commit is deployed to DEV, an agent (OpenCode runtime)
generates Playwright tests for the change's blast radius, runs them **against the live
DEV site** (the app is never built or started here), and — when green, reviewer-approved
and covering the change — publishes them to the app repo's `e2e/` via a **PR with
auto-merge**. Failures open an Issue. The suite lives in git and improves run after run.

**Priority above features: stable, reliable, deterministic.** The hardest problem is
*trust*, not engineering — see [The value/trust risk](#the-valuetrust-risk).

## Repo map

| Path | What |
|---|---|
| `qa-engine/src/` | The engine: bounded contexts (`change-analysis`, `generation`, `coordination`, `agent-tools`, `test-execution`, `objective-signal`, `cross-run-learning`, `run-orchestration`, …), hexagonal. New engine logic goes here. |
| `src/` | The permanent shell around the engine (see [Boundary](#boundary-qa-engine--src)). |
| `src/settings/` | The typed Settings: one registry of every environment variable, `loadSettings(env)`, the store; `docs/settings.md` is generated from it. |
| `agents/` | `agents` container: OpenCode config (`opencode.json`), prompts (`AGENTS.md`, `agent/*.md`, `skill/`), MCPs (Serena, Playwright). |
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
npm run typecheck && npm run arch:check && npm run previous-forms:check && npm run seed:lint && npm run embedded:lint && npm run sdk:typecheck && npm run contract:check && npm run settings:check && npm test
(cd client && go vet ./... && go test ./...)
# arch:check has no baseline: the layering rules hold for every file, and the shell's deep imports of context internals are a frozen list
# (qa-engine/.dependency-cruiser-shell-exceptions.json) that may only shrink.

npm run seed:lint           # the e2e seed (config/e2e/) against its own ESLint config, as an app's static gate runs it
npm run previous-forms:check # banned terms of retired forms and dead file references (scripts/check-previous-forms.ts)
npm run embedded:lint       # the scripts that run as text in another process (qa-engine/src/**/embedded), typechecked by npm run typecheck (embedded:typecheck)
npm run settings:gen        # writes docs/settings.md from src/settings/registry.ts
npm run settings:check      # fails when docs/settings.md is stale
npm run mutate -- <preset>  # mutation testing per preset (scripts/mutate.ts)
npm run sandbox:smoke       # IN the running orchestrator container: proves the execution sandbox holds (docs/execution-sandbox.md)
npm run judge-calibrate -- --judge <name> [--min-n 20] # calibrate an LLM judge against human labels and persist the report (inside the orchestrator container; docs/observability-design.md §11.3)
npm run fault-calibrate -- --campaign <id> [--out <file>] # whether the response oracle's score holds still across a campaign's replicates (inside the orchestrator container); gates nothing
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
- `agents` — **the non-deterministic agent**: a supervisor fronting the OpenCode runtime
  (`opencode serve`) + MCPs. Writes `.spec.ts` files into the working copy.

Keep the two rigorously separate.

### Boundary: qa-engine ↔ src

`qa-engine/src` never imports from `src/` — enforced by `npm run arch:check`
(dependency-cruiser `no-src-import-in-qa-engine`). `src/` has four permanent roles:
- **Composition root** — `src/server/wire-app.ts` (settings, persistence, API, webhook, queue; `src/index.ts` only
  starts it), `src/server/engine-root.ts` (assembles the engine from each context's `composition/` builders) and
  `src/server/run-engine-factory.ts`, which maps each app's `AppConfig` into the engine's `EngineRootDeps` and wires the host collaborators (agent runtime, GitHub, runners).
- **Control plane** — `src/server/*` (webhook, queue, API, TUI surface) and `client/`. The control API is a route table
  (`src/server/api/route-table.ts`): each route declares its method, path and `auth`; handlers throw `ApiError` and every
  error answers `{ schemaVersion: 1, error }`; a known path with an unsupported method answers 405.
- **Provider I/O edges** — `src/integrations/opencode-client.ts` (raw SDK primitives
  only) and `src/agent-runtime/*` (provider-agnostic facade + the OpenCode strategy).
- **Persistence** — `src/server/persistence/` (schema, migrations, repositories) behind `getHistory()`, and
  `src/server/run-history-sqlite-adapter.ts`.

Seams are pinned by `src/server/seam-parity.contract.test.ts`.

### The run flow — start here

`RunQaUseCase` (`qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts`)
is the only engine; webhook (`src/server/webhook-handler.ts`, wired by `src/server/wire-app.ts`) and CLI (`src/cli.ts`) both enter through
`enqueueTrackedRun`. It walks a table of 47 named steps in 15 phases (`application/run-flow/run-steps.ts`, ids in `step-ids.ts`); a step returns one closed outcome (go on, go to a step, or end the run for a reason), every end goes through `finalizeRun` (`run-flow/finalize-run.ts`), the only place a run is saved, published, learned from and pruned, and every fault a step lets escape is classified by `failure-policy.ts` into rethrow, end, carry on or degrade. `diff` mode:

1. **Gate** — wait until DEV serves this SHA (`dev.versionUrl`; skipped when absent).
2. **Classify** — checkout, diff + message, `classifyCommit` (Conventional Commits
   cross-checked against the diff). `skip` → `skipped` without spending a token.
3. **Setup** — restore the app's accepted suite from the suite store (below), seed `e2e/` from
   `config/e2e/` for whatever is still missing, install deps.
4. **Ground** — assemble what the agent receives (see below).
5. **Generate** — the lead plans and author sidekicks (`qa-author`) write/improve specs + `e2e/.qa/manifest.json`; an independent
   reviewer judges. Authors for code, context and login-seed runs and for corrections are author sidekicks too, in the run's working copy, with no `run_spec` budget and no continuation session; an e2e run with no coordinator ends `E-NO-AUTHOR` (`no-coordinator`). Declared `noop` + zero specs → `skipped`. Zero specs without `noop`
   → `infra-error E-NO-DECISION`; no author sidekick able to run → `infra-error E-NO-AUTHOR`; step budget exhausted → `infra-error E-STEP-BUDGET`; a diff run's
   first pass stopped by its tier's time budget, or any agent turn of the run stopped by the run's
   wall-clock deadline (below) → `infra-error E-TIME-BUDGET`. With the closed loop on (below) the author of a flow may also
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
   → Issue. A reviewer that could not be reached (its session failed, or it returned nothing) judged
   nothing, which is not a rejection: the run ends as a persisted `infra-error` `E-REVIEWER-UNAVAILABLE`
   (the reviewer's reason on the run record and in the log, no PR and no Issue, nothing learned; three in
   a row log an observe-only audit finding). A reviewer that answered unreadably is still a fail-closed
   parse miss. The reviewer's findings are evidence-bound: a blocking correction must cite a contract
   clause, an execution of this run or a DOM fact, the orchestrator verifies the citation
   (`review-finding-filter.service.ts`) and only a verified blocking finding blocks — an uncited,
   out-of-scope or DOM-only one is advisory telemetry, never sent to the author. A finding that cites
   an arm of the changed code no test ran (`{"kind":"arm","ref":"<file>:<line>"}`, tagged
   `[missing-case]`) is a missing case: it is taken out before that filter whatever the integrity switch,
   kept only when the run's measurement lists that arm (the reviewer receives the list only while it
   describes the bytes under review), recorded in `gateSignals.missingCases` and shown in the PR or
   Issue, and it never blocks or rejects: a rejection resting only on missing cases is an approval. The author may
   answer a finding with a typed `rebuttals` entry instead of a correction; it withdraws the finding only
   against evidence the run can check (a case green on the current bytes, or a contract clause still
   intact — `review-rebuttals.service.ts`). A verified blocking finding that survives while its rebuttal
   stays unverified, with nothing delivered to correct it, is a judgment the engine cannot settle: the run
   ends as a persisted `infra-error` `E-REVIEW-DISPUTED` (no PR, no Issue, nothing learned, the finding and
   the rebuttal on the record). `shadow: true` replaces every PR/Issue with a log line. An accepted run
   (`isAccepted`: `pass`, generated, approved or review not required, coverage not blocking; shadow
   ignored) first captures its suite into the suite store, before publication.

Verdicts: `pass | fail | flaky | invalid | infra-error | skipped`
(`qa-engine/src/shared-kernel/run-verdict.ts`). `E-PRECONDITION` = login could not be
completed, or the fix loop's triage re-read confirmed DEV did not render the target: recorded,
never learned from, no Issue. The triage (review-loop integrity on) re-reads a failure once, with
no regeneration, when the evidence does not blame the test: its target is absent while the same
bytes passed through `run_spec`, or its failure point read an empty data state (`dev.dataState`)
on a page this run's Context Pack read with results. The failure capture states whether the page
had settled (data requests in flight, a second read of the tree), and the regeneration prompt says so.

**Modes** (`--mode`): `diff` (default, the only one that classifies), `complete`
(analyze repo + suite, `e2e/.qa/analysis.json`, cover important gaps), `exhaustive`
(re-evaluate and regenerate the whole suite), `manual` (focused by `--guidance`). Prompts
are assembled in `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts` from section registries (`generator-sections.ts`, `reviewer-sections.ts`): each section declares when it applies and how it renders from one derived context.

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
  `qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts`
  (fail-open): the stored context map, reused at another sha only when the files it names are unchanged between the two
  commits (`run-orchestration/domain/context-map-validity.ts`; otherwise the run grounds without it and a rebuild at
  the run's sha is requested, recorded as `recapture` requested/skipped, see `docs/observability-design.md`),
  context pack (live DOM per route, redirect advisory, relevant API contracts, routes not
  capturable — `generation/infrastructure/context-pack.ts`), harness facts
  (`generation/domain/harness-facts.ts`), existing-suite manifest.
- **Pre-exec / review grounding** — `pre-exec-grounding-port.adapter.ts`,
  `review-dom-grounding-port.adapter.ts` (same folder).
  The pre-exec selector-ambiguity check is a regex over the spec text and **advisory**: its findings
  are counted (`preExecAmbiguityCatches`) and logged as a warning, never fold the verdict, request a
  regeneration or feed the FixLoop; execution decides. Only the catalog gate's fabricated test-ids
  (a captured, settled route) feed the one-shot corrective regeneration.
- **Closed loop (`run_spec`)** — on unless `qa.closedLoop.enabled: false` (or a run asks: `--closed-loop on|off`, `closedLoop` on
  `POST /api/v1/runs`). The author of each flow of a plan gets one custom tool, `agents/tool/run_spec.ts`, that POSTs its session id and
  agent name to the orchestrator's internal listener (`src/server/tools-endpoint.ts`, `QA_TOOLS_PORT`, not published, behind
  `QA_TOOLS_TOKEN`); the orchestrator runs the spec once (sandbox profile `suite`, retries 0, a fresh session copy, namespace
  `<runId>-rs<n>`, a cleanup pass after every call, per-account lock) and answers with a bounded, redacted report, never raw
  output. The capability (`test-execution/domain/run-spec-capability.ts`) is the orchestrator's, bound to the flow-author
  sessions the agent transport reports for the run (`ClosedLoopRegistry`); the budget is granted per flow of a plan only, so a run-level author holds none: caps on calls, time per call (also bounded by the
  run deadline) and DEV writes (counted by the capture block's ledger in `fixtures.ts`, a spec must import its `test` from
  there), a ledger of every call's sha256, revoked when the run ends. Scratch specs live in `e2e/.qa-probe/` and are swept
  after every generation: never delivered, stored or validated. When `loopClosed` (every delivered spec's current bytes are those
  whose last call passed) the regenerations that only repeat that work are skipped; the declared no-op, `E-NO-DECISION` /
  `E-STEP-BUDGET` / `E-TIME-BUDGET` and the single coverage or branch-case regeneration are unchanged. The `Run spec budget` prompt
  section (facts only) exists only when granted. `gateSignals.closedLoop { calls, devWrites, closed }`.
- **Authenticated browser (`authbrowser_*`)** — on unless `qa.agentBrowser.enabled: false`, and skipped for a run with no saved session (or a run asks: `--agent-browser on|off`,
  `agentBrowser` on `POST /api/v1/runs`). The author (`qa-author`) and the explorer (`qa-explore`, read-only) get four custom tools
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
  for the author or the explorer of the run; the capability is revoked, the browser closed and its work dir removed when the run ends, and
  a boot sweep ends a browser a previous process left. A prompt of an authoring session the run did not grant hides the tools
  (a per-prompt `tools` map, `openCodePromptBody`). The `Authenticated browser budget` prompt section (facts only) exists only
  when granted.
- **Code-graph tools (`codegraph_*`)** — on for every e2e run (the code graph is part of the grounding, no setting switches it off). The
  lead (`qa-lead`) and the explorer (`qa-explore`) get the read-only code-graph tool (`codegraph_explore`, `agents/tool/codegraph.ts`) that POSTs to the same internal listener (`/internal/codegraph`, `QA_TOOLS_TOKEN`). The orchestrator admits
  the query (`agent-tools/domain/code-graph-query.ts`: known keys, bounded values, no free graph query, nothing that
  indexes or deletes), binds it to the repositories of the run's change (the graph holds every app's code and is never mounted into the agents
  container) and runs the code-graph engine (`codegraph`, ADR-0002); the answer is redacted string by string (a secret JSON escapes is still found) and cut by its structure, so it stays JSON. On a run over several repositories one call answers over each repository of the change, sections labelled by repository. `CodeGraphToolRegistry` binds the lead's sessions
  of the run (an explorer's only with its delegation id and a share of the run's calls), calls are capped per run (`DEFAULT_CODE_GRAPH_TOOL_LIMITS`), and the capability is revoked when the run ends. A prompt
  of a `qa-lead` or `qa-explore` session the run did not grant hides the tools. Calls are spans (`qayaba.tool.codegraph`) and the run log
  counts them.
- **Lead and sidekicks (`qa.coordination`)** — the only coordination: every e2e run that generates has the lead return a **plan**
  instead of specs (`LeadPort.plan`, a read-only turn) and each flow authored by an author sidekick (`qa-author`) in parallel. A code run, a context run and a login still to be written never coordinate: one author sidekick writes them in the run's working copy (no plan, no `run_spec` budget); the lead never writes tests. `qa.coordination`
  only sets the limits. The lead grounds deterministically (no agent turn), the plan turn's
  diff names the app's own test files instead of showing them (`LanguageRegistry.isTestFile`), it is the read-only `qa-lead` agent (no write, shell, fetch, `run_spec`, authenticated browser, location or Playwright tool, by its roster entry), and it explores with the code-graph tools. Before it plans it may ask once for exploration (at most 3 questions): read-only `qa-explore` sidekicks answer them in the run's working copy with the code graph and the authenticated browser, and the orchestrator labels every finding verified, contradicted or unverified from what it holds itself (the Context Pack, the browser's own ledger, the code graph) before the lead sees it; the lead then plans in the same session. A diff over the prompt cap keeps every whole file section that fits
  (code before style sheets) and lists each one left out with its added and removed lines (`prompt-cap.ts`), and the plan turn is told the
  use cases the change makes testable (`PlanningLimits.candidates`): the plan must cite each direct one in a flow's `candidates` or list it in `dropped` with a reason, otherwise the lead is asked once more in its open session, and what is still unresolved is recorded `unplanned` on the plan snapshot and as a `lead-decision` event (`plan-coverage.ts`). The plan is untrusted: `admitLeadPlan` keeps only what its shape and the
  run's limits allow (`maxFlows`, a deterministic spec path `e2e/flows/<slug>.spec.ts` per flow, the lead's own write lists ignored) and
  refuses the run with a recorded reason otherwise (`E-NO-AUTHOR`; no author is run in the lead's place). Each sidekick works in a plain bounded copy of what the run may read
  (`<mirrors>/.qa-delegations/<run>/<delegation>`, `DelegationWorkspacePort`); only the files its brief names (`writablePaths`) are taken
  back, through `spec-path-confinement`, and anything else it changed is listed as a proposal and never applied. Each brief carries
  the Live DOM of its flow's pages, cut from the run's Context Pack (`generation/domain/pack-pages.ts`). A pool of at most
  `maxParallel` flows runs under `FanOutDispatcher` (a signal and a time per flow, a throwing flow isolated); each flow closes its own
  `run_spec` loop (`ClosedLoopHandle.openFlow`, the same `AccountLock` lease, its own caps and namespace) and, with a login, reads DEV
  through the orchestrator's authenticated browser with a share of the run's caps. What a sidekick may author with is
  `sidekickAuthoring`: authenticated browser, `run_spec` only, the plain browser for an app with no login (one flow at a time), or
  excluded (a login with neither grant): the run then ends `E-NO-AUTHOR` and the log says why. Each flow is authored
  once; then the lead **reviews** the flows in its planning session (kept open by the plan, asked read-only, at most `MAX_REVIEW_TURNS`
  turns inside the run's deadline and reserve; `lead-review.ts`): it sees each flow's objective, outcome, the sidekick's summary, the
  `run_spec` facts and the delivered spec (through the confined reader), and answers per flow `accept`, `revise` (its instruction to the
  SAME sidekick session, which is kept with its workspace and loop until the pass ends), `replace` (a fresh sidekick on the escalated
  model) or `drop`. Its answer is untrusted and the orchestrator's facts decide over it: an `accept` of a spec that has not passed
  `run_spec` on its current bytes is sent back while it can run and a turn is left; an app defect (5xx, uncaught runtime error, by the
  fixed rules of `authoring-failure.ts`) is never sent back to be made green (the spec that showed it is delivered); what a sidekick wrote is taken back whatever its turn ended in; a
  delivered spec is never dropped. Every revision carries the orchestrator's facts (the failure kind of the last `run_spec` call, and
  the two reads when a flow's empty read contradicts a page the Context Pack read with results, which also refuses that flow's
  decline). Flows that deliver are added up like a generation (`aggregateFlowOutcomes`), and the rest of the run (validate,
  execute, coverage, review, decide) goes on as for any generation, with the pass kept open (`CoordinatedPass`: the lead's session and
  every flow's session, workspace, loop and location) until the review ends. The reviewer's verified corrections go to the lead
  (`lead-correction.ts`), which routes each to the flow whose spec it cites (revise in the same sidekick session, replace with a fresh
  one) or rebuts it; the orchestrator's facts decide over its answer (a finding that cites a flow goes to it and to no other), the
  workspace is refreshed from the working copy first, a finding no flow took goes to a regeneration, and the result goes through the
  round's acceptance and rebuttal check like any regeneration. The run's own checks before the review take the same route: the
  static gate's errors (one finding per error block), a failing execution's cases in the fix loop (and the contract deltas of a
  round the intent lock refused), the pre-execution selector contradictions and the change-coverage gap (the changed lines no test ran and the
  arms of their decisions that never ran) each go to the lead as
  facts it routes to their flows and never rebuts; what no flow takes goes to the lead's own regeneration with only that evidence,
  and the run's acceptance of the round is unchanged. The run releases the pass after the review and in its `finally`. DEV access: every action holds its account's lease (`DevLease`, an `AccountLock`
  whose read-only concurrency is gated by the proxy; the proxy has no read-only mode yet, so today every action is exclusive).
  Workspaces are removed in a `finally` and swept at boot. `gateSignals.coordination { plan, refusal, flows, delivered,
  incomplete, authoring, review, corrections }`. `docs/lead-sidekicks.md`.
- **Authoring location (`dev.geolocation`)** — the app declares a durable browser position (the suite, `run_spec` and the
  Context Pack run at it) and may declare named `places`. The run carries a mutable authoring location — the lead's, and one
  per flow of a plan — that the `set_geolocation` tool moves for the authenticated browser and the prompts; a plan may name a
  place per flow and a flow without one inherits the lead's. It never enters the delivered suite: a spec whose result depends
  on a location pins it with `setLocation(context, latitude, longitude)`.
- **Step limit and milestone** — the author, lead and reviewer prompts state the cap
  their runtime enforces (facts-only `step-limit` section): one live read per run of the
  OpenCode server's resolved agents (`steps`, the deprecated `maxSteps` mapped into it; `stepLimits`
  in `src/agent-runtime/`), never the orchestrator's own copy of `agents/opencode.json`. A turn whose prompt
  stated none (a sidekick's) is classified against the cap the server last listed for its agent
  (`turnStepLimit`); the file, baked into the orchestrator's image, only for an agent never listed. A role with no resolved limit
  (failed read or uncapped agent) states none. The
  author's test-writing turns (diff/manual first passes, every regeneration) add a
  `step-milestone` directive, counted by the prompt-contract lint, at half the limit: the first
  spec or a reasoned no-op; on a regeneration, the first correction or why none applies (the
  verdict's `noop.reason`). Exhaustion is classified against the number the prompt stated.
  Whether the runtime's count resets every turn is still open (the statement holds either way;
  see `docs/efficiency-benchmark.md`).
- **Effort tier** — an e2e `diff` first pass gets the diff's real size and the effort its tier
  warrants (`shared-kernel/diff-stat.ts`: tiny ≤2 files and 40 lines, focused ≤8 and 400,
  broad above): always an upper bound on spec files (a flow each), each holding a test per behaviour
  the change decides (its success and each other state it handles that the page can be brought to
  through the UI), and every tier admits the reasoned no-op. A lead's plan names one acceptance
  outcome per such behaviour, and an author writes a test per criterion. The same tiers bound
  the first pass's wall time (`DIFF_TIME_BUDGET_MS`: tiny 6 min, focused 12 min, broad none), because a
  step can be arbitrarily long and the step cap alone never ends a turn spent on a few slow ones. The
  budget covers the whole first pass: the session carries it and each prompt, the repair included, is
  given only what is left of it as its own `timeoutMs`; a repair with none left is not
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
  repair is unbounded (`run-orchestration/domain/run-time-budget.ts`, one named table:
  `diff-tiny` 25 min, `diff-focused` 40, `diff-broad` 60, `manual` 45, `complete` 90, `exhaustive` 150,
  `context` 60; override per row with `QA_RUN_TIME_BUDGET_MS_DIFF_TINY|DIFF_FOCUSED|DIFF_BROAD|MANUAL|COMPLETE|EXHAUSTIVE|CONTEXT`,
  a positive whole number of milliseconds, there is deliberately no `none`; a mistyped value fails the
  composition). The use case arms it once after classification (`RunDeadlinePort.arm`), because a diff
  run's row follows its change's size; it counts from there, so the deploy-gate wait is not on it. Every
  agent turn goes through `RunDeadlineRuntime`, a decorator over the agent runtime: a turn finding no time
  left is not sent, and every other runs under the smaller of its own limit and what is left (the tier
  budget above still applies, inside it). A turn the deadline itself ended (not one that hit a limit of
  its own) raises `RunDeadlineExceededError`, which `guarded` (the failure policy) turns into a persisted `infra-error E-TIME-BUDGET` with
  a note naming the budget and the turn, nothing published and nothing learned. Deterministic phases
  (validation, a Playwright execution) are not cut: they have their own timeouts and the next agent turn
  meets the deadline. The deadline is the one time authority: the first generation pass is bounded by the smaller of its tier budget and what the deadline has left (`RunDeadline.allowance`), and a fix-loop regeneration starts only while the deadline has time left and the configured `wallClockBudgetMs` is not spent (`regenerationAllowed`); neither stops a turn already running. A deadline that expires after a suite ran green on its final bytes degrades the run to publication with the proven suite when no review verdict is required (`deadline-after-proof`). An audit signal, not a lesson: a streak of `E-TIME-BUDGET` ends reaches the process audit alone
  (`observesOperatingSignal`), which logs an observe-only `recurring-time-exhaustion` finding; it never
  folds, reflects, opens a maintainer incident or changes a rule.
- **Contract repair** — the re-prompt that only restates a verdict (author or reviewer) runs with tools
  disabled (`AgentPromptOpts.withoutTools`; OpenCode sends a per-prompt `tools` deny map) and under its own short timeout (`REPAIR_TURN_TIMEOUT_MS`,
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
  style sheets), read strictly from the working copy (`infrastructure/adapters/implementation-resources.ts`).
  Brief routes keep their place in
  front, nothing is inferred from names, and a cross-repo run ranks only by the spec of an
  operation under the service's staged root. The cut is `MAX_ROUTES` pages, raised to as many as the change is
  linked to, up to `MAX_ROUTES_PER_CHANGE`.
- **Templated routes** — a route template of the map (`/shops/:province/:city`) is opened through a real
  link: the first capture renders the routes that are pages, and also the app root for the links it shows;
  `generation/domain/route-instantiation.ts` matches those same-origin pathnames to the template segment by
  segment (a template needs at least one literal segment), the cut is made on pages in rank order, not on
  templates, and the pages found are captured in a second pass labelled with both address and template. A
  template no link fits is opened at the page the app declares for it (`dev.routeSamples`, a real page that
  fills the template segment by segment; a link the site showed comes first), for an app that navigates by
  script. A declared page is first rendered beside its sibling that cannot exist (its last parameter replaced by
  `qayaba-no-such-page`); one whose tree is that sibling's is the site's "nothing here" page, gone from DEV, and is
  listed as not capturable with why instead of delivered. A template counts as opened only when the capture grounded its page at its own address; otherwise it is
  listed as not capturable, with why.
- **Cross-run learning** — `qa-engine/src/contexts/cross-run-learning/`: deterministic
  rule fold, rule governance, curriculum, and the `qa-reflector` pass (distils
  `candidate`/`low`-confidence rules only; flaky/infra verdicts excluded). No agent keeps a memory of its own across
  runs: an agent memory held what the agent believed, with no SHA, no expiry and no check against DEV,
  and later runs read those beliefs as facts over what the Context Pack read live; what a run reuses
  comes from the orchestrator (the suite store, this ledger, the Context Pack). **The reflector is OFF by default** (`QA_REFLECTOR_ENABLED=true`
  turns it back on; `src/server/reflector-switch.ts`): it was handed a fragment of a run without its
  real error text and invented a cause from a false-positive gate signal, and the resulting rule
  told a shell-less author to run `tsc`. With it off, no reflection is asked of an agent, and the
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

Provider-agnostic runtime (`src/agent-runtime/`): each role is assigned a provider + model;
OpenCode is the one strategy today and another runtime is added as a strategy behind the same
facade. The agents are the lead (`qa-lead`, plans and reviews, read-only), the author
(`qa-author`, the one agent that writes tests, for a flow or for the run's own task), the
explorer (`qa-explore`, read-only, asked for by the lead before it plans) and the reviewer
(`qa-reviewer`), beside the maintainer, assistant, reflector and proposer. `agents/opencode.json`
is the source of truth for the roster, models and per-role step limits (`maxSteps`). Prompt layers:
`agents/AGENTS.md` (shared rules) → `agents/agent/*.md` (per-role procedure + JSON contract) →
`agents/skill/` (on-demand craft). Static layers are linted against assembled prompts
(prompt-contract lint) and size-budgeted.

The static layers are **consume-first**: use what the prompt supplies at the confidence it
states and look up only what it lacks; to change a flow, find its existing spec, read it, and
update it. The author is done once its specs are written or it has decided nothing is worth a
test, and the verdict is its last action.

`qa-maintainer` self-repairs THIS repo via fix PRs; auto-deploy only with
`SELF_MAINTAINER_AUTOMERGE="true"`, behind `src/server/merge-guard.ts` (read its
threat-model header first) and a canary-before-promote hot-swap.

### Persistence & onboarding

- The suite's source of truth is **git** (app repo `e2e/`). Run history and the learning ledger
  (`qayaba-data` volume) are the only non-regenerable data; Serena index and mirrors are caches.
- The history database carries a schema version (`PRAGMA user_version`). Opening never prunes; retention (`pruneHistory`) runs at boot and every 24 h. A file that does not match schema 1 is refused at start with `history database at <path> predates schema 1 and cannot be adopted; remove or move it aside`; nothing deletes it.
- Onboarding an app = `config/apps/<app>.yaml` + `.env`. `${VARS}` expand from the env.
- **Suite store** (`qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts`,
  `data/suites/<app>/` in the qayaba-data volume, never mounted into the agents container): the accepted
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
  map gives it, so it carries no `read` block. `agent-tool-surface.test.ts` derives each role's resolved rules from `agents/opencode.json`.
- **`opencode serve` is never open.** The supervisor always starts it with `OPENCODE_SERVER_PASSWORD` (the value
  compose gives the `agents` and `orchestrator` services, or a random one when unset, with a loud warning), and the
  orchestrator's clients (`src/integrations/opencode-server-auth.ts`) send it as Basic auth, refuse to be built
  without it and throw on a 401. The value is never logged, is scrubbed from untrusted spawns and from supervisor
  responses, and must be identical on both services.
- **The agents container never holds the test account.** `DEV_TEST_USER`/`DEV_TEST_PASS` are not in its compose
  environment: the app login is the orchestrator's (`AuthSessionAdapter`) and the agent only gets the saved session.
  `DEV_ENV_*` (the DEV HTTP Basic gate) stays, for the baseline arm's Playwright config.
- **A watched repo cannot configure the agent.** OpenCode merges a session directory's `opencode.json` and
  `.opencode/` (permission overrides, plugins that run code, MCP servers) over `agents/opencode.json`; a mirror is a
  watched repo's working copy. The supervisor starts `opencode serve` with `OPENCODE_DISABLE_PROJECT_CONFIG=true`
  (verified live: a hostile `opencode.json` raised the author to `bash: allow` and a `.opencode/plugin` ran code
  just by listing agents, both gone with the flag). Only the baseline experiment opts back in (`AGENT_ALLOW_PROJECT_CONFIG=true`).
  A repo's `AGENTS.md`/`CLAUDE.md` stay prompt text, the same trust class as the source the agent reads.
- **`run_spec` does not give the agent a way to run code.** The agent asks; the orchestrator, which owns every limit, runs a
  spec file the agent wrote in the sandbox. A call is served only for a session the transport bound to `qa-author` for a flow of a live
  run (the run-level author holds no `run_spec`), behind a service token on an unpublished port the sandbox uid cannot reach; the path is confined to `*.spec.ts` of the
  suite (never `auth.setup.ts`, never outside `e2e/`), read with the strict reader, and answered without raw process output.
  Never widen the tool to another agent, a free-form command or a path outside the spec directory.
- **The authenticated browser never gives an agent the session, and never writes.** The agent asks; the orchestrator's browser, in
  the run's sandbox, holds the session in memory and reads. The surface is four actions (no evaluate, no script injection, no file
  chooser, no download); every request passes the route guard, which fails closed; service workers are blocked; the saved session is
  never staged to the browser's process nor written by it (`npm run arch:check` fails on a file API in the browser modules and on
  `playwright-core` outside its loader). A call is served only for a session the transport bound to `qa-author` or `qa-explore` of
  a live run (the explore role is read-only whatever the app's `allowMutating` says), behind the service token; every other role denies the tools (`agents/opencode.json`, pinned by a test).
  Never widen the tools to another role, add an action that runs script or sends a file, or let a mutating request through without an
  `allowMutating` entry the app's config names.
- **The code-graph tool reads the index of each repository of the run's change, and only through the orchestrator.** The agent names terms; the orchestrator
  admits them, names the repos and the workspace, sets the file cap and runs the engine. Never forward a repo, a project, a path or an option
  the agent names, let a term start with `-`, add a free graph query or an action that indexes, deletes or writes, mount the graph store
  into the agents container, or widen the tool beyond `qa-lead` and `qa-explore` (an explore session only with its delegation id and a share of the run's calls).
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
  (`RedactionPortAdapter`: the engine's pattern policy plus the orchestrator's own environment secrets); diff/commit text → prompts via
  `sanitizeText` in `qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter.ts`. The run's own account
  secrets (login, DEV gate, certificate passphrase, session cookie and storage values) are
  also redacted **by value** (`shared-kernel/run-secret-redaction.ts`: one scope per run,
  applied in both redaction paths and at the agent transport before the patterns look).
- **Logging is redacted at the port.** Production code logs through `LoggerPort` (`appLogger` in the shell, `engineLog` in the engine); the redacting adapter redacts the message and every field before `logJson` writes. A raw `console` call is a test failure (`src/no-console.test.ts`).
- **One settings object.** The shell reads its environment in `loadSettings`; a new variable is a registry entry (`src/settings/registry.ts`) with a type, default and description, and `npm run settings:gen` regenerates `docs/settings.md`. A secret is marked `secret: true`: it never has a documented default and a dump of the settings shows it as `[set]`.
- **Everything in English**; comments describe the final state, not the process.

## Conventions & gotchas

- **Dependency injection is the testing strategy.** `RunQaUseCase` runs on ports
  (one per file, `<kebab-name>.port.ts`, in each context's `application/ports/`) wired by the contexts' `composition/` builders and `src/server/engine-root.ts`;
  orchestration is unit-tested with fakes. Real integrations (agent runtime, Playwright,
  git) are the deliberately uncovered boundaries; each exports `*Deps` + `default*Deps`.
  Follow that pattern for new side-effecting code.
- **No build step** — `tsx` is a devDependency; install ALL deps in Docker.
- **When the OpenCode pin or `@opencode-ai/plugin` moves**, re-run `agents/smoke/run-spec-tool.smoke.mjs` and
  `agents/smoke/authbrowser-tool.smoke.mjs` and `agents/smoke/codegraph-tool.smoke.mjs` in the new image (the plugin's `ToolContext` and the naming of a file's exports are what the
  tools depend on). **When Playwright moves**, `playwright-core` in `package.json` moves with
  it, and `npx tsx scripts/agent-browser-smoke.ts` is re-run in the new orchestrator image (see `docs/execution-sandbox.md`).
- **Pin exact versions on the execution path** — Playwright `1.60.0` matches the
  `playwright:v1.60.0-noble` image. Never use `^`. The OpenCode build is pinned in
  `agents/Dockerfile`: when the pin moves, re-run the three smoke scripts above in the new image.
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
   Mutation presets narrow a file by anchor (`path.ts#Name`, or `path.ts@scope` between `mutation-scope` marker comments), never by line number (`docs/testing-standards.md`, Mutation policy).

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
- **Branch cases** (never a gate; `qa.changeCoverage.branchCases`, default `regenerate`): a green diff run
  whose measurement blocks nothing and found untaken arms on changed lines gets **one** regeneration (the
  step `regenerate-for-branch-cases`) with those arms as the cases still missing (a blocking enforce
  measurement regenerates for coverage instead, with the same arms in its gap). It goes through acceptance
  like any regeneration; an accepted one is recounted from the dumps already on disk (the first run's minus
  those of the re-run spec files, plus the acceptance's), never by re-running DEV.
  `gateSignals.branchCases { outcome, armsBefore, armsAfter? }`. A run deadline spent during it is the
  run's degrade (`deadline-after-proof`), as for the coverage regeneration.
- **Missing cases**: the reviewer gets the arms still untaken and may cite one (`arm`, `[missing-case]`).
  A cited arm the run listed is recorded (`gateSignals.missingCases`) and shown in the PR or Issue; it
  never blocks or rejects.

- **Causal label and calibration** (record only, never a gate): `gateSignals.causal` labels a failure by whether the change reaches it, `coverageByCandidate` and `valueByCandidate`/`valueStats` hold the per-use-case coverage and kill rates, and `npm run fault-calibrate` gives each campaign variant a calibration verdict. The response oracle corrupts only the operations the change reaches and writes no score without a scope.

New "quality" logic should strengthen this signal (better line mapping, moving apps from
`signal` to `enforce`), not add another LLM proxy.

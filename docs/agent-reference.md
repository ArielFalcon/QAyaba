# Agent reference — deep detail for AGENTS.md

On-demand reference for the parts of [`AGENTS.md`](../AGENTS.md) that matter only when you change the engine's run decisions, the context an agent receives, or the suite store. `AGENTS.md` is the always-loaded contract; this file is the detail behind its pointers.

Nothing here is optional reading for the areas it covers: the rules are normative, they are just too detailed to load on every session.

## Run flow and decision semantics (full)

9. **Decide** — green + approved + coverage not blocking → PR. Rejected/`fail`/`invalid`
   → Issue. A reviewer that could not be reached (its session failed, or it returned nothing) judged
   nothing, which is not a rejection: the run ends as a persisted `infra-error` `E-REVIEWER-UNAVAILABLE`
   (the reviewer's reason on the run record and in the log, no PR and no Issue, nothing learned; three in
   a row log an observe-only audit finding). A reviewer that answered unreadably is still a fail-closed
   parse miss. The reviewer's findings are evidence-bound: a blocking correction must cite a contract
   clause, an execution of this run or a DOM fact, the orchestrator verifies the citation
   (`review-finding-filter.service.ts`) and only a verified blocking finding blocks — an uncited,
   out-of-scope or DOM-only one is advisory telemetry, never sent to the generator. A finding that cites
   an arm of the changed code no test ran (`{"kind":"arm","ref":"<file>:<line>"}`, tagged
   `[missing-case]`) is a missing case: it is taken out before that filter whatever the integrity switch,
   kept only when the run's measurement lists that arm (the reviewer receives the list only while it
   describes the bytes under review), recorded in `gateSignals.missingCases` and shown in the PR or
   Issue, and it never blocks or rejects: a rejection resting only on missing cases is an approval. The generator may
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


### What the agent receives: grounding and learning

The harness pre-computes context so the agent does not have to rediscover it. Any change
to the agent's behaviour must make it **consume** this context, not re-derive it:
- **Pre-generation grounding** —
  `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts`
  (fail-open): the stored context map. Before a run starts, the runner rebuilds the map at the run's sha in the same
  queue turn when it is missing, marked stale, or does not fit the commit (`src/server/context-map-wiring.ts`, once per app
  and commit). A map built at another sha is reused when its route declarations and named files still hold; a page whose
  implementation files were only modified keeps its route without its front-to-back links
  (`qa-run-orchestration/domain/context-map-validity.ts`). A map that still does not fit is left out and a rebuild at the
  run's sha is requested once per commit, recorded as `recapture` requested/skipped, see `docs/adr/0001-grounding-telemetry-quality.md`),
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
  `E-STEP-BUDGET` / `E-TIME-BUDGET` and the single coverage or branch-case regeneration are unchanged. The `Run spec budget` prompt
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
- **Code-graph tool (`codegraph_explore`)** — on for an e2e run whose structural signal is on and whose generator runs on OpenCode. The
  lead (`qa-generator`, never a sidekick) gets one read-only action (`agents/tool/codegraph.ts`: `explore`) that POSTs to the same
  internal listener (`/internal/codegraph`, `QA_TOOLS_TOKEN`). The orchestrator admits the call (`qa-run-orchestration/domain/code-graph-query.ts`:
  1 to 8 terms of at most 200 identifier or path characters, none starting with `-`, passed to the engine after `--`; no free graph
  query, nothing that indexes or deletes), binds it to the run's own repo and index (the graph holds every app's code and is never mounted
  into the agents container), decides the file cap and the size of the answer itself, and asks the engine through `CodeExplorePort`.
  The answer is the engine's text, redacted by value and by pattern and cut only between files, with an omission marker, so no code block is
  partial; it carries the index SHA (`qayaba.code_graph.sha` on the call's span). `CodeGraphToolRegistry` binds the lead's sessions
  of the run, calls are capped per run (`DEFAULT_CODE_GRAPH_TOOL_LIMITS`), and the capability is revoked when the run ends. A prompt
  of a `qa-generator` session the run did not grant hides the tool. Calls are spans (`qayaba.tool.codegraph`) and the run log
  counts them; Codex has none.
- **Lead and sidekicks (`qa.coordination`)** — the only coordination: every e2e run that generates has the lead return a **plan**
  instead of specs (`GenerationPort.plan`, a read-only turn, `plan` in the generator's verdict) and each flow authored by a sidekick in parallel. A code run, a context run and a login still to be written never coordinate; `qa.coordination`
  only sets the limits. The lead grounds deterministically (no agent turn), the plan turn's
  diff names the app's own test files instead of showing them (`LanguageRegistry.isTestFile`), its session is denied Playwright
  (`LEAD_PLAN_DENIED_TOOLS`), and it explores with the code-graph tool. A diff over the prompt cap keeps every whole file section that fits
  (code before style sheets) and lists each one left out with its added and removed lines (`prompt-cap.ts`), and the plan turn is told the
  pages of the map the change is linked to (`PlanningLimits.changeRoutes`: the map's own links first, then up to six pages the run's call graph
  proved the change reaches, each with its basis and shortest proof on the run's record — `qa-run-orchestration/domain/change-pages.ts`);
  a page no admitted flow visits is a `router` event. The plan is untrusted: `admitLeadPlan` keeps only what its shape and the
  run's limits allow (`maxFlows`, a deterministic spec path `e2e/flows/<slug>.spec.ts` per flow, the lead's own write lists ignored) and
  hands the change back to the lead (`lead`, the lead authors it alone) with a recorded reason otherwise. Each sidekick works in a plain bounded copy of what the run may read
  (`<mirrors>/.qa-delegations/<run>/<delegation>`, `DelegationWorkspacePort`); only the files its brief names (`writablePaths`) are taken
  back, through `spec-path-confinement`, and anything else it changed is listed as a proposal and never applied. Each brief carries
  the Live DOM of its flow's pages, cut from the run's Context Pack (`generation/domain/pack-pages.ts`). A pool of at most
  `maxParallel` flows runs under `FanOutDispatcher` (a signal and a time per flow, a throwing flow isolated); each flow closes its own
  `run_spec` loop (`ClosedLoopHandle.openFlow`, the same `AccountLock` lease, its own caps and namespace) and, with a login, reads DEV
  through the orchestrator's authenticated browser with a share of the run's caps. What a sidekick may author with is
  `sidekickAuthoring`: authenticated browser, `run_spec` only, the plain browser for an app with no login (one flow at a time), or
  excluded (a Codex sidekick, or a login with neither grant): the lead then authors alone and the log says why. Each flow is authored
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
  Workspaces are removed in a `finally` and swept at boot. `gateSignals.coordination { plan, downgrade, flows, delivered,
  incomplete, takeover, authoring, review, corrections }`. `docs/lead-sidekicks.md`.
- **Authoring location (`dev.geolocation`)** — the app declares a durable browser position (the suite, `run_spec` and the
  Context Pack run at it) and may declare named `places`. The run carries a mutable authoring location — the lead's, and one
  per flow of a plan — that the `set_geolocation` tool moves for the authenticated browser and the prompts; a plan may name a
  place per flow and a flow without one inherits the lead's. It never enters the delivered suite: a spec whose result depends
  on a location pins it with `setLocation(context, latitude, longitude)`. Codex has no custom tool and states the facts only.
- **Step limit and milestone** — the generator and reviewer prompts state the cap
  their runtime enforces (facts-only `step-limit` section): one live read per run of the
  OpenCode server's resolved agents (`steps`, the legacy `maxSteps` mapped into it; `stepLimits`
  in `src/agent-runtime/`), never the orchestrator's own copy of `agents/opencode.json`. A turn whose prompt
  stated none (a sidekick's) is classified against the cap the server last listed for its agent
  (`turnStepLimit`); the file, baked into the orchestrator's image, only for an agent never listed. A role with no resolved limit
  (failed read, uncapped agent, or Codex, which has no step budget) states none. The
  generator's test-writing turns (diff/manual first passes, every regeneration) add a
  `step-milestone` directive, counted by the prompt-contract lint, at half the limit: the first
  spec or a reasoned no-op; on a regeneration, the first correction or why none applies (the
  verdict's `noop.reason`). Exhaustion is classified against the number the prompt stated.
  Whether the runtime's count resets every turn is still open (the statement holds either way;
  see `docs/efficiency-benchmark.md`).
- **Effort tier** — an e2e `diff` first pass gets the diff's real size and the effort its tier
  warrants (`generation/domain/diff-stat.ts`: tiny ≤2 files and 40 lines, focused ≤8 and 400,
  broad above): always an upper bound on spec files (a flow each), each holding a test per behaviour
  the change decides (its success and each other state it handles that the page can be brought to
  through the UI), and every tier admits the reasoned no-op. A lead's plan names one acceptance
  outcome per such behaviour, and a sidekick writes a test per criterion. The same tiers bound
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

## Suite store — capture, restore and reconcile (full)

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

# Lead and sidekicks

How every e2e run generates: the lead plans a change's independent flows and sidekicks author them in
parallel, each closing its own `run_spec` loop. There is no other way a run generates and nothing to turn on. Everything after generation (validation, execution, change-coverage, review, decide) is unchanged. A code run,
a context run and a login still to be written do not coordinate: one author sidekick (`qa-author`) writes them in the run's working copy, with no plan and no `run_spec` budget, and the same author sidekick serves every correction and regeneration the run asks for after the first pass. When the plan is not admitted as a fan-out, no sidekick
can author, there is no time, or the coordination fails, the run ends `infra-error` `E-NO-AUTHOR`: the lead never writes the tests in the author's place. The reason code
(`no-coordinator`, `coordination-failed`, `cannot-plan`, `no-author-grant`, `no-time`, `plan-timed-out`, `plan-rejected:<reason>`) is recorded in
`gateSignals.coordination` (`refusal`) and in the probe report's "Coordination" section.

## Tuning it

`qa.coordination` in `config/apps/<app>.yaml` sets the limits.

```yaml
qa:
  coordination:
    maxParallel: 3           # flows authored at once (1-6)
    maxFlows: 12             # optional ceiling on flows, for cost (absent: none; the run's time bounds them)
    planBudgetMs: 180000     # the lead's planning turn
    flowBudgetMs:            # one flow, per runtime
      opencode: 480000
```

A run with a login needs `qa.closedLoop` and/or `qa.agentBrowser` (both on unless an app turns them off) for its sidekicks to author against the
signed-in app (see below); without either, no sidekick can author and the run ends `E-NO-AUTHOR` (`no-author-grant`).

## What a run does

1. **Plan.** The lead is asked for a plan (a read-only turn): `noop` with a reason, or `fanout` with
   flows. A flow is an id, an objective, acceptance items, the routes it touches and, when the app declares
   `dev.geolocation`, an optional place it authors at. A route segment that holds a stand-in for a value (`<run>`, `{city}`)
   is kept as a parameter, and a flow that names no route visits the site-relative paths its objective and acceptance name; a
   route names a map page when it fills the template segment by segment (`/shops/madrid/:slug` for `/shops/:province/:slug`),
   which decides both the Live DOM its brief carries and the change pages it visits. The turn is held to
   read-only by a per-prompt tool denial (the runtime's file tools and every editing tool of the code-navigation
   server); a lead on a runtime that has no such denial is not asked for a plan and the change stays with it as one
   piece of work, with the reason recorded. The lead grounds deterministically: it
   reads the Context Pack, the structural signal, the suite listing and the change map with its ranked hunks, in which the
   app's own test files are named rather than shown (the language registry's conventions), and it explores with its code-graph tool. Its
   planning session, review included, is denied Playwright: DEV is read by the sidekicks.
2. **Admit.** `admitLeadPlan` treats the plan as untrusted. It slugs the ids, assigns each flow the spec path
   `e2e/flows/<slug>.spec.ts` itself (any write list the lead names is ignored), caps the sizes, and refuses
   duplicates. It never refuses a plan for its number of flows: the run's **capacity** (`flow-capacity.ts`) is `maxParallel` x the full
   `flowBudgetMs` that fit in what is left of the run after the reserve (at least one wave while a flow still has `MIN_FLOW_MS`),
   bounded by the app's optional `maxFlows` ceiling, and unbounded with neither a deadline nor a ceiling. The plan's first flows up
   to the capacity are admitted in plan order; the rest are named `notAdmitted` and asked of the lead in the amendment turn (below).
   Each admitted flow's grant is primary (`perFlowGrant`, `flow-capacity.ts`): it is granted the `run_spec` and authenticated-browser
   calls its own time runs at the tool's per-call time, so the run's call totals are derived, the sum of its flows' grants, and no
   later flow of a large plan starves. Each grant is still bounded by the flow's time and every call by the run's deadline. An
   app's `qa.closedLoop.maxCalls` is an optional ceiling on the flows' `run_spec` calls together, which they then share, never
   under a useful minimum the ceiling allows (`MIN_RUN_SPEC_CALLS_PER_FLOW` 3: write and run, correct once, confirm). The run's
   cap on writes to DEV (`qa.closedLoop.maxDevWrites`) protects DEV's data and is never derived. It holds across the flows
   together through one run ledger (`RunDevWriteLedger`) that every loop of the run checks and charges while the call holds the
   test account's lease: no call is admitted once the run's total is spent, even with share left, and no two flows are admitted
   against the same last write. A call that is stopped (its sidekick's session ended, its time ran out) is charged what
   its tests' ledgers counted, those still running by their writes plus the requests they had out, so it spends the run's
   cap by what it sent and not by the whole remainder, and the replacement sidekick of the flow, which shares the flow's
   one loop, inherits the flow's share less that count. Every flow keeps its own share (its fair share of the cap, never under
   `MIN_RUN_SPEC_DEV_WRITES_PER_FLOW` 2, never above the cap) and its loop, never cut to 0 by its place in the plan; its brief says
   "up to N requests that write to DEV while the run's shared cap lasts (M left now)", and each answer reports the smaller of its
   share left and the run's. Writes are counted after a spec ran, so the last admitted call can send more than was left (the total
   can pass the cap by that one call's writes); a call whose writes cannot be counted is charged the run's whole remainder. Only an
   app whose cap is 0 gives its flows no loop, and their briefs say the app allows no writes to DEV. Calls refused for writes, for the
   run's total or for the calling flow's own share, are counted in `gateSignals.closedLoop.writesRefused`. A browser session of a flow spends its flow's share alone;
   the browser's own run total (`DEFAULT_AGENT_BROWSER_LIMITS.maxCalls`) holds only the sessions bound to no flow and is the base an
   explore question's share is cut from. The derived totals are recorded: `gateSignals.closedLoop.granted` and
   `gateSignals.agentBrowser.granted`. A plan that cannot be admitted goes back to the lead once, in its open session, with the
   reason (`renderRejectedPlanRequest`); a no-op or an admitted answer replaces it, and anything else ends the run `E-NO-AUTHOR` with
   the first reason recorded (`refusal: plan-rejected:<reason>`); a plan of one flow is a fan-out of one, and a fan-out of no flow whose use cases are dropped
   with a basis and a reason is the lead's declared no-op (the run is `skipped` with those reasons); with no reasoned, based drop it is refused `empty`. The plan must answer for each direct
   use-case candidate of the change that a browser can reach (the admission set, at most `MAX_ADMISSION_CANDIDATES`): a
   flow covers a candidate when it cites its id (`candidates`) or visits one of its pages, and the lead may drop one with a
   typed basis and a reason (`dropped`; `DROP_BASIS`: `no-observable-change`, `already-covered`, `needs-unavailable-state`). The orchestrator holds the basis
   to the facts it has (`dropRefusal`, `plan-coverage.ts`): `no-observable-change` is refused when a seed of the candidate is
   executable code of a declared language (`LanguageRegistry`, a test file excluded) or when the candidate's pages made data requests
   while the run's capture read them (the Context Pack's `Requests the pages made` section, read back by `recordedRequestsFor`; the
   refusal names the first three), `already-covered` when no spec of the suite
   is linked to the candidate; a drop with no basis of the set, or a refused one, leaves the candidate unresolved and goes back
   to the lead in the one amendment turn with the fact that contradicts it. The fact is a signal, not proof (a refactor, a
   type-only or a comment edit changes code and nothing a browser observes), so it applies to every no-op shape (`{"kind":"noop"}`, which
   drops each use case on `no-observable-change`, a fan-out of no flow, and the drops inside a fan-out): a drop the lead keeps after the
   one re-ask stands (a no-op stays `skipped`, a fan-out keeps its flows) and is recorded per candidate with its basis and the contradicting fact
   (`gateSignals.coordination.dropsContradicted`, `contradicted` on the plan snapshot's candidate, a `lead-decision` event); it is never an infra error. The planning turn lists the candidates, each with the specs the suite already holds for it and what the manifest
   declares each one checks and the part of the diff its flow would own (`candidateLine`; its owned slice from the change map,
   `owned-slices.ts`: hunks, added and removed lines), so the lead plans from that instead of opening them and groups use cases into
   flows of a workable size; the section states the run's capacity. **One amendment turn** (`MAX_PLAN_ROUNDS`): a plan that leaves a
   use case unresolved (a refused drop among them), names flows past the capacity, or admits a flow whose owned change alone does
   not fit an author's window (the run's `ContextBudget`; an unknown window makes no flow too large) is returned to the lead once, in
   its open session, with all of those facts in the same request (`renderReplanRequest`); a second answer that is a plan of flows
   replaces the first. A candidate still unresolved is admitted as it stands, recorded `unplanned` on the plan snapshot and as a
   `lead-decision` event, and named in every review turn (`plan-coverage.ts`). Flows still past the capacity are not authored, and
   flows still too large are authored with the rest of their change as references (a flow whose brief still does not fit
   then is not sent, below); both are recorded (`gateSignals.coordination`
   `capacity`, `notAdmitted`, `oversize`, and a `lead-decision` event carrying `qayaba.coordination.flows_not_admitted` /
   `flows_oversize`).
   A route the run's capture saw sent away by the change itself (classified `change-introduced`, see "Route availability" in
   `AGENTS.md`) is a direct use case of basis `route-config`: its evidence names the route table entry and where the
   browser ends, and a drop of it as `no-observable-change` or `needs-unavailable-state` is refused, since the run observed
   the changed behaviour with its own client (`dropRefusal`).
3. **Author.** Each sidekick's brief carries the Live DOM of its flow's pages (by address, or by the map template a
   page was opened from) and the data requests those pages made while they were captured, cut from the run's Context Pack
   (`packPagesFor`); over the author's window the pages give way first, then those requests, then the data contradictions those pages showed (`Possible data contradictions`, facts the run observed: see `Data contradictions` in `AGENTS.md`), last fact first, as a count; a flow whose pages the pack did not read gets
   none. The brief states the change the flow must exercise in one section, cut from the run's change map
   (`brief-change.ts`, over the kernel's `buildChangeMap` and `sliceFor`): every use case the flow must exercise (those its
   plan cites, then those its routes name), each with its id, its reach path, its changed symbols with their ranges and
   where the expected behavior comes from (the declared contract operation, the commit's stated intent, the diff); the
   files its use cases seed, each with its kind, added and removed lines and origin (`map-link`, `declared`, `graph`, `shared`); and
   the slice's owned hunks, redacted and never cut, code first, then hunks holding a changed decision, then diff order.
   The changed decisions come from the static decision listing grounding makes of the run's own working copy before
   anything runs (`shared-infrastructure/decision-listing.ts`, through the lister the language registry declares per
   language: JavaScript and TypeScript today; a language with none lists nothing, and a file that does not parse lists
   nothing and is named on the `qayaba.change.decisions` span). A section of its own names every decision whose head an
   owned hunk holds, preloaded or not, as `file:line kind: arm (line N), …` (an implicit else or a short circuit has no
   code of its own), and asks for a test per arm the page can be brought to through the UI; a flow with none has no
   such section.
   Every owned hunk is preloaded while the brief fits the author's window (`ContextBudget.fit`: prompt plus the working
   room the turn needs, for the model the session runs on); when it does not, owned non-code hunks and then the
   lowest-ranked code hunks are named as `file:start-end (+a -r, kind, why)` instead, and an unknown window preloads
   everything. The fit rides on the turn's span (`qayaba.prompt.context.*`); a brief that had to reference owned code
   logs a warning. A brief still over a known window with every owned hunk named by reference (the last step of the
   degradation order, after the lead was asked to split the flow) is **not sent**: the flow ends `over-window`, an
   undelivered flow like any other (counted `incomplete`, never an infra error by itself, a spec it delivered earlier stays
   delivered), named in `gateSignals.coordination.overWindow` and in a `lead-decision` event carrying
   `qayaba.coordination.flows_over_window` and the fit it was judged by (`qayaba.prompt.context.prompt_tokens`,
   `window_tokens`, `working_room_tokens`). An unknown window fails open: the brief is sent. The brief's known facts are those of its own pages, each saying where it was read, its tools are the
   ones its turn grants (`read`, `write`, `run_spec` with a loop, `authbrowser`, `playwright` for an app with no login,
   `set_geolocation` with a location), and a section with nothing to state is not rendered. The sidekick reports a
   claim per id (`covered`, `not-covered`, `blocked`), which the plan snapshot keeps beside the flow's outcome and no
   grader trusts; its return contract asks for nothing else nobody reads (no evidence, validation or assumptions of its
   own). `FanOutDispatcher` runs at most `maxParallel` flows. Each has its own abort signal and time
   (`flowBudgetMs`, cut to the run's deadline); a flow that throws does not stop the others.
4. **Take back.** Each sidekick works in a plain, bounded copy of what the run may read
   (`<mirrors>/.qa-delegations/<run>/<delegation>`). Only the files its brief names (`writablePaths`) are copied
   back, through `spec-path-confinement`. Anything else it changed is listed as a proposal for the lead and never
   applied: the sidekick has no write authority over the watched repo or the shared suite.
5. **Review.** The lead judges the flows in its planning session and may revise, replace or drop them (below).
6. **Add up.** `aggregateFlowOutcomes` ends the coordinated pass as a generation ends: delivered specs, a declared
   no-op, or an end that says why nothing was finished. The rest of the run reads it like any generation.

If nothing could be coordinated (no plan, no time, nobody to author with) the run ends `E-NO-AUTHOR` with the refusal code, and no author is run in the lead's place.

### What the lead plans from

The planning turn sees the whole change even when it is large, and nothing of it is cut blind. Its `## Commit diff` section
carries the change map first: every changed file once, with its added and removed lines, its kind (the language
registry's), its relevance class, whether it is an app test file, and the use cases its changed code seeds. Then come the
hunks in rank order (code, other kinds, style sheets; within each, the hunks holding a changed decision of the static
listing first, then diff order), as many as fit the lead's own window by the fit rule (prompt plus the lead's working room within its
window, `ContextBudget`). Every hunk not shown is named as a reference,
`path:start-end` with its lines, kind and why: past the window, or in an app test file, a generated file or a low-relevance
file, which are only ever named. An unknown window holds nothing back (`plan-diff.ts`, `plan-diff-section.ts`). It is told the pages
of the app's map the change is linked to and asked to give a flow to each page whose behaviour the change alters; the
pages no admitted flow visits are recorded as a `lead-decision` event. The Context Pack captures as many of those pages as the
change is linked to, up to `MAX_ROUTES_PER_CHANGE`.

### Asking to explore

Instead of a plan the lead may ask once for exploration: `{"explore":[{"id","question","routes"?}]}`, at most 3 questions of at most
400 characters, with site-relative routes. The orchestrator runs one read-only `explore` sidekick (`qa-explore`) per question in the
run's working copy, in parallel, each bounded by `EXPLORE_BUDGET_MS` (120 s) and by the time the run can spare after its reserve.
An explore sidekick holds the code graph and the authenticated browser, never a write, `run_spec` or location tool; the
exploration spends at most a quarter of the run's browser and code-graph calls, split between the questions
(`EXPLORE_CALL_SHARE`). Its answer is `{id, status, findings:[{claim, kind, ref, evidence}]}` (at most 12 findings). Before the lead
sees a finding the orchestrator labels it: `verified` when the Context Pack read the page, the pack read the data route with
results, the orchestrator's browser showed that sidekick the page, or the code graph holds the symbol (`<file>#<symbol>`);
`contradicted` when it claims an empty data state the pack read with results (the pack's read stands); `unverified` otherwise,
shown to the lead as a claim. The lead is then asked in the same session and that answer must be a plan: a second request is
refused as a plan that was not admitted (`E-NO-AUTHOR`, `plan-rejected:malformed`). A plan answered directly spends no exploration time.

## How the prompts are assembled

Every prompt of this context is assembled from registered section definitions (`coordination/application/coordination-sections/`) through the shared prompt engine (`shared-kernel/prompt-sections.ts`), the one the generator and the reviewer use: the flow author's brief, the explore sidekick's brief, the lead's review turn, its correction turn (and the request that sends a refused answer back), its re-plan refusal and the turn after an exploration. Sections are ordered by priority and joined by a blank line, and each report carries its sections' sizes and hashes (`assemble*` functions; the `render*` ones return the text). A delegation brief states four things, each in exactly one section: the objective (`task` / `question`), the return shape (`contract`), the boundary (`scope`: what it may write, and the authority it cannot raise) and the tools it holds (`tools`, from the kind's grant); the prompt-contract lint (R17, R18) fails a brief that misses one, states one twice, names a tool its turn does not grant or says it may write when the turn grants no write. `scripts/prompt-contract-matrix.ts` assembles each of these prompts over its shapes and holds them to budgets recorded in `scripts/prompt-contract-coordination-baseline.json`. A module outside a registry that writes a prompt heading fails `prompt-registry-rule.test.ts`.

## What a sidekick may author with

`sidekickAuthoring` picks one mode per run:

| Mode | When | Tools |
|---|---|---|
| `authenticated-browser` | the app has a login and the run was granted the authenticated browser | `run_spec` for its own flow, `authbrowser_*` with its per-flow grant |
| `run-spec-only` | a login and only the closed loop | `run_spec` for its own flow |
| `unauthenticated-browser` | no login | the plain browser; one flow at a time (the browser is one shared process) |
| `excluded` | a login with neither grant | none: the run ends `E-NO-AUTHOR` |

A sidekick's prompts are denied `serena*` always (its symbol edits write wherever the server's project points),
`playwright*` unless the mode is `unauthenticated-browser`, and `run_spec` unless its flow holds a loop. The denial
is a per-prompt `tools` map, so a session the run did not grant a tool never sees it.

## Authoring location

When the app declares `dev.geolocation`, a flow may name one of its declared `places`; a flow that names none inherits
the lead's value when it opens. `set_geolocation` moves only the caller's scope (the run for the lead, its flow for a
sidekick), the sidekick's task states the flow's value, and the two attempts of one flow share it. It is authoring
context, never an input to the delivered suite: the suite and `run_spec` run at the app's declared default, and a spec
that depends on another location pins it with `setLocation(context, latitude, longitude)`.

## DEV access

Every action against DEV holds its test account's lease from the orchestrator (`DevLease`, an `AccountLock`).
Actions on one account are serialized; the lease can admit concurrent read-only actions on distinct accounts, but
the egress proxy has no read-only mode today, so every action is exclusive in practice and flows queue behind
each other on one account. The queue between runs stays sequential. Agent-declared tags never decide isolation.

## The lead's review

Each flow is authored once. The lead is then asked to review the flows in its planning session, which the plan kept
open (`PlanOutput.lead`), read-only like the plan, bounded by `planBudgetMs` and by what the run has left beyond its
reserve; at most `MAX_REVIEW_TURNS` (3) turns, and revisions are ordered in every turn but the last (`lead-review.ts`).
Per flow it is shown the objective and acceptance, what came of the flow, the sidekick's summary and concerns, the
flow's `run_spec` facts (calls used, the last call's status and failure, whether the spec it holds now is the one that
passed) and the spec it delivered, read through the confined reader and bounded. When the plan had use cases to answer
for, the turn also names those no flow covers and those whose covering flows all ran `run_spec` and none holds a spec
that passed it (`candidateGapsOf`); a candidate covered only by a flow without `run_spec` is not called unproven, and one
the lead dropped with a reason is not named.

An acceptance criterion the sidekick reports `unmet` blocks the flow's result (`pushback.ts`: `acceptance-contradiction`), with
one exception: the entry may carry the typed cause `"cause":"dev-state"` and the `pages` where the sidekick read DEV's state
(`AcceptanceReportEntry.devState`; prose in `note` or `concerns` never counts). The orchestrator backs the claim from what it
holds itself (`backDevStateUnmet`, `explore-verification.ts`): every named page must be a page the orchestrator's browser
showed that flow's sessions (`AgentBrowserHandle.readsOf`) or one its own `run_spec` calls read empty, and an empty read of a
page the Context Pack read with results (`observationConflictIn`) backs nothing, the pack winning as for an exploration
finding. A backed unmet is not a contradiction: the result stays `completed-with-concerns` with the sidekick's own summary,
a concern `acceptance-unmet-dev-state` naming the criterion and the fact, and `DelegationResult.unmetByDevState`; the lead
is shown it as a "DEV limits" line (the criterion cannot be met on DEV as it stands: accept the flow or drop the criterion;
asking again for that state cannot succeed). Any other unmet, or one the facts do not back, is `blocked` as before. A delivered
spec is never dropped either way, and `sidekick_report_consistent` reads the recorded status, so a backed unmet beside a
passing `run_spec` is not an inconsistent report.

The turn says whose statement each line is. A sidekick answer the reader could not read, or one addressed to another brief
(`DelegationResult.answerMiss`), is stated as the orchestrator's own fact ("Sidekick answer: the orchestrator could not read
it"), never under "Sidekick says" or "Sidekick concerns". A `run_spec` failure is shown as the last failure only when the
ledger's `sha256` is that of the spec bytes the confined reader returns now; otherwise it is labelled as seen on earlier
bytes, in the review, in the instruction that sends an unverified spec back, and in the facts added to a revision. The
lead's session remembers what it was shown (`withSpecDigests`): a flow whose spec bytes are those shown in an earlier turn
carries a line, "unchanged since review turn N" with the sha256 and the line count, instead of the spec. The turns of the
lead (this one, the correction, the re-plan, the refusal and the exploration outcome) pass their section sizes and hashes to
the transport, as the sidekick's brief and its feedback do. It answers per flow:

- `accept`;
- `revise`: its instruction goes to the SAME sidekick session, which is kept, with the flow's workspace, `run_spec`
  loop and location, until the coordinated pass ends. A flow that ran out of its time (or was stopped) keeps its session
  too, idle and aborted, so a `revise` of it reaches that session instead of becoming a `replace`: the stop of a flow
  aborts its prompt and never deletes the session;
- `replace`: the old session is ended and a fresh sidekick takes the flow from its brief and the instruction, on the
  escalated capability (and `COORDINATION_ESCALATED_MODEL` when set);
- `drop`: a flow that delivered nothing is settled with the lead's reason.

The answer is untrusted, and the orchestrator's facts decide over it:

- an `accept` of a spec that has not passed `run_spec` on its current bytes, while the flow can still run it and a turn
  is left, is turned into a `revise` carrying the failure the orchestrator saw; on the last turn it stands and the run's
  execution judges it. A flow whose `run_spec` is refused for writes (its own share of DEV writes spent, or the run's cap)
  cannot run it: the review's facts say so, its `accept` stands (`unverified-no-writes`), and the run's execution and fix
  loop judge the spec;
- an app defect is never sent back to be made green (`revise`/`replace` refused);
- a delivered spec is never dropped: it is already in the working copy, and the run's execution and the reviewer judge it.
  A spec the sidekick wrote is taken back after every turn whatever the turn ended in (`needs-lead`, `failed`, an answer
  that could not be read): its status is its word, the bytes are what the run judges;
- a flow the answer does not name, or an answer that cannot be read or runs out of its time, leaves the flows as they are.

How an agent's closing JSON is read (sidekick results, the lead's review and correction answers, explore answers): the LAST top-level object
of the output that has the shape of that contract (`shared-kernel/last-json-object.ts`), whatever narration or earlier objects
come before it; braces in prose never hide it. A sidekick output with no DelegationResult is a failed result marked `readMiss: unreadable`:
still not a success, files still taken back, but recorded with failure class and `qayaba.delegation.status` `unreadable` instead of
`failed`, so it is never counted as a failure the sidekick reported (the `sidekick_report_consistent` grader does not read it as one).
A flow sidekick's prompt carries one closing contract, the DelegationResult block.

Every revision carries the orchestrator's facts beside the lead's instruction. A sidekick that writes nothing and says
why (the change needs no test of its own) is a declined flow, not a failure. When every flow comes back empty, the run ends `E-NO-DECISION`; the lead does not take the change over. The review is counted in
`gateSignals.coordination.review { turns, accepted, revised, replaced, dropped, refused }` and each decision is a
`lead-decision` event of the coordination telemetry.

A `run_spec` call keeps the facts of each failing test in the ledger (`failures`: its error, redacted and bounded; the
page it ended on, by pathname; the results the app's declared data state showed there; the server status; the runtime
errors the page raised; whether the page was still changing). What a revision is told about them is decided by fixed
rules, never by the sidekick's account (`classifyAuthoringFailure`, `authoring-failure.ts`, the fix loop's adjudicator rules):

- **App defect** (an attributed 5xx, or a framework/uncaught runtime error): the spec is right to fail and is never sent
  back to be made green. When the sidekick's workspace still holds a spec, it is taken back and the
  flow is delivered, so the run's own execution and fix loop report the defect; otherwise the flow ends on it.
- **Page still loading**, **element not on the page**, **value mismatch**: a revision is told which, with what to
  do about it (wait for the page's data; build the locator from the failure-point tree; take the expected value from the
  change and its contract, never from the page).

The pages the run's Context Pack read with results (under the app's declared data state) are deterministic facts in
the brief of each sidekick whose flow visits them. When a flow's empty read lands on one of them, the two reads disagree: the sidekick's decline is
not taken, the flow is shown to the lead with the conflict, and any revision is told both reads (`observationConflictIn`). The two reads are not taken under the same conditions (the pack
reads every route in one shared browser context and waits for the declared data state), so the conflict names a
difference to look at, not a culprit.

## The lead's code-graph tool

When the app's structural signal is on and the generator runs on OpenCode, the lead (not a sidekick) can read the code graph
while it plans and reviews through one action, `codegraph_explore`: it names symbols, file paths or short code terms and gets
back the verbatim source of what matches, grouped by file, with the calls among them and what depends on them. The source it
shows counts as already read, so the lead does not open those files again. The orchestrator serves each call over the run's
own index: it admits the terms, picks the repo and the file cap, redacts the answer and cuts it only between files (an omission
marker says what was left out), and the answer carries the commit of the index it came from (AGENTS.md, Code-graph tools).
The tool is the lead's when it authors alone too.

## What the reviewer is shown of the change

The reviewer of a planned run judges each spec against its own flow's part of the change, not against the whole commit diff
(`run-flow/review-change.ts` builds it from the kernel change map and slices; `reviewer-change-sections.ts` renders it). It is
given: the slice of each flow under review (the hunks that flow's use cases own, ranked); every changed file with its language
kind and added and removed lines; and, in full, every part of the diff no flow under review holds (a hunk only a flow that
delivered nothing owns, a hunk no candidate seeds, a deletion), under a heading saying no flow under review was assigned it, with
app test files, generated and low-relevance files named as references. The arms no test ran reach it as before, so the
missing-case and citation rules are unchanged. When no flow under review owns any hunk, or the run had no plan (code, manual,
complete, exhaustive), it keeps the whole diff: it never sees less than the change. Nothing is cut silently: when the prompt does
not fit the reviewer's window (the run's `ContextBudget` fit: prompt plus the working room its turn needs), whole hunks become
`path:start-end` references, non-code first, then the unassigned code, then each flow's code from its lowest rank; within the
unassigned code the hunks holding a changed decision go last, and a flow's slice ranks its hunks holding one first, so they
are the last of their kind to go. An unknown window shows everything, and the review is never split.

## The reviewer's corrections

A pass whose flows delivered, with the lead's planning session, is not closed when the coordination ends: the run keeps it
(`CoordinatedPass`) through validation, execution and the independent review. When the reviewer rejects a round with verified
findings, the run asks the lead, in the same planning session, instead of regenerating alone (`lead-correction.ts`):

1. The lead is shown each flow that a finding cites (by the spec its citation names, or its text), with the spec as the working
   copy holds it, and the findings that cite no flow, numbered.
2. It answers per flow `revise` (the same sidekick session) or `replace` (a fresh sidekick on the escalated model), naming which
   loose findings go with it, and per finding a rebuttal with its basis (`execution` and a test of this run, or `contract` and a
   clause).
3. The orchestrator's facts decide: a flow is always sent the findings that cite it, a finding that cites one flow is never moved
   to another, a flow with findings the lead ignored is sent them with the orchestrator's own instruction, and a closed session is
   replaced. An answer that cannot be read still sends each flow its own findings.
   An answer with a part the orchestrator does not admit (an order naming no finding, an unknown flow) while findings are left
   with no flow, or a readable answer that leaves listed findings neither sent to a flow nor rebutted (and that no flow of the
   orchestrator's own, below, takes), goes back to the lead once, in the same session, with the reasons, the numbers it left out
   and the range of finding numbers (`renderRefusedCorrection`); the re-answer is admitted as any answer, and one that still
   leaves findings unrouted keeps the first answer's result when it is no better. Never a third asking: a finding left out
   again is recorded unrouted with that reason (the lead neither sent it to a flow nor rebutted it after being asked once more).
   The lead's turns never spend the room the flows they order need. Every caller of the correction pass (review, static, execution,
   flaky, coverage, branch cases) meets this at the one shared point (`correct`): a lead turn, and the re-ask, is held to the room
   (what is left of the run less its reserve) less `MIN_FLOW_MS`, never above `planBudgetMs`, so what the lead orders still has the
   minimum a flow needs. When that leaves the turn less than `MIN_FLOW_MS` it is not sent: without the first turn each finding goes
   to its default owner (the spec it cites or names, the flow whose test ran the file, the flow whose use case holds it as a direct
   seed, plan order), without the re-ask the first answer stands, and each is recorded as a `lead-decision`. A run with no
   deadline is bounded by `planBudgetMs` alone. The values come from the run's own budget, never from the app.
4. Each flow's workspace is refreshed from the working copy (the run may have changed the spec since), then its sidekick gets the
   findings verbatim, the lead's instruction and the orchestrator's facts. Only a change made after the refresh comes back.
5. A finding no flow took that names a spec of the suite no flow of the plan authored (a static-gate error or a failing case in a
   spec the suite already held) gets a **maintenance flow** (`maintenance-flow.ts`), opened by the orchestrator in the lead's
   place: an ordinary flow, so a fresh sidekick in a delegation workspace, a brief built like a plan flow's (the findings as its
   task, the Live DOM of the pages the candidates that list the spec visit), that one spec as its only `writablePaths` entry
   (confined to a `*.spec.ts` inside the spec directory, never a hidden directory such as the probe one), its own `run_spec` loop
   with the share of a plan flow, and the same release as every flow. All unrouted findings that name the same spec go to that one
   flow, and a later finding on it is routed to it through the lead like any other. It is bounded: at most one per spec, within
   the app's `maxFlows` ceiling when it sets one (counting the plan's flows and the maintenance flows already opened) and the run's time reserve, and only for a
   spec the working copy can read; without room the findings stay unrouted and the reason is a `lead-decision` event. What it delivers
   joins the round like the flows' deliveries. It is counted in `corrections.maintained`.
   A file seeds a use case through one seed definition every reader goes through (`candidateSeeds`, `seedingOf`,
   `candidatesSeededBy` in `shared-kernel/change-map.ts`): one of the use case's own seeds, or a hub's changed code the use case
   shares with other pages (its shared seeds). The change map, the flows' slices and briefs, the gap's units and the routing below
   all read it, so a file only a hub carries to a page still seeds that page's use case. A changed non-code file (a component's
   template, its style sheets) seeds what the changed source file that declares it by a relative path literal seeds: the change
   scope reads those declarations from the mirror it walks, by the rule a route's implementation files are read by
   (`declaredResourcesOf`, `implementation-resources.ts`), and the candidate holds the file whole (`DECLARED_FILE_SEED_SYMBOL`),
   direct when a seed's file declares it, shared when only a hub's does; the brief names its origin `declared`. Nothing is
   inferred from a name, and a file whose declaring source did not change seeds nothing.
   A finding that names a changed source file (a coverage finding: `CorrectionFinding.file`, and `line` for an arm) goes to a flow
   that holds the file, one that covers a use case the file seeds (`flowsHoldingFile`), and to no other. With one such flow it is
   that flow's whatever the lead answers. With several it reaches exactly one: the flow the lead's first order naming it gives it
   to, when that flow holds the file; when the lead says nothing about it, the default (`routeOfFinding`): the first flow, in the
   pass's order (the plan's, then the flows the pass opened), whose spec's tests ran the file (`CorrectionFinding.ranBy`, the spec
   files whose coverage dumps ran a line of it: what the run executed; the V8 collector names the dumps that ran each changed file,
   `ObjectiveSignalPort.measure`/`recount` tell them apart among the passing cases' spec files by the dump's name
   (`isDumpOfSpecFile`), a dump no such spec wrote counting for none, from exactly the dumps that measurement read, and the gap's
   units carry them; held in memory, never a gate signal or persisted), preferring among those, and then among the rest, the one
   whose use case holds the file as one of its own seeds over one that holds it only as a hub's code. The lead sees it under that
   default flow and, in a section of its own, the flows it may give it to instead; an order that gives it to a flow that does not
   hold the file, or to a second flow, is refused with why and the finding keeps its flow. A finding that cites a flow's spec
   still goes to that flow and no other. With findings no flow owns, the prompt lists every flow with its use cases. A file that
   is one of a use case's own seeds, where no flow of the pass covers that use case (dropped or unplanned), opens one flow for that
   use case (a hub's code a use case only shares opens none: the hub reaches many pages and any one of them is arbitrary, so such a
   finding is the lead's to place, and it is asked again once about one it leaves out), the generalization of the maintenance
   flow (`candidateFlowOf`, id `cand-<use case>`, the deterministic spec path of its id, the same cap, confinement and time reserve,
   a fresh sidekick that writes the spec), counted in `corrections.maintained`. Every unit of the gap is kept, listed across use cases and arms across files. Over the lead's
   window (the fit rule) the units give way as references: first the ones no flow owns, then the flows' own, each shown by the file it
   is about and then by file with the numbers of its findings, so a number still names a finding, the flow it is routed to is sent its
   text whole, and the omission is recorded as `window-fit`.
6. Findings that remain (they name no spec, or one outside the spec directory, or a file that seeds no use case of the change, or no
   maintenance flow could take them or it delivered nothing) are recorded as unrouted (a `lead-decision` event naming their numbers, an error line in the log and
   `corrections.unrouted`) and nobody corrects them: a fresh run-level author, with no flow spec, no `run_spec` history and no
   instruction of the lead's, would repeat the whole first pass cold. Everything the flows delivered goes through the round's
   acceptance, and the lead's rebuttals through the same check as a generator's.

## The run's own checks

The checks that run before the review correct through the same pass (`regenerate`, `generation-services.ts`): each piece of
evidence becomes a finding, routed by the lead exactly as above. The origin of the findings is named in the lead's prompt and in
the sidekick's instruction (`CORRECTION_ORIGIN`, `lead-correction.ts`):

| Origin | Findings |
|---|---|
| `pre-exec` | one per selector contradiction, citing the spec it was attributed to when only one was |
| `static-gate` | one per error block the gate reported (each names its file) |
| `execution` | one per failing case of the fix loop, citing its spec, plus one per contract delta of a round the intent lock refused |
| `coverage` | one per file with uncovered change lines and one per decision arm no test ran (every one, listed across use cases and files), each naming its changed file, citing no spec |

These are facts the run observed: the lead is not offered a rebuttal, and one it gives anyway is not taken. What no flow takes
gets a maintenance flow or stays unrouted, as above, and is not regenerated; the turn's findings are told apart by their position, never by their text, and
the lead can hand a finding that cites no flow to any flow by its number. A finding that cites no spec belongs to the one flow whose
spec its text names as a whole path; one that names several is the lead's to place. A correction hands back the source of every
spec it took, for the fix loop's next post-failure selector check. On a failing execution a sidekick may answer, changing
nothing, that its test is right and the app or the environment is not (`testCorrect`); the claim reaches the fix loop as a
generator's does, only when no flow changed a spec, and is checked against the run's evidence there. The
round's acceptance, contract check and budgets are the caller's, unchanged. A run without a pass regenerates as it always did. A run with a pass whose budget of corrections through the lead is spent does not: the findings are recorded unrouted with the reason `lead correction budget spent` (`CoordinatedPass.leaveUnrouted`: a `lead-decision` event, an error line in the log, `corrections.unrouted`), the round's delivery is left as it is and its acceptance goes on.

The pass is released as soon as the review ends, and in the run's `finally` however it ends. The corrections of every origin are
recorded as `gateSignals.coordination.corrections { turns, routed, unrouted, revised, replaced, rebutted, maintained? }`.

## Cleanup

Sidekick sessions, `run_spec` loops, flow locations and delegation workspaces are released, and the lead's session
ended, when the coordinated pass ends: in the coordination's `finally`, or, for a pass kept for the corrections that follow, when
the run releases it. They are also swept at the start of a coordinated run and at orchestrator boot (a process killed mid-run
leaves nothing behind).

## Operating it

- Rebuild the `orchestrator` and `agents` images (the sidekick config, the tools map and the new tool binding ship
  in them) and keep `QA_TOOLS_TOKEN` set: `run_spec` and `authbrowser_*` are served from the internal listener.

## Known limits

- The lead cannot drop a spec that reached the working copy, nor add a flow its plan did not name; sidekick proposals
  (changes outside the brief's file) are reported, not consolidated.
- Read-only concurrency is unreachable until the proxy can enforce read-only access.
- Each flow's `run_spec` and browser caps are shares of the run's; the shares are not reconciled with what the
  generator spends in the same run.
- No live run of this mode has been recorded: the behavior is verified by unit and contract tests, not by a
  campaign.

## Session lifecycle

A transport session ends in exactly one place: its holder's `dispose` (`closeSession`, a flow's `release`, the pass's
`release`, the `finally` of `coordinate`). A signal's abort (a flow's time, the run's cancel) aborts the session's prompt and
nothing else, and a `dispose` waits for the aborts still running before it deletes, so a delete never races a message the
runtime is persisting. The orphan sweep (`cleanupOrphans`, every 60 s) is only the backstop for a holder that never
disposed: a session is an orphan when no prompt is in flight and nothing has used it (opened it, started or ended a prompt)
for longer than the longest run can last (the largest run time budget in force, never less than the agent's own turn
limit, plus 5 minutes), so a session a run holds between two of its own turns, the lead's planning session while the
flows author included, is never collected.

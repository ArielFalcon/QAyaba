# Lead and sidekicks

How every e2e run generates: the lead plans a change's independent flows and sidekicks author them in
parallel, each closing its own `run_spec` loop. There is no other way a run generates and nothing to turn on. Everything after generation (validation, execution, change-coverage, review, decide) is unchanged. A code run,
a context run and a login still to be written do not coordinate. When the plan is not admitted as a fan-out, no sidekick
can author, or the coordination fails, the lead authors the whole change in one turn, and why is recorded in
`gateSignals.coordination` (`downgrade`) and the probe report's "Coordination" section.

## Tuning it

`qa.coordination` in `config/apps/<app>.yaml` sets the limits.

```yaml
qa:
  coordination:
    maxParallel: 3           # flows authored at once (1-6)
    maxFlows: 6              # flows a plan may name (2-12)
    planBudgetMs: 180000     # the lead's planning turn
    flowBudgetMs:            # one flow, per runtime
      opencode: 480000
```

A run with a login needs `qa.closedLoop` and/or `qa.agentBrowser` enabled for its sidekicks to author against the
signed-in app (see below); without either, they stay out and the lead authors alone.

## What a run does

1. **Plan.** The lead is asked for a plan (a read-only turn): `lead` (one piece of work it authors itself), `noop` with a reason, or `fanout` with
   flows. A flow is an id, an objective, acceptance items, the routes it touches and, when the app declares
   `dev.geolocation`, an optional place it authors at. A route segment that holds a stand-in for a value (`<run>`, `{city}`)
   is kept as a parameter, and a flow that names no route visits the site-relative paths its objective and acceptance name; a
   route names a map page when it fills the template segment by segment (`/shops/madrid/:slug` for `/shops/:province/:slug`),
   which decides both the Live DOM its brief carries and the change pages it visits. The turn is held to
   read-only by a per-prompt tool denial (the runtime's file tools and every editing tool of the code-navigation
   server); a lead on a runtime that has no such denial is not asked for a plan and the change stays with it as one
   piece of work, with the reason recorded. The lead grounds deterministically: it
   reads the Context Pack, the structural signal, the suite listing and the diff, in which the app's own test files
   are named rather than shown (the language registry's conventions), and it explores with its code-graph tool. Its
   planning session, review included, is denied Playwright: DEV is read by the sidekicks.
2. **Admit.** `admitLeadPlan` treats the plan as untrusted. It slugs the ids, assigns each flow the spec path
   `e2e/flows/<slug>.spec.ts` itself (any write list the lead names is ignored), caps the sizes, and refuses
   duplicates and more than `maxFlows`. A plan that cannot be admitted, or that names one flow, hands the change
   back to the lead as one piece of work with the reason recorded (`downgrade`). The change pages that plan left
   unvisited (all of them when it named no flow, those its only flow does not name when it named one) are recorded as a
   `lead-decision` event and stated in the lead's authoring turn (`unvisitedChangePages`, section `change-pages`): it covers each
   one whose behaviour the change alters or says in its verdict why it needs no test.
3. **Author.** Each sidekick's brief carries the Live DOM of its flow's pages (by address, or by the map template a
   page was opened from), cut from the run's Context Pack and bounded; a flow whose pages the pack did not read gets
   none. `FanOutDispatcher` runs at most `maxParallel` flows. Each has its own abort signal and time
   (`flowBudgetMs`, cut to the run's deadline); a flow that throws does not stop the others.
4. **Take back.** Each sidekick works in a plain, bounded copy of what the run may read
   (`<mirrors>/.qa-delegations/<run>/<delegation>`). Only the files its brief names (`writablePaths`) are copied
   back, through `spec-path-confinement`. Anything else it changed is listed as a proposal for the lead and never
   applied: the sidekick has no write authority over the watched repo or the shared suite.
5. **Review.** The lead judges the flows in its planning session and may revise, replace or drop them (below).
6. **Add up.** `aggregateFlowOutcomes` ends the coordinated pass as a generation ends: delivered specs, a declared
   no-op, or an end that says why nothing was finished. The rest of the run reads it like any generation.

If nothing could be coordinated (no plan, no time, nobody to author with) the lead authors the change alone.

### What the lead plans from

The planning turn sees the whole change even when it is large: the diff keeps every whole file section that fits the prompt
cap, code before style sheets, and lists each file it leaves out with the lines it adds and removes. It is told the pages
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
refused as malformed, and the change goes back to the lead as one piece of work. A plan answered directly spends no exploration time.

## What a sidekick may author with

`sidekickAuthoring` picks one mode per run:

| Mode | When | Tools |
|---|---|---|
| `authenticated-browser` | the app has a login and the run was granted the authenticated browser | `run_spec` for its own flow, `authbrowser_*` with a share of the run's caps |
| `run-spec-only` | a login and only the closed loop | `run_spec` for its own flow |
| `unauthenticated-browser` | no login | the plain browser; one flow at a time (the browser is one shared process) |
| `excluded` | the sidekick role is not on OpenCode, or a login with neither grant | none: the lead authors alone |

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
passed) and the spec it delivered, read through the confined reader and bounded. When the change is linked to pages of
the app's map, the turn also names the change pages no flow visits and those whose visiting flows all ran `run_spec`
and none holds a spec that passed it (`changePagesOf`); a page visited only by a flow without `run_spec` is not called
unproven. It answers per flow:

- `accept`;
- `revise`: its instruction goes to the SAME sidekick session, which is kept, with the flow's workspace, `run_spec`
  loop and location, until the coordinated pass ends;
- `replace`: the old session is ended and a fresh sidekick takes the flow from its brief and the instruction, on the
  escalated capability (and `COORDINATION_ESCALATED_MODEL` when set);
- `drop`: a flow that delivered nothing is settled with the lead's reason.

The answer is untrusted, and the orchestrator's facts decide over it:

- an `accept` of a spec that has not passed `run_spec` on its current bytes, while the flow can still run it and a turn
  is left, is turned into a `revise` carrying the failure the orchestrator saw; on the last turn it stands and the run's
  execution judges it;
- an app defect is never sent back to be made green (`revise`/`replace` refused);
- a delivered spec is never dropped: it is already in the working copy, and the run's execution and the reviewer judge it.
  A spec the sidekick wrote is taken back after every turn whatever the turn ended in (`needs-lead`, `failed`, an answer
  that could not be read): its status is its word, the bytes are what the run judges;
- a flow the answer does not name, or an answer that cannot be read or runs out of its time, leaves the flows as they are.

Every revision carries the orchestrator's facts beside the lead's instruction. A sidekick that writes nothing and says
why (the change needs no test of its own) is a declined flow, not a failure. When every flow comes back empty and time
remains, the lead takes over the whole change as one piece of work (`takeover` in the signal). The review is counted in
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
every sidekick's brief. When a flow's empty read lands on one of them, the two reads disagree: the sidekick's decline is
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
4. Each flow's workspace is refreshed from the working copy (the run may have changed the spec since), then its sidekick gets the
   findings verbatim, the lead's instruction and the orchestrator's facts. Only a change made after the refresh comes back.
5. Findings no flow took go to a regeneration with only those findings. Everything delivered goes through the round's acceptance,
   and the lead's rebuttals through the same check as a generator's.

## The run's own checks

The checks that run before the review correct through the same pass (`regenerate`, `generation-services.ts`): each piece of
evidence becomes a finding, routed by the lead exactly as above. The origin of the findings is named in the lead's prompt and in
the sidekick's instruction (`CORRECTION_ORIGIN`, `lead-correction.ts`):

| Origin | Findings |
|---|---|
| `pre-exec` | one per selector contradiction, citing the spec it was attributed to when only one was |
| `static-gate` | one per error block the gate reported (each names its file) |
| `execution` | one per failing case of the fix loop, citing its spec, plus one per contract delta of a round the intent lock refused |
| `coverage` | the uncovered change lines, citing no flow |

These are facts the run observed: the lead is not offered a rebuttal, and one it gives anyway is not taken. What no flow takes
goes to the lead's own regeneration with only that evidence (the failure DOM stays with the failing cases it belongs to); the
turn's findings are told apart by their position, never by their text. A finding that cites no spec belongs to the one flow whose
spec its text names as a whole path; one that names several is the lead's to place. A correction hands back the source of every
spec it took, for the fix loop's next post-failure selector check. On a failing execution a sidekick may answer, changing
nothing, that its test is right and the app or the environment is not (`testCorrect`); the claim reaches the fix loop as a
generator's does, only when no flow changed a spec, and is checked against the run's evidence there. The
round's acceptance, contract check and budgets are the caller's, unchanged. A run without a pass regenerates as it always did.

The pass is released as soon as the review ends, and in the run's `finally` however it ends. The corrections of every origin are
recorded as `gateSignals.coordination.corrections { turns, routed, unrouted, revised, replaced, rebutted }`.

## Cleanup

Sidekick sessions, `run_spec` loops, flow locations and delegation workspaces are released, and the lead's session
ended, when the coordinated pass ends: in the coordination's `finally`, or, for a pass kept for the corrections that follow, when
the run releases it. They are also swept at the start of a coordinated run and at orchestrator boot (a process killed mid-run
leaves nothing behind).

## Operating it

- Rebuild the `orchestrator` and `agents` images (the sidekick config, the tools map and the new tool binding ship
  in them) and keep `QA_TOOLS_TOKEN` set: `run_spec` and `authbrowser_*` are served from the internal listener.
- `src/integrations/fixtures/opencode-agent-list.json` was edited by hand to carry `run_spec` on `qa-sidekick`;
  re-record it from the pinned OpenCode build when convenient (its README says how).

## Known limits

- The lead cannot drop a spec that reached the working copy, nor add a flow its plan did not name; sidekick proposals
  (changes outside the brief's file) are reported, not consolidated.
- Read-only concurrency is unreachable until the proxy can enforce read-only access.
- Each flow's `run_spec` and browser caps are shares of the run's; the shares are not reconciled with what the
  generator spends in the same run.
- No live run of this mode has been recorded: the behavior is verified by unit and contract tests, not by a
  campaign.

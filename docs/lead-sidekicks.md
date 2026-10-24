# Lead and sidekicks

An opt-in mode in which the lead plans a change's independent flows and sidekicks author them in
parallel, each closing its own `run_spec` loop. Everything after generation (validation, execution,
change-coverage, review, decide) is unchanged. The default is `single`: the lead authors the whole change in one
turn, with exactly the session calls a run without this mode makes (pinned by a golden test).

## Turning it on

| Where | How |
|---|---|
| App | `qa.coordination` in `config/apps/<app>.yaml` |
| One run | `npm run qa -- ... --coordination lead-sidekicks`, `coordinationMode` on `POST /api/v1/runs`, `--coordination` of the campaign |

The run's own choice wins over the app's. The mode a run used, and why it was downgraded when it was, is in
`gateSignals.coordination` and the probe report's "Coordination" section.

```yaml
qa:
  coordination:
    mode: lead-sidekicks     # single (default) | lead-sidekicks
    maxParallel: 3           # flows authored at once (1-6)
    maxFlows: 6              # flows a plan may name (2-12)
    planBudgetMs: 180000     # the lead's planning turn
    flowBudgetMs:            # one flow, per runtime
      opencode: 480000
      codex: 600000
```

A run with a login needs `qa.closedLoop` and/or `qa.agentBrowser` enabled for its sidekicks to author against the
signed-in app (see below); without either, they stay out and the lead authors alone.

## What a run does

1. **Plan.** The lead is asked for a plan (a read-only turn): `single`, `noop` with a reason, or `fanout` with
   flows. A flow is an id, an objective, acceptance items, the routes it touches and, when the app declares
   `dev.geolocation`, an optional place it authors at. The turn is held to
   read-only by a per-prompt tool denial (the runtime's file tools and every editing tool of the code-navigation
   server); a lead on a runtime that has no such denial is not asked for a plan and the change stays with it as one
   piece of work, with the reason recorded. The lead grounds without the explorer (a run may still ask for one): it
   reads the Context Pack, the structural signal, the suite listing and the diff, in which the app's own test files
   are named rather than shown (the language registry's conventions), and it explores with its code-graph tools. Its
   planning session, review included, is denied Playwright: DEV is read by the sidekicks.
2. **Admit.** `admitLeadPlan` treats the plan as untrusted. It slugs the ids, assigns each flow the spec path
   `e2e/flows/<slug>.spec.ts` itself (any write list the lead names is ignored), caps the sizes, and refuses
   duplicates and more than `maxFlows`. A plan that cannot be admitted, or that names one flow, hands the change
   back to the lead as one piece of work with the reason recorded (`downgrade`).
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
is a per-prompt `tools` map, so a session the run did not grant a tool never sees it. Codex sidekicks are excluded.

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
passed) and the spec it delivered, read through the confined reader and bounded. It answers per flow:

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
- a delivered spec is never dropped: it is already in the working copy, and the run's execution and the reviewer judge it;
- a flow the answer does not name, or an answer that cannot be read or runs out of its time, leaves the flows as they are.

Every revision carries the orchestrator's facts beside the lead's instruction. A sidekick that writes nothing and says
why (the change needs no test of its own) is a declined flow, not a failure. When every flow comes back empty and time
remains, the lead takes over the whole change as one piece of work (`takeover` in the signal). The review is counted in
`gateSignals.coordination.review { turns, accepted, revised, replaced, dropped, refused }` and each decision is a
`router` event of the coordination telemetry.

A `run_spec` call keeps the facts of each failing test in the ledger (`failures`: its error, redacted and bounded; the
page it ended on, by pathname; the results the app's declared data state showed there; the server status; the runtime
errors the page raised; whether the page was still changing). What a revision is told about them is decided by fixed
rules, never by the sidekick's account (`classifyAuthoringFailure`, `authoring-failure.ts`, the fix loop's adjudicator rules):

- **App defect** (an attributed 5xx, or a framework/uncaught runtime error): the spec is right to fail and is never sent
  back to be made green. When the sidekick still holds the bytes that showed it, they are taken back as they ran and the
  flow is delivered, so the run's own execution and fix loop report the defect; otherwise the flow ends on it.
- **Page still loading**, **element not on the page**, **value mismatch**: a revision is told which, with what to
  do about it (wait for the page's data; build the locator from the failure-point tree; take the expected value from the
  change and its contract, never from the page).

The pages the run's Context Pack read with results (under the app's declared data state) are deterministic facts in
every sidekick's brief. When a flow's empty read lands on one of them, the two reads disagree: the sidekick's decline is
not taken, the flow is shown to the lead with the conflict, and any revision is told both reads (`observationConflictIn`). The two reads are not taken under the same conditions (the pack
reads every route in one shared browser context and waits for the declared data state), so the conflict names a
difference to look at, not a culprit.

## The lead's code-graph tools

When the app's structural signal is on and the generator runs on OpenCode, the lead (not a sidekick) can query the code graph
while it plans and reviews: `codegraph_search_graph` (find a symbol), `codegraph_trace_path` (its callers or callees) and
`codegraph_get_code_snippet` (its source). The orchestrator serves each call on the run's own project, bounded and redacted
(AGENTS.md, Code-graph tools). The tools are the lead's in `single` mode too.

## Cleanup

Sidekick sessions, `run_spec` loops, flow locations and delegation workspaces are released, and the lead's session
ended, in a `finally` when the coordinated pass ends, and swept at the start of a
coordinated run and at orchestrator boot (a process killed mid-run leaves nothing behind).

## Operating it

- Rebuild the `orchestrator` and `agents` images (the sidekick config, the tools map and the new tool binding ship
  in them) and keep `QA_TOOLS_TOKEN` set: `run_spec` and `authbrowser_*` are served from the internal listener.
- `src/integrations/fixtures/opencode-agent-list.json` was edited by hand to carry `run_spec` on `qa-sidekick`;
  re-record it from the pinned OpenCode build when convenient (its README says how).
- To A/B the mode: `docs/efficiency-benchmark.md`, "Lead and sidekicks: A/B".

## Known limits

- The lead cannot drop a spec that reached the working copy, nor add a flow its plan did not name; sidekick proposals
  (changes outside the brief's file) are reported, not consolidated.
- The reviewer's corrections still go to a regeneration, not to the lead.
- Read-only concurrency is unreachable until the proxy can enforce read-only access.
- Each flow's `run_spec` and browser caps are shares of the run's; the shares are not reconciled with what the
  generator spends in the same run.
- Codex sidekicks are excluded.
- No live run of this mode has been recorded: the behavior is verified by unit and contract tests, not by a
  campaign.

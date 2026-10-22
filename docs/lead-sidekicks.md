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
   piece of work, with the reason recorded.
2. **Admit.** `admitLeadPlan` treats the plan as untrusted. It slugs the ids, assigns each flow the spec path
   `e2e/flows/<slug>.spec.ts` itself (any write list the lead names is ignored), caps the sizes, and refuses
   duplicates and more than `maxFlows`. A plan that cannot be admitted, or that names one flow, hands the change
   back to the lead as one piece of work with the reason recorded (`downgrade`).
3. **Author.** `FanOutDispatcher` runs at most `maxParallel` flows. Each has its own abort signal and time
   (`flowBudgetMs`, cut to the run's deadline); a flow that throws does not stop the others.
4. **Take back.** Each sidekick works in a plain, bounded copy of what the run may read
   (`<mirrors>/.qa-delegations/<run>/<delegation>`). Only the files its brief names (`writablePaths`) are copied
   back, through `spec-path-confinement`. Anything else it changed is listed as a proposal for the lead and never
   applied: the sidekick has no write authority over the watched repo or the shared suite.
5. **Add up.** `aggregateFlowOutcomes` ends the coordinated pass as a generation ends: delivered specs, a declared
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

## Escalation

Per flow, from what the orchestrator observed (the sidekick's status and the flow's `run_spec` ledger of spec hashes
and statuses, not the sidekick's own account of its work): a flow whose file is not taken back gets another attempt
while its time lasts, with the failure and the last `run_spec` status as feedback, on the escalated capability (and
`COORDINATION_ESCALATED_MODEL` when set). A sidekick that asks for the lead (`needs-lead`), makes no progress between
attempts or exhausts its time is handed back. A sidekick that writes nothing and says why (the change needs no test of
its own) is a declined flow, not a failure. When every flow comes back empty and time remains, the lead takes over the
whole change as one piece of work (`takeover` in the signal).

## Cleanup

Delegation workspaces are removed in a `finally` when the coordinated pass ends, and swept at the start of a
coordinated run and at orchestrator boot (a process killed mid-run leaves nothing behind).

## Operating it

- Rebuild the `orchestrator` and `agents` images (the sidekick config, the tools map and the new tool binding ship
  in them) and keep `QA_TOOLS_TOKEN` set: `run_spec` and `authbrowser_*` are served from the internal listener.
- `src/integrations/fixtures/opencode-agent-list.json` was edited by hand to carry `run_spec` on `qa-sidekick`;
  re-record it from the pinned OpenCode build when convenient (its README says how).
- To A/B the mode: `docs/efficiency-benchmark.md`, "Lead and sidekicks: A/B".

## Known limits

- A flow that fails gets a second attempt and then goes to the lead whole; there is no per-flow lead takeover turn
  that keeps the sidekick's partial work, and sidekick proposals (changes outside the brief's file) are reported,
  not consolidated.
- Read-only concurrency is unreachable until the proxy can enforce read-only access.
- Each flow's `run_spec` and browser caps are shares of the run's; the shares are not reconciled with what the
  generator spends in the same run.
- Codex sidekicks are excluded.
- No live run of this mode has been recorded: the behavior is verified by unit and contract tests, not by a
  campaign.

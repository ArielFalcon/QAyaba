# ADR-0006: Bundle mutation gets its own switch

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** D7. On 2026-10-28 15:32Z the owner approved the recommendations D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). D7 as put to the owner: "Bundle mutation: its own switch, default on for every e2e app (config-format change)". The recommendation the owner approved: "Yes". Supporting words, 2026-10-28 13:36Z (translated): "The architecture has to focus on tests being generated with quality and testing real flows, forcing neither the FAIL nor the PASS state."
- **Code references at 4105c582:**
  - The switch today: `src/orchestrator/schemas.ts:253-257`, `:436-445`, `src/server/run-engine-factory.ts:988-1005`, `config/apps/example.yaml:149-158`, `src/cli.ts:273`, `src/qa/value-report.ts:172-174`, `AGENTS.md:831`
  - What it needs and what it does: `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:172-180`, `qa-engine/src/contexts/objective-signal/infrastructure/bundle-mutation-oracle.adapter.ts:55-75`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts:159-170`, `config/e2e/fixtures.ts:323-368`
  - Tests that pin today's default: `src/server/run-engine-factory.test.ts:1452-1461`, `src/orchestrator/schemas.test.ts:276-286`
  - The `qa` block is not strict: `src/orchestrator/schemas.ts:220-346` (the block closes at `:346` with no `.strict()`)
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0004](0004-response-value-oracle-removal.md), [ADR-0005](0005-coverage-enforce-activation.md), [ADR-0007](0007-code-target-removal.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md)

**In one line:** bundle mutation is switched by its own configuration key and runs by default for every e2e app, shadow or not. This is a configuration-format change.

## Context

**What turns it on today.** The key `qa.valueOracle`, which is also the switch of the response oracle (`schemas.ts:253-257`). `resolveValueOraclePolicy` returns the explicit value, otherwise `off` for a shadow app and `signal` for the rest (`schemas.ts:444`). The factory builds the oracle (`run-engine-factory.ts:988-993`) and bundle mutation (`:999-1005`) from that one flag; bundle mutation is skipped for the code target. The shadow default was meant for the response oracle's full-suite DEV re-run: "do not double-run DEV while onboarding" (`schemas.ts:437`; `config/apps/example.yaml:155` says the same in other words). That oracle is deleted by [ADR-0004](0004-response-value-oracle-removal.md). The default stays and now withholds a different signal.

**Effect.** A shadow app without the explicit key gets no bundle mutation: no `mutation_kill_rate`, no surviving mutants in the branch-case regeneration (`coverage.steps.ts:159-170`), no verified coverage. Three of the four e2e apps override the default (app configurations read on 2026-10-28, user data): name-webapp, petclinic and jhipster-store set `signal` while in shadow, and portfolio sets `off`, a static site, for a reason that concerns the response oracle. The code app sets no key and goes with the code target ([ADR-0007](0007-code-target-removal.md)).

**What it needs.** Measured change coverage. Mutants are chosen from the coverage report's mutation sites and only when the change was measured (`objective-signal-port.adapter.ts:172-180`). In the history, bundle mutation is recorded in exactly the 18 outcomes that have a measured ratio. The other 13 have none: infra errors, a skip, flaky, failed and invalid runs, and three passes without a ratio. So "on by default" means "tried whenever coverage is measured". By the condition at `:174`, a DEV that serves no source maps gets no mutants and no error.

**Why it is worth switching on.** It is the only signal in the history that separates a suite that ran the changed lines from one that checked them. `AGENTS.md:908-910` names `mutation_kill_rate` as a grader that answers whether the suite has value. Four runs of one commit and range:

| Run | qayaba commit | Line coverage | Mutants killed |
|---|---|---|---|
| run-ed28973-mvs0onsn-6ad17f30 | 40513c1e | 0.766 | 0 of 3 |
| run-ed28973-mvs2ukug-c82da7be | 40513c1e | 0.904 | 1 of 3 |
| run-ed28973-mvs49h5y-acdab309 | 40513c1e | 0.738 | 1 of 3 |
| run-ed28973-mvs7oo0f-17041c71 | 4105c582 | 0.630 | 0 of 3 |

With 0.904 of the changed lines executed, two of the three mutants went unnoticed. Identical inputs spread widely, so four runs show a direction, not proof. Across the 18 outcomes with the signal, 13 applied three mutants and 7 of those killed none (history read on 2026-10-28; different code versions, so a count, not a trend).

**What default-on spreads** (known, not conditions of this decision):

- Its re-runs run one after another with no time check (`bundle-mutation-oracle.adapter.ts:67-70`). The time-authority hypothesis H16 is plausible, and no run shows harm from it. The re-runs of the measure step took 92.5 s to 467.9 s of DEV time in the 11 runs H16 re-checked. The coverage phase of run-ed28973-mvrxb30p-ecfe944b ran 7 suite executions for 1,035.0 s (mutants, observation runs, a regeneration's acceptance run and closure re-checks together). According to that refutation, no run it checked was free of out-of-git ×5 time limits.
- The three mutants are the first untaken-arm decisions in file-path order (H19, plausible).

**Keys that do not exist are dropped without a message.** The `qa` block is not strict. Parsing `config/apps/example.yaml` with an added `qa.bundleMutation` gave a valid configuration and an undefined key (checked on 2026-10-28 against the schema at 4105c582). Two of the five app configurations read that day carry a retired key under `qa` that the schema drops the same way, and [ADR-0005](0005-coverage-enforce-activation.md) shows the same drop hiding a documented key. For this decision: once `qa.valueOracle` leaves the schema, `signal` is dropped harmlessly (the default is on), but portfolio's `off` is dropped too, and bundle mutation turns on for an app whose owner set it off.

## Decision

| # | Decided |
|---|---|
| 1 | Bundle mutation gets its own switch, independent of any oracle key. |
| 2 | The switch defaults to on for every e2e app, shadow or not. |
| 3 | This is a configuration-format change. |

**Not decided here** (each is an open owner question; the recommended answer follows it):

1. What is the key, where does it live, and when does it land? Recommended: `qa.changeCoverage.bundleMutation`, with the values of its neighbours (`signal | off`, default `signal`), beside `branchCases` (`schemas.ts:236-237`), because it consumes the same measurement. It lands in step 1 together with [ADR-0004](0004-response-value-oracle-removal.md), so the owner's configurations change once and not twice.
2. How are retired and unknown keys under `qa` handled? Recommended: warn at load, naming the key and, for `valueOracle`, the replacement; make it an error once the owner has cleaned the configurations. That is the step 1 warning and step 6 strict schema of the dormant-features audit ([RFC-0001](../rfc/0001-dormant-features.md)). Either way the owner moves portfolio's `off` to the new key when the change lands, or bundle mutation turns on there. The blast radius of an error at load (one app or the whole process) is not verified.

## Consequences

- **The shadow-aware default disappears.** `resolveValueOraclePolicy` and its tests (`schemas.test.ts:276-286`) go or change. The CLI report (`cli.ts:273`) and the line that tells an operator to "set valueOracle: signal" (`value-report.ts:172-174`) change with them.
- **DEV time rises for every e2e app, in shadow too.** Every green diff with a measured change gets the re-runs above. The risk is H16. If it shows harm, the fix belongs to the time authority, not to this switch.
- **The counter reader and the `_mutate` fixture stay.** Bundle mutation counts its mutated responses through them ([ADR-0004](0004-response-value-oracle-removal.md)).
- **[ADR-0005](0005-coverage-enforce-activation.md) relies on it.** Its condition requires bundle mutation on.
- **A config format others consume changes** (the app YAML). Documents to correct in the same change: `AGENTS.md:831` ("on with `qa.valueOracle`") and the value-oracle block of `config/apps/example.yaml:149-158`.

## Enforcement

Not enforced yet. What will hold it, added by the change that implements it:

- A failing test first, through the factory seam `buildEngineRootDeps`: a shadow app with no mutation key gets the bundle mutation adapter; the same app with the key `off` gets none; a non-shadow app gets one; the code target gets none. It replaces `run-engine-factory.test.ts:1452-1461`, whose line 1459 pins the opposite ("the shadow-aware default keeps it off").
- A schema test for the key's values and default, and one for the handling of the retired key (open question 2).
- The example configuration and `AGENTS.md` change in the same commit.

## Alternatives considered

| Alternative | Why it is not the decision |
|---|---|
| Keep `qa.valueOracle` as the bundle mutation switch | No configuration change. But once the response oracle is gone the name is wrong, and the shadow default keeps hiding the one signal that measures. |
| Rename the key and keep the shadow-aware default | Apps in onboarding get no value signal, and three of the four e2e apps already override the default. |
| Always on, with no switch | Leaves no way to turn it off for an app where it costs or misleads. The owner chose a switch. |

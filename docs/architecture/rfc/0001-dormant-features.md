# RFC-0001: Dormant features: keep, redesign or delete

- Status: Accepted, 2026-10-28: OD-1 to OD-20 as recommended ([ADR-0013](../adr/0013-owner-decisions-remaining-questions.md)). Decided before: D1-D14, recorded in [ADR-0003](../adr/0003-learning-layer-rebuild.md), [ADR-0004](../adr/0004-response-value-oracle-removal.md), [ADR-0005](../adr/0005-coverage-enforce-activation.md), [ADR-0006](../adr/0006-bundle-mutation-switch.md), [ADR-0007](../adr/0007-code-target-removal.md), [ADR-0008](../adr/0008-product-version-source.md), [ADR-0009](../adr/0009-campaign-freeze-on-server.md), [ADR-0010](../adr/0010-maintainer-removal.md) and [ADR-0011](../adr/0011-root-cause-fix-policy.md).
- Code references at 4105c582: `src/settings/registry.ts:74`, `qa-engine/src/contexts/cross-run-learning/domain/rule-fold.ts:28`, `qa-engine/src/contexts/coordination/application/coordination-context.ts:1`, `qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts:76`, `src/server/run-engine-factory.ts:366-371`, `src/server/run-engine-factory.ts:988-1005`, `src/server/run-engine-factory.ts:1428-1432`, `qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:64`, `scripts/campaign.ts:264-267`, `src/orchestrator/schemas.ts:440-445`, `qa-engine/src/contexts/coordination/application/explore-request.ts:12`, `odd/tasks/lead-review-loop.md:22`
- Related: [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [RFC-0002](0002-platform-steps-0-1.md) (orders the step 1 deletions), [RFC-0004](0004-log-level-from-outcome.md), [rejected-explanations](../rejected-explanations.md), [README](../README.md), the platform plan `docs/engine-platform-architecture.md`

## Summary

- An audit of 46 dormant, staged or inert members (8 groups) gives 33 discard, 10 redesign then integrate, 2 keep and integrate, 1 keep as configuration. None of them explains a run failure family; they cost carrying effort, and two give false signals today (the curriculum's "PROVEN" claim, an armed self-maintainer).
- The owner has already settled 14 members by a named decision and 2 in part; 4 follow from one, and 9 fall under rows 1 and 2 of the platform plan's decision table. 17 members have no decision yet (one of them, 1.9, is held open in ADR-0003).
- Those members and every fork the ADRs left to this RFC are listed under "Owner decisions needed" (OD-1 to OD-20), each with its evidence and a recommended answer.
- Re-checked at 4105c582, the audit's core claims hold. Three claims changed: qa-explore was asked for once (3 turns in a cancelled replicate); the learning skeleton is about 1,650 lines but does not just return a constant; the unconditional merge fallback in publication belongs to every target, not to the code target. One holds only in part (`recurring-dev-not-rendered`, one of four reasons).
- Recommendation: option C, a verdict per member by evidence. It is the smallest change that stops carrying code with no consumer, producer or measured value through platform steps 2-6.

## Problem

### The owner's diagnosis

2026-10-28 14:14Z (translated): "As the app kept failing, it was decided to deactivate things first to be less ambitious and try a simpler version; this has left what was deactivated in a very outdated and probably incorrect state. The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work. That is why I want you to look for what is switched off, to see whether its hypothetical value, once fixed, justifies integrating it or it is discarded." On the learning layer, same message (translated): "The specific idea of the learning layer seems good to me: that the app 'evolves' with the app it tests, learning from errors and decisions between executions."

### The causal chain

Evidence: read-only queries on the history database on 2026-10-28 (34 runs, all of one app, 31 campaign-tagged; 31 run outcomes) and the code at 4105c582. All live evidence comes from one app. Each verdict below rests on a property of the engine (nothing reaches it, nothing produces it, nothing measures it), never on that app.

| Step | What happened | Evidence (confirmed unless marked) |
|---|---|---|
| 1 | Features were added on a run that did not yet produce facts a feature could trust. This ordering is the owner's account (14:14Z, quoted above: features kept being added "in an app that did not work"); it cannot be checked here, because history before 2026-10-26 is not held. | Confirmed for two missing facts, a recorded DEV version and a value signal that measures: no app configures a version source; `valueScore` is null in 31 of 31 outcomes; the version fact is recorded nowhere (`src/server/run-engine-factory.ts:1428-1432` returns a boolean and the gate step records nothing). Hypothesis for two more, a proven outcome and an owned run ending: H01 is plausible and H10 is refuted as a family ([rejected-explanations](../rejected-explanations.md)). |
| 2 | Inert: the rule loop has no producer, no closing signal and no delivery. | Reflector off by default (`src/settings/registry.ts:74`); its one write is `qa-engine/src/contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts:157`; promotion needs `oracleOutcomeCount >= 1` (`qa-engine/src/contexts/cross-run-learning/domain/rule-fold.ts:28`); lessons are barred from the coordinator projection (`qa-engine/src/contexts/coordination/application/coordination-context.ts:1`). `learning_rules` holds 0 rows; the scorecard holds 24 entries with `measuredRuns` 0. |
| 3 | Live and wrong: the curriculum writes a false lesson into the lead's prompt. | See "The live wrong lesson" below. |
| 4 | Armed: code with outward effects ran on routine events. | The maintainer is triggered whenever an incident is pending and it is idle (`src/server/health-poller.ts:57-59`); a restart (`src/server/runner.ts:843-846`) and an orphan-session sweep (`src/server/wire-app.ts:399`) both record incidents. The code target's app was configured to publish; it was disarmed on 2026-10-28 as D8 approved (`qa.shadow: true` in the owner's gitignored configuration, [ADR-0007](../adr/0007-code-target-removal.md)). |
| 5 | Hidden cost: tests, constants and twins pin or repeat what nobody uses. | Flipping the engine's `reviewLoopIntegrity` fallback (`qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:64`) fails 25 of 468 tests in `qa-engine/test/contexts/run-orchestration/application/run-qa.use-case.test.ts` and 35 of 656 across the `run-qa` test files (probe on a scratch copy of 4105c582). The coverage threshold 0.7 is defined in seven places in `src/` and `qa-engine/src/`, nine counting `scripts/probe-report.ts:31` and `web/public/js/api.js:360` (list in the re-check table below). |

### The live wrong lesson

- Run run-ed28973-mvra9a3s-09df0987 (2026-10-27 22:54, cycle 1) ended `fail` / `E-EXEC-FAIL` at 23:32:56Z. The curriculum row shows `caughtRealBug` true for `empty-state` (18 evaluated, 9 credited), `boundary-value` (18, 9) and `re-query-after-mutation` (11, 6), first caught 23:32:57Z, 0.4 s later.
- `caughtRealBug` is set only by `app_defect` evidence (`qa-engine/src/contexts/cross-run-learning/domain/curriculum.ts:76`, `:101-108`), and the curriculum fold is deliberately outside the learning gates (`qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts:387-398`). So the run was adjudicated `app_defect`. That class is an inference from the row and the code; the adjudication is not stored. [ADR-0003](../adr/0003-learning-layer-rebuild.md) holds the full chain.
- "PROVEN (" is in one lead turn of each of the 8 runs started after it (run-ed28973-mvruzwli-8bb3adcd, run-ed28973-mvrwjx2d-1bf83af5, run-ed28973-mvrxb30p-ecfe944b, run-ed28973-mvs0onsn-6ad17f30, run-ed28973-mvs2ukug-c82da7be, run-ed28973-mvs49h5y-acdab309, the baseline run-ed28973-mvs7oo0f-17041c71 and the cancelled run-ed28973-mvs9yzjd-bf4eb95c), and in none of the 21 earlier runs with lead turns (8 of 106 lead turns; counts only, no prompt text read). The marker persists across code epochs because it is stored state, not code.
- The sentence is false: "PROVEN (n bugs) counts the application defects past runs caught with that template" (`qa-engine/src/shared-kernel/scenario-catalog.ts:114`). The code credits every offered template by co-occurrence. The section's own registry reason reads "no observed failure behind it" (`qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts:678`).
- Hypothesis: the marker biases the lead's plan. No ablation exists, so its effect is unmeasured.

### What the re-check at 4105c582 changed

| Audit claim | Result | Evidence |
|---|---|---|
| The rule loop has no producer, closing signal or delivery | Holds; counts moved by one run | `valueScore` null in 31 of 31 (audit: 30 of 30); scorecard 24 entries (audit: 23) |
| qa-explore was never asked for (0 turns in 33 runs) | No longer holds | 3 explore turns, all in run-ed28973-mvs9yzjd-bf4eb95c, the replicate the operator cancelled on 2026-10-28; each took 63 to 118 s against a cap of 120 s (`qa-engine/src/contexts/coordination/application/explore-request.ts:12`). The run produced no outcome to judge, so no value evidence exists. The verdict stands; see OD-3. |
| The learning skeleton is about 1,650 lines returning a constant | Narrowed | The context holds 1,646 non-test lines. Retrieval does return an empty list (`qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts:54-64`), but the curriculum writes, and the gates and the process audit run on every run. |
| The unconditional REST merge fallback is part of the code target | Narrowed | It is in the publication adapter every target uses (`qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts:14-24`, `:58-73`). Deleting the code target does not remove it; see OD-20. |
| 25 of 468 use-case tests pass only on the off path of `reviewLoopIntegrity` | Holds, and is larger | 25 of 468 in `run-qa.use-case.test.ts`; 35 of 656 across all `run-qa.*.test.ts` files |
| The freeze is guarded by the client only, and off in every run | Holds | `scripts/campaign.ts:264-267`; the server reads it per process (`src/server/run-engine-factory.ts:760`); `effective_config.campaignFreeze` false in 34 of 34 runs, 31 campaign-tagged |
| The coverage threshold is defined in seven places | Holds for `src/` and `qa-engine/src/`; two more outside them, nine in all | Seven: `qa-engine/src/contexts/run-orchestration/application/run-flow/outcome-assembly.ts:18`, `src/server/effective-config.ts:47`, `src/server/run-engine-factory.ts:644`, `src/server/run-engine-factory.ts:707`, `src/server/run-report-view.ts:138`, `src/server/trends-view.ts:103`, `src/qa/value-report.ts:163`. Outside them: `scripts/probe-report.ts:31`, `web/public/js/api.js:360`. The console's mock data (`web/public/js/data.mock.js`) and the client's test fixtures (`client/internal/ui/charts_test.go`) also carry 0.7 and are not counted. |
| Three of the four test-support modules escape the merge guard | Holds | `isProtectedPath` (`src/server/merge-guard.ts:500`) returns false for `src/telemetry/trace-harness.ts`, `src/integrations/fixtures/opencode-roster.ts` and `src/no-console.scan.ts`, true for `src/server/web-console/console-harness.ts` (run on a scratch copy) |
| The multi-account branch is 48 commits behind with +26,938/-23,674 | Holds | `feat/parallel-runs-v2`: 48 behind and 37 ahead of 4105c582, 240 files changed from the merge base; `pr2/accounts`: 185 behind, 16 ahead |
| The `recurring-dev-not-rendered` finding can never fire | Holds for one of four reasons | The audit reads `r.adjudication?.class` (`qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts:79`) and no persistence code stores an adjudication. The other three reasons were not re-checked. |

Not re-verified (no network, or out of reach): the GitHub side of the maintainer (21 attempts, 18 open pull requests, push refused); the judge's 12,000-byte diff cut and its 255 passing tests; the maintainer pre-deploy gate running "as root"; the 12 unreachable files of item 8.1; history before 2026-10-26; whether the product serves any version endpoint.

### What this does not explain

- None of the three confirmed causes (H06, H11, H20; [ADR-0011](../adr/0011-root-cause-fix-policy.md)) is a dormant feature, and no dormant feature explains a failure family. Deleting them improves carrying cost and removes false signals; it does not move coverage, kills or pass rate.
- The effect of the false lesson on a plan, and whether context-heal ever fires (`context_stale` and `context_heal_requests` hold 0 rows, which fits "never" but does not prove it), are not shown.

## Goals and non-goals

Goals:
- One verdict per member, with the evidence that decides it.
- Say which verdicts the owner already took, and which ADR records them.
- List every choice still open, so nothing is read as decided that is not.
- Leave no dormant member without an owner, an entry condition or a deletion.

Non-goals:
- Fix a run failure family, or rank root causes ([RFC-0003](0003-coverage-dump-harvest.md), [RFC-0004](0004-log-level-from-outcome.md) and [RFC-0005](0005-suite-store-single-writer.md) do that).
- Design the rebuilt learning layer, the coverage `enforce` condition or the bundle-mutation key (ADR-0003, ADR-0005, ADR-0006).
- Order the step 1 commits or list files ([RFC-0002](0002-platform-steps-0-1.md)).

## Options

| Option | Removes | Adds | Risk |
|---|---|---|---|
| A. Carry every member, dormant, through the refactor | Nothing | Every later step (2-6) moves, retargets and keeps green the learning context (1,646 lines) and the maintainer, judge, oracle, mode and lease code, plus 35 tests pinned to a path no app uses | The staleness the owner described repeats: members already drifted (the Langfuse collector twin, `escalations` equal to `incomplete`). The false lesson and the armed maintainer stay. |
| B. Delete all 46 in step 1 | All carrying cost | Nothing | Loses the 13 members whose value is evidenced or is the owner's stated direction (the learning idea, bundle mutation killed a mutant in 10 of 31 outcomes, coverage `enforce`, the version fact). Contradicts D1, D6, D7 and D9. |
| C. A verdict per member by evidence (recommended) | 33 members, plus the settled parts of the others | Ten redesign members each need a record, an entry condition and a kill criterion | A redesign member sits unscheduled and goes dormant again. Mitigation: OD-19, a member with no record by the end of platform step 6 is deleted. |

## Recommendation

Option C. Judge every member by four tests, none of which names an app:

| Test | Question | A "no" with no evidenced need means |
|---|---|---|
| Consumer | Does anything reach it? (plan row 2: `docs/engine-platform-architecture.md:84-97`) | Discard |
| Producer | Does anything feed it a real input? | Discard |
| Measured value | Did it change an outcome we can read? | Discard, or redesign if the value is plausible and only its inputs are untrustworthy |
| Risk armed | Does it have an outward effect while idle? | Discard first, and disarm now |

Why this is the smallest change: the cause is code built on facts that were not yet trustworthy. Deleting what fails the tests removes the carrying cost and the false signals in one move; fixing each member in place would build more on the same missing facts. Where the value is plausible (13 members) the verdict keeps the intent and drops the code, so the redesign starts from the facts that now exist.

### Decisions already taken

The owner approved D1-D13 together on 2026-10-28 15:32Z (translated): "Regarding the 13 recommendations I agree with everything", and D14 at about 15:45Z (translated): "That design seems good to me."

| D | Decided (as approved) | Members | Record |
|---|---|---|---|
| D1 | Delete the rule loop, the reflector and the curriculum at step 1; rebuild one engine-owned lesson kind later with a kill criterion; no dormant skeleton | 1.1, 1.3, 1.4, 1.7, 1.8, 1.13 (current code) | [ADR-0003](../adr/0003-learning-layer-rebuild.md) |
| D2 | Switch the curriculum off and reset the stored row, with step 1 and not before | 1.8 | ADR-0003 |
| D3 | A verified lesson reaches the brief of the flow its scope covers | 1.6 | ADR-0003 |
| D4 | First lesson kind: DEV data volatility per page or operation, deterministic, measured against a frozen arm, deleted after one cycle without improvement | 1.3 (new ledger) | ADR-0003 |
| D14 | Learning gates keyed per lesson kind on the facts it reads, never per run on its verdict; every run is input | 1.14 | ADR-0003 |
| D5 | Delete the response value oracle now; accept no objective value signal for backend changes until service-triggered runs work | 2.1, and 1.5 and 2.2 with it | [ADR-0004](../adr/0004-response-value-oracle-removal.md) |
| D6 | Coverage `enforce` after 3 consecutive replicates with a trustworthy measurement and bundle mutation on; a block holds the PR with the report, no Issue | 2.4 | [ADR-0005](../adr/0005-coverage-enforce-activation.md) |
| D7 | Bundle mutation gets its own switch, default on for every e2e app | 2.3 | [ADR-0006](../adr/0006-bundle-mutation-switch.md) |
| D8 | Delete the code target at step 1; the owner's configuration is already disarmed; code-level testing returns later as an RFC | 7.4 | [ADR-0007](../adr/0007-code-target-removal.md) |
| D9 | The served version comes from the product; until then runs record "version unknown" | 7.1 (the source) | [ADR-0008](../adr/0008-product-version-source.md) |
| D10 | The server freezes every campaign-tagged run by default; a learning experiment declares its arm | 1.15 | [ADR-0009](../adr/0009-campaign-freeze-on-server.md) |
| D11 | Remove the self-maintainer and its mirror with step 1; the GitHub clean-up needs the owner's explicit go | 4.1, 4.2 | [ADR-0010](../adr/0010-maintainer-removal.md) |
| D12 | Only confirmed causes get a fix; an unconfirmed family gets no family slice | placement of every member below | [ADR-0011](../adr/0011-root-cause-fix-policy.md) |
| D13 | After-measurement conditions: same suite (12 of 13 snapshot entries), same freeze (off). The baseline is one replicate by the owner's instruction; the count for after-measurements is one per version (Correction 2026-10-29: decided as recommended, [ADR-0013](../adr/0013-owner-decisions-remaining-questions.md)) | Measurement | ADR-0011 |

D2 and the GitHub part of D11 land with step 1.

### Verdicts by group

Member ids (1.1 to 8.9) number the 46 members by group G1 to G8. "Settled by" is one of: a D from the table above; "follows Dn" (deleted with its only producer or consumer, scope stated in that ADR); "plan row 1 or 2" (the platform plan's rule: a copy of something the engine has, or nothing reaches it; delete); "OD-n" (open, see below). Verdict words: discard, redesign (then integrate), keep, keep as configuration. Every path:line is at 4105c582.

#### G1. Learning layer (17)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 1.1 | Reflector, the only rule producer | discard | D1 | Off by default (`src/settings/registry.ts:74`), wired only when on (`src/server/run-engine-factory.ts:1466`). Input is the class plus six gate signals, no error text, spec, diff or DOM (`qa-engine/src/contexts/run-orchestration/application/run-flow/outcome-assembly.ts:134-155`). Its rule is saved with no check of its claim (`qa-engine/src/contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts:113-157`). The audit proposed keeping the `run_outcomes.reflection` column (dropping it is a persisted-format change for no gain); that is not settled by D1: ADR-0003 holds it open under "Persisted leftovers". |
| 1.2 | Deterministic-distiller branch | discard | follows D1 | Only the prefix constant exists and nothing writes it (`qa-engine/src/contexts/cross-run-learning/domain/rule-governance.service.ts:10-14`). |
| 1.3 | Rule ledger, governance, retrieval, injection | redesign | D1 (delete), D4 (rebuild) | Retrieval runs every run and returns an empty list (`qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts:54-64`). The key is the app alone, no repository, route or commit (`qa-engine/src/contexts/cross-run-learning/domain/learning-repository.ts:5-22`), and the sha is ignored (`qa-engine/src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts:49`). 0 rows in `learning_rules`. |
| 1.4 | Promotion through the response oracle; prevention credit | discard | D1 | Needs `oracleOutcomeCount >= 1` (`qa-engine/src/contexts/cross-run-learning/domain/rule-fold.ts:28`); `valueScore` null in 31 of 31. Credit gives 0.6 when the run has no class (`:39-46`), which its own comment calls derived, not objective (`:15`). |
| 1.5 | Oracle scorecard | discard | follows D5; named in ADR-0003 | 24 entries, 0 measured; part of the wire contract (`src/contract/commands.ts:755`, `:792`). |
| 1.6 | Lesson delivery to the roles that write tests | redesign | D3 | The coordinator projection must never hold learned rules (`qa-engine/src/contexts/coordination/application/coordination-context.ts:1`). ADR-0003 shows no production code builds that type; the author brief simply has no section for lessons. |
| 1.7 | Reviewer reject-on-sight rules | discard | D1 | Rendered as "REJECT" (`qa-engine/src/contexts/cross-run-learning/application/render-learned-rules.ts:40-43`); the evidence filter has no rule citation kind (`qa-engine/src/contexts/run-orchestration/domain/review-finding-filter.service.ts:16`). |
| 1.8 | Curriculum credit ("PROVEN (n bugs)") | discard | D1, D2 | See "The live wrong lesson". |
| 1.9 | Keyword archetype detector as learning key | discard | open in ADR-0003 | Regex over the raw diff (`qa-engine/src/shared-kernel/structural-pattern.ts:4-12`). Its callers are the curriculum, rule archetypes, retrieval bias and run-flow steps (`qa-engine/src/contexts/cross-run-learning/domain/distill-rule.ts:64-66`, `qa-engine/src/contexts/cross-run-learning/infrastructure/curriculum-port.adapter.ts:30`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts:40`); no module of the generation context calls it. |
| 1.10 | Process audit: observe streak, context-heal | keep | OD-13 | The streak is deterministic and fault-isolated. The kind `recurring-test-failure` advises "needs rule promotion (oracle)" (`qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts:139-147`), a path that cannot fire once the loop is gone. Context-heal: no firing observed. |
| 1.11 | Audit kind `recurring-dev-not-rendered` | discard | plan row 2; OD-13 | Reads a stored adjudication that no persistence code stores (`process-audit.ts:79`). |
| 1.12 | Audit layer-2 diagnosis | discard | plan row 2; OD-13 | No producer; its comment cites a scope note that does not exist (`src/server/run-engine-factory.ts:1486-1489`; no match in `process-audit.ts`). |
| 1.13 | Quarantine and ledger CLI | redesign | D1 (current code); open in ADR-0003 (the actor) | `veto` and `restore` set a status with no actor recorded (`src/qa/learning/ledger-cli.ts:28-35`). |
| 1.14 | Learning gates | keep, re-keyed | D14 | One owner of what may teach (`qa-engine/src/contexts/cross-run-learning/domain/learning-gates.ts:8`). `E-STEP-BUDGET` and `E-COVERAGE-GAP` are not in `NON_LEARNING`, so they teach. |
| 1.15 | Campaign freeze | keep as configuration | D10 | Default false (`src/settings/registry.ts:107`); refused by the client only (`scripts/campaign.ts:264-267`). |
| 1.16 | Learning twins | discard | plan row 1 (the twins); the stub repository is open in ADR-0003 | `qa-engine/src/contexts/cross-run-learning/domain/distill-rule.ts:69-97` repeats the four patterns and the classification of `qa-engine/src/shared-kernel/error-class.ts:50-79`. The stub repository that a frozen run uses (`src/server/run-engine-factory.ts:1459`) is not a twin. Whether it survives step 1 is open in ADR-0003 (it implements the rule-loop port D1 deletes) and [RFC-0002](0002-platform-steps-0-1.md) fixes it; the audit proposed keeping it and correcting its stale header (`qa-engine/src/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts:1`). |
| 1.17 | Agent-memory residue | discard | plan row 2 | The removal stands; residue in `qa-engine/src/contexts/generation/domain/tool-call-taxonomy.ts:102-106` and `web/public/js/api.js:457`. |

#### G2. Value signals and gates (5)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 2.1 | Response value oracle | discard | D5 | Aims only at operations in reach (`qa-engine/src/contexts/run-orchestration/application/run-flow/fault-aim.ts:40-46`); with none it answers "not measured" (`qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts:38-39`); `valueScore` null in 31 of 31. The port drops the not-measured reason (`details` is returned, then omitted: `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:199-226`). Hypothesis: a spec could forge its counters, which the suite's own process writes (`config/e2e/fixtures.ts:310-316`). |
| 2.2 | Fault calibration, per-candidate value | discard | follows D5; D6 replaces the condition it fed | Consumes 2.1. |
| 2.3 | Bundle mutation tied to the oracle switch | redesign | D7 | One policy decides both (`src/server/run-engine-factory.ts:988-1005`), and a shadow app defaults it off (`src/orchestrator/schemas.ts:440-445`). It applied in 18 of 31 outcomes and killed a mutant in 10. |
| 2.4 | Change-coverage `enforce` | redesign | D6 | Default `signal` (`src/server/run-engine-factory.ts:707`). Inputs are not trustworthy yet: coverage is marked stale in 10 of 31 outcomes, and the threshold is defined in seven places in `src/` and `qa-engine/src/`, nine with `scripts/` and `web/` (list in the re-check table above). |
| 2.5 | Intent lock `enforce` | discard | OD-9 | Default `signal` (`src/server/run-engine-factory.ts:708`). The signal is on 24 outcomes, `opacityHigh` in all 24, and it would have rejected in 5. |

#### G3. LLM judges and evaluation (4)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 3.1 | LLM judges, `qa-judge` role, `judge-calibrate` | discard | OD-1 | Off by default (`src/settings/registry.ts:151`); the role is parked (`agents/pending/qa-judge.opencode-block.json`); `judge_attempts` and `judge_calibrations` hold 0 rows; all 1,422 stored scores are deterministic. |
| 3.2a | Langfuse sink, label import, compose profile | discard | OD-1 | Its collector twin drifted: the collector's own metrics level is `none` (`config/otel/collector-langfuse.yaml:90`), the live one `basic` (`config/otel/collector.yaml:72`), and telemetry health reads those metrics (`config/otel/collector.yaml:68-70`). |
| 3.2b | Human labels without Langfuse, reference set | redesign | OD-2 | 0 human scores among the stored 1,422. The reference set is operator data (`src/server/use-case-reference-loader.ts:10`); on the operator's checkout it holds 10 changes and none is the evaluated commit. |
| 3.3 | OpenCode OTel "Option A" prose | discard | plan row 2 | Stale documentation only (`docs/observability-design.md:509-513`, `:1364-1365`). |

#### G4. Self-maintainer (3)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 4.1 | `qa-maintainer`, incident to fix pull request | discard | D11 | Armed, not disabled: see chain step 4. |
| 4.2 | Auto-merge, canary hot-swap, merge guard | discard | D11 | Auto-merge defaults false (`src/settings/registry.ts:147`). The hot-swap copies `src` and the package files, not `qa-engine` (`src/server/self-update.ts:159-161`). The pre-deploy gate runs install, typecheck and test through `fx.exec` with a scrubbed environment (`src/server/maintainer-runtime.ts:284-288`). |
| 4.3 | Audit `engine-fix` to incident edge | discard | follows D11 | `E-STATIC` is the only engine-defect class (`qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts:21`) and every `invalid` verdict gets it (`qa-engine/src/shared-kernel/error-class.ts:96-98`): a stage, not a cause. |

#### G5. Lead and sidekick options (2)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 5.1 | qa-explore, lead-requested exploration | discard | OD-3 | At most 3 questions and 120 s (`qa-engine/src/contexts/coordination/application/explore-request.ts:9`, `:12`). Asked once in 34 runs (re-check above). Its "verified" label means the orchestrator holds the page, not that the claim is true (`qa-engine/src/contexts/coordination/application/explore-verification.ts:59-60`). `backDevStateUnmet`, `DevStateGround` and `pathOfRef` live in the same file and gate `dev-state` unmet criteria; they stay. |
| 5.2 | Escalated model for a `replace` | discard | OD-4 | Unset by default (`src/settings/registry.ts:71`); the resolver returns no model without it (`qa-engine/src/contexts/coordination/application/resolve-sidekick-model.ts:8-10`), while a replace still sets the tier to `escalated` (`qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:916`). The fields lie: `escalations` is the count of incomplete flows (`qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts:145`). 5 replaces ran across 28 outcomes with coordination data. |

#### G6. Parallel DEV access (2)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 6.1 | DevLease read-only shared mode | discard | OD-5 | Built without `readOnlyEnforced` (`src/server/run-engine-factory.ts:366-371`); the only production caller passes `mayWrite: true` (`qa-engine/src/contexts/test-execution/domain/dev-lease.ts:98`), and shared mode needs both (`:102`). The docs say the proxy has no read-only mode (`docs/lead-sidekicks.md:202-205`). |
| 6.2 | Multi-account pool | discard | OD-6 | Lives only on branches `pr2/accounts` and `feat/parallel-runs-v2`; the YAML key is dropped silently today (8.4). The queue is sequential by invariant, and the audit found no measured queue wait (31 of 32 runs were operator replays; not re-checked). |

#### G7. Triggers, modes and targets never exercised (4)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 7.1 | Deploy gate, to become a served-version fact | redesign (implemented in `4d5bc33a`, T19) | D9 (the source); OD-10 (the rest) | No app configures a version source. The read is a bare GET (`src/server/run-engine-factory.ts:290-298`); "serving" is a sha match plus `healthy` (`:1428-1432`); the loop waits to the timeout (`qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts:27-35`). A replay of an older sha can never match once DEV moves on. |
| 7.2 | Service-triggered cross-repo runs | redesign | OD-11 | 0 of 34 runs have a trigger repository. The run-creation schema has no field for one (`src/contract/commands.ts:161-183`), and the push parser reads no branch (`src/server/webhook.ts:38-44`). No objective value signal covers a backend change (D5). |
| 7.3 | `complete` and `exhaustive` modes | discard | OD-7 | 0 runs in either (modes in the history: diff 31, manual 2, context 1). Their prompt orders the author to write an analysis file (`qa-engine/src/contexts/generation/infrastructure/prompt-builders/task-builders.ts:324-337`) that no code reads. Public enum at `qa-engine/src/shared-kernel/contract/events.ts:6`; budget rows at `qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts:19-20`. |
| 7.4 | Code target and its Stryker oracle | discard | D8 | All 34 runs target e2e. |

#### G8. Dead code, switches, residue (9)

| Id | Member | Verdict | Settled by | Evidence |
|---|---|---|---|---|
| 8.1 | Unreachable modules (12 files, extractor ports, plan parser) | discard | plan row 2 | The audit's reachability scan lists them; not re-run here. RFC-0002 holds the file list. |
| 8.2 | Inert seams `prChangedFiles` and the static `contextMap` | discard | plan row 2 | Read from the root dependencies (`src/server/engine-root.ts:420-422`), never set by production composition; two tests assert they stay absent (`src/server/run-engine-factory.test.ts:1069-1073`, `src/server/seam-parity.contract.test.ts:232`) and change with the deletion. |
| 8.3 | `reviewLoopIntegrity: false` path | discard | OD-8 | Product default is on (`src/server/run-engine-factory.ts:1049`, `src/server/engine-root.ts:548`); no configured app sets it (only a commented example, `config/apps/example.yaml:129`); the engine fallback is off (`qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:64`) and 25 tests rest on it. |
| 8.4 | Silent stripping of unknown app-config keys | redesign | OD-14 | The app schema is non-strict with one `.strict()` (`src/orchestrator/schemas.ts:266`), so a typo of a threshold key falls back to the default without a word. |
| 8.5 | Retired runtime selectors | discard | OD-15 | Warned when set (`src/agent-runtime/config.ts:56-68`); the template still assigns them. |
| 8.6 | Prose and field residue | discard | plan row 2 | `avgCorrectionsRound1` is constant null (`src/server/persistence/telemetry-analysis.query.ts:184`); console placeholders (`web/public/js/api.js:455-459`). |
| 8.7 | Test support in production folders | redesign | OD-16 | Four modules (see the merge-guard row above); nothing in production imports them. |
| 8.8 | `GET /apps/:name/telemetry` | discard | OD-12 | Route at `src/server/api/route-table.ts:76`, handler at `src/server/api/handlers/insights.ts:74-84`; no first-party client; one of its fields is constant null (8.6). `GET /telemetry/health` stays. |
| 8.9 | Residue of removals with a stated decision | discard | plan row 2 | Code is clean; residue sits in operator YAMLs, the console and the judge block. |

### Shape of the served-version fact (7.1)

[ADR-0008](../adr/0008-product-version-source.md) left three points to this RFC (the states, the learning precondition, the waiting); where the decision lives is this RFC's own proposal from plan row 3, and the config format stays with ADR-0008. The proposal, kept to what removes the evidenced gap (a boolean that cannot tell "no source", "unreadable" and "another commit" apart, and that refuses every replay):

| Point | Proposal | Why |
|---|---|---|
| States | A closed set recorded on every run: `undeclared`, `unreadable` (with a typed reason), `equal`, `behind`, `ahead`, `unrelated`. The product-side port returns only the served commit; the engine computes `behind` / `ahead` / `unrelated` from the mirror's history | Today an unreadable source and a different commit fail the same way after the timeout, and no source passes silently (`src/server/run-engine-factory.ts:290-298`, `:1428-1432`). Ancestry is the signal that separates a deploy that has not landed (`behind`) from a replay (`ahead`); without it the two look alike. |
| Where it is read | The decision "serving" moves out of the factory into the run-orchestration context behind the existing gate port; the HTTP read stays an adapter | A decision about a run in the shell is plan row 3 |
| Learning precondition | Per run, by lesson kind: each kind declares which states it admits, and a left-out run carries the state as its typed reason | D14 admits facts by their own state, never by a global rule |
| Waiting | Wait only when the run is deploy-triggered and the state is `behind`; record only on a manual or campaign run | A replay cannot become `equal` by waiting. The trigger source already exists (`qa-engine/src/shared-kernel/run-mode.ts:4`). |

Implemented in `4d5bc33a` (T19): the six states are recorded as `gateSignals.servedVersion` and the gate span's `qayaba.served_version.*`; ancestry comes from the repo mirror; only a webhook-triggered run waits, only while `behind`. The learning precondition stays with the learning slice. See the Implementation note of [ADR-0008](../adr/0008-product-version-source.md).

Not proposed here: the declaration's config format and which port implementations ship first (ADR-0008 keeps them; Correction 2026-10-29: ADR-0008 in turn left them to the standalone change, so the point was circular; recommended in [ADR-0013](../adr/0013-owner-decisions-remaining-questions.md), decided when T19 lands), reading the endpoint with the DEV gate credentials (hypothesis that the endpoint sits behind it; DEV was not probed), and waiting outside the queue slot (a later change). The span attribute that the design names for this fact, "deploy verified" (`docs/observability-design.md:249`), is set by no code.

### Where the redesigned members live

| Member | Home in the engine and platform layout | Entry condition | Kill criterion |
|---|---|---|---|
| 1.3, 1.6, 1.13, 1.14 lesson kind | Engine context `cross-run-learning` (entity, delivery section through the coordination-sections registry); store in `platform` persistence | Step 1 done; ADR-0008 and ADR-0009 landed | D4: deleted after one cycle without improvement |
| 2.3 bundle mutation | Engine context `objective-signal`; the switch in the app-config schema (`app-catalog`) | Lands with ADR-0004's deletion | Measured by its own signals (kills per outcome) |
| 2.4 coverage `enforce` | `objective-signal` (the coverage decision service becomes the one threshold owner) | ADR-0005's condition | An app never reaching the condition stays on `signal` |
| 3.2b labels | Engine context `evaluation`; the command is a platform entry point | OD-2 | Unused after one campaign cycle: delete |
| 7.1 served-version fact | Engine context `run-orchestration` (gate port); HTTP adapter in the context's infrastructure | ADR-0008; standalone change before the learning rebuild | None: it is a fact, not a feature |
| 7.2 service-triggered runs | `run-orchestration` plus the webhook entry point | OD-11 (one live exercise) | No exercise by the end of platform step 6: delete |
| 8.4 unknown keys | `app-catalog` domain validation (plan row 3 names app-config validation) | Warn first at step 1; strict at step 6 | None |
| 8.7 test support | A test-support root, at plan step 4 | After D11 removes the merge guard | None |

## Patches it supersedes

What the deletions remove at 4105c582 (the commit order is RFC-0002's):

| Members | Removed |
|---|---|
| 1.1 | `src/settings/registry.ts:73-74`, `src/server/run-engine-factory.ts:1466`, `src/server/effective-config.ts:72`, the reflector adapter |
| 1.3, 1.4, 1.7 | `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/ground.steps.ts:54-64`, `qa-engine/src/contexts/cross-run-learning/domain/rule-fold.ts:28`, `qa-engine/src/contexts/cross-run-learning/application/render-learned-rules.ts:8-46` |
| 1.8 | `src/server/run-engine-factory.ts:1508` (the per-run `grounding.curriculum` override that exists only to switch it off), `qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts:387-398`, `qa-engine/src/shared-kernel/scenario-catalog.ts:114`, `qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts:678` |
| 2.1, 2.2 | `src/server/run-engine-factory.ts:988-993`, `qa-engine/src/contexts/run-orchestration/application/run-flow/fault-aim.ts`, `qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts`, `config/e2e/fixtures.ts:310-316` |
| 2.5 | The `enforce` value of the policy at `src/server/run-engine-factory.ts:708` and its refusal branch at `qa-engine/src/contexts/run-orchestration/application/run-flow/run-services.ts:108` |
| 3.1, 3.2a | `src/settings/registry.ts:151-152`, `agents/pending/qa-judge.opencode-block.json`, `config/otel/collector-langfuse.yaml` |
| 4.1-4.3 | `src/server/health-poller.ts:57-59`, `src/settings/registry.ts:147-148`, `src/server/self-update.ts:103-161`, `src/server/maintainer-runtime.ts:284-288`, `:348`, `:434` |
| 5.1, 5.2 | `qa-engine/src/contexts/coordination/application/explore-request.ts`, `qa-engine/src/contexts/coordination/application/resolve-sidekick-model.ts`, `src/settings/registry.ts:71`, `qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:916`, `qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts:145` |
| 6.1 | The shared branch in `qa-engine/src/contexts/test-execution/domain/dev-lease.ts:98-102`; the wording at `docs/lead-sidekicks.md:202-205` and `AGENTS.md:692-695` is corrected to say every action is exclusive |
| 7.3 | `qa-engine/src/shared-kernel/contract/events.ts:6` (two enum members), `qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts:19-20`, `qa-engine/src/contexts/generation/infrastructure/prompt-builders/task-builders.ts:324-337` |
| 8.2 | `src/server/engine-root.ts:420-422` |
| 8.3 | `qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:64`, `qa-engine/src/contexts/run-orchestration/application/run-flow/run-services.ts:57`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts:283`, `:488`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/fix-loop.steps.ts:293`, `src/orchestrator/schemas.ts:225` |
| 8.5, 8.8 | `src/agent-runtime/config.ts:56-68` (at step 6), `src/server/api/route-table.ts:76`, `src/server/persistence/telemetry-analysis.query.ts:184` |

## Test plan

This RFC changes behavior in only two members (7.1 and 8.4). The deletions change none, and the testing standard in force on the refactor branch (`AGENTS.md`, "Testing standards", rule 2) says a small, contained change gets no new test.

| What | Test, through the public seam | Fails today for |
|---|---|---|
| 7.1, no source | The run use case with a fake gate port and an app declaring no source ends with the served-version state `undeclared` | The gate passes and records nothing (`src/server/run-engine-factory.ts:1428-1432`) |
| 7.1, replay | The same use case, a fake port serving a descendant of the run's sha, records `ahead` and the run goes on | Today the same input waits to the timeout and ends `infra-error` (`qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts:27-35`) |
| 8.4 | Loading an app config with a misspelled key (for example in the coverage block) reports the key by name | The key is dropped and the default applies, with no output (`src/orchestrator/schemas.ts:266`) |
| 8.3, first | Before the switch goes, each of the 25 tests that guards a real rule is retargeted to the production path; a test that only pins the off path is deleted (`AGENTS.md`, "Testing standards", rule 7: suite size is not a goal) | n/a: a refactor of tests with the suite green on both fallbacks |
| Every deletion | A global search for the removed names returns nothing; the removed names join the banned terms of `npm run previous-forms:check` in the same commit; the full CI gate stays green; a contract removal also passes `npm run contract:check` and `npm run sdk:typecheck` | n/a |
| Shared code | For each removed switch that shared code with a live path, run the live command with the previous code and with the change and compare stdout, stderr and exit code (the differential check of `AGENTS.md`) | n/a |

The records cite files that later deletions remove. [RFC-0002](0002-platform-steps-0-1.md) Q1 owns the previous-forms exemption; [ADR-0007](../adr/0007-code-target-removal.md) point C and [ADR-0010](../adr/0010-maintainer-removal.md) point D ask the same question, and the [README](../README.md) compares the options.

## Measurement

The cause is carrying cost and false signals, so the signals are structural and read from code and the history database. They claim no change in run quality: a difference inside the spread of identical inputs is not an effect ([ADR-0011](../adr/0011-root-cause-fix-policy.md)).

| Signal | Before (4105c582, 2026-10-28) | After |
|---|---|---|
| Lead turns whose prompt carries "PROVEN (" | 8 of 106; present in 8 of 8 runs since run-ed28973-mvruzwli-8bb3adcd, including the baseline | 0 in every run after step 1 and D2 |
| Non-test lines in `qa-engine/src/contexts/cross-run-learning` | 1,646 | Only the gates and the process audit remain, plus the freeze path's repository as [RFC-0002](0002-platform-steps-0-1.md) decides |
| Tests that fail when the review-loop fallback is flipped | 25 in one file, 35 across the family | 0, and the switch is gone |
| Dormant members without an owner, a record or a deletion | 46 | 0 |
| Runs recording a served-version state | 0 of 34 | Every run |
| Unknown config key reported | Never | Reported by name |

Before and after for run behavior follow ADR-0011: before is the one baseline replicate run-ed28973-mvs7oo0f-17041c71 (pass, line coverage 0.630 marked stale, branch 55 of 126, bundle mutation 0 of 3 killed, 56 min, $0.45, engine 4105c582); after is one replicate of the version under test (one per version; Correction 2026-10-29: decided as recommended in ADR-0013), same launch parameters, same 12-entry suite, freeze off. The owner's words on the count concern the baseline (2026-10-28 14:29Z, translated): "the replicates will take too long, the 3 separately one after another, launch just 1". It shows a direction only. Cycle 3 ran the same input three times on one commit (40513c1e) and spread from 0.738 to 0.904 in line coverage and 0 to 1 of 3 kills. The lead prompt of the after replicate differs from the baseline by the missing curriculum section, an intended and recorded difference.

Run quality is unproven by design for this RFC.

## Owner decisions needed

Recommended answers are mine. OD-1 to OD-9 cover members no decision settles; OD-10 onward are forks of redesigned members, the contract batch and the placement rules. The owner accepted every recommended answer on 2026-10-28 ([ADR-0013](../adr/0013-owner-decisions-remaining-questions.md)).

| OD | Members | Decision | Recommended answer | Evidence |
|---|---|---|---|---|
| OD-1 | 3.1, 3.2a | Discard the LLM judges and the Langfuse sink? | Yes. One governance commit for the role and the activation switch; AGENTS.md says not to add another LLM proxy | Never produced a score (0 rows in `judge_attempts` and `judge_calibrations`); deterministic graders cover the same targets; the collector twin drifted |
| OD-2 | 3.2b | Keep human labels, decoupled from the judges; add the evaluated commit to the reference set (operator data); a deterministic delivered-recall grader as a later record? | Yes | 0 human scores; the operator's reference set holds 10 changes and none is the commit that 33 of 34 runs tested (the run count is ADR-0004's) |
| OD-3 | 5.1 | Discard qa-explore? | Yes; first move the DEV-state backing helpers in `qa-engine/src/contexts/coordination/application/explore-verification.ts` to a module of their own | One use in 34 runs, in a cancelled run, with no outcome; each turn up to 120 s and a second lead turn on the critical path. No owner decision covers qa-explore: the owner's 2026-10-24 decision removed the pre-generation grounding explorer (`odd/tasks/lead-review-loop.md:22`, S6), and the same request has the lead exploring "if it needs" (translated, `:39`). qa-explore, a read-only sidekick the lead asks for, was added on 2026-10-26 (commit cbcc6b84) |
| OD-4 | 5.2 | Discard the escalated-model path and keep `replace` as "fresh session"? | Yes | See 5.2; the tier label and the `escalations` field already misreport |
| OD-5 | 6.1 | Discard the DevLease shared mode, keep the exclusive lease, and fix the wording that overstates what holds the lease? | Yes | See 6.1; no caller can ask for shared |
| OD-6 | 6.2 | Do not merge the multi-account branches; the owner drops the `auth.accounts` key from the app YAML? | Yes; re-entry only on a measured queue wait from real deploys | `feat/parallel-runs-v2`: 48 behind, +26,938/-23,674; its live proof never ran (audit) |
| OD-7 | 7.3 | Discard `complete` and `exhaustive`, a public-enum change? | Yes; `manual` covers bootstrap; own commit with the contract regenerated | 0 runs; the analysis file they ask for is read by no code |
| OD-8 | 8.3 | Discard the `reviewLoopIntegrity` switch and its off path, a config-format change? | Yes; retarget the tests first; the removed key warns (OD-14) | 25 of 468 tests rest on it; every product default is on |
| OD-9 | 2.5 | Discard the intent lock `enforce` branch, keeping the extractor and `diffContracts`? | Yes | No evidenced value: `opacityHigh` in 24 of 24 outcomes |
| OD-10 | 7.1 | Adopt the shape in "Shape of the served-version fact": six states, ancestry from the mirror, learning admitted per run by lesson kind, wait only when deploy-triggered and `behind`? | Yes, as a standalone change before the learning rebuild | ADR-0008 left three points to this RFC (states, learning precondition, waiting); where the decision lives is this RFC's own proposal from plan row 3; the config format stays with ADR-0008 |
| OD-11 | 7.2 | Authorize one live exercise of a service-triggered run (a signed push payload for one service repo, in shadow mode), by the owner or on the owner's explicit authorization of the repository, sha and credential? | Yes, after D10 lands so the run is frozen | 0 service-triggered runs; the only entry point for backend changes |
| OD-12 | 1.5, 2.2, 5.2, 7.3, 8.3, 8.8, 2.5 | Approve the public-contract removals as separate commits, each with `npm run contract:check`: scorecard and value fields, `escalationRate` and `escalations`, the two mode values, the `reviewLoopIntegrity` key, the intent lock `enforce` value, `GET /apps/:name/telemetry`? | Yes. The value fields are also ADR-0004's open question 1 | Each is a contract others consume (high-risk item 3 of the work order) |
| OD-13 | 1.10, 1.11, 1.12, 4.3 | Keep the observe streak; rename `recurring-test-failure` and drop the "rule promotion (oracle)" advice; delete the dead findings; delete context-heal if it does not fire over the next campaign cycle? | Yes | `process-audit.ts:139-147`, `:79`; ADR-0003 lists context-heal as undecided |
| OD-14 | 8.4 | Warn per unknown app-config key as the first commit of step 1, strict schema at step 6, and the owner removes retired keys from the operator YAMLs? | Yes | `src/orchestrator/schemas.ts:266`; ADR-0006 open question 2 asks the same for the coverage block |
| OD-15 | 8.5 | The owner edits the retired selectors out of `.env.example`? | Yes, the owner's data | `src/agent-runtime/config.ts:56-68` warns when they are set |
| OD-16 | 8.7 | Move the four test-support modules under a test-support root at plan step 4? | Yes; the merge-guard gap is moot once D11 removes the guard | Three of four are outside the guard today |
| OD-17 | 1.2, 1.11, 1.12, 1.16, 1.17, 3.3, 8.1, 8.2, 8.6, 8.9 | Confirm as one batch that rows 1 and 2 of the plan's decision table delete these without a per-item decision? | Yes | Each is a copy or has no consumer; the table above gives the evidence |
| OD-18 | placement | Confirmed local residuals of refuted families (the threshold in seven places in `src/` and `qa-engine/src/`, nine counting `scripts/` and `web/`, `E-STEP-BUDGET` teaching, a parse miss with no class, a stale measurement served as current) ship as RED tests in the slice that owns their fact, never as patches on main, and the members that depend on them wait? | Yes. ADR-0011 rule 5 forbids main patches; a plausible cause is never fixed | Nine threshold sites verified in the re-check table (seven in `src/` and `qa-engine/src/`, two in `scripts/` and `web/`); `NON_LEARNING` lacks both classes |
| OD-19 | 1.3, 1.6, 1.13, 2.3, 2.4, 3.2b, 7.1, 7.2, 8.4, 8.7 | A redesign member with no record by the end of platform step 6 is deleted, not left dormant? | Yes | The owner's own diagnosis; every member here drifted while dormant |
| OD-20 | outside the dormant set | The publication adapter merges through REST when enabling auto-merge fails, and waits for no check (`qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts:58-73`). Decide its fate when? | When the first non-shadow publication is planned; no change before. It is active code every target uses, so D8 does not touch it | The audit attached it to the code target; it is shared |

Correction 2026-10-30 (OD-13): asked whether to keep the name `recurring-test-failure` or rename it to `recurring-app-behavior-gap`, the owner answered "lo que recomiendes" (translated: "whatever you recommend"; feature document L15). The recommendation was to keep the name, because what misled was the "rule promotion (oracle)" advice, which is gone; the finding's summary now says "a recurring app-behavior gap (not an engine defect)". The name stays and the rename half of OD-13 is closed; context-heal is still pending a campaign cycle (feature document T27).

Questions held open in the ADRs and not repeated here: ADR-0003 (the lesson entity and its actor, whether the no-op repository and `LearningPort` survive step 1 (RFC-0002 fixes it), the vehicle for D3 and the comment at line 1 of the coordinator projection, whether the exemplar templates and the keyword detector go with the curriculum, the definition of a data-state failure, context-heal, persisted leftovers (tables and columns, among them `run_outcomes.reflection`)); ADR-0004 questions 1 and 2; ADR-0005 questions 1 to 4; ADR-0006 questions 1 and 2; ADR-0007 points A to D; ADR-0010 points A to D. For the entries open in ADR-0003 the audit's recommendation is: the actor is recorded, the templates and the detector are deleted with the curriculum, context-heal follows OD-13, the `reflection` column is kept (no persisted-format change), and the freeze path's repository is kept with a corrected header. [RFC-0002](0002-platform-steps-0-1.md) Q4 recommends otherwise for that last entry: delete the stub with the rule-loop port it implements and keep the builder until step 2. This RFC follows RFC-0002 on that entry, since RFC-0002 traced the port the stub implements. These are proposals, not decisions.

If phase 3b confirms further root-cause families, the placement of members that depend on them may change, and this RFC gets an amendment.

## Out of scope

- The rebuilt learning layer, the coverage `enforce` decision and the bundle-mutation key: ADR-0003, ADR-0005, ADR-0006 and their RFCs.
- File-level inventory and the order of the step 1 commits: [RFC-0002](0002-platform-steps-0-1.md).
- The three confirmed causes: [RFC-0003](0003-coverage-dump-harvest.md), [RFC-0004](0004-log-level-from-outcome.md), [RFC-0005](0005-suite-store-single-writer.md).
- Closing the 18 maintainer pull requests and deleting the mirror: needs the owner's explicit go (ADR-0010).
- Edits to operator data: the app YAMLs, the reference set, `.env.example`.
- Test quality and the engine/AI boundary table (ADR-0002 open question 3): other strands of the investigation.

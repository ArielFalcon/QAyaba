# ADR-0005: When change coverage moves to enforce

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** D6. On 2026-10-28 15:32Z the owner approved the recommendations D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). D6 as put to the owner: "Coverage enforce: replace L7(b) (fault calibration, unreachable) and choose where a block goes". The recommendation the owner approved: "Replace with '3 consecutive replicates with a trustworthy measurement (no stale or unreadable-evidence unknown) and bundle mutation on'; a block = PR held with the report, not an app Issue". Supporting words, 2026-10-28 13:36Z (translated): "The app is a QA tester; if its priority is to make green tests, it becomes a garbage generator."
- **Code references at 4105c582:**
  - The gate and what follows a block: `qa-engine/src/contexts/objective-signal/domain/decide-coverage.service.ts:24-32`, `qa-engine/src/contexts/run-orchestration/domain/coverage-regen.ts:19-23`, `qa-engine/src/contexts/run-orchestration/domain/run-decision.service.ts:50-52`, `:67-69`, `qa-engine/src/contexts/run-orchestration/domain/run-decision.ts:5`, `qa-engine/src/contexts/workspace-and-publication/domain/publish-decision.service.ts:3`, `:19`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts:199`, `:218-262`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts:14-26`
  - The configuration key: `src/orchestrator/schemas.ts:228-239`, `src/server/run-engine-factory.ts:644`, `:707`, `config/apps/example.yaml:131-141`, `AGENTS.md:769`, `docs/observability-context.md:111`, `docs/architecture-remediation.md:354`
  - The condition being replaced: `odd/tasks/arch-p6-result-quality.md:82`, `:132`, `:151`, `:155`, `:165`, `qa-engine/src/contexts/objective-signal/domain/fault-calibration.ts:11`, `:51-66`, `scripts/fault-calibration.ts:62`
  - The measurement the gate reads: `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts:614-696`, `qa-engine/src/contexts/run-orchestration/application/run-flow/decided-end.ts:278`, `qa-engine/src/shared-kernel/run-outcome.ts:122-123`, `qa-engine/src/contexts/objective-signal/infrastructure/coverage-collector.adapter.ts:16-19`, `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:172-180`
  - Tests that pin today's block: `qa-engine/test/contexts/run-orchestration/domain/run-decision.scenarios.test.ts:133`, `qa-engine/test/contexts/run-orchestration/domain/run-acceptance.test.ts:23`, `qa-engine/test/contexts/workspace-and-publication/domain/publish-decision.service.test.ts:17-18`
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0004](0004-response-value-oracle-removal.md), [ADR-0006](0006-bundle-mutation-switch.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0003](../rfc/0003-coverage-dump-harvest.md)

**In one line:** an app moves to change-coverage `enforce` only after three consecutive replicates with a trustworthy measurement and bundle mutation on. A block holds the PR with the report and opens no Issue in the app's repository. No app moves because of this record.

## Context

**What enforce does.**

- `blocks()` is true only for `enforce` with a `fail`. `unknown` never blocks (`decide-coverage.service.ts:26`, `:30-32`).
- A blocked, measured, per-commit run gets one coverage regeneration (`coverage-regen.ts:19-23`).
- If it is still blocked, the run becomes an Issue in the app's repository (`run-decision.service.ts:50-52`, `publish-decision.service.ts:19`, target `publication-port.adapter.ts:199`, `:258`) and its suite stays out of the suite store (`run-decision.service.ts:67-69`).
- No run has used it. The effective configuration of all 32 runs that record one says `signal` (`runs.coverage_mode`, history read on 2026-10-28).

**The condition today, and where it lives.** Owner decision L7 (2026-10-25), in the P6 task document: "no app moves to `qa.coveragePolicy.mode: enforce` until a local-frontend run with source maps measures coverage in 3 replicates and the S3 calibration passes on the same case (T7)" (`odd/tasks/arch-p6-result-quality.md:155`). Part (a) is the 3 measured replicates, part (b) the calibration. The task that would apply it, T7, is open (`:132`) and was deferred again at `:165`. The condition is restated in `docs/architecture-remediation.md:354`. Nothing in code checks it: the schema accepts `enforce` for any app (`schemas.ts:234`), and `calibrate` is called only by its own script (`scripts/fault-calibration.ts:62`). It is a rule for whoever edits an app's configuration.

**Why part (b) cannot pass.** `calibrate` returns `insufficient` unless three replicates carry `valueStats` (`qa-engine/src/contexts/objective-signal/domain/fault-calibration.ts:11`, `:51-66`). Only the response oracle writes them, and no outcome has any ([ADR-0004](0004-response-value-oracle-removal.md)).

**Why part (a) rests on an old premise.** The deferral assumed DEV serves no source maps ("DEV serves no source maps", `odd/tasks/arch-p6-result-quality.md:82` and `:151`); it was deferred again at `:165`, where the condition is a run against the local frontend with source maps. In the history, 18 of 31 outcomes carry a measured ratio, and every one was measured against DEV. The engine never builds or starts the app (`AGENTS.md:27-28`), so a "local frontend run" would mean pointing an app at another origin, while the history shows the DEV origin already gives a measurement.

**The measurement the gate would read.**

| Fact | Evidence |
|---|---|
| Under `signal`, an accepted regeneration after the measurement leaves the old ratio in place and marks it stale. | `review.steps.ts:614-622`, `:679-695`; `decided-end.ts:278`; `run-outcome.ts:122-123` |
| 10 of the 18 measured ratios carry `coverage.stale`. The baseline run-ed28973-mvs7oo0f-17041c71 (4105c582, ratio 0.630) is one of them. | History read on 2026-10-28 |
| Under `enforce` the run measures again on the final bytes with a whole-suite execution, so staleness is something to read in `signal` replicates before an app moves. | `review.steps.ts:627-677` |
| A collector that fails or times out answers an empty report. `unknown` never blocks, so the gate turns itself off when evidence is lost. Whether unreadable evidence is told apart from a true `unknown` is hypothesis H22 (plausible, not confirmed). | `coverage-collector.adapter.ts:16-19`; `decide-coverage.service.ts:26` |
| Latent defect on the enforce path: a flaky run whose final measured run is red takes that run's verdict, and a `fail` opens an Issue. `AGENTS.md` says the flaky verdict stays. Found by the independent check of the last fixes; no app uses enforce, so it has not fired. | `review.steps.ts:630-633`; `AGENTS.md:152` |

**The condition applied to the record.** Campaigns with at least three replicates, on the facts the run records. "Measured" means the run recorded a ratio. The campaigns ran at different qayaba versions, so read the rows as a timeline, not as one set:

| Campaign | Measured | Marked stale | Bundle mutation recorded | Meets the condition |
|---|---|---|---|---|
| t7-x5-2026-10-26-a | 3 of 3 | 2 | 3 | No |
| t7-x5-2026-10-26-b | 2 of 3 | 1 | 2 | No |
| t7-broad-3c-2026-10-27 | 3 of 5 | 2 | 3 | No |
| validation-2026-10-28-a | 2 of 3 | 2 | 2 | No |
| validation-2026-10-28-b (cycle 3, 40513c1e) | 3 of 3 | 0 | 3 | Yes |
| validation-2026-10-28-c (baseline, 4105c582) | 1 of 1 | 1 | 1 | No |

One campaign qualifies, at a code version that is no longer main, and the baseline on main is stale. The "Yes" holds on the recorded facts only: the record does not say whether any evidence was left out. Two of the three passing outcomes with no ratio (run-ed28973-mvpky8fw-f5c5f61e, run-ed28973-mvptanac-2600fbd4) logged unread dumps, according to the refutation of H22; that check was not repeated here.

**The configuration key drifted.** The code reads `qa.changeCoverage.mode` (`schemas.ts:228-239`, `run-engine-factory.ts:644`, `:707`) and the example configuration documents that spelling (`config/apps/example.yaml:138-141`). `AGENTS.md:769`, `docs/observability-context.md:111`, `docs/architecture-remediation.md:354` and the L7 text call it `qa.coveragePolicy.mode`. No such key exists. The `qa` object is not strict, so a configuration written from the documented spelling parses without a message and the key is dropped. Checked on 2026-10-28 against the schema at 4105c582: `config/apps/example.yaml` with `qa.coveragePolicy.mode: enforce` and no `changeCoverage` parsed, and both `qa.coveragePolicy` and `qa.changeCoverage` came out undefined, so the app would run `signal`. Two of the five app configurations read that day still carry a retired key under `qa` that the schema drops the same way. Every configured app runs `signal`.

## Decision

| # | Decided |
|---|---|
| 1 | An app moves to `enforce` only after three consecutive replicates with a trustworthy measurement (no stale measurement, no `unknown` caused by unreadable evidence) with bundle mutation on. |
| 2 | This replaces L7(b), the fault calibration. |
| 3 | A block holds the PR with the report. It does not open an Issue in the app's repository. |

Moving an app stays the owner's act on its configuration. This record sets the condition and moves nothing.

**Not decided here** (each was an open owner question, decided 2026-10-28 as recommended, [ADR-0013](0013-owner-decisions-remaining-questions.md); the recommended answer follows it):

1. Does the new condition replace all of L7, or only part (b), so that part (a), "a local-frontend run with source maps", still stands? Recommended: it replaces L7 as a whole. Replicates measured on DEV count, as 18 outcomes show DEV can be measured.
2. What makes replicates "consecutive"? Recommended: replicates of one campaign case (one input), in order, at one qayaba commit. A replicate that fails the trust test, or a new qayaba commit, restarts the count. The table above shows why: the qualifying campaign ran at a version main has left.
3. What does "holds the PR" send where? Two readings. Reading A: nothing goes to the app's repository; the PR text with the coverage report is kept on the run, the stored decision says `held`, and the suite stays out of the store as today. Reading B: a PR is opened without auto-merge and carries the report. Recommended: A. It needs no new publisher capability, follows the shadow-log precedent (`publication-port.adapter.ts:210-214`), and keeps qayaba's unaccepted work out of the app's repository, in line with the decision not to open an app Issue.
4. How is the condition checked, and how is "unreadable evidence" recognised? Recommended: a read-only operator script over the run history that answers per app, in the place of `fault-calibrate`; the engine does not refuse an `enforce` setting. The record first gets a typed fact that evidence was left out of a measurement, as a precondition of the clause, not as a fix of H22. Without it, that clause cannot be checked.

## Consequences

- **L7(b) and its script are retired** with the oracle ([ADR-0004](0004-response-value-oracle-removal.md)).
- **The drift is fixed by the implementation.** `AGENTS.md:769`, `docs/observability-context.md:111` and `docs/architecture-remediation.md:354` are corrected to `qa.changeCoverage.mode`, the key the code reads and `run-engine-factory.test.ts:1475-1481` pins. The task log under `odd/` keeps its text as history. A key the schema drops without a message is the cause of the drift; its handling is open question 2 of [ADR-0006](0006-bundle-mutation-switch.md).
- **A held block needs new code.** The publisher can only open a PR with auto-merge, and when auto-merge cannot be enabled it merges (`github-pr.adapter.ts:14-26`). The decision types change: `SideEffect` (`run-decision.ts:5`), `decide` (`run-decision.service.ts:50-52`), `PublishOutcome` and its rule (`publish-decision.service.ts:3`, `:19`), the publication route (`publication-port.adapter.ts:218-262`). The stored decision of a run (`runs.decision` holds `none`, `quarantine` or `shadow-log` in the history) gets a new value. The word is already in use: `publish-decision.service.test.ts:17` is titled "→ issue (PR held)", meaning no PR is published.
- **Preconditions on the enforce path.** The latent defect above is fixed first, with a failing test, as an input to the verdict and ending slice of the refactor, never as a patch on main (the approved work order). The final whole-suite measurement under `enforce` has no time check (H16, plausible).
- **The condition costs time.** Three replicates of a run took 40 to 60 minutes each in cycle 3 (run-ed28973-mvs0onsn-6ad17f30, run-ed28973-mvs2ukug-c82da7be, run-ed28973-mvs49h5y-acdab309).

## Enforcement

Not enforced yet. What will hold each part:

- **The key.** When the documents are corrected, the previous-forms gate (`scripts/check-previous-forms.ts:38-52`) gets `qa.coveragePolicy` as a banned term. The records under `docs/architecture` quote it on purpose, so that change keeps the new rule from applying to the folder ([RFC-0002](../rfc/0002-platform-steps-0-1.md) Q1, commit G1) or allow-lists the lines.
- **The block.** A test through the public seam of the decision and the publication port: a measured `fail` under `enforce` records the side effect `held` (reading A of open question 3), opens no Issue and opens no PR, and the report text is kept. A `fail` under `signal` and an `unknown` under `enforce` are unchanged.
- **The condition.** Held by the operator until open question 4 is answered. No code refuses `enforce` today.

## Alternatives considered

| Alternative | Why it is not the decision |
|---|---|
| Keep L7 as written | Part (b) never passes and part (a) assumes DEV cannot be measured. `enforce` stays off for good, and the only objective gate against the generate-and-review loop never turns on. |
| Where a block goes: an Issue in the app's repository (today) | Set aside by D6. What it leaves: a block says qayaba's own suite did not run enough of the change, yet the Issue lands in the tracker of the product under test, though it is not a defect of the app. The dormant-features audit ([RFC-0001](../rfc/0001-dormant-features.md)) called this a design question for the owner. |
| Where a block goes: a report owned by qayaba and nothing else | Under reading A of "holds the PR" this is the same thing. Under reading B the difference is whether a PR exists. |
| A gate per use case from `coverageByCandidate` instead of one aggregate ratio | It reads the flow rather than a single threshold, which fits the pillar on signals. It is not part of D6 and nothing here prevents it later. |
| The engine refuses `enforce` for an app that does not qualify | Turns a configuration into a silent `signal` or stops every run of the app. See open question 4. |

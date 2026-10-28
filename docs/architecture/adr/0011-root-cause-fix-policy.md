# ADR-0011: Root-cause fix policy and measurement conditions

- Status: Accepted, 2026-10-28, owner
- Decision source: D12 and D13, on top of the investigation brief the owner wrote on 2026-10-28 (10:21Z). On 2026-10-28 (15:32Z) the owner approved D1-D13 together: "Regarding the 13 recommendations I agree with everything, [...]" (translated; the rest of the sentence concerns the learning layer's filter on problem runs, settled in D14). D12 as approved: "Only confirmed causes get a fix: H06, H11, H20 + what phase 3b confirms; unconfirmed families get no family slice" (phase 3b is the narrowing round, see Consequences). D13 as approved (the row the owner saw at 15:18Z, recommendation "First option"): "After-measurement conditions: same effective suite as the baseline (12 of 13 snapshot entries, digest fc7ad52e) and same freeze (off), via a new 12-entry snapshot with its blobs; alternative: re-run the baseline with the full snapshot and freeze on". That row has no replicate count. The only owner words on the count are about the baseline: one replicate (2026-10-28 14:29Z and 15:52Z, quoted in rule 4). How many replicates an after-measurement and each later version get is not decided (see Not decided here). The owner's words behind each rule are in the Decision table.
- Code references at 4105c582:
  - Rules a fix must respect: `AGENTS.md:3-21` (golden rule; `:20-21`: a "bug" may be a deliberate guard from a past fix), `AGENTS.md:746-760` (testing standards; `:752-753`: a bug fix starts with a test that fails for the bug's reason)
  - What the before and the after must hold constant: `scripts/campaign.ts:264-266` (freeze guard, launcher only), `src/server/effective-config.ts:62` (the freeze a run records), `qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/suite-store-trace.ts:48` (the suite digest a run records), `qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts:504-516` (the blob removal behind the 12-of-13 restore), `scripts/campaign-compare.ts:94-100` (isolation judged inside one campaign)
  - Defects found while verifying F18-F21 (table in Consequences): `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts:631-633`, `qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:480`, `:1045`, `:1070-1071`, `:1273-1278`, `qa-engine/src/contexts/coordination/application/coordination-sections/replan-sections.ts:71`, `qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:272`, `AGENTS.md:148-152`
- Related: [ADR-0001](0001-design-pillars.md), [ADR-0002](0002-architecture-direction.md), [ADR-0009](0009-campaign-freeze-on-server.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md), [RFC-0003](../rfc/0003-coverage-dump-harvest.md), [RFC-0004](../rfc/0004-log-level-from-outcome.md), [RFC-0005](../rfc/0005-suite-store-single-writer.md), [Rejected explanations](../rejected-explanations.md)

**In short:** only a confirmed cause gets a fix. Each fix is test-first, one commit per root cause, and removes the patches it supersedes. It is measured before and after under fixed conditions (the baseline is one replicate by the owner's instruction; the count for the after-measurements is for the owner to confirm), and reported "unproven" without measured improvement; one run against one run shows a direction, never proof. Defects found on the way become RED tests in the refactor, never patches on main. A product or architecture decision stops the work until the owner decides.

## Context

The investigation read 29 runs of one app as a timeline of code epochs, proposed 27 hypotheses and had two independent refuters try to disprove each, except H25 and H27, which had one combined refuter. The result: 3 confirmed (H06, H11, H20), 17 plausible, 7 refuted. The verdict of a hypothesis is the lower of its refuters' verdicts; an adjudicator settles a hypothesis one refuter confirmed and the other refuted (H02, H11, H17, H20, H21). Two of the three confirmed ones were settled that way (H11, H20), and both are confirmed in a narrower form than they were proposed.

| Confirmed | The cause, as confirmed | Record |
|---|---|---|
| H06 | coverage dumps are parsed synchronously on the orchestrator's event loop | [RFC-0003](../rfc/0003-coverage-dump-harvest.md) |
| H11 | each seam fixes its log level at the call site and never derives it from the typed outcome recorded beside it | [RFC-0004](../rfc/0004-log-level-from-outcome.md) |
| H20 | the suite store removes every blob its new manifest does not name, while a replicate reset copies the manifest only | [RFC-0005](../rfc/0005-suite-store-single-writer.md) |

Without written rules, a refactor drifts toward the failure the owner named on 2026-10-28 13:36Z (translated): "If all the fixes we plan are designed to fix only those symptoms, what will happen is that when running qayaba against a new app, it will start failing constantly again." This record fixes the rules the owner set, in the owner's words, so no later session has to rediscover them.

The approved work order is platform steps 0-1, then one slice per confirmed root-cause family (moving what it touches out of `src/`), then platform steps 4-6.

## Decision

| # | Rule | The owner's words |
|---|---|---|
| 1 | **Only a confirmed cause gets a fix.** A plausible hypothesis stays an open question and is never fixed. A refuted one is recorded as a rejected explanation. A family that is not confirmed gets no family slice. Today: H06, H11, H20. | Brief, 2026-10-28 10:21Z: "Only “confirmed” moves on. Discard anything refuted; report “plausible” as open questions, never fix them." D12 recommendation, approved: "Yes (the brief's own rule)". |
| 2 | **Design, then test-first, one commit per root cause, superseded patches removed.** The RFC names the patches the fix makes redundant (path:line) before any code is written. The RED test goes through a public seam and fails for the bug's reason. The GREEN fix is one commit. The patches it supersedes go in the same change. | Brief: "Design: for each confirmed cause, one fix that removes the cause for the whole family, consistent with the architecture and ADRs. Name the patches it makes redundant." and "Implement (worktree): test-first — a test that reproduces the failure mechanism (RED), then the fix (GREEN). One commit per root cause. Remove the patches the fix supersedes." |
| 3 | **Measure before and after. A fix without measured improvement is reported as "unproven".** The signal that shows the cause gone is named in the RFC's Measurement section. The full suite is compared with the baseline. | Brief: "Verify: full suite against the baseline; re-run the affected scenarios and compare failure rates before/after. A fix without measured improvement is reported as unproven." |
| 4 | **Measurement conditions (D13).** The table below: the suite and the freeze are D13's first option, approved. The baseline is one replicate. The replicate count of the after-measurements is not decided (see Not decided here). | D13 first option, approved 2026-10-28 15:32Z (see Decision source). About the baseline, 2026-10-28 14:29Z (translated): "the replicates will take too long, the 3 separately one after another, launch just 1". 2026-10-28 15:52Z (translated): "we had agreed on 1 single replicate, why did you launch 3?" |
| 5 | **No patches on main during the refactor.** A defect found on the way is kept as information for the refactor, as a RED test in its family's slice (the RED test in a slice is the investigation's mechanism, not the owner's wording). | 2026-10-28 15:04Z (translated): "do not add more patches to main, keep those discoveries as information for the refactor process". |
| 6 | **A product or architecture decision stops the work until the owner decides.** The agent does not choose. | Brief: "If a fix needs a product or architecture decision, STOP and ask me — do not choose." |
| 7 | **Evidence labels hold in every record.** A conclusion is "confirmed" (evidence in hand) or "hypothesis". A claim names its run id, log line or `path:line`. A cause is not generalized from one run. A run is read in the code epoch it ran in, never pooled with runs of other code. | Brief: "Never generalize from one run. Recurrence must be shown with counts." and "Do not attack symptoms nor straw men: if the evidence does not support a cause, say “not enough evidence” instead." 2026-10-28 10:36Z (translated): "Do not analyze the runs as a set, as if they had been run with the same code." |

Unchanged boundaries from the brief: "Never push, merge, or touch other existing worktrees." Push, pull request and merge stay the owner's.

### Measurement conditions (rule 4, D13)

| | Before | After |
|---|---|---|
| Replicates | ONE, by the owner's instruction: run-ed28973-mvs7oo0f-17041c71 (campaign validation-2026-10-28-c, replicate 1), engine code 4105c582 | Not decided (see Not decided here). Recommended: one of the version under test |
| Input | app commit ed28973, 3-commit range, shadow mode, full capture | the same launch parameters, copied from the baseline launch |
| Suite it starts from | 12 of the snapshot's 13 entries restored, digest fc7ad52e (span `qayaba.suite_store.restore`) | the same 12 entries, from a new 12-entry snapshot that carries its blobs |
| Freeze | off (`effectiveConfig.campaignFreeze` false on the run record) | off |
| Full CI gate | green at 4105c582: 12282 tests, 12280 pass, 0 fail, 2 skipped | green: 0 failing |
| What a comparison may claim | | A direction. Never proof when it is one run against one run (the spread below). |

Why 12 of 13: the snapshot names `flows/user-account.spec.ts` at 6aa379ad, whose blob the suite store removed after run-ed28973-mvrxb30p-ecfe944b (H20, [RFC-0005](../rfc/0005-suite-store-single-writer.md)). That run, the last of cycle 2, restored 13 entries (digest a17480c9). The baseline and the cycle 3 replicates restored 12, with digest fc7ad52e. A run that restored 13 started from another suite and is not comparable.

Why one against one is not proof. Three replicates of cycle 3 ran the same engine commit (40513c1e) on the same input. The baseline ran 4105c582, four engine commits later (F18-F21, listed under Consequences), so its row differs in engine code as well as in the run.

| Run | Engine code | Verdict | Line coverage | Branch arms | Mutants killed |
|---|---|---|---|---|---|
| run-ed28973-mvs7oo0f-17041c71 (baseline) | 4105c582 | pass | 0.630, marked stale | 55/126 | 0 of 3 |
| run-ed28973-mvs0onsn-6ad17f30 | 40513c1e | flaky | 0.766 | 52/132 | 0 of 3 |
| run-ed28973-mvs2ukug-c82da7be | 40513c1e | pass | 0.904 | 86/132 | 1 of 3 |
| run-ed28973-mvs49h5y-acdab309 | 40513c1e | pass, E-FALSE-POSITIVE | 0.738 | 64/130 | 1 of 3 |

Inside cycle 3 alone, with identical code and input, line coverage spans 0.738-0.904 and branch arms 0.394-0.652. A difference within that spread is not evidence of an effect.

The run run-ed28973-mvs9yzjd-bf4eb95c (campaign validation-2026-10-28-c, replicate 2) was launched against the one-replicate instruction and cancelled by the operator on 2026-10-28. It is excluded from every comparison. Replicate 3 was never launched.

## Consequences

- Every RFC for a confirmed cause carries a RED test, the list of patches it supersedes and a Measurement section. A cause with no such RFC is not fixed.
- "Unproven" is a normal result and is reported as such. A fix is also unproven when its trigger did not occur in the after replicate. An improvement seen in one against one is reported as a direction, never as proof. A failure rate cannot be computed from one replicate; the comparison reads the named signal in the two runs.
- A narrower mechanism a refuter found is a new hypothesis, not a confirmed cause. It enters refutation like any other and gets a fix only if it is confirmed (rule 1). Seven refuted explanations and their narrower mechanisms are in [Rejected explanations](../rejected-explanations.md).
- The freeze setting is part of the conditions. Once [ADR-0009](0009-campaign-freeze-on-server.md) is implemented, a campaign-tagged run is frozen unless its request declares the learning arm. An after-measurement run then has to declare it, or be launched without a campaign, to keep the freeze off as the baseline had it.
- Each replicate costs 40-60 minutes and $0.35-0.46 (the four runs above). The number of replicates per version is the owner's to confirm (Not decided here).

Defects found while verifying the last four fixes on main (F18-F21, commits c6a37c9a, a1ea43eb, d3af69c8, 4105c582). Each was confirmed by the independent verifier and by a refuter of its report. Under rule 5 none is patched on main. None fired in the baseline run.

| Id | Commit | Where | Defect | Area (the investigation's placement, not an owner decision) |
|---|---|---|---|---|
| B1 | 4105c582 | `review.steps.ts:631-633` | Under `enforce`, a flaky run whose final measured run is red replaces the flaky verdict. `AGENTS.md:148-152` says the flaky verdict stands. Latent: no configured app uses `enforce`. | how a run's ending is decided |
| B2 | d3af69c8 | `lead-sidekicks.ts:480`, `replan-sections.ts:71` | The capacity override makes the "not admitted" section state the wrong capacity. | a capacity fact with two sources |
| B2' | c6a37c9a | `lead-sidekicks.ts:1273-1278`, `:1070-1071` | `leadTurnBudget` is `room - MIN_FLOW_MS`, which leaves no margin when the reserve is pinned (under 480 s left). A lead turn that runs to its timeout still drops every order. Not fixed by F18 in that regime; not a new regression. | the run's time authority |
| B3 | c6a37c9a | `lead-sidekicks.ts:1045`, `run-qa.use-case.ts:272` | An unsent correction turn leaves `tally.turns` at 0, so `gateSignals.coordination.corrections` is not recorded. | the coordination record |

Not decided here (decided 2026-10-28 as recommended, [ADR-0013](0013-owner-decisions-remaining-questions.md)):

- **Where a defect goes when its family is not confirmed.** B1-B3 are not defects of H06, H11 or H20, so rule 5 has no slice to put their RED tests in. Recommended: each gets its own RED test and fix commit on the refactor branch, scheduled with the first step or slice that already edits the same function, never earlier.
- **How many replicates an after-measurement and each later version get.** The owner's words on the count are about the baseline (one; 2026-10-28 14:29Z and 15:52Z), and the D13 row the owner approved has no count. The "one per version" reading was written by the investigation after the bulk approval and was not confirmed by the owner. Recommended: one replicate per version, because the owner chose one for the baseline for time and one against one is read as a direction either way; more only if the owner asks. Owner to confirm or change.
- **Whether the replicate after platform step 1 becomes the new before.** Step 1 also switches the curriculum off (D2) and deletes the learning layer (D1), so the lead's prompt changes. The first after replicate then differs from the baseline by more than one fix. Recommended: take one replicate after step 1 and use it as the before of the first family fix (this depends on the replicate-count answer above).

## Enforcement

Held by the RFC template and by review. No gate sees the order of a test and a fix, or the claim a record makes.

| Rule | Held by today | Gap |
|---|---|---|
| 1 Only confirmed | Each RFC's Recommendation cites the refuter verdict; "Owner decisions needed" lists every fork. | Not enforced yet. |
| 2 Test-first, one commit, patches removed | `AGENTS.md:752-753`; the Code implementation standard added to `AGENTS.md` on the refactor branch (done means a global search for the rule plus the full CI gate); each RFC's "Patches it supersedes" list; `AGENTS.md:20-21` (confirm a patch is not a deliberate guard before removing it). `npm run previous-forms:check` catches banned terms and dead references only. | No check that a superseded patch was removed. Not enforced yet. |
| 3 Unproven | The RFC's Measurement section. | Not enforced yet. |
| 4 Conditions | The launcher refuses a pipeline arm when the freeze is off (`scripts/campaign.ts:264-266`); the baseline launcher bypassed it. The run records the freeze (`src/server/effective-config.ts:62`) and the suite digest (`suite-store-trace.ts:48`). `scripts/campaign-compare.ts:94-100` compares digests among the runs of one campaign listing. | No check between the baseline's campaign and the after replicate's was found (hypothesis: read, not run). Freeze on the server: [ADR-0009](0009-campaign-freeze-on-server.md), not yet implemented. Suite isolation: [RFC-0005](../rfc/0005-suite-store-single-writer.md). |
| 5 No patches on main | Review of what lands on main. | Not enforced yet. |
| 6 Decisions stop the work | Each RFC's "Owner decisions needed". | Not enforced yet. |
| 7 Evidence labels | The previous-forms gate checks that a cited path exists and, for a bare file name, that the line is inside the file. | It does not check that the line says what the record claims. |

## Alternatives considered

- **Fix the plausible hypotheses too.** Rejected by the brief: "never fix them". A plausible verdict means a refuter could not exclude an alternative explanation.
- **Three or more replicates for the baseline.** Not chosen: the owner asked for one (2026-10-28 14:29Z and 15:52Z) and gave time as the reason ("the replicates will take too long"). For the after-measurements the count is open (Not decided here). The price of one is that no one-against-one comparison is proof.
- **Re-run the baseline from the full 13-entry snapshot with the freeze on.** D13's other option. Not chosen: the owner approved the first option, which keeps the one baseline and rebuilds the after-snapshot to match it. The other needs a second baseline run.
- **Patch main as defects are found.** Rejected by the owner (rule 5): the discoveries go into the refactor.
- **Pool the replicates of different code versions into one failure rate.** Rejected by the owner's timeline instruction (2026-10-28 10:36Z, rule 7): runs of different code are not one set.

# RFC-0014: What replaces the diff tiers (ADR-0001, open question 3)

- **Status:** Accepted, 2026-10-31, under the owner's rule of [ADR-0015](../adr/0015-owner-decisions-2026-10-30.md) point 2 (the recommended answer of every question below is taken; [ADR-0019](../adr/0019-owner-decisions-rfc-0014.md) records them)
- **Code references at b0402666** (the worktree head when the map was made; read a line with `git show b0402666:<path>`).
- **Implementation:** T22 on `fix/root-cause-t22` (from `f2f7203b`); the units U1-U4 below, landed as the commits of the Implementation note at the end.
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P3 and open question 3), [RFC-0012](./0012-one-time-authority.md) ("the tiers that choose its row stay until T22"), [ADR-0017](../adr/0017-time-authority-answers.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [Rejected explanations](../rejected-explanations.md) (H14)

## Summary

1. `diffTier` sorts a change into `tiny`, `focused` or `broad` by two comparisons against constants (`qa-engine/src/shared-kernel/diff-stat.ts:41-44`, `:46-53`). The source declares its own limit: generated files and lockfiles inflate a tier and a one-line change can have a wide blast radius (`:40`). ADR-0001 lists it as the P3 deviation and leaves the replacement to this RFC (open question 3).
2. The tier has four direct readers and one indirect (the map below). Three of them do not need a size at all; the fourth (the effort sentence) is already answered by a fact the engine computes, the use cases the change makes testable.
3. Proposal: delete the tier. The run deadline becomes one `diff` row (a safety bound, not an estimate), the first-pass tier cap goes, the effort sentence states one rule that scales with the affected flows, and the settings that named a tier retire. No new threshold, no new setting, no new signal to compute.
4. Evidence is thin on purpose: no record shows a tier misjudging a run's work (Evidence). The case rests on the code (P3, the declared limit) and on what each consumer is for.

## The consumers of the tier

| # | Consumer | Where | What the tier decides |
|---|---|---|---|
| C1 | Run deadline row | `qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts:33-37` (`DIFF_KEY_FOR_TIER`), `:48-52` (`runTimeBudgetKey`), `:14-20` (25/40/60 min); read at `run-deadline.ts:119-120` and `opening.steps.ts:171-178` | Which of `diff-tiny`/`diff-focused`/`diff-broad` bounds the whole run. The table's own comment: "it exists to end a run that is no longer converging, not to shape one that is" (`:13`) |
| C2 | First-pass cap | `diff-stat.ts:56-60` (`DIFF_TIME_BUDGET_MS`: 6 min, 12 min, none), `generation/domain/generator-time-budget.ts:36-62`, `generate-tests.use-case.ts:207-219` (held to `allowance("generate")`, limit `tier-budget`) | The wall time of a run-level author's first pass. A coordinated flow runs on `flowBudgetMs`, not on this (review log, base cause R2, `odd/tasks/root-cause-2026-10-28-review-log.md:201`; the run-level author is the login, architecture-map and regeneration author of `author-dispatch.ts:1-6`) |
| C3 | Effort sentence | `generation/infrastructure/prompt-builders/task-builders.ts:203-223` (`EFFORT_BY_TIER`), `:256`, `:291` | Which of three sentences the diff first pass prompt ends its scope budget with. `upperBound` is read by tests only (`prompts.scope-guard.test.ts:243-244`); the prompt carries the words "one or two spec files", "a few spec files for the affected flows", "one spec file per affected flow, not a suite rewrite". All three admit the no-op (`admitsNoOp: true`) |
| C4 | Run history partition | `src/server/persistence/repositories/run.repository.ts:298-306` (`recentPhaseRecords` reads `time_budget = ?`), `migrations/0006-run-time-budget.ts:5-9`, `opening.steps.ts:178-184` | Which finished runs RFC-0012's measured reserves are taken from: only those of the same row |
| C5 | Benchmark label | `scripts/efficiency-benchmark.ts:25`, `:52-53`, `:61-65`, `:113-114`; `docs/efficiency-benchmark.md:67-76`, `:549-550` | Only a grouping: the operator declares a case's tier; the script "never checks it against the real diff" (`:52`) |
| indirect | The plan's flow capacity | `coordination/application/flow-capacity.ts:26-37`, `lead-sidekicks.ts:1318-1326` | Nothing directly. `flowCapacity` reads `allowanceMs`, `flowBudgetMs` and the app's `maxFlows`; the tier reaches it only through the deadline row of C1 |

Operator-facing names that carry the tier: `QA_RUN_TIME_BUDGET_MS_DIFF_TINY|FOCUSED|BROAD` (`src/settings/registry.ts:103-105`, `docker-compose.override.yml:47-49`, `docs/settings.md:97-99`), `QA_DIFF_TIME_BUDGET_MS_TINY|FOCUSED|BROAD` (`registry.ts:108-110`, `settings.ts:233` and `:252-254`, `run-engine-factory.ts:805-806`, `docker-compose.override.yml:41-43`, `docs/settings.md:102-104`). Docs that state the tier: `AGENTS.md:179` (the engine/AI boundary row "Signal (not yet named)"), `:525-545` (Effort tier), `:546-` (Run deadline), `docs/observability-context.md:155-156`, `docs/observability-design.md:237`, `:348`, `docs/testing-standards.md:805`, `:834`. `.env.example` was not read.

## Evidence

What the records show, and what they do not:

- The limit is declared in code: `diff-stat.ts:40`. A change at 40 lines is `tiny` and at 41 is `focused` (`:46-53`), a discontinuity of the class P3 names.
- Three pre-window history runs (mv41sbze, mv55m2ok, mv57rbz5) ended `E-TIME-BUDGET` with 5, 5 and 19 of 50 steps in 360 s, "under a cap derived from the diff's size tier" (`docs/architecture/rejected-explanations.md:103`, "from the pre-window history records, not re-checked"). 360 s is the `tiny` first-pass cap (`diff-stat.ts:57`). Hypothesis: the cap cut productive work; the records do not show the work was productive.
- The T17 run `run-ed28973-mvuspjsx-a31b6838` and its baseline `run-ed28973-mvs7oo0f-17041c71` were both bounded as `diff-broad` (60 min); wall 60.0 and 56.0 min, the coverage phase 26.8 and 20.4 min, the review 12.9 and 6.9 (feature document L20). That shows the row binding; it does not show the tier misjudged the change: the change's file and line counts are not in the records.
- No record holds a `tiny` or `focused` run of the cycle. The effect of this RFC on small changes has no baseline (Measurement).

## Proposal

1. **C1: one `diff` row; no signal.** `RUN_TIME_BUDGET_KEYS` swaps the three diff rows for `diff` at 60 min (today's `diff-broad`, `run-time-budget.ts:17`). The row is a bound on a run that stopped converging (`:13`), so it has nothing to estimate. What adapts to the run is RFC-0012's allotment by purpose, with reserves measured from the app's own phases (`run-deadline.ts` `measure`, `reserveAfter`). `RunTimeBudgetScope` loses `diff` and `changedFiles` (`:39-45`); `armRunDeadline` keeps its place (`run-steps.ts:36`, before the change scope at `:47`) and no longer needs the diff. A signal that is absent cannot matter because none is read.
2. **C2: delete the first-pass tier cap.** `DIFF_TIME_BUDGET_MS`, `generator-time-budget.ts` (the whole file), `DIFF_TIME_BUDGET_ENV`, `resolveDiffTimeBudgets`, the ports `timeBudgets` and `promptCapMs` (`generate-tests.use-case.ts:40-42`, read only by `generatorTimeBudgetMs`) and the wiring (`run-engine-factory.ts:804-806`, `settings.ts:233`) go. The pass keeps the code path `broad` already takes ("a tier that bounds nothing stays so, and the deadline's own runtime ends such a turn", `generate-tests.use-case.ts:218`): its time is the `generate` allotment, the stall watchdog and the step cap end it, each with its typed end. `tier-budget` stays in the closed limit vocabulary (`shared-kernel/turn-limit.ts:5`, `allotment-cap.ts:9`) because stored spans and runs carry it, marked as no longer produced.
3. **C3: one effort rule.** The sentence is the one `broad` has today: "at most one spec file per affected flow, not a suite rewrite", with the per-behaviour clause and the no-op clause unchanged (`task-builders.ts:210-218`). The affected flows are the use cases the change makes testable (`PlanningLimits.candidates`, `shared-kernel/coordination.ts:27-28`; the plan must cite each direct one or drop it with a typed basis, AGENTS.md "Lead and sidekicks"), so the bound scales with the change by a fact the engine computes. The size sentence (`sizeSentence`, `:227-229`, "touches N files with +A/-R lines") stays: it is a fact stated to the agent, not a branch. `EFFORT_BY_TIER`, `EffortTier.upperBound` and the three-way text go.
4. **C4: history continues.** `recentPhaseRecords` for budget `diff` reads the rows stored as `diff-tiny`, `diff-focused` and `diff-broad` as well (`run.repository.ts:305`), so the measured reserves of an app do not restart on fallback. No stored value is rewritten (the migration rule of `0006-run-time-budget.ts:7-9`), so there is no data migration.
5. **C5: the benchmark keeps its operator label.** The three words stay valid in a case file; the type moves from the engine's kernel into `scripts/efficiency-benchmark.ts`, because the engine no longer has a tier. Nothing in the report changes.
6. **Indirect: flow capacity is unchanged.** It is a ceiling (`flow-capacity.ts:26-37`), not a quota; the plan is held to the candidates, not to the capacity. With one row every diff run has the same ceiling.
7. **Operator settings (a contract others consume).**
   - `QA_RUN_TIME_BUDGET_MS_DIFF` is added (a positive whole number of milliseconds, default 3 600 000, no `none`, as `run-time-budget.ts:59-68`).
   - `QA_RUN_TIME_BUDGET_MS_DIFF_TINY|FOCUSED|BROAD` keep working for one release: one warning per set name that names `QA_RUN_TIME_BUDGET_MS_DIFF`; the effective value is the new variable when set, else the largest of the old values that are set (an operator who lengthened a bound keeps it), else the default.
   - `QA_DIFF_TIME_BUDGET_MS_TINY|FOCUSED|BROAD` join `src/settings/retired.ts:5-25` (warn once, not read), as `QA_RUN_TIME_BUDGET_MS_COMPLETE` did: the cap they set is deleted. An operator who set `none` or a larger value loses nothing; one who set a shorter cap loses that cap, and the warning says so.
   - Registry entries, `docs/settings.md` (`npm run settings:gen`) and the compose pass-through lines change with their units. `.env` files and the compose override are operator data, edited by the owner (ADR-0013 point 3).

## What does not change

- `diffStat` and the size sentence: facts, not thresholds.
- The run deadline as the one clock, the allotment by purpose and the deterministic phases cut at the deadline (RFC-0012).
- The reasoned no-op, valid in every case (AGENTS.md, "Honor the explicit no-op").
- Flow, plan and tool-call caps (`flowBudgetMs`, `planBudgetMs`, `perCallMs`).

## Alternatives considered

- **Keep three tiers, computed from signals** (code-class lines only, the direct candidate count, `fileClass` to exclude generated files, `file-classes.ts:44-50`). It fixes the declared limit and keeps the discontinuity: a run still branches on a count against a constant, which is the shape P3 rules out. Rejected.
- **Derive the run bound from the app's recent run durations**, with 60 min as the fallback (RFC-0012's pattern for reserves). A bound taken from the durations it guards moves with the slowness it exists to catch, and identical inputs would get different bounds (P1). Not recommended; revisit only if the measurement shows runs that never converge and still fit the single bound.
- **Keep C2 as one constant cap.** A constant with no signal behind it, only for the run-level author. Not recommended; the stall watchdog and the step cap already end a turn that is stuck.

## Work units

Each unit is its own commit, RED test first through the public seam, tests and docs with the code. U2 and U3 change settings others consume (Risk: item 3); each ships alone.

| Unit | Change | RED test (one per rule) | Deleted |
|---|---|---|---|
| U1 (C3) | One effort sentence | `renderMain` of a diff run for a 1-file/3-line change and for a 12-file/900-line change ends its scope budget with the same effort sentence, and it names no tier (today the two differ) | `EFFORT_BY_TIER`, `EffortTier.upperBound`, `effortText`'s tier argument; the tier tests of `prompts.scope-guard.test.ts:243-283` and `prompts.no-op-reasons.test.ts:35` move to the one rule |
| U2 (C2) | The first-pass cap goes | `GenerateTestsUseCase.author` on a tiny diff with a fake runtime: the first prompt's `timeoutMs`/`timeLimit` are the `generate` allotment's and its end is never `tier-budget` (today 6 min, `tier-budget`); settings load: `QA_DIFF_TIME_BUDGET_MS_TINY=1` yields the retired warning and no failure | `DIFF_TIME_BUDGET_MS`, `generator-time-budget.ts` and its test, `promptCapMs`/`timeBudgets` ports, `diffTimeBudgets` setting, three registry entries, compose lines 41-43; "Time budget per tier" of `docs/efficiency-benchmark.md:132-148` |
| U3 (C1, C4, C5) | One `diff` row; history continues; benchmark label | `runTimeBudgetKey` of a 1-line and of a 2000-line diff is `diff` (today `diff-tiny`, `diff-broad`); `resolveRunTimeBudgets` honours `QA_RUN_TIME_BUDGET_MS_DIFF`, and a settings load with only `..._DIFF_TINY=600000` and `..._DIFF_BROAD=1200000` yields 1 200 000 and two warnings; `getHistory().runs.recentPhaseRecords(app, "diff", n)` returns runs stored as `diff-tiny`, `diff-focused`, `diff-broad`; a differential check that `manual` and `context` keep their rows and env names | `DIFF_TIERS`, `DIFF_TIER_NAMES`, `DiffTier`, `diffTier`, `DIFF_KEY_FOR_TIER`, the scope's `diff`/`changedFiles`, three registry entries and compose lines 47-49 (the old names stay readable for one release, as Proposal 7) |
| U4 | Records | `npm run previous-forms:check` fails on a reference to `DIFF_TIERS`/`diffTier` outside `docs/architecture/` (banned term added) | The text of AGENTS.md `:179`, `:525-545`, `:546-`, `docs/observability-context.md:155-156`, `docs/observability-design.md:237` and `:348`, `docs/testing-standards.md:805` and `:834` is rewritten; ADR-0001's open question 3 points here; an epoch row for the runs after U3 in the run index of `rejected-explanations.md` |

Order: U1 (no contract), U2, U3, U4. U2 before U3 so the two settings families retire in separate commits. The full gate of AGENTS.md "Commands" closes each unit.

## Measurement

One replicate per measurement (S3): a direction, not proof. Baseline: `run-ed28973-mvuspjsx-a31b6838` and `run-ed28973-mvs7oo0f-17041c71`, both `diff-broad`, so U1-U3 should leave a broad-class run unchanged except the label. The informative replicate is a small change (file and line counts under the old `tiny` limits), for which the records hold no baseline; take one from the same commit on the unchanged head first. Read from the run record and the trace:

- `timeBudget` is `diff`; wall time and `phaseTimings` per phase; whether the run ended `E-TIME-BUDGET`, and `limits[].fired` (no `tier-budget` after U2).
- `gateSignals.coordination`: flows planned against the direct candidates (`plan`, `flows`, `dropped`), and specs generated per flow after U1.
- `qayaba.allotment.reserve_source` (`measured` after U3 means C4 held; `fallback` means the former labels were not read).
- `deadline-after-proof` degradations and whether a `review_verdict` was recorded (the T17 finding).
- Cost and `flow_delivery_rate` against the baseline (feature document L20).

A regression to look for: a small change that now plans more flows than it has direct candidates, or runs longer with the same verdict (hypothesis; no record bounds it).

## Questions (recommended answers taken, ADR-0019)

1. What bounds a diff run once the tier is gone? **Recommended: one `diff` row at 60 minutes** (Proposal 1). Alternative: a bound derived from the app's recent runs (circular, P1); keep the tiers computed from signals (still a threshold).
2. The first-pass cap of the run-level author? **Recommended: delete it**; the turn runs under its allotment, the stall watchdog and the step cap (Proposal 2). Alternative: one constant cap.
3. The effort rule? **Recommended: one sentence, "one spec file per affected flow, not a suite rewrite"**, the affected flows being the candidates the plan covers (Proposal 3). Alternative: state the direct candidate count in the sentence (adds a fact to every prompt; consider if the measurement shows over-planning).
4. Operator settings? **Recommended: the three run-budget names keep working for one release with a warning and the largest set value; the three first-pass names retire with a warning** (Proposal 7). Alternative: retire all six at once.
5. History continuity? **Recommended: read the former labels for `diff`; rewrite nothing** (Proposal 4). Alternative: a migration that relabels stored rows (item 1 of the high-risk list; not needed).
6. The `tier-budget` value in the closed limit vocabulary? **Recommended: keep it, marked no longer produced**, and remove it with the epoch that prunes the old data. Alternative: remove it now (old stored values would no longer parse).
7. The benchmark's declared tier? **Recommended: keep the operator's label; the type moves into the script** (Proposal 5). Alternative: drop the label and group by measured size.
8. Does flow capacity get a signal of its own? **Recommended: no; it stays a ceiling** (Proposal 6), revisited only if the measurement shows planned flows beyond the candidates and their drops.

## Review questions (ADR-0001 procedure)

- **P1:** the same diff gets the same bound, prompt and capacity as before; the 40/41-line discontinuity of `fits` (`diff-stat.ts:46-48`) is gone, since no branch compares a size.
- **P2:** the engine decides the bound; the agent receives a fact (the size sentence) and a rule about flows. The written rule: the AGENTS.md boundary row at `:179` is replaced in U4.
- **P3:** removes the three comparisons of `fits`/`diffTier` and the two tier tables; the consumers read no signal (C1, C2) or a fact the engine already computes (C3: the candidates). No constant is added except the single row, a safety bound, not an estimate of effort.
- **P4:** nothing app-specific; the candidates come from the language registry and the code graph.
- **P5:** the mechanism is shown by the code (`diff-stat.ts:40`, `:46-53`) and by what each consumer is for, not by one app's run; the history runs of the evidence are pre-window and not re-checked, and no record shows a misjudged run. The case does not rest on them.
- **P6:** nothing makes a test greener. "The effort is a ceiling on the work and never a floor" stays (`task-builders.ts:203`); the review is required as before. A risk: a small change runs up to 60 min instead of 25 when it stops converging (hypothesis, Measurement).
- **P7:** removes `DIFF_TIERS`, `DiffTier`, `diffTier`, `EFFORT_BY_TIER`, `generator-time-budget.ts`, six settings (replaced by one) and one history label set; adds one read of three former labels. A smaller change considered: keep the tiers and only exclude generated files from the count; it leaves the threshold (Alternatives).

## Implementation note

Landed in the order of the work units, each with its RED test through the public seam and its docs:

- **U1** `f2462a63`: `EFFORT_TEXT` replaces `EFFORT_BY_TIER`. The sentence lives in the `task` section of the generator prompt, which the lead's plan turn and the run-level author's first pass both assemble, so it reaches both. A flow author's brief (`brief-sections.ts`) never carried a tier text: its one spec file is the deterministic `e2e/flows/<slug>.spec.ts` of the plan (`writablePaths`), so the rule is structural there and nothing was added. The prompt-contract baseline and digests were re-recorded with a stated raise (a small change's sentence is longer).
- **U2** `c4db4bec`: `DIFF_TIME_BUDGET_MS`, `generator-time-budget.ts`, the `promptCapMs`, `timeBudgets` and `now` ports, the `diffTimeBudgets` setting and `repairTurnLimit` are gone, and so is the unused `deadline` hand-off from the engine root to the generation adapter. The first pass states no time of its own: `RunDeadlineRuntime` holds it to the generate allotment and types the end (`allotment` or `run-deadline`); a timeout of the host surfaces as the integration error a broad change already met. `GenerationEndFacts.timedOut` is optional and no longer reported. `QA_DIFF_TIME_BUDGET_MS_TINY|FOCUSED|BROAD` retired with a warning.
- **U3** `0a265e0b`: one `diff` row at 60 minutes, `QA_RUN_TIME_BUDGET_MS_DIFF`, the three former names read for one release (a warning each, the largest set value), `recentPhaseRecords` for `diff` reads `diff-tiny`, `diff-focused` and `diff-broad` rows too, `RunTimeBudgetScope` is the mode alone, and the benchmark's size label moved into `scripts/efficiency-benchmark.ts`. `tier-budget` stays in the limit vocabulary, marked no longer produced. The compose pass-through lines of the three former names stay (marked deprecated) so they keep reaching the container for the release; they go with the names.
- `3e22f47c`: `diffStat` moved from the kernel into the generation context, its only reader, because the kernel owner rule (two parties or a port) no longer held for it.
- **U4** this commit: the records, the `diff-tier` banned term of `npm run previous-forms:check` (RED test first: a deleted name fails outside `docs/architecture/`), and the removal of the unemitted `qayaba.tier` and `qayaba.tier.budget_ms` attributes from the attribute registry. The gate was already red on `f2f7203b` for three uses of a banned word for the earlier labels in this record; they now read "former".

One change of reading follows from U3 and was not in the proposal: a diff run stored with no recorded kind (written before schema 6) is now of the `diff` kind, as a manual one is of `manual`, where before it was in no per-size row.

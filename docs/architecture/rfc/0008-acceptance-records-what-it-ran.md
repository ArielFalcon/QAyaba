# RFC-0008: A regeneration's acceptance records what it ran (N06)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/contexts/run-orchestration/application/regeneration-acceptance.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/fix-loop.steps.ts`, `qa-engine/src/contexts/run-orchestration/domain/fix-loop.aggregate.ts`, `qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts`, `qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts`, `qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts`, `qa-engine/src/contexts/agent-tools/domain/closed-loop.ts`, `qa-engine/src/shared-kernel/derive-cycle-backstop.ts`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/spec-snapshot-validation.adapter.ts`, `qa-engine/test/contexts/run-orchestration/application/regeneration-acceptance.test.ts`, `qa-engine/test/contexts/run-orchestration/application/run-qa.closed-loop.test.ts`, `qa-engine/test/contexts/run-orchestration/domain/fix-loop.aggregate.test.ts`, `agents/tool/run_spec.ts`, `scripts/mutate.ts`, `src/types.ts`, `docs/engine-platform-architecture.md`, `AGENTS.md`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0003](./0003-coverage-dump-harvest.md) (the executions this fix adds carry coverage; see "Cost"), [RFC-0005](./0005-suite-store-single-writer.md), [RFC-0006](./0006-review-answer-crosses-whole.md) (N02, same review phase, a different mechanism; file name only, not read), [Rejected explanations](../rejected-explanations.md). Not the same slice as RFC-0003, RFC-0004 or RFC-0005: the mechanism, the files and the signal differ.

## Summary

1. Cause N06, confirmed by two independent refutations: the acceptance of a regeneration does not execute a changed file whose bytes hold a `run_spec` pass (`regeneration-acceptance.ts:138-143`), and the accepting call sites then rewrite `run.cases` as if every kept file had execution products.
2. Effect on the record: a kept file keeps the cases of its previous bytes, or loses all of them. In #29 two delivered files (9 tests) had no case and the reviewer was never shown them. No verdict change is shown.
3. Main removed one site (the gap regeneration, `4d027a61`) by never reusing a proof there. The shared skip, the review site and the fix-loop site are alive at 4105c582.
4. Proposal (O1): an acceptance always executes the changed files it accepts. The proof-reuse input is removed from the shared service, so no site can bring it back and each accepted outcome carries cases for every kept file.
5. Cost: one more acceptance execution when every changed file was proof-held (87 s and 97 s measured for one-file review acceptances). `run.cases` keeps its several writers; making them one is an owner decision, not recommended here.

## Problem

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | A `run_spec` call records one ledger entry: the path, the sha256 of the bytes, a status, the namespace, time, writes. It holds no case, no test count and no `grep`. | `run-spec-capability.ts:70-79`, `run-spec.use-case.ts:263` |
| 2 | The status is `passed` when the runner's verdict is `pass` with at least one case. A call limited by the tool's `grep` argument to one test of the file therefore records `passed` for the whole file's bytes. | `run-spec.use-case.ts:337-342`, `agents/tool/run_spec.ts:15`, `closed-loop-port.adapter.ts:280` |
| 3 | A file is "closed" when its last ledger entry has its current sha256 and passed. The run's handle asks the run's ledger and every flow's ledger. | `run-spec-capability.ts:250-259`, `closed-loop-port.adapter.ts:152-156`, `:246` |
| 4 | The acceptance asks that predicate for each changed file. A closed file is not executed. When every file is closed nothing executes and the outcome has no `execution`. | `regeneration-acceptance.ts:138-143`, `:155-177`, `:190-197` |
| 5 | Two of the three accepting call sites hand the proof source over. The gap site did, until `4d027a61`. | review: `review.steps.ts:446-457` (`closedLoop` at `:453`); fix loop: `fix-loop.steps.ts:149-159` (`:155`); gap: `coverage.steps.ts:240-249`, no `closedLoop` |
| 6 | Each site then writes the cases with its own rule. Review: replace the kept files' cases only `if` the execution produced any, and do the same on a second copy, `session.reviewCases`; the comment at `:560` says "the existing cases already describe the bytes on disk". Fix loop: remove the cases of every changed file, add the execution's, so a proof-held file loses its cases and a failing case of it vanishes. Gap (now): replace the kept files' cases by the execution's. | `review.steps.ts:553-560`, `fix-loop.aggregate.ts:214-238`, `:759`, `coverage.steps.ts:270-272` |
| 7 | The review phase takes its scope from those cases: the files the reviewer is shown, the existing-suite context, the in-scope set of the finding filter, the DOM pre-check bypass, the execution evidence. A delivered file with no case is not reviewed. | `review.steps.ts:91`, `:97`, `:143`, `:160`, `:202`, `:242`, `:293`, `:337` |

The chain was re-read at 4105c582. `regeneration-acceptance.ts` is byte-identical between bd1d2e46 (the head of the #27-#29 epoch) and 4105c582, and the review site's case rule is unchanged between them.

The acceptance also has a mixed outcome. When some changed files are closed and others are not, only the others execute, so `execution.cases` covers a strict subset of `kept` (`regeneration-acceptance.ts:139-143`, `:155-176`). That is the "dropped" branch. When all are closed it is the "stale" branch.

### What the runs show

Epoch heads are the checkout a run loaded. `#N` is the investigation's run number. Every run below ran under the raised time limits that live outside git (the chain reads none of them; they change how often an author holds a pass, not what the acceptance does with one).

| Run | Code head | Site | What the record and the spans show |
|---|---|---|---|
| #25 `run-ed28973-mvr9sbey-cb4eceda` | 58151b36 | review | One review acceptance, kept 1; `gateSignals.integrity` `acceptances 1, proofReused 1`. The author's `run_spec` passed `flows/upload-native-only-web.spec.ts` at 4 tests; no suite execution follows the acceptance's validation. The record keeps 3 cases of the previous bytes. Harmless here (both versions pass). The run's commit range is invalid for comparison; the chain reads no range. |
| #27 `run-ed28973-mvruzwli-8bb3adcd` | bd1d2e46 | gap | `regeneration_acceptance` origin `coverage`, kept 3, restored 0; `integrity` `acceptances 2, proofReused 1`. The next suite executions sit inside `qayaba.coverage.survivor_recheck`, and the run has no `qayaba.coverage.recount` span. Two files hold the titles of their previous bytes. The same run's review acceptance (kept 1) did execute (97 s) and its cases are right: the run is its own control. |
| #29 `run-ed28973-mvrxb30p-ecfe944b` | bd1d2e46 | gap, mixed | `regeneration_acceptance` origin `coverage`, kept 3, restored 1. The record holds 11 cases in 2 files (cuisine 6, discovery 5). `flows/upload-native-only-web.spec.ts` (6 tests, `run_spec` pass) and `flows/user-account.spec.ts` (3 tests, `run_spec` pass) have none, and `run_spec_snapshots` lists four delivered files. The event `review.targets` names only the two files that have cases, where #27's names all three delivered ones. |

Controls (the bug absent where the cause is absent):

- Four runs on code with `4d027a61` (`run-ed28973-mvs0onsn-6ad17f30`, `run-ed28973-mvs2ukug-c82da7be`, `run-ed28973-mvs49h5y-acdab309` on 40513c1e; `run-ed28973-mvs7oo0f-17041c71` on 4105c582): every delivered file has cases, and each gap acceptance is followed by an execution. In the baseline, validation ends at +2691 s and `qayaba.spec.execute` starts at +2695 s (126 s). The baseline's review acceptance also executed (+3233 s validation, +3237 s execution, 87 s) because the author's last `run_spec` had failed, so none of the four exercises proof reuse at the review site.
- Supporting, not counted (full proof reuse, O4 to O6, raised env limits too): #10, #12, #15, #17, #21 show the validate-then-no-execution pattern; the record keeps fewer titles than the delivered file in #12, #15, #17 and #21. #19 shows the dropped branch with a second amplifier: its last `run_spec` for the file ran 1 test of 5 through `grep`, and the ledger counted it as a pass (chain steps 1-2).
- Fifteen runs in the history database record `integrity` counters: 13 had one acceptance, 2 had two (#27 and the baseline), none hit the cap, and 7 show `proofReused` of at least 1 (#10, #12, #15, #17, #21, #25, #27). The counter does not say which site reused the proof.

### Reached by a different route: the quality strand's finding

The test-quality strand found the same blind spot from the delivered tests (its finding Q08: delivered bytes outside the gate's recorded cases). Its two refutations kept the mechanism and cut the claim. What this record takes from it, and what it leaves:

| Q08 said | Verdict after refutation | Used here |
|---|---|---|
| About 30 delivered tests are outside the record, in 10 runs | 26 tests in 8 runs. #23 and #24 are bytes the acceptance rolled back, not delivered bytes: `run_spec_snapshots` is written at validation and never retracted (`spec-snapshot-validation.adapter.ts:2-4`, `:76`). | Only the 8 runs |
| No review on those bytes | False for #12, #15, #17, #27 (the reviewer's text holds them); true for #19 and #29 | The review scope dependency (chain step 7) |
| A flaky variant (#18, #22, c1) | A different mechanism; c1 ran coverage and review | Left out |
| Prediction at 70% | Fails as written (53% in sample; 0 of 3 after the gap fix) | Not used |
| "No measured quality loss" | Nothing measured it | Not claimed either way |

### What N06 does not explain

- Whether a stale or dropped case changed any verdict or published a bad test. Not shown. #29's `pass` came from the primary execution. The observed effects are a record that misdescribes the delivered suite, a recount that did not run (gap site, removed), and two delivered files the reviewer never saw (#29).
- The fix-loop site. No run reached it (hypothesis about reachability): it needs a changed file that holds a pass on its current bytes in a fix-loop round. The refutation's probe on the real `FixLoop`, with an acceptance port shaped like `fix-loop.steps.ts:149-159`, shows a failing case vanish and the loop report `pass` with zero executions. A probe is not a run, and I did not re-run it.
- The frequency. Whether an author holds a pass on its final bytes depends on time limits, flow count and the author's last call. The counted runs sit under raised limits; under defaults the precondition is probably rarer (hypothesis, not tested).
- Why the grep-limited pass counts as a pass of the file (#19). A neighbour with its own fix; see Out of scope.

### Why it matters

- **The record and the reviewer's scope follow an execution that did not happen.** The engine measures; whether it measures depends on whether the agent's last act was `run_spec`. That moves the engine/AI line the wrong way (ADR-0001 pillar: a rule-drawn boundary).
- **It is one decision made three times.** The acceptance returns products for a subset of `kept`, and three sites each assume the subset is everything, with three different rules. Main fixed the gap site by deciding that its consumer needs the cases, the dumps and the closure baseline, so a proof is not enough (`AGENTS.md:888-892`). The review site needs the cases for the reviewer's scope, evidence and pre-check, and the fix loop needs them for its verdict. No site of the three is a verdict-only consumer.

## Goals and non-goals

**Goals**

1. For every accepted regeneration, the record's cases for each kept file come from an execution of the bytes now on disk.
2. The reviewer's scope holds every delivered file.
3. No call site can accept on a proof alone: the class is removed, not one more site.

**Non-goals**

- Which regenerations are accepted, the per-file restore, the proof ledger itself, or the cap.
- The recount of coverage at the review site (it stays marked stale under `signal`).
- The other readers of the closure predicate (see Out of scope).

## Options

Two questions decide the options: who owns `run.cases`, and may an acceptance skip executing what it accepts.

Today `run.cases` has four writers with local rules: the gap site (`coverage.steps.ts:271`), the review site (`review.steps.ts:557`, plus the copy at `:558`), the fix loop's accepted round (`fix-loop.aggregate.ts:759`) and the fix loop's retry merge (`fix-loop.aggregate.ts:831-844`), beside the primary execution. The acceptance owns the products of an accepted regeneration, but it does not say which files they cover.

| Option | Who owns `run.cases` | May an acceptance skip executing what it accepts | DEV executions and time |
|---|---|---|---|
| O0 Keep main | Four writers, three rules | Yes, on a `run_spec` pass | None added. The record is wrong at the review and fix-loop sites. |
| O1 Always execute | The acceptance is the one producer of the cases of accepted bytes and covers every kept file; the writers only place them | Never | One more acceptance execution when every changed file was proof-held; none extra when the set is mixed (the proof-held files join the execution that runs) |
| O1b O1, and one function for the writers | One pure function places an accepted outcome's cases (gap, review, fix-loop round), and the review copy goes away | Never | As O1 |
| O2 Keep the skip; the ledger carries the cases | Two producers of the same fact: the ledger and the acceptance | Yes | None added |
| O3 Keep the skip; the record says "unknown" | The writers, each with an "unknown" branch | Yes | None added |

### O0. Keep main

- **Removes:** the gap site only.
- **Adds:** nothing.
- **Risk:** the review site is reachable on any run whose review correction ends with a `run_spec` pass of its final bytes (#25), and the dropped branch needs two files changed in one review acceptance. The fix-loop site stays a latent fail-to-pass.

### O1. An acceptance always executes the changed files it accepts

- **Removes:** the skip (`regeneration-acceptance.ts:138-143`), the `closedLoop` input (`:76-77`) and its two remaining hand-overs (`review.steps.ts:453`, `fix-loop.steps.ts:155`). With nothing skipped, `execution.cases` covers every kept file by construction at all three sites, and the per-file restore's "closed files stand" branch (`:218-219`) has nothing left to stand for.
- **Adds:** nothing new. It is the rule main already applies at the gap site, made the rule of the shared step. The input leaving the type makes the class a compile error: a site cannot pass a proof source.
- **Risk:** time and the cap. See "Cost".

### O1b. O1, and one function that places an accepted outcome's cases

- **Removes:** the three local rules and the review copy `session.reviewCases` (`review.steps.ts:97`, `:558`), which would be derived from `run.cases` at each round.
- **Adds:** one pure function in the run-orchestration domain, used by three sites.
- **Risk:** the fix loop's merge also owns the verdict (`fix-loop.aggregate.ts:231-236`), so the function covers the cases only and the verdict stays where it is. No failure in the record traces to the writers once the products are total, so the need is not evidenced (ADR-0001 P7). It is offered because the owner asked who owns `run.cases`.

### O2. The ledger carries the cases

- **Removes:** the need to execute, for a file whose last call covered the whole file.
- **Adds:** a second producer of cases (the `run_spec` result, on another namespace, with another write count). The entry must refuse a call limited by `grep` and a file that changed after the call. The case objects join the ledger entry.
- **Risk:** it still cannot give dumps (`run_spec` runs with coverage off), so the recount stays impossible for those files, which is what main rejected at the gap site. It keeps the agent's call order in the engine's measurement.

### O3. The record says "unknown", and the scope comes from delivered files

- **Removes:** the silent stale case; the review scope no longer follows the cases.
- **Adds:** an "unknown" state for a delivered file's cases that the reviewer's evidence, the pre-check and the closure baseline must each handle.
- **Risk:** the record still cannot say what ran, and `unknown` never blocks (AGENTS.md), so the blind spot moves rather than closes.

### Cost of O1, measured

- **When it fires:** only when every changed file of an accepted regeneration holds a pass on its current bytes (the "stale" branch), or for the proof-held files of a mixed set. A regeneration whose last `run_spec` failed already executes.
- **One-file review acceptances:** 87 s (`run-ed28973-mvs7oo0f-17041c71`, baseline, +3237 s) and 97 s (`run-ed28973-mvruzwli-8bb3adcd`, +2394 s). The baseline took 3,361 s, so one such execution is about 2.6% of a run.
- **Mixed sets:** no extra execution, only those files' tests added to the execution that runs. Not measured.
- **The cap:** each acceptance execution counts toward `MAX_ACCEPTANCE_EXECUTIONS = 4` per run (`derive-cycle-backstop.ts:4`), shared by gap, review and fix-loop acceptances. A reused proof spent none. The highest count recorded is 2 acceptances in a run (2 of 15 runs); the cap was never hit. On an app with more correction rounds the cap could bind (hypothesis).
- **Coverage on every execution:** an execution through the acceptance carries coverage (`PW_COVERAGE` is `"0"` only for the `run_spec` counting path, `e2e-execution.runner.ts:943`; see [RFC-0003](./0003-coverage-dump-harvest.md)). Each added execution is followed by a dump harvest on the event loop. Until RFC-0003's work unit 1 lands, that is one more potential stall (hypothesis).
- **DEV writes:** an acceptance execution runs the file's tests against DEV once more. Whether those writes count against a run-level write cap was not checked.

## Recommendation

**O1.** One cause, one site of decision: the shared acceptance.

1. In `regeneration-acceptance.ts`, drop step 3 (proof reuse) and the `closedLoop` input. Every changed file goes to `toExecute`. `executedSpecs` equals the changed files (minus the restored ones); `execution.cases` covers every kept file.
2. In the review and fix-loop sites, stop passing `closedLoop` to the acceptance and drop the local variable where nothing else reads it (`review.steps.ts:413`). The review site keeps its guard-free replace; the fix loop's merge is unchanged.
3. Keep the proof ledger itself, and `ClosedLoopHandle.isClosed`: other readers use it (see Out of scope).

**Why it is the smallest change that removes the cause at every site of its class.** The class is "an accepted outcome that carries products for a subset of the files it accepted". The subset exists in one place, the skip. Removing the skip makes every present and future site total with no site edit beyond deleting an argument. O2 and O3 leave the subset in place and add a branch at each consumer. O1b adds a function the evidence does not call for.

**Who owns `run.cases` after O1.** The acceptance owns the products of accepted bytes: it covers every kept file or it does not accept. The four writers remain, each placing complete products. This record does not make them one (Owner decision 3). The alternatives lens judged the owner thesis "mixed": one owner returning an explicit "unknown" would have prevented the silent stale, but cannot invent the missing cases; something has to decide that the consumer needs an execution. O1 is that decision, taken once.

**May an acceptance ever skip executing what it accepts.** No. No consumer is verdict-only: the gap site needs cases, dumps and the closure baseline; the review site needs cases for scope, evidence and pre-check; the fix loop needs cases for its verdict. The skip saves 87 to 97 s and has no consumer.

**Why app-agnostic.** The path reads no route, framework or app fact. It fires on any e2e app with the closed loop on (the default) whenever an accepted regeneration changes a file that holds a `run_spec` pass. A `code` run has no closed loop and no occurrence. Every analyzed run tested one app, name-webapp, and nothing here is shaped by it. How often the precondition holds is app-shaped (time limits, flow count); the rule is not. On another app the signature is: after a review correction accepted without an acceptance execution, the record's case titles for the corrected file are those of the previous bytes; or `specCounts.generated` is larger than the number of distinct case files in the record and the reviewer prompt's "Specs to review (N file(s))" is smaller than the delivered count. A Java or Spring backend tested through the same Playwright path behaves the same way.

**Where it lives.** The run-orchestration context, application layer (decision-table row 3 of `docs/engine-platform-architecture.md`: it decides which bytes stand). Nothing in `src/`; nothing to move. The change is one commit that follows ADR-0011 rule 2 (RED test first, superseded code removed in the same change).

## Patches it supersedes

| What | Where | Effect |
|---|---|---|
| The proof-reuse step | `regeneration-acceptance.ts:138-143` | Removed. |
| The `closedLoop` input and its doc comment | `regeneration-acceptance.ts:76-77` | Removed from the type. |
| The "closed files stand" branch of the per-file split | `regeneration-acceptance.ts:210-225` (`!executed.includes(file)` at `:219`; comment at `:211-212`) | Nothing is un-executed any more; simplified. |
| Header and outcome comments that say "or reuse a proof" and "absent when every change reused a proof" | `regeneration-acceptance.ts:4`, `:37`, `:39` | Rewritten to the final state. |
| Hand-overs of the proof source | `review.steps.ts:413` (the destructure, if unused), `:453`; `fix-loop.steps.ts:155` | Removed. |
| The comment that proof reuse leaves the cases right | `review.steps.ts:560`; the comment at `review.steps.ts:541` ("or reuse a proof") | Removed or rewritten. |
| The mutation preset description | `scripts/mutate.ts:636` ("or reuse a proof") | Rewritten. |
| The rule text for the per-file acceptance | `AGENTS.md:894-897` ("or, outside a gap regeneration, whose bytes already hold a `run_spec` proof") and `AGENTS.md:888-892` (the gap-only wording) | Rewritten: no acceptance reuses a proof. |
| Tests that pin the skip | `regeneration-acceptance.test.ts:181`, `:313` | Rewritten to pin the new rule (see Test plan). |

Not superseded: the ledger and `isClosed` (`run-spec-capability.ts:250-259`, `closed-loop-port.adapter.ts:152-156`) and `integrity.proofReused` (Owner decision 4). The gap site tests (`run-qa.closed-loop.test.ts:432`, `:449`, `:464`) stay as guards. `AGENTS.md:20-21` asks to confirm a patch is not a deliberate guard: the skip was added to save an execution (the comment at `regeneration-acceptance.ts:138`); main already judged it wrong at the gap site (`4d027a61`'s message states the defect).

## Test plan

The seam is the use case with fake ports, the one `run-qa.closed-loop.test.ts:432` already uses for the gap site ("a gap regeneration whose bytes hold a run_spec proof is still executed by its acceptance"). One test per rule, no real time.

| # | Rule | Seam | Fails today because |
|---|---|---|---|
| T1 (RED) | A review correction whose changed file holds a `run_spec` pass on its final bytes is executed by its acceptance, and the record holds that execution's cases. | The use case with a closed loop whose ledger passes the corrected file and a fake execution port. Assert (a) the fake received the file under an `-acc` namespace; (b) the run's cases for the file carry the new titles, not the previous ones; (c) the next review round's targets include the file. | `review.steps.ts:453` hands the proof source over: no execution, the record keeps the previous titles. It fails for the bug's reason, not for a missing call. |
| T2 (RED) | A review correction that changes two files, one proof-held, leaves cases for both. | As T1 with two files. Assert both files have cases in `run.cases` and in the reviewer's targets and that no delivered file is absent from them. | The proof-held file is executed by nobody, loses its cases (`review.steps.ts:557`) and leaves the reviewer's scope (the #29 shape). |
| T3 (RED, if reachable) | A fix-loop round whose changed file holds a pass is executed, and a case of it that still fails keeps the verdict `fail`. | The use case with a failing primary execution, a regeneration into proof-held bytes and a fake execution port that fails the file. | `fix-loop.steps.ts:155` skips the execution and `mergeAcceptedRound` removes the failing case (`fix-loop.aggregate.ts:216-230`), so the loop reports `pass`. If the use-case fixture cannot reach it (reachability is a hypothesis), the type-level removal is the guard and T3 is dropped, not faked. |
| T4 (rewrite) | An acceptance executes every changed file; an accepted outcome has a case for each kept file. | `RegenerationAcceptance.accept` with fakes, changed files whose proofs would have been closed under the old input. Replaces the tests at `regeneration-acceptance.test.ts:181` and `:313`. | Those tests pin the skip itself. |
| Guard | Previous behavior holds. | The per-file restore tests (`regeneration-acceptance.test.ts:283`, `:337`, `:356`, `:379`, `:402`), the cap test (`:204`), the deadline test (`:230`), the gap-site tests (`run-qa.closed-loop.test.ts:432`, `:449`, `:464`) and `fix-loop.aggregate.test.ts:780` (an accepted round names as re-run only what it executed: now it is all changed files) pass unchanged except where named. | n/a |

Differential check, per the testing standards: for the gap site, run the same proof-held input against a copy of 4105c582 in a scratch directory and against the change; stdout, cases and acceptance events are identical (it already executes). The review and fix-loop sites differ, as intended, and only by the cases of proof-held files.

Break proof: re-adding `closedLoop` to the review site's acceptance call fails T1; the input no longer exists in the type, so a typecheck fails first.

## Measurement

The signal is deterministic and read from the run record and spans, not from a score:

| Signal | Before (`run-ed28973-mvs7oo0f-17041c71`, 4105c582) | Expected after |
|---|---|---|
| Delivered files with no case in the record | 0 | 0 |
| `gateSignals.integrity.proofReused` | 0 (`acceptances 2`, `capHit` false) | 0 whenever an acceptance changed a file |
| A `qayaba.spec.execute` span after each acceptance's validation checks (`regeneration_acceptance` event, `kept_files`) | gap: +2691 s then +2695 s; review: +3233 s then +3237 s | the same pattern at every origin |
| Reviewer `review.targets` against delivered files | equal (3 files, both rounds) | equal |

Honest limit: the trigger did not occur in the before run, and one replicate of the after reaches the trigger only if an author ends a correction on a `run_spec` pass of its final bytes (7 of 15 recorded runs did, on older code). A replicate that never reaches it shows nothing. Per ADR-0011 the fix is then reported as proven by its RED tests (the mechanism is deterministic) and unproven by the replicate. The replicate shows the record the fix changes; it does not prove the fix. Line coverage, branch arms and mutants killed are not signals for this fix: they spread from 0.630 to 0.904 on identical inputs (ADR-0011).

Cost signal to read in the same replicate: the seconds of acceptance executions (`qayaba.spec.execute` after an acceptance validation) and the count against the cap of 4.

## Owner decisions needed

1. May an acceptance ever skip executing what it accepts? Recommended: no (O1). The skip has no verdict-only consumer; it saves 87 to 97 s.
2. Accept the cost: one more execution when every changed file was proof-held, counted against `MAX_ACCEPTANCE_EXECUTIONS = 4`. Recommended: yes, and leave the cap at 4 (highest recorded: 2 acceptances in a run). Revisit only if a run hits the cap.
3. One writer of `run.cases` (O1b)? Recommended: not in this change. After O1 no failure traces to the writers; revisit if a fifth writer appears or a divergence shows in a record.
4. Keep `integrity.proofReused` (`src/types.ts:290`)? Recommended: keep the field and its two increments. It then counts accepted regenerations that executed nothing, which is the measurement signal; a rename or removal changes a persisted record and waits for its own reason.
5. Commit shape. Recommended: one commit that holds T1-T4, the removal of the skip and the removals listed above, in the run-orchestration family slice of F-A. Not governance-sensitive (no security boundary, no agent write authority, no switch).

## Out of scope

Plausible neighbours of the same family, not confirmed by N06 and so not fixed here (rule D12):

- Other readers of the closure predicate "every delivered spec was seen passing": the static-fix retirement (`qa-engine/src/contexts/run-orchestration/application/run-flow/phases/execute.steps.ts:117`), the pre-execution corrective regeneration (`.../phases/generate.steps.ts:290`), the fix loop's retirement and its triage proof (`fix-loop.steps.ts:257`, `:296-300`), the lead's verified flag (`qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:969`). They treat a ledger pass as "green" for other decisions. Open question.
- The grep-limited pass that closes a whole file (chain step 2). O1 removes its effect at the acceptance; the other readers above still see it. Seen in one run (#19, a run under raised limits); open question.
- The snapshot table's `delivered` flag, written at validation and never retracted (`spec-snapshot-validation.adapter.ts:76`), which over-counted rolled-back bytes in the quality strand (#23, #24). A measurement-tool defect, not an engine verdict; open question.
- Whether the stale-coverage flag after a review acceptance should be a recount (the `remeasure-stale-coverage` step, `review.steps.ts:615`). Not part of N06.
- Whether stale or dropped cases changed any published test. Not shown.
- The review answer crossing the pipeline whole (N02, [RFC-0006](./0006-review-answer-crosses-whole.md)): a different mechanism in the same phase; separate commit. (Correction 2026-10-29: the slices are not independent. This slice's test fake returns the reviewer shape `corrections`, which RFC-0006 changes to `findings`; whichever slice lands second ports the fake.)

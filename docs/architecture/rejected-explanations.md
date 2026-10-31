# Rejected explanations

Seven hypotheses of the root-cause investigation were refuted: H03, H05, H10, H13, H14, H26 and H27. This page records each so it is not proposed again without new evidence: the claim, why it failed, what it never explained, and the narrower mechanism the refuters found inside it.

Seven more claims, refuted later (N03, N07, Q02, Q03, Q05, Q06, Q07), are listed under [Refuted later](#refuted-later-the-narrowing-round-and-the-test-quality-strand).

**How to read "refuted".**

- It means the hypothesis as stated does not explain the runs it cites. It does not mean its code facts are false. Most held when re-checked and are marked so.
- Two independent refuters read each hypothesis against raw data (traces, logs, run records) and the code of the epoch each run ran in. H27 had one refuter covering both lenses. The lower of the two refuters' verdicts stands; when one confirms and the other refutes, an adjudicator decides (H02, H11, H17, H20, H21). These seven were refuted by the lower-verdict rule with no split, so none needed an adjudicator. The brief's bar for a hypothesis was at least 3 concrete runs it explains, a falsifiable prediction, and the failures it does not explain.
- The narrower mechanisms below are not decided here. Each is a new hypothesis for the narrowing round, which refutes it again before any fix ([ADR-0011](adr/0011-root-cause-fix-policy.md), rule 1).
- Code is cited at 4105c582. Run numbers (#n) and epochs are defined in the [run index](#run-index) at the end.

| Id | The claim, in one line | Evidence lens | Alternatives lens | Why it fell | Narrower mechanism handed on |
|---|---|---|---|---|---|
| H03 | Refusals the run induces are unowned: no requester, broadcast by time | plausible | refuted | The merged root is on the causal path of no run where an outcome changed | The login's refused-host rule decides on presence over the whole login |
| H05 | Seeds, shared seeds and changed files have no single owner | plausible | refuted | Under 3 runs share the mechanism; each cited run has a better explanation | Engine rule vs the lead's judgment on drops; answer reading; lead silence and time |
| H10 | The run's ending has no single typed owner | plausible | refuted | The engine's writers never disagreed; 2 runs show two writers, both confounded | Two single-path gaps (a turn limit, a cancel) and one latent duplicate constant |
| H13 | The coverage denominator has no owner and no identity | plausible | refuted | No owner mechanism acted in any run; the one decision effect came from a missing scope rule | Lines the collector cannot classify count as uncovered |
| H14 | Coordination budgets are fixed constants against work that scales | plausible | refuted | Only #7 shows harm, and it is the small change; budgets did not bind elsewhere | The plan turn's expiry alone is terminal |
| H26 | The failure-point capture has no typed outcome | plausible | refuted | The reader consequence never occurred; 8 lost captures come from 3 tests | A producer that loses everything on one failed read; a WARN that ignores data in scope |
| H27 | A session's end has several owners deciding from proxy facts | plausible (one refuter wrote both lenses) | refuted | One run shows harm; the family splits into four mechanisms | A value (age threshold) and an unclamped flow budget, one since changed and one set outside git |

## H03. Refusals the run induces are not owned facts

- **Claim.** Conditions the run induces (refusals by its own egress filter, its saved session) are not owned facts. A refusal carries no requester or intent and is broadcast by time, and each consumer attributes it to the app, the child or the login by co-occurrence or raw text.
- **Why refuted.**
  - The merged root is on the causal path of no run where an outcome changed. #1 and #2 ended `infra-error E-PRECONDITION` (egress-denied); #3 logged the same error and its context run passed with no login. The only child alive in the login window was the login's own discovery child, which met an undeclared image CDN. The seed attempt that failed met no non-exempt host, and the rule still decided on the whole window: `qa-engine/src/contexts/app-catalog/infrastructure/auth-session.adapter.ts:229-240`, while per-attempt windows already exist at `:129-148`. Control: #4 failed the same two attempts with no non-exempt host, bootstrapped and passed. A requester identity would not have prevented #1-#3. All three are on the investigation's invalid list: the image origin was undeclared in the app configuration until 18:09:08Z on 2026-10-26.
  - `network_class` is set by the host of the test's own failed request, so time plays no part: `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:410-413`, `:737-746`. `egress` is the only class ever emitted (all 71 failed tests with network evidence in #1-#28 carry it). Only telemetry and the API contract read it.
  - `runtime_error` is the page's own console text (`config/e2e/fixtures.ts:731`): 76 of 77 values in #1-#28 and 13 of 13 in #29 are DNS lines. Decision paths already drop them (`qa-engine/src/shared-kernel/runtime-error-class.ts:13`, `:25`).
  - The route-catalog advisory and the availability classifier disagree in #25 (`qa-engine/src/contexts/generation/infrastructure/route-catalog.ts:118-140` against `qa-engine/src/contexts/generation/domain/route-availability-classifier.ts:113`, `:130`). On this app the classifier's session rule cannot fire: the app declares no `auth.loginPath`. So the "contradiction" is two different questions, and the advisory only writes to the log.
  - Runs that share the broadcast mechanism and produced a failure: 0. It is armed in #11 (`www.google.com` in the window of a successful login, from the concurrent authenticated browser) and in #31, with no failure. The `lgtm` and `collector` denials in #14, #20, #27 and #29 rest on a kernel NAT collision nobody reproduced (it needs the shared stack).
  - Probes run at db041567 (the commit the investigation branched from) reproduced the mechanisms (4 of 4); a second probe with one child alive turned the seed's failure into terminal `egress-denied` for an undeclared, irrelevant host and not for a declared-blocked one (3 of 3).
- **What it does not explain.** Why the stock seed and discovery could not sign in (#1-#4). The origin of Chromium's background-host refusals. Any effect on an agent decision (prompt text was not read: not enough evidence).
- **Narrower mechanisms found** (not decided).
  1. The login's egress rule promotes presence to a terminal cause over the whole login, with `dev.blockedOrigins` as the only correction (`auth-session.adapter.ts:229-240`, `qa-engine/src/contexts/app-catalog/domain/auth-precondition.ts:21-22`). Changed a verdict in one incident (#1-#3, 7 minutes, O0b). Armed on any app through the authenticated browser's Chromium background hosts: Google hosts appear on 20 of 20 browser execs and on 1 of 53 login execs. The refuters' candidate signal: was the refused request on the failing attempt's own page, and did it block the page. The rule was added on purpose (`b8909bba`); a change must keep the case where the refused host is the cause.
  2. Self-induced refusals saturate the console and network-class telemetry; no decision reads them (`config/e2e/fixtures.ts:861-883`, `e2e-execution.runner.ts:737-746`).
  3. The route-catalog advisory contradicts the classifier on apps that declare `loginPath` (log only).
  4. Hypothesis, not reproduced: root lookups that reuse a sandbox-uid conntrack flow are redirected into the DNS filter (`qa-engine/src/shared-infrastructure/egress/iptables-ruleset.ts:29`, `bin/egress-init.sh:46-47`).
- **Refuters' reading of the single-owner thesis.** Mostly against. The login cause already has one owner (the adapter) and it applies a wrong rule. Only the telemetry channels would gain from one consumed fact.
- **Quality.** The login rule ends a run before any test is written. `network_class` is always `egress`, so it never says why a test failed, and the one real app error in 77 (#17, `UNIMPLEMENTED`) sits among DNS lines.

## H05. Which part of the change a use case stands on has no single owner

- **Claim.** `seeds`, `sharedSeeds` and `changedFiles` are three parallel fields and every reader builds its own union.
- **Why refuted.** The code fact holds: `qa-engine/src/contexts/change-analysis/domain/use-case-candidate.ts:195` derives `changedFiles` from seeds; `qa-engine/src/shared-kernel/use-case-candidate.ts:34-35` declares shared seeds beside them; `qa-engine/src/contexts/coordination/application/plan-coverage.ts:81` reads the union. What fails is that it explains the runs.
  - Of 58 findings sunk as `no-seed-use-case` in #23, #27, #29 and #30, 33 name files no definition seeds (components created by a template, a DI token, pages whose map link was dropped). The sink also needs the lead to leave findings unrouted: in #27 and #29 the lead left as many findings on seeded files unrouted (`no-flow-took`: 24 and 22) as on unseeded ones (22 and 22). Seeds only chose the label.
  - The plan-side refusal on the same 4 use cases fired in 7 of 7 three-commit runs from O7 to O11 (#23, #24, #26-#30). The lead's reasons in 6 of 6 O7-O10 runs argue the shared store and API hunks on the merits (refactors that render the identical list). The same 4 were dropped in all 11 three-commit runs from O6 to O10 (#18-#24, #26-#29), across two lead models, including O6, where none of the three fields, the role rule (`agents/agent/qa-lead.md:33`) or the refusal check existed.
  - Same epoch, opposite outcomes: #30 left all 84 findings unrouted; #31 and #32 left 0, and routed 12 findings each on unseeded files. The difference is whether the lead's correction turn finished with room left.
  - Runs that share the exact mechanism (the sink label from seeds-only readers): #27 and #29, one epoch. Under 3.
- **What it does not explain.** The `needs-unavailable-state` drops in #23 and #28. Whether the lead's drop was right on the merits (the diff supports "refactor" for the list query, while the page also drives map markers: not enough evidence). The second `no-changed-lines` candidate.
- **Narrower mechanisms found** (not decided).
  1. The path-A label was a reader disagreement. One seed definition for routing removed it on main (`485d5604`; `qa-engine/src/shared-kernel/change-map.ts:29-30`). Per-candidate coverage still reads seeds only (`qa-engine/src/contexts/objective-signal/domain/per-candidate-coverage.ts:49`, `:70`).
  2. The engine refuses a drop on a weak signal (any attached executable code counts as observable, direct or shared: `plan-coverage.ts:81`), asks once, then honours the drop and credits the lead. The refuters' sketch of a better line: the engine states the fact and the agent answers with a typed basis the engine can check.
  3. A second answer that is a bare plan is not read, and every non-answer becomes "the first plan stands" (`qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:462`, `:484`, `:492`; `plan-coverage.ts:91-95`). #27 recorded 4 contradicted drops this way although the lead covered all 4.
  4. Findings the lead leaves unrouted regenerate nothing: lead silence and time, not seeds.
  5. Missing static proof: components reached only by an Angular template selector or a DI token have no caller edge (`qa-engine/src/shared-infrastructure/code-graph/codegraph-store-reader.mjs:65`).
  6. The route-config producer builds candidates with `seeds: []` (`qa-engine/src/contexts/run-orchestration/application/run-flow/route-availability-grounding.ts:55`), and a map link is dropped when another proof holds the page (`qa-engine/src/contexts/change-analysis/domain/use-case-candidate.ts:170`).
- **Refuters' reading of the single-owner thesis.** Mixed. One function removed path A. The plan dispute is a rule question an owner would only settle one way or the other, and the missing proof is a missing fact.
- **Quality.** After the re-ask, the flows for the 4 use cases asserted DEV's empty state in 3 of 5 runs (#23, #28, #29): tests that pass because DEV is empty. That follows from the coarse rule plus the data state, not from the seed split.

## H10. The run's ending has no single typed owner

- **Claim.** Several writers derive the run's ending from different inputs, and the error class is a lossy learning key reused as the failure class.
- **Why refuted.** Every step of the chain held, at every epoch head, and probes reproduced it (4 of 4). The evidence lens stopped at plausible: no run in the valid set shows the symptom, and several divergences are deliberate and pinned by tests. The alternatives lens refuted it:
  - Seven members, not one mechanism. Only two runs show two writers deriving one fact and disagreeing: #7 (a plan-turn budget invisible at run level) and #8 (an operator cancel). #7 started from an unreset suite and #8 is excluded as an operator cancel.
  - `E-NO-AUTHOR` for every refusal is a documented contract with tests (`qa-engine/test/contexts/run-orchestration/application/run-qa.coordination.test.ts:188-200`, `:246-253`). `E-COVERAGE-GAP` on a green signal-mode run is documented (`qa-engine/src/shared-kernel/error-class.ts:105-108`) and matched the coverage decision in 8 of 8 runs (ratios 0.151-0.568: #10-#12, #15, #19-#21, #23). The trace's decision vocabulary follows the registry (`qa-engine/src/shared-kernel/telemetry/attribute-registry.ts:136`, `src/server/run-trace.ts:87`).
  - The run record carries no class on 32 of 32 records: a read-model gap shared with H02, not a second writer.
  - The engine never disagreed with itself: one call site per end kind, and the shell's crash writer fired in 0 runs.
  - No verdict, decision or publication changed.
- **What it does not explain.** Any verdict. Why #25 was rejected. Why ratios were low.
- **Narrower mechanisms found** (not decided).
  1. `state.run.limit` has one writer, the run deadline (`qa-engine/src/contexts/run-orchestration/application/run-flow/failure-ends.ts:35`), and the trace facts map only two more (`qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:157-170`). A plan turn that hit its budget (#7) and a run degraded after a spent deadline (#30) read `budgets.exhausted=false`.
  2. The cancel path writes no phases (`src/server/runner.ts:822-826`) and discards the job's late result that holds them (`:583-587`): #8 has `phases: []` on the record and 9 phase spans in the trace.
  3. A parse-miss rejection carries no class (#24).
  4. Latent, 0 runs: the class re-derives "gap" from a constant 0.7 (`qa-engine/src/contexts/run-orchestration/application/run-flow/outcome-assembly.ts:18`, `:118`) instead of reading the app's coverage decision. With `minRatio` 0.5, a pass at 0.6 is a coverage pass and `E-COVERAGE-GAP` (probe).
  5. The audit kind `recurring-test-failure` names an observe-only quality gap a failure (`qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts:139-147`). Caution: that streak was the only cross-run signal that the generated suites of 8 runs missed 43-85% of the changed lines; removing the class would hide it.
- **Refuters' reading of the single-owner thesis.** Mostly against: the owner of the class already exists. It would have helped only the cancel (1 run) and the limit (1 run).
- **Quality.** A pass run reads as a plain pass on the API record in #10-#23, with neither class nor coverage status.

## H13. The change-coverage denominator has no owner and no identity

- **Claim.** The denominator is a stack of subtractive filters in four layers, with two definitions of "is this line code" chosen by the run's own evidence, exclusions threaded by hand per caller, and no rule recorded with the number.
- **Why refuted.** The mechanism is real and a probe reproduced it. The evidence lens held it at plausible (the composition of the count is recorded after all, in `gateSignals.changeCoverage`, and its prediction about mapped files fails on #14 and #15, which mapped 6 and 5 files and both counted 22 lines). The alternatives lens refuted it as a cause:
  - Cross-epoch moves were deliberate rule changes, each narrowing a pessimistic default (O5, O8, O9 and after the window). One owner would have the same five versions.
  - Inside one code version the denominator moved by at most 1 line of 312-452. The ratio spread came from the numerator: in O6 (#19-#21) covered lines ranged over 42 (214 to 256) against a denominator of 451-452.
  - The only decision effect is derived: #19 and #20 would pass the 0.7 band (0.769 and 0.800) without 131 markdown and stylesheet lines counted as uncovered code. That is one missing scope rule inside the single assembler, fixed in O8 (`ec1b0bbc`); R0 counted those lines too, so an owner would have counted the same. #20 started from an unreset suite. The class flip taught nothing: `qayaba.context.learning` held 0 items on all 26 runs that carry the span.
  - The members that share the ownership mechanism are the module resolver placed in another context (#27, #29: 3 lines, no decision) and exclusions threaded per caller (0 runs: the caller that forgot them never ran, and every run was in signal mode).
- **What it does not explain.** Unreadable dumps, the numerator collapse, the acceptance lifecycle, unrouted findings, kill rates. #13 ended `unknown`, so no ratio was consumed.
- **Narrower mechanisms found** (not decided).
  1. A line the collector cannot classify counts as uncovered code, and the set of classifiable file kinds is inferred from the run's own maps (`qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts:127-136`, `:145`, `:151`). It is a deliberate anti-gaming guard held by one owner. On other app shapes a probe predicts it fires harder (hypothesis, not observed): a changed `.java` file is a declared language (`qa-engine/src/shared-kernel/language-id.ts:27`, `statements: null`), so a full-stack change gets a ratio of 0.1 where 1.0 is right; a `.vue` file counts only when the run maps another `.vue` (ratio 1.0 or 0.1). Under `enforce` this would block on lines no browser test reaches. It bears on [ADR-0005](adr/0005-coverage-enforce-activation.md).
  2. No rule version on the measurement (`qa-engine/src/contexts/objective-signal/domain/objective-signal.ts:7-34`): ratios from different epochs read as comparable. An observability gap with no failure behind it.
- **Refuters' reading of the single-owner thesis.** The rule the existing owner holds is wrong, not shared.
- **Quality.** The bias is downward only: #19 and #20 stored 0.55 and 0.57 instead of 0.77 and 0.80. It never forces a PASS; under `enforce` it could push toward a FAIL (hypothesis).

## H14. Coordination budgets have no owner that derives them

- **Claim.** Fixed plan, flow, review-turn and call-grant constants face work that scales with the change, and their expiry is terminal.
- **Why refuted.** The constants exist (`qa-engine/src/shared-kernel/coordination.ts:54-58`, `qa-engine/src/contexts/coordination/application/lead-review.ts:34`, `qa-engine/src/contexts/coordination/application/flow-capacity.ts:73-80`) and a probe reproduced the terminal plan expiry (4 of 4). The harm does not scale with the work.
  - Of 159 agent turns, one hit a limit: #7's plan turn (180 s). #8, on the same range, epoch, suite and agents process, planned in 40 s with 5 steps against 20. At identical prompt size #21 took 258 s and 23 steps and #22 112 s and 3 steps. A budget derived from the work gives #7 and #8 the same value.
  - No author turn reached its flow budget in 75 spans. The 13 of 15 author turns over 480 s that contain a failed or refused `run_spec` call follow the loop, not the change size.
  - #23's review cap came from the DEV-write cap (every call refused `no-writes`). #22's `no-calls` came from a share rule since replaced. #27's `no-calls` came from the out-of-git per-call value; with defaults it would have granted 4 and not 3, and the verdict was unchanged.
  - A size-derived cap already failed the same way before the window: three history runs (mv41sbze, mv55m2ok, mv57rbz5, from the pre-window history records, not re-checked) ended `E-TIME-BUDGET` with 5, 5 and 19 of 50 steps in 360 s, under a cap derived from the diff's size tier. The remedy has the size-threshold shape that [ADR-0001](adr/0001-design-pillars.md) (P3) rules out.
  - The "latent" overruns were measured under prompts that state the budget (900 s), so they do not predict behaviour under 180 s.
- **What it does not explain.** Why #7's turn was slow (agent or provider: not enough evidence).
- **Narrower mechanisms found** (not decided).
  1. The plan turn is the only lead turn whose expiry is terminal: a timed-out plan is refused `plan-timed-out` with no re-ask whatever deadline is left (`qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:327`, `qa-engine/src/contexts/generation/application/generate-tests.use-case.ts:143-148`), while a malformed plan is re-asked once (`lead-sidekicks.ts:331-335`). Pinned by `qa-engine/test/contexts/coordination/application/lead-sidekicks.test.ts:379-384`. Plausible at n=1 (#7), confounded. To confirm: owner-launched default-limit runs of the 3-commit range, each `plan-timed-out` split by time to first step against steps used.
  2. One formula clamps the flow time by the deadline but not its per-call divisor (`qa-engine/src/contexts/coordination/application/lead-plan.ts:292-298`): the grant fell from 4 to 3 in #27. Harmless there.
  3. A flow whose last call failed and whose grant is spent is still sent back (`lead-review.ts:160-163`), the `no-calls` twin of the `no-writes` gap closed in `2d3cdd00`. Hypothesis; the cap ended that loop in #22.
  4. The opposite direction after the window: a constant too large (the x5 plan budget of 900 s let a correction turn run 554 s and spend the flows' room). See [ADR-0011](adr/0011-root-cause-fix-policy.md), B2'.
- **Refuters' reading of the single-owner thesis.** Mixed: a wrong rule (terminal plan expiry), values (x5, the share of 8), and a write cap that is not ownership at all.
- **Quality.** No verdict was forced. A larger flow budget could lengthen loops that iterate on failing specs, which is the green-forcing pressure the owner warns about (hypothesis).

## H26. The failure-point capture has no typed outcome

- **Claim.** Four states (no dump, unmatched, empty tree, tree) collapse into absent optional fields, and readers take the absence as an observation.
- **Why refuted.** The code holds and a probe reproduced it (7 of 7): `config/e2e/fixtures.ts:768-888` is one `try` around an unguarded first read (`:775`) with a `catch` that records no reason; the harvest and its fixed WARN are at `e2e-execution.runner.ts:402-419`; absence reads as settled and as not-found at `qa-engine/src/shared-kernel/qa-case.ts:56-58` and `qa-engine/src/contexts/coordination/application/authoring-failure.ts:14`, `:35-37`. The evidence lens stopped at plausible because all three runs are confounded and the headline consequence never happened. The alternatives lens refuted it:
  - In the corpus, 96 non-passing attempts across 29 traces, 8 had no tree and 8 WARN lines map to them. The 8 come from 3 tests in 3 runs (#17, #23, #24); only 2 of those tests lost a capture. #17 is one native-emulation test re-run six times under the x5 limits.
  - No decision read a lost capture. The authoring classifier runs on a flow's last `run_spec` call: #17 ended on a passing call, #23's last call was captured, and #24 was a branch-case acceptance run that reads no tree (its dump carried settle facts, so `failureUnsettled` was true).
  - Nothing after #24: O9 and O10 had 0 timeouts and 43 non-passing attempts, all with a tree; #29 alone captured 13 of 13. No WARN line exists after #24, cycle 2 and cycle 3 included.
  - The members that share the decision-reader mechanism: 2 runs (#17, #23), and it fired in 0.
- **What it does not explain.** Why the fixture wrote nothing (the `catch` hides the reason). Why 2 dumps kept no role. Any outcome: all three runs passed.
- **Narrower mechanisms found** (not decided).
  1. A failing first read loses `finalUrl` and the runtime errors already in hand, because they share the `try` (probe). Arithmetic fit, hypothesis: #17's 43.0 s attempt against a 30 s test timeout leaves about 13 s of teardown, which matches an 8 s action timeout plus a 5 s snapshot timeout on a page that did not answer.
  2. The WARN at `e2e-execution.runner.ts:417-418` is a fixed literal written in the same loop body as `failureAttempts`, 15 lines later (`:402` against `:417-418`); `failureAttempts` already tells "no dump matched" from "dump without a kept role": false on "no dump" in 2 of 8 and on its consumer ("fix-loop") in 8 of 8.
  3. Latent, exposed in 2 runs and fired in 0: readers default "not observed" to "settled" and "not found". Trigger frequency is agent- and app-shaped (5 of 6 losses are one test faking a native platform on a map page).
- **Refuters' reading of the single-owner thesis.** Mixed: a producer logic bug, a wrong reader default and a log literal. A typed outcome would have prevented none of the observed losses.
- **Quality.** Latent direction toward a forced PASS: a non-observation reported as "absent on a settled page". Not shown in #17 (the bytes are gone): not enough evidence.

## H27. A session's end has several owners

- **Claim.** Besides the holder's release, non-holders end a session from proxy facts (age or idle time, abort, silence, the first turn's error class), and disposal cascades into in-flight DEV executions.
- **Why refuted.** One refuter covered both lenses: the evidence lens alone would give plausible, the alternatives lens refuted. The code facts hold and a probe reproduced them (4 of 4): the idle sweep (`qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts:649-664`, threshold `src/server/wire-app.ts:391`), the stall watchdog (`agent-transport-policy.ts:732-744`), the executor's disposal on a first-turn error (`qa-engine/src/contexts/coordination/application/sidekick-executor.ts:118-123`), and the registry's cancel (`qa-engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts:76-83`).
  - Exactly one run shows harm: #26. In #28 the disposal is inferred from code, the lead chose `replace` itself, and nothing was in flight. Both harmful events are one run of one epoch.
  - The family is four mechanisms: the age or idle sweep bypasses the unbind, so it never cancels a `run_spec` (the title's second clause does not apply); the abort listener fired in 0 runs and was removed in O10 (`93ee3941`); the stall watchdog has 0 live occurrences; the first-turn disposal is the only cascade (#26 harmful, #28 harmless).
  - The lead's loss in #26 fits a value: an age threshold of 30 min under a 60 min run, exposed when sessions began to outlive a turn. The epoch thresholds predict every outcome: 80 min at O7 (#23 used its lead 38.8 min after the first turn and kept it), 30 min at O8-O9, idle with a floor of 155 min at O10 (#27 at 35.6 min and #29 at 28.4 min were kept). The sweep also most likely fired in #24, harmlessly (inferred from the maintainer branch time).
  - The sidekick half needed an out-of-git value: the x5 flow budget (2,400 s) sits above the transport cap of about 960 s (`src/integrations/opencode-client.ts:704-707` plus `src/util/net.ts:12-13`), so the HTTP turn died with `fetch failed` at 962.8 s while a tool ran. The kill that followed (+43 ms) fits the deliberate guard `826f68b9`, which cancels a session's `run_spec` when the session is unbound so a spec does not keep running against DEV (a refuter's reading, not excluded).
  - #28's disposal followed a provider 401 incident, an environment trigger.
- **What it does not explain.** The `fetch failed` itself (the transport cap). The 401. The charge rule for a stopped call.
- **Narrower mechanisms found** (not decided).
  1. A value: the age threshold under the run's length. Changed at O10 (`93ee3941`: idle sessions only).
  2. An unclamped flow budget above the transport's turn cap, set by out-of-git configuration.
  3. At 4105c582 the first-turn disposal, the idle sweep and the watchdog remain, and the `run_spec` cancel is derived from the unbind. Code-only risk with 0 live occurrences in O10 (#27-#29).
- **Refuters' reading of the single-owner thesis.** Mixed. One owner of "end only on the holder's release" would have prevented the lead loss, and so did a correct value at O10. No owner prevents a client losing a turn.
- **Quality.** #26 hid the quality of one flow: unproven, unreviewed bytes of `filter-facets` reached the final execution and 2 of its cases failed. Whether that is an app defect or a test defect: not enough evidence.

## Refuted later: the narrowing round and the test-quality strand

Seven more claims were refuted after the first version of this page: two narrowed candidates (N03, N07) and five test-quality hypotheses (Q02, Q03, Q05, Q06, Q07). An evidence lens and an alternatives lens read each one; the lower verdict stands. What the last column names was re-checked and holds as a fact; it did not explain the runs as claimed, and it is not decided here.

| Id | The claim | Why it fell | What holds or survives |
|---|---|---|---|
| N03 (from H21) | The Context Pack capture had no "confirmed empty" value, so every 0 on a declared result route was retried and recorded as an engine capture fault (O6-O7). | Two mechanisms under one phrase. In 15 of the 16 retried events the engine never held a 0: the count was unread, while the live-DOM trees of #18 to #23 show the page's empty-result text. One event (#23) is a read 0 that was retried. | The unread count; its proximate cause, a 1 ms last read of the wait (`2aaab75b`), is a hypothesis. A confirmed-empty rule exists on main since `78453627`. |
| N07 (from H14) | A flow's `run_spec` capacity is granted once, and its later turns run with a full budget and no reading of that capacity, so they rewrite blind. | The code facts hold, but the send-back of a spec whose calls are spent is owner-specified and pinned by a test; the turns were not blind (10 of the 19 zero-execution author turns used the authenticated browser 5 to 22 times); and the round's acceptance executes the bytes and restores failing ones. | Correction turns do not show the calls left, while review turns do: an open question. |
| Q02 | The reviewer sees test-value defects, but its blocking channel cannot carry them; block or ship follows the tag word. | Re-running the 59 stored reviewer findings through the current chain, the channel carries 14, and 12 of them are value defects. | A grave tag promotes a finding to blocking, and the filter never compares the claim with the spec: a code fact with no failure shown. |
| Q03 | Absence assertions have no modelled precondition, and the one prompt line near them routes them to advisory. | The unforced absence assertions were effective: the engine's gate mutant was killed by them in 4 of the 4 runs where it was measured (#11, #14, #15, #25). | No role prompt covers absence assertions. A viewport-conditional vacuous conjunct, shipped in #10 and #12, is a separate mechanism. |
| Q05 | The coverage-gap and branch-case mandate has no decline channel, so an arm with no honest closure gets padding, a comment-only revision or an environment fake. | A decline channel exists since O5 (a finding no flow takes is recorded unrouted), and leads used it (#19, #21, cycle 3). | Pressure at the re-ask and on owned findings, which overlaps the plausible N08. |
| Q06 | Survivor routing and the mutant sample put style tests in unrelated flows while the change's logic is never mutated. | Several mechanisms under one phrase. The routing chain it cites arrived with `70d8b41a`, after the cited runs, and that commit replaced the fan-out rule. | The path-ordered mutant sampler, which is the plausible N05. |
| Q07 | The revise and replace loop weakens assertions to reach green, and nothing mechanical sees it. | Only #22, and arguably #19, both in O6, show a lead order that removed or relaxed assertions; the other cited revisions strengthened tests. | When a flow's `run_spec` calls are spent, a revise carries no engine fact about what a removed assertion protects. The spec versions written inside the `run_spec` loop are not stored, so weakening there cannot be measured. |

## Run index

Runs are numbered by start time among the 29 runs of one app (app commit ed28973, except #4, which ran 76c3067) on 2026-10-26 to 2026-10-28, plus three runs of cycle 3 (#30-#32). The table lists the runs this page cites, and #6, which [ADR-0005](adr/0005-coverage-enforce-activation.md) cites. An epoch is one orchestrator process, so the engine code a run executed: O0b e6c7d095, O2 7207dca0, O3 482e9a20, O4 94f2b45e, O5 f96f958f, O6 f96f958f, O7 e4efa50e, O8 27238792, O9 58151b36, O10 bd1d2e46, O11 40513c1e (Correction 2026-10-30: O12 to O16 are the root-cause branch's, in the second table below). "x5" is an uncommitted experiment that raised hard time limits fivefold, live from #10 (the app configuration kept it through #29). O4 and O6 also ran uncommitted changes; the epoch's commit is the base.

| # | Run id | Epoch | # | Run id | Epoch |
|---|---|---|---|---|---|
| 1 | run-ed28973-mvpkbluk-e06d2a3b | O0b | 17 | run-ed28973-mvpv5uq4-70a26708 | O6 |
| 2 | run-ed28973-mvpkbluw-9a35dee7 | O0b | 18 | run-ed28973-mvpw76qh-ae9fb4bf | O6 |
| 3 | run-ed28973-mvpkd7fc-600da1fc | O0b | 19 | run-ed28973-mvq9r6vy-7f454004 | O6 |
| 4 | run-76c3067-mvpkmead-24d8a1b6 | O0b | 20 | run-ed28973-mvqb6uob-69a66ac0 | O6 |
| 6 | run-ed28973-mvpky8fw-f5c5f61e | O0b | 21 | run-ed28973-mvqc7x8j-2da31df4 | O6 |
| 7 | run-ed28973-mvplioa1-1f3e2dbe | O2 | 22 | run-ed28973-mvqd9fda-955d5933 | O6 |
| 8 | run-ed28973-mvplnlnz-012f8ac2 | O2 | 23 | run-ed28973-mvqy1s7l-64c65862 | O7 |
| 10 | run-ed28973-mvpnptj0-f49cfd71 | O4 | 24 | run-ed28973-mvr4s6br-7cfce5f0 | O8 |
| 11 | run-ed28973-mvpoel1j-e5a7cee8 | O4 | 25 | run-ed28973-mvr9sbey-cb4eceda | O9 |
| 12 | run-ed28973-mvpoyt4e-6b1ff206 | O4 | 26 | run-ed28973-mvra9a3s-09df0987 | O9 |
| 13 | run-ed28973-mvptanac-2600fbd4 | O5 | 27 | run-ed28973-mvruzwli-8bb3adcd | O10 |
| 14 | run-ed28973-mvptrv69-d4f52b7e | O5 | 28 | run-ed28973-mvrwjx2d-1bf83af5 | O10 |
| 15 | run-ed28973-mvpu85em-1b65ceb1 | O5 | 29 | run-ed28973-mvrxb30p-ecfe944b | O10 |
| 30 | run-ed28973-mvs0onsn-6ad17f30 | O11 | 31 | run-ed28973-mvs2ukug-c82da7be | O11 |
| 32 | run-ed28973-mvs49h5y-acdab309 | O11 | | | |

### Epochs after O11 (the root-cause branch)

Correction 2026-10-30 (checkpoint 3, C-B3; [RFC-0009](rfc/0009-pack-record-matches-prompt.md) F6 asks for the break to be recorded in this table). The runs of the root-cause branch are read in the epoch they ran in ([ADR-0011](adr/0011-root-cause-fix-policy.md), rule 7): a run is never pooled with a run of another epoch, and a series that crosses a row below changes meaning there. These runs have no `#` number; the epoch is the engine code of the commit.

| Epoch | Commit | Run | What it carries, and what changes meaning |
|---|---|---|---|
| O12 | 4105c582 | the baseline, `run-ed28973-mvs7oo0f-17041c71` | Four engine commits after O11 (F18-F21, [ADR-0011](adr/0011-root-cause-fix-policy.md)). The "before" of the baseline measurement. |
| O13 | 60d4b7bf | T17, `run-ed28973-mvuspjsx-a31b6838` | Platform step 1 (the deletions) plus T4 (the suite store's one writer). The slices' "before" and [RFC-0005](rfc/0005-suite-store-single-writer.md)'s after (feature document L18-L20). The first launch, `run-ed28973-mvusl6a5-2cffc23a`, ended `E-NO-AUTHOR` for an environment cause (L19) and is excluded. |
| O14 | 2af99d58 (the slice's two commits, 88d2a300 and 2af99d58) | none | The break of [RFC-0009](rfc/0009-pack-record-matches-prompt.md) (F6): `context_utilization` and the pack series (`change_pages_grounded`, the delivered ids) change meaning, because the id record now lists what the prompt printed. Do not pool across it; old runs keep their spans and their stored scores, with no regrade. |
| O15 | b900bc7e | `run-ed28973-mvv7lrgu-65aff66e` (verdict `fail`; feature document L28) | Every slice T4-T11 integrated: the dump harvest in a worker (T5 unit 1), the log level derived from the outcome (T6), the review answer whole (T7), the DEV-write control (T8, first design), the acceptance that records what it ran (T9) and the skip refusal in the seed, the pack record (T10, O14), the tool call's outcome (T11). One replicate: a direction, not proof. |
| O16 | 17bb77c1 | none yet | The checkpoint 3 corrections: the control load bounded apart from the call and read before the spec child starts (`b690fa8c`, which changes `generate` and `run_spec` time), the engine rule against a test that ran before turning green by being skipped, expected to fail or removed (`a6cded89`), the tool-target redaction window (`9b243fab`), the carried-on log levels (`c71b0438`). T5 unit 2 and the T12 after-measurement run in a later epoch. |
| O17 | 0a265e0b | none yet | RFC-0014 ([ADR-0019](adr/0019-owner-decisions-rfc-0014.md)): a diff run's `time_budget` is `diff` (60 min) whatever its size, not `diff-tiny`, `diff-focused` or `diff-broad`; the effort sentence is one for every size; the first pass has no time cap of its own, so `tier-budget` is no longer a limit that fires. Do not pool a small change's wall time, `limits` or spec count across it. The measured reserves continue (the `diff` history reads the former labels). |

# RFC-0015: One execution contract; the verdict never comes from an instrumented execution

- **Status:** Accepted, 2026-10-31, by [ADR-0023](../adr/0023-owner-decisions-rfc-0015.md) (every recommended answer); implemented as T41 (feature document T40, L73-L75).
- **Implementation (T41):** U1 `94e17675` (the contract recorded on every execution), U2 `5055cc3c` (judging uninstrumented, one measurement execution, E8 and E13 split), U3 `921c8d42` (dumps keyed by the bytes they ran; the judging executions' dump bookkeeping removed), U4 `14c781ef` (scripts written once per worker as `<sha256>.script.json`, keyed by the source's sha256 alone since the dump entry keeps its URL; `_coverage` has its own fixture time), U5 `614702de` (login wall on every judging execution, one renewal, `session-lost`), U6 the AGENTS.md and observability documents.
- **Code references at 21ef1810** (the worktree head when the map was made; read a line with `git show 21ef1810:<path>`). The installed Playwright is 1.60.0 (`package.json:60`, `config/e2e/package.json:8`).
- **Evidence:** T12-d `run-ed28973-mvwe1bcz-26750e38` (engine 6190f228, L65), the T40 investigation (L66) and the T40 A/B on DEV (L73).
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0003](./0003-coverage-dump-harvest.md) (O4, coverage on the observation re-runs), [RFC-0008](./0008-acceptance-records-what-it-ran.md), [RFC-0012](./0012-one-time-authority.md), [ADR-0005](../adr/0005-coverage-enforce-activation.md), [ADR-0006](../adr/0006-bundle-mutation-switch.md), T39 (the measurement split into `measure-coverage` and `measure-mutation`)

## Summary

1. The same spec bytes are judged by several executions: `run_spec`, the final execution, the fix loop's rounds and triage, the acceptance runs, the mutant and observation re-runs, the survivor closure, the stale-coverage re-measure and the static gate's `playwright test --list`. Each runs under its own conditions, so "passed" means something different in each (the map below).
2. One difference is confirmed to change outcomes: V8 precise coverage. On `/map` a test failed 3 of 3 with coverage on and passed 3 of 3 with it off; clicks were 2-5x slower; the coverage fixture's teardown costs 13-25 s a test and can lose a passed test (L73). Every judging execution except `run_spec` is instrumented today.
3. The rule this RFC proposes, for any app: **one execution contract defines the conditions under which a spec's outcome is judged; every judging execution runs under it; a condition may differ only when it is shown not to change the outcome, or when the difference is recorded and the outcome is not used as a judgment (a measurement-only execution).**
4. First application, coverage: option A′. Every judging execution runs uninstrumented. Coverage is taken by one measurement execution of the passing tests, which is also the first unmutated observation, and mutant kills are judged against that execution's own passes. The measurement can then be cut by the deadline without touching the verdict.
5. The other breaks are ranked by evidence. Session age is confirmed as a condition: a session expires about 90 minutes after login, and no judging execution checks it. Retries, observation, write counting, spec scope and order, DEV writes between executions and the `--list` environment are confirmed differences in code; their effect on outcomes is a hypothesis.

## The rule

An **execution contract** is the set of conditions a judging execution runs under. It is one value, built in one place, recorded on every execution. An execution is one of two kinds:

- **Judging:** its outcome decides something: the verdict, the fix loop's adoption of a round, the acceptance of a file, a `run_spec` proof the run later relies on, a mutant's kill, a survivor's closure. It runs under the contract.
- **Measuring:** its outcome is a signal only (coverage, observation). It may add conditions (instrumentation), it records them, and nothing it produces is read as a judgment.

A condition may differ between judging executions only when one of these holds:

- (a) the RFC that allows it shows, from the code, that it cannot change a case's outcome; or
- (b) it is recorded on the execution and the outcome is read only for what the difference does not touch. For example, the run's namespace differs by design, and a spec names its data from the `namespace` fixture.

## The map: every execution of a run

`runE2E` (`qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:239`) starts each one through the launcher's `suite` profile (`:1086-1093`). The purposes are the kernel's vocabulary (`qa-engine/src/shared-kernel/exec-purpose.ts:9`).

### What each execution decides, and its dumps

| # | Execution (purpose, namespace) | Where | What it decides | Instrumented today | Dumps it supplies | Who reads them |
|---|---|---|---|---|---|---|
| E1 | `run_spec` (`run-spec`, `<runId>-rs<n>`) | `agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts:274-288`; `test-execution/application/run-spec.use-case.ts:271-320` | The author's loop; `loopClosed` skips the pre-exec corrective and fix-loop regenerations; a file with a `run_spec` proof is kept in a per-file acceptance outside a gap regeneration (AGENTS.md "Per-file acceptance"); the lead's review sends back an accept with no proof | No (`PW_COVERAGE=0`, `e2e-execution.runner.ts:1092`, set with `countWrites`) | none | none |
| E2 | Final execution (`suite`, the run namespace) | `run-orchestration/application/run-flow/phases/execute.steps.ts:215-231` | The verdict; the engine's skip refusal (`refuseOutright`) | Yes | coverage dumps of every spec file; failure capture | measurement (base namespace, `coverage.steps.ts:89-111`); mutant selection (`objective-signal-port.adapter.ts:203`); mutation baseline (`coverage.steps.ts:96`); recount base (`:372-395`); `bestCoverage` of the fix loop (`fix-loop.aggregate.ts:370`) |
| E3 | Fix-loop acceptance of a round (`acceptance`, `<runId>-acc<n>`) | `fix-loop.steps.ts:146-156` → `regeneration-acceptance.ts:155` | Whether the round's bytes are kept, per file | Yes | dumps of the changed files | not read by the fix loop's measurement; the retry below re-runs them |
| E4 | Fix-loop retry (`fix-retry`, `<runId>-r<n>`) | `fix-loop.aggregate.ts:781-818` via `fix-loop.steps.ts:69-77` | The run's verdict and cases after the round; the best round (`recordBest`, `:822-830`) | Yes | a whole-suite round sets `coverageNs`; a filtered round adds to `coverageReruns` (`:813`, `:816`) | measurement and recount (`latestDumpsOf`, `objective-signal-port.adapter.ts:158-166`); `bestCoverage` restores them with the best round's bytes (`fix-loop.aggregate.ts:411-412`) |
| E5 | Fix-loop triage re-read (`fix-retry`, `<ns>-triage`) | `fix-loop.aggregate.ts:543-556` | `flaky` instead of `fail`, or `E-PRECONDITION` | Yes | coverage dumps of the failing files | **none**. `coverageReruns` is not updated on this path, so a measurement after a triage that passed reads those files from the failed execution's dumps (code, `:547-556`) |
| E6 | Gap regeneration acceptance: coverage, branch cases, flaky (`acceptance`, `<runId>-acc<n>`) | `coverage.steps.ts:290-300` → `regeneration-acceptance.ts:155` | Per-file acceptance (`greenSpecFiles`, `:246-255`) | Yes | dumps of the kept files (`reruns`, `coverage.steps.ts:327`) | recount (`:380-388`); the restored-bytes rule (a restored file is read from the dumps of the bytes it got back, `latestDumpsOf`); survivor-closure baseline (`:354`) |
| E7 | Review-correction acceptance (`acceptance`, `<runId>-acc<n>`) | `review.steps.ts:439-449` | Per-file acceptance of the correction | Yes | dumps of the kept files | recount, as E6 |
| E8 | Stale-coverage re-measure under enforce (`suite`, `<runId>-coverage-final`) | `review.steps.ts:617-645` | **The verdict.** A measured run that ends red replaces a passing run's verdict (`:629-630`); a flaky verdict stands (commit 4105c582) | Yes | a new measurement base | the enforce gate's measurement and its mutation pass (`:633-645`) |
| E9 | Mutant re-runs (`mutant`, `<ns>-mut<i>`) | `bundle-mutation-oracle.adapter.ts:112-142`; wired at `src/composition/run-engine-factory.ts:850-855` | A kill: a case that passed in E2 (or E8) now fails (`:134-139`) | Yes, and observed (`PW_OBSERVE`, `objective-signal-port.adapter.ts:237`) | coverage dumps; fault-injection counters | counters judge reach (`:123-131`); a killed mutant's dumps, with its edit undone, are verified coverage (`withProofs`, `objective-signal-port.adapter.ts:311-320`; recount proofs `:341-342`) |
| E10 | Unmutated observations (`observation`, `<ns>-obs`, `<ns>-obs2`) | `bundle-mutation-oracle.adapter.ts:111`, `:172`, `:189` | What a survivor moved (signal) | Yes, and observed | coverage dumps (unread); `observed-*.json` | the observation reader; the coverage dumps are written and harvested for nothing (RFC-0003 O4) |
| E11 | Survivor closure (`mutant`, `<runId>-closure-mut<i>`) | `coverage.steps.ts:348-363` → `objective-signal-port.adapter.ts:324-327` | Whether a regenerated test now kills its survivor | Yes | dumps, counters | counters only; the dumps are not read |
| E12 | Static gate `playwright test --list` | `test-execution/infrastructure/static-gate.checks.ts:213`, `offline` profile (`:104-115`) | `invalid` when the specs do not load or enumerate | n/a (runs no test) | none | none |
| E13 | Experiment acceptance (`acceptance`, `<ns>-acc1`, `-acc2`) | `accept-delivered-specs.use-case.ts:100-126`, wired at `run-engine-factory.ts:532-560` (`scripts/baseline-agent.ts` only) | Whether an experiment arm's suite would be accepted | Yes | dumps of `-acc1` | its measurement (`:126`) |
| — | Control load (`control`) | `e2e-execution.runner.ts:1120-1135` | Nothing on its own; the write charge of E1 is made against it | No (own config, no fixtures) | none | none |
| — | Cleanup pass (`cleanup`) | `e2e-execution.runner.ts:904` | Nothing (undoes data) | No (`PW_CLEANUP`, `config/e2e/fixtures.ts:175`) | none | none |

### The conditions each judging execution runs under

Shared by every `runE2E` call, from the same deps (`run-engine-factory.ts:827-833`): the base URL, `PW_NAMESPACE`, the action timeout (`PW_ACTION_TIMEOUT_MS`, default 8 s, `config/e2e/playwright.config.ts:44`), the test-id attribute, the failure capture (`QA_FAILURE_CAPTURE_DIR`), `PW_DATA_STATE` (read by the capture only, when a test did not end as expected, `fixtures.ts:698`), the durable geolocation (`app.dev.geolocation`), a per-spawn copy of the saved session (`exec-sandbox.ts:245`, `exec-env.ts:116`), the app's own `playwright.config.ts` (seed: `workers: 1`, `fullyParallel: false`, `retries: 2`, `globalTimeout` 12 min, the default 30 s test and 5 s expect timeouts, `trace: "on-first-retry"`, `:25-35`) and the process timeout (`QA_E2E_TIMEOUT_MS`, default 15 min, `e2e-execution.runner.ts:40`). The closed loop runs through the run's own execution port (`src/composition/engine-root.ts:352-354`), so it shares those deps.

What differs:

| Condition (where set) | E1 run_spec | E2 final | E3/E6/E7 acceptance | E4 fix retry | E5 triage | E8 re-measure | E9/E11 mutant | E10 observation | E12 `--list` |
|---|---|---|---|---|---|---|---|---|---|
| Coverage `PW_COVERAGE` (`runner.ts:1092`; `fixtures.ts:175`) | off | **on** | **on** | **on** | **on** | **on** | **on** | **on** | n/a |
| Observation `PW_OBSERVE` (`runner.ts:1092`; `fixtures.ts:583-586`, `:647-656`) | off | off | off | off | off | off | **on** | **on** | n/a |
| `PW_MUTANT` route (`fixtures.ts:228-260`) | none | none | none | none | none | none | the mutant | a selection that edits nothing, still a `page.route` | n/a |
| Write counter and control child (`runner.ts:1092`, `:1120-1135`; `fixtures.ts:588-599`) | **on** | off | off | off | off | off | off | off | n/a |
| Retries (`playwrightArgs`, `runner.ts:972-975`) | 0 | config (2) | 0 | config (2) | 0 | config (2) | 0 | 0 | n/a |
| Tracing (`trace: "on-first-retry"`) | never | on retries | never | on retries | never | on retries | never | never | n/a |
| Spec files, tests | one file, optional `--grep` (`closed-loop-port.adapter.ts:277-284`) | the whole suite in path order, one worker | changed files only (`regeneration-acceptance.ts:155`) | failing files, or the whole suite when coverage will measure (`fix-loop.aggregate.ts:775-779`, `fix-loop.steps.ts:239`) | failing files | whole suite | reaching files; other tests skipped at runtime by the fixture (`fixtures.ts:236`) | every mutant's tests | every file |
| Process timeout | per call, from the closed-loop budget (`run-spec.use-case.ts:230`) | 15 min, and the seed's `globalTimeout` 12 min | same as E2 | same as E2 | same as E2 | same as E2 | same as E2 | same as E2 | `DEFAULT_VALIDATE_CHECK_TIMEOUT_MS` |
| Session copy, age at start | from the last login (pre-generate, or pre-execute for later calls) | pre-execute login (`execute.steps.ts:199-208`) | age since pre-execute | idem | idem | idem | idem | idem | none (`offline`) |
| Environment | `suite` | `suite` | `suite` | `suite` | `suite` | `suite` | `suite` | `suite` | `offline`: no `PW_BASE_URL`, `PW_NAMESPACE`, session or geolocation env |
| DEV writes before it | other flows' calls, each followed by a cleanup pass | every flow's `run_spec` calls | E2 and earlier rounds, whose undo is per test and best-effort (`fixtures.ts:154-167`) | idem | idem | idem | idem | idem | none |

Geolocation and workers are the same in every judging execution. The authoring location (`set_geolocation`) moves only the authenticated browser and the prompts; it never reaches an execution. A spec that depends on a location pins it with `setLocation` (AGENTS.md "Authoring location").

## Where today's executions break the contract, ranked by evidence

| Rank | Break | Evidence | Label |
|---|---|---|---|
| 1 | **Coverage.** Every judging execution except E1 runs with V8 precise coverage. Playwright 1.60.0 starts it with `callCount: true, detailed: true`, enables the debugger and fetches each script's source as it is parsed (`node_modules/playwright-core/lib/coreBundle.js`, `JSCoverage.start` and `_onScriptParsed`). The seed's teardown then fetches every script's source map, one by one, and writes the whole entry list (`fixtures.ts:184-197`), all inside the test's 30 s. | L73: `/map` 3 of 3 fail on vs 3 of 3 pass off; clicks 2-5x slower, navigations 1.2-1.3x; teardown 13-25 s a test, about 27 MB a dump; a passed test lost when the teardown alone reaches 30 s. L66: `Tearing down "_coverage" exceeded the test timeout` in T12-d's final execution; list-results-store 30 s under `run_spec` vs 236 s in the final execution. | **Confirmed** |
| 2 | **Session age.** Each judging execution gets a copy of the last saved session. Login runs at pre-generate (`setup.steps.ts:63`) and pre-execute (`execute.steps.ts:200`) and never again. No execution records the session's age or checks that it is still valid, except `run_spec`, which detects the login wall after the fact and renews (`run-spec.use-case.ts:307-316`, `test-execution/domain/login-wall.ts:12`). | L73: the saved session expires about 90 min after login. For the default rows (diff and context 60 min, manual 45, `run-time-budget.ts:13-17`) no judging execution starts after the deadline, the pre-execute login comes after the deadline is armed, and an execution lasts at most 15 min, so the session's age stays under about 75 min (code). An operator override of `QA_RUN_TIME_BUDGET_MS_*` above that bound (such as the ×5 experiment) lets the coverage phase's executions meet an expired session; they would fail as the test's own failure. | **Confirmed** as a condition; latent in default runs |
| 3 | **Observation on one side of a kill.** A mutant's re-run observes (a request listener, plus an accessible-tree read in teardown inside the test's time); the baseline it is judged against (E2 or E8) does not. A pass lost to the observation's teardown counts as a kill. | Code (`fixtures.ts:647-656`, `bundle-mutation-oracle.adapter.ts:134-139`). Its time cost has not been measured. | Hypothesis |
| 4 | **Retries and tracing.** E2, E4 and E8 retry twice and trace the retries; every other judging execution has no retry. The judged outcome of a case is its first attempt everywhere (flaky means it passed only on a retry), so retries change classification, not the first attempt. The traced retry attempt runs under one more instrumentation. | Code (`runner.ts:972-975`, `playwright.config.ts:27`, `:35`) | Confirmed difference; outcome effect hypothesis |
| 5 | **`run_spec`'s write counter and control child.** Listeners on every request, a ledger rewritten atomically on every DEV write, and a control page load before the spec child. | Code (`fixtures.ts:588-599`, `runner.ts:1120-1135`). L73: 0 DEV writes in all 18 runs, so the counter had nothing to record. | Hypothesis |
| 6 | **Spec scope and order.** E1 runs one file alone (optionally a `--grep` subset); E2 runs the whole suite in path order in one worker; E9 skips tests at runtime inside the files it re-runs. A spec can pass alone and fail after another file's data, or the reverse. Coverage also widens judging executions: the fix loop re-runs the whole suite instead of the failing files when coverage will measure (`fix-loop.aggregate.ts:775-779`). | Code | Confirmed difference; outcome effect hypothesis |
| 7 | **DEV writes between executions.** Data a test created and failed to undo stays on DEV for every later execution. | Code (`fixtures.ts:154-167`, best-effort undo) | Hypothesis |
| 8 | **`page.route` in observation runs.** The unmutated observation registers a route that matches nothing. Playwright documents that routing disables the HTTP cache, so these runs fetch differently from E2. | Playwright documentation; not measured | Hypothesis |
| 9 | **`globalTimeout` 12 min against an instrumented whole suite.** T12-d's final execution took 9.5 min of the seed's 12. Tests the global timeout stops never run. | Code (`playwright.config.ts:31`), L65 | Hypothesis (risk; not observed) |
| 10 | **`--list` runs without the suite's environment.** Top-level code that reads `PW_*` variables enumerates tests differently than the execution does. | Code (`static-gate.checks.ts:104-115`, `exec-env.ts:7`) | Hypothesis |
| — | Namespace | Differs by design. Specs name their data from the `namespace` fixture (`fixtures.ts:95-97`). | Allowed by rule (b): recorded |
| — | Failure capture, `PW_DATA_STATE` | Same in every execution. The capture's waits run only for a test that did not end as expected (`fixtures.ts:673`, `:698-717`). | Allowed by rule (a) |

Out of this ranking (L73): `list-results-store` fails in both arms (DEV environment), and the cuisine `[stubbed: geo…]` test fails in both arms. See "Out of scope".

## First application: coverage

The question is how a run gets its coverage, mutation and survivor signals without an instrumented execution deciding anything.

### Option A: judging executions uninstrumented, one measurement execution

- E1-E8 run with `PW_COVERAGE=0`.
- In the coverage purpose, a new step runs one **measurement execution** (purpose `measurement`): the passing tests of the final bytes, `PW_COVERAGE=1`, retries 0.
- `measure-coverage` reads its dumps alone. Mutants are chosen from them, and each mutant's kill is judged against **this execution's** passes, so both sides of a kill run instrumented.
- After an accepted regeneration, the recount re-measures only the kept spec files, in a measurement execution of their passing tests. A file's dumps are keyed by the fingerprint of its bytes, so a restored file keeps the dumps of the bytes it got back.

**A′ (recommended):** the measurement execution also observes (`PW_OBSERVE=1`) and serves as the first unmutated observation (`-obs`). The mutants, the measurement and the first observation then share every condition, and the `-obs` re-run goes away. The `-obs2` re-run after the last mutant stays.

| | A′ on a T12-d-sized run |
|---|---|
| Time | The final execution runs uninstrumented. Hypothesis: about 2-4 min instead of 9.5, from the per-test figures of L66 and L73 (teardown 13-25 s a test; 5-8x on the map and list pages; the light pages unchanged); to be measured. The measurement execution plus first observation costs about what `-obs` took (11.7 min) and replaces it. Mutants are unchanged (12 min each). Net run time is about 6-7 min shorter, and the verdict arrives about 6-7 min earlier. Fix-loop rounds and acceptances get shorter too, and the fix loop can always filter to the failing files. Pure A, without the merge, adds about 9.5 min of measurement to the coverage phase: net about +2-4 min. |
| Deadline and T39 | The verdict is fixed before the coverage purpose begins. The measurement is held to the coverage allowance like any T39 re-run (estimated from the verdict execution's case durations, scaled once a re-run of the pass has been timed). If it does not fit or is cut, coverage is `unknown` with a typed reason (`measurement-not-run`), which never blocks, under `enforce` too (ADR-0005; amended by L77, ADR-0023 Consequences). The verdict is untouched. A change with no changed code line runs no measurement. |
| Stored outcome and telemetry | The verdict and cases come from E2 (uninstrumented). `gateSignals.changeCoverage` gains `measuredBy { namespace, tests, failedOnlyUnderMeasurement[] }`. The execution span carries `qayaba.exec.purpose=measurement` and every execution span carries the contract's digest and its recorded deviations. `bundleMutation` gains a not-judged reason, `baseline-not-green-under-measurement`. `run_spec_final_agreement` should rise where rank 1 was the cause. |
| Blast radius | `config/e2e/fixtures.ts` (`_coverage`: an explicit on value, its own timeout, de-duplicated dumps); `e2e-execution.runner.ts` (`PW_COVERAGE` explicit on every spawn); `shared-kernel/exec-purpose.ts` (`measurement`); `run-flow/phases/coverage.steps.ts` (the measurement step, `measureGreenRun`, `recountAfter`, `closeSurvivors`); `run-flow/run-steps.ts` and `step-ids.ts`; `domain/fix-loop.aggregate.ts` (`coverageNs`, `coverageReruns`, `bestCoverage` and the `coverageWillMeasure` filter go); `fix-loop.steps.ts`; `regeneration-acceptance.ts` and its result's `reruns`; `review.steps.ts` (E8 split, below); `objective-signal-port.adapter.ts` (sources by fingerprint, the baseline); `bundle-mutation-oracle.adapter.ts` (first observation from the measurement); `objective-signal/application/ports/*` (the measure options); AGENTS.md ("The value/trust risk", "Closed loop"); `docs/observability-design.md`; tests. About 15 source files, most of them deletions of dump bookkeeping. |

### Option B: keep one instrumented execution, make the instrumentation cheap

Remove what can be removed:

- give the coverage fixture's teardown its own timeout, out of the test's time;
- fetch sources and source maps once per script per worker;
- start coverage without block detail where branch data is not needed.

**B cannot guarantee the rule.** The A/B shows the test body itself slowing 2-5x on `/map` (L73). The teardown fixes do not touch that. Playwright's coverage API always starts precise coverage with call counts and block detail, and enables the debugger. A cheaper profile needs a raw CDP session the seed would own, and branch coverage, branch cases and mutant selection need the block counts. A residual slowdown remains, and the size of the instrumented execution's error then depends on the app's script weight. Showing it harmless would take an A/B per app (P5). The verdict would still come from an instrumented execution.

| | B |
|---|---|
| Time | Teardown out of the test's time saves up to the 13-25 s a test; the body stays 2-5x slower on heavy pages. Hypothesis: the final execution at about 6-8 min. |
| Deadline and T39 | Unchanged from today: the measurement and the verdict share one execution, so neither can be cut alone. |
| Stored outcome | Unchanged; failures that only instrumentation causes remain possible and are not visible. |
| Blast radius | The seed fixture, the dump reader (de-duplicated format) and the harvest; about 4 files. |

### Option C: coverage without precise instrumentation

**C1, best-effort coverage taken at teardown.** Run uninstrumented and read V8's best-effort coverage when the test ends (raw CDP, `Profiler.getBestEffortCoverage`). The body runs at full speed; the teardown cost of sources and maps stays. Its counts are per function and may miss collected functions. Line coverage becomes coarse and branch coverage is lost. That changes the meaning of the objective signal and empties branch cases and the arm-first mutant selection. Not recommended (P6).

**C2, judge everything instrumented, but under one condition everywhere.** Turn coverage on in `run_spec` too. It makes the conditions equal, so the rule's letter holds, but every judgment inherits the confirmed distortion: a test that fails only because of the measurement is judged failed everywhere and is regenerated against a phantom. Rejected.

### Mutation when a test fails only under instrumentation

Under A′, such a test passed in the verdict execution and failed in the measurement.

- It is recorded in `failedOnlyUnderMeasurement` with its name.
- It is not part of any mutant's baseline: a kill needs a pass under the same conditions.
- A mutant whose only reaching tests are such tests is not judged, with the reason `baseline-not-green-under-measurement`, and is never counted as survived.
- Its dumps do not credit coverage (open question 5).

The count is also the per-run measurement of rank 1: how many outcomes the instrumentation changed.

### What any instrumented measurement still needs

These hold under A′ as well. A slow measurement is acceptable; one that loses its own data is not.

1. **Its own fixture time.** `_coverage` declares a fixture `timeout` of its own, so its teardown cannot fail or lose a test. Under A′, a test lost to the measurement would also be lost as a baseline.
2. **Dumps de-duplicated per script.** A worker keeps each script's source and source map once, keyed by URL and hash, and a test's dump references them instead of repeating about 27 MB. This is a format change between the seed and the dump reader (`coverage-dump-reader.ts`, `v8-browser-coverage.adapter.ts`). The reader keeps the inline form for stored older fixtures.
3. **`PW_COVERAGE` explicit both ways:** `0` for every judging execution, `1` for the measurement. A stored suite whose `fixtures.ts` predates the change (the fixture defaults to on) still runs correctly, because the orchestrator never relies on the fixture's default.

### E8: the stale re-measure that decides a verdict

`remeasureStaleCoverage` (`review.steps.ts:617-645`) uses one instrumented whole-suite execution both to prove the final bytes green and to measure them. Under the rule these are two executions:

- a judging whole-suite execution under the contract, which decides as today (a red result is the verdict of a passing run; a flaky verdict stands);
- the measurement execution of its passing tests.

## Session age inside the contract

The contract carries the session as a condition: **a judging execution starts with a session the run itself signed in, and its age at the start is recorded.** No age constant decides anything (P3). Validity is checked after the fact, as `run_spec` already does:

- On every judging execution, a failure that ended on the login wall (`endedOnLoginWall`) is not a judgment of the spec.
- The run renews the session through the trusted renewal port (`run-spec.use-case.ts:309-312`) and re-runs that execution once.
- A second login wall ends the run `infra-error` with a typed `session-lost`, never learned from and with no Issue.

**Amended by T41's correction (L77):** the look of a failure page is the trigger of a check, never the fact. As implemented, a failure that looks like the login page asks the run's own check of the session (the orchestrator's browser opens the pages the failing tests asked for with the saved session and applies the authenticated browser's `detectInvalidation`); only a session shown lost is renewed (by the run's own login) and the execution re-run, the re-run being the judgment; a session not shown lost leaves the first result standing; a run that holds no saved session never checks; `session-lost` ends a run only when the re-run meets the login page again and the check shows the freshly signed-in session gone again.

The record then shows the age at which the app's session ended, a fact a later RFC can use.

## Recommendation

**A′ as the first application of one execution contract,** in these units. Each is its own commit, RED test first through the public seam.

| Unit | Change | Risk |
|---|---|---|
| U1 | The contract as one value (`ExecutionConditions`: instrumentation, retries, workers, spec set and order, timeouts, session login time and age, geolocation, namespace, environment profile), built in one place and recorded on every execution span and on the run record. No behaviour change. | item 3 (span attributes) |
| U2 | `measurement` purpose; `PW_COVERAGE` explicit; E1-E8 uninstrumented; the measurement-and-observation execution step; kills judged against its passes; E8 split | items 3 and 6 |
| U3 | Dumps keyed by bytes; the fix loop's and the acceptance's dump bookkeeping deleted; the fix loop filters to the failing files | item 6 |
| U4 | Seed fixture: own timeout, de-duplicated dumps, reader accepts both forms | items 3 and 5 |
| U5 | Session condition: login wall checked on every judging execution, renewal, typed `session-lost` | item 2 (session handling) |
| U6 | Records: AGENTS.md, observability docs, ADR | none |

### Open questions (each with a recommended answer)

1. **Which conditions does the contract fix?** Recommended: instrumentation (none), retries (as below), workers and parallelism (the app's config, never overridden), timeouts (the app's config and one process timeout), environment profile (`suite`), geolocation (the durable one), session (signed in by the run, age recorded), with namespace and spec set recorded under rule (b). Alternative: fix only instrumentation now and record the rest.
2. **Retries.** Recommended: the judged outcome of a case is its first attempt in every judging execution (as today); retries stay only where they classify flakiness (E2, E4 and the judging half of E8), and the traced retry attempt is never read as a judgment. Alternative: retries 0 everywhere, with flakiness judged by a second contract execution (doubles DEV time for a signal the retry already gives).
3. **`run_spec`'s write counter.** Recommended: keep it, since it is a safety bound. A/B it as coverage was (counter on vs off, same specs). Until it is shown neutral, a `run_spec` proof is advice to the author and the lead and never replaces a judging execution, so per-file acceptance executes every changed file. Alternative: count writes in every judging execution, so the condition is shared (it adds a ledger to the suite).
4. **Merge the measurement with the first observation (A′)?** Recommended: yes. It removes one whole re-run and puts both sides of a kill under the same conditions. Alternative: pure A, with the measurement separate from `-obs` (about 10 min more).
5. **Coverage credit from a test that failed only under measurement.** Recommended: none. It ran the code partway and checked nothing (P6). It is listed and counted. Alternative: count its executed lines as covered, but never use it as a mutant baseline.
6. **Re-measurement after an accepted regeneration.** Recommended: re-measure the kept files only, with dumps keyed by bytes, so the recount and the survivor closure read dumps taken under the mutants' conditions. Alternative: mark the coverage stale and re-measure nothing (cheaper; survivor closure is then not judged).
7. **E8 under enforce.** Recommended: split it into a judging whole-suite execution and the measurement. Alternative: drop the whole-suite re-execution and rely on per-file acceptance (smaller, but enforce publishes on bytes no whole-suite execution ran).
8. **Session.** Recommended: the login-wall check, one renewal, one re-run, then `session-lost` (section above). Alternative: sign in again before every judging execution (one login per execution, more DEV traffic, and no fact about the session's lifetime).
9. **Scope and order (rank 6) and DEV writes (rank 7).** Recommended: record them in the contract (spec set, order, the run's DEV writes so far) and decide after a measurement shows an effect. Alternative: run every acceptance with the whole suite (costly, and the order effect stays unproven).
10. **`--list` environment (rank 10).** Recommended: give `--list` the contract's non-secret variables (base URL, namespace, test-id attribute, geolocation), never the session. Alternative: record only.
11. **`globalTimeout` (rank 9).** Recommended: none needed under A′, since the judging executions run uninstrumented; the measurement execution is spawned with a global timeout of its own derived from its allowance. Alternative: drop the seed's `globalTimeout` and rely on the process timeout.

### Review questions (ADR-0001 procedure)

- **P1:** the same bytes get the same judgment whichever execution judges them. Today a pass depends on which execution ran (rank 1, confirmed). The rigid base is the contract; the flexible edge is what a measurement adds and records.
- **P2:** the engine decides every condition; no agent chooses one. The written rule is "The rule" above, to be added to AGENTS.md in U6.
- **P3:** no size or count is compared with a constant. The session is checked by a fact (the login wall), not by an age threshold. The measurement starts when the allowance holds its estimate (T39's rule).
- **P4:** nothing app-specific. The coverage mechanism is Chromium's, the session check is the app-agnostic login-wall rule already used by `run_spec`, and the contract reads only the app's own config.
- **P5:** the confirmed break is shown on one app's pages. The mechanism, a profiler with block counts and a debugger attached, slowing a script-heavy page's main thread, is a property of V8, not of that app. The fix removes the condition rather than tuning it to `/map`. Option B would need a per-app proof, which is why it is not recommended.
- **P6:** a test no longer fails because it was measured, so a sound test is not regenerated against a phantom, and a kill is no longer counted from the measurement's cost. Mutation stays judged under one set of conditions. Coverage can be lost to time (unknown never blocks; enforce holds).
- **P7:** removes `coverageNs`, `coverageReruns`, `bestCoverage`, the acceptance's `reruns`, the `coverageWillMeasure` filter, the `-obs` re-run and the instrumented re-measure's double role. It adds one execution purpose, one contract value and one measurement step. A smaller change considered: B alone; it does not remove the cause.

## Measurement

One replicate per version (S3, ADR-0013). Before: T12-d `run-ed28973-mvwe1bcz-26750e38`. After: the same launch parameters on the engine with U1-U5. Read from the record and the trace:

- the final execution's wall time and per-test durations, against T12-d's 9.5 min;
- `run_spec_final_agreement` (0.4 in T12-d);
- `failedOnlyUnderMeasurement` (its count is the direct measure of rank 1);
- the measurement execution's time and whether it was cut;
- mutants judged, killed and not judged, by reason;
- the coverage ratio and branch arms, against T17 and T12-d (a lower ratio from a cut measurement is `unknown`, not a regression);
- the verdict and the run's total time.

A fix without a measured improvement is reported "unproven" (ADR-0011 rule 3).

## Out of scope

- **DEV no longer renders the `Map` region on `/restaurantes/madrid*`.** `list-results-store` fails with coverage on and off (L73). This is environment.
- **The cuisine `[stubbed: geo…]` test.** It fails the same way in both arms (L73): the test or the app, not the measurement. L66 holds the race hypothesis.
- **The saved session's lifetime.** Separate finding, with its evidence: in the T40 A/B the saved session ended about 90 minutes after login (L73). This RFC takes the session's age into the contract (section above) but does not decide the app's session length or a proactive refresh. By code, no execution of a default 60-minute run outlives a session signed in at pre-execute (rank 2); a run whose budget an operator raises past about 75 minutes can.

# ADR-0023: RFC-0015's answers (one execution contract)

- **Status:** Accepted, 2026-10-31, under the owner's standing rule: each answer is the recommended option, chosen by the agent, not words of the owner
- **Decision source:** the owner's standing instruction of 2026-10-30, "No te detengas más a preguntarme" ([ADR-0015](0015-owner-decisions-2026-10-30.md) point 2), and the owner's words on this finding, 2026-10-31: "Espero que estés identificando y tratando el problema raíz y no para ñame, no solo el cambio de ubicación sino la discrepancia de criterios" (feature document `odd/tasks/root-cause-2026-10-28.md`, L73-L75)
- **Code references at:** 3ac7e10b
- **Related:** [RFC-0015](../rfc/0015-verdict-from-uninstrumented-execution.md), [ADR-0001](0001-design-pillars.md), [ADR-0011](0011-root-cause-fix-policy.md), [ADR-0017](0017-time-authority-answers.md)

## Context

The same spec bytes are judged by several executions of a run (`run_spec`, the final execution, the fix loop's rounds, acceptance runs, mutant and observation re-runs, the enforce re-measure), each under conditions of its own, so a pass meant different things in each. The T40 measurement (L73) confirmed one of them on DEV: with V8 precise coverage on, a test on a script-heavy page failed 3 of 3 runs and passed 3 of 3 without it. RFC-0015 maps every judging execution and its conditions, ranks the breaks by evidence and closes with eleven questions, each with a recommended answer.

## Decision

The rule: **every execution that judges a spec (a verdict, a per-file acceptance, a fix-loop adoption, a mutant's kill) runs under one execution contract; a condition may differ only when it is shown not to change the outcome, or when the execution only measures and its outcome judges nothing.** Coverage is measured in an execution whose only job is to measure.

Every recommended answer of RFC-0015 is taken as written:

| # | Question | Decision |
|---|---|---|
| 1 | What the contract fixes | No instrumentation; retries as in 2; the app's own workers and timeouts; the `suite` environment profile; the durable geolocation; a session the run signed in, its age recorded. Namespace and spec set are recorded, not fixed. |
| 2 | Retries | A case is judged on its first attempt in every judging execution; retries remain only where they classify flakiness, and a traced retry is never read as a judgment. |
| 3 | `run_spec`'s write counter | Kept as a safety bound and measured A/B. Until it is shown neutral, a `run_spec` proof advises the author and the lead and never replaces a judging execution: per-file acceptance executes every changed file. |
| 4 | Measurement and first observation | Merged (A′): one execution measures coverage and is the mutants' unmutated baseline. |
| 5 | A test that failed only under measurement | No coverage credit and no mutant baseline; listed and counted (`failedOnlyUnderMeasurement`). |
| 6 | After an accepted regeneration | Only the kept files are re-measured, dumps keyed by bytes. |
| 7 | The enforce re-measure | Split into a judging whole-suite execution and the measurement. |
| 8 | Session | Every judging execution checks the login wall: one renewal, one re-run, then a typed `session-lost`. Amended (L77): the login wall only triggers the run's own check of the session; a renewal and re-run follow only a session shown lost, and `session-lost` only a re-run whose fresh session is shown lost again. **Amended again (L78), superseding both:** the session's age is recorded, never acted on, until a run shows an execution outliving its session. No execution checks, renews or re-runs for the session, and there is no `session-lost` end. Why: RFC-0015 rank 2 says no execution of a default run can outlive the session (about 75 min of age at most against a lifetime of about 90 min); the loss was seen only in the off-queue T40 harness, 3 h after login; ADR-0001 P7 asks for a failure family before structure is added; and the guard alone produced five defects (L77 B1-B3, L78 N1-N2). Each execution's session age stays on its span and in `gateSignals.executions`. |
| 9 | Scope, order and DEV writes between executions | Recorded in the contract; decided once a measurement shows an effect. |
| 10 | `--list` environment | Given the contract's non-secret variables, never the session. |
| 11 | `globalTimeout` | Unchanged for judging executions; the measurement execution gets a global timeout of its own, derived from its allowance. |

RFC-0015's status becomes Accepted. Its units U1-U6 are implemented as task T41 of the feature document, each its own commit with a RED test first, and the change is measured by one real run against T12-d (RFC-0015, "Measurement"); without a measured improvement it is reported unproven (ADR-0011 rule 3).

## Consequences

- The verdict no longer depends on which execution ran the bytes; a test no longer fails because it was measured, and a mutant is no longer killed by the measurement's cost.
- Coverage can be lost to time without touching the verdict: a measurement cut or not run is `unknown`, under `signal` and `enforce` alike, and `unknown` never blocks (ADR-0005; `DecideCoverageService.blocks` is the one place that says what blocks). Amended (L77): this line said "held under `enforce`", and T41 held the run past `blocks`; the independent verifier showed it held green runs the baseline published (a measurement execution that crashed, a codeless change), so ADR-0005's rule stands. A change with no changed code line runs no measurement execution and records no change-coverage. T33's rule is unchanged: a run deadline that fires with an enforce gate undecided ends the run on its time budget.
- `coverageNs`, `coverageReruns`, `bestCoverage`, the acceptance's `reruns`, the `coverageWillMeasure` filter and the separate `-obs` re-run are removed; one execution purpose, one contract value and one measurement step are added.
- The breaks ranked as hypotheses (observation on one side of a kill, the write counter, scope and order, DEV writes between executions, `page.route` in observation runs, `--list`) are recorded by the contract and decided by measurement, never assumed.

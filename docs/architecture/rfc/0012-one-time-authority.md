# RFC-0012: One time authority for a run

- **Status:** Accepted, 2026-10-30, under the owner's rule of [ADR-0015](../adr/0015-owner-decisions-2026-10-30.md) point 2 (the recommended answer of every question below is taken; [ADR-0017](../adr/0017-time-authority-answers.md) records them)
- **Code references at be6d70f7** (the map was made on that commit; read a line with `git show be6d70f7:<path>`).
- **Implementation:** T33 on `fix/root-cause-2026-10-28`: one clock `f75b0673`; closed `limit.fired` set `662542e7`; allotment by purpose with the measured reserve `d408073c`; deterministic phases cut at the deadline `48c24acc`; caps as upper bounds with typed ends `9f1692fd`; delegated-run and benchmark waits `a5d59333`, `cbb25867`. Correction after the independent verifier: a spent share is that turn's end (`AllotmentSpentError`) and only the run's own deadline ends the run (`242c732e`), so a spent fix share skips the regeneration and the run keeps its `fail` and Issue; a suite proven green is kept whichever post-proof step the deadline meets, steps that start nothing survive it, and an `enforce` coverage gate the deadline left undecided (no measurement, or a stale one) ends the run on its time budget (`318b56c6`, `7322bc2e`, `62ef13f6`); the reserve is measured only from runs of the same budget row that entered a purpose, finished it and were not cut in it, and a purpose no run entered measures 0 only when whole runs with green bytes (or of a kind that executes nothing) passed it over (`e758f2c3`, `c8b13a14`, `ce6f52e2`); the lead's correction turns keep the margin the flows they order need (`63b42e18`: point 5's premise that the lead turn's purpose already holds it back was false, so that margin stays). Deviations: the deterministic phases are cut at the deadline's instant, not at their purpose's allowance (the phases after them depend on what they prove); unmeasured later purposes share one fallback reserve, not one per phase, and the decision holds back only its measured time, never the fallback (publication takes seconds and is never cut; a guessed reserve there only took time from the review); the per-allotment signal exists for the run (the launcher's choke point) while an agent turn's signal is the timeout the transport enforces, because a second signal raced it (contradiction E); no `agent_turns` column was added for the cut purpose (it rides the run limit fact and the root span).
- **Related:** [ADR-0002](../adr/0002-architecture-direction.md) (addition 7, "one time authority"), [ADR-0016](../adr/0016-refactor-review-base-causes.md) (base cause R2, task T33), [ADR-0001](../adr/0001-design-pillars.md) (P1-P7), [ADR-0011](../adr/0011-root-cause-fix-policy.md) (B2'), commit a6a1532b (the agent transport's own deadline removed).

## Summary

1. AGENTS.md says "The deadline is the one time authority". The code has 35 places that decide how long something in a run may take; most do not read the deadline, several duplicate it, and nine pairs contradict: one fires while the other believes time remains.
2. Live evidence: the interim run `run-ed28973-mvv7lrgu-65aff66e` lost 32 of 43 generate minutes to a transport timeout under a 2400 s turn budget (fixed in a6a1532b); T17 `run-ed28973-mvuspjsx-a31b6838` had its review cut by the deadline after coordination's 25 % reserve had been spent by earlier phases.
3. Proposal: the run deadline is the only clock. It allots time by purpose, holds the reserve the later phases need, and every bounded activity runs under a signal derived from it. Every other number either becomes an input to it (a cap a purpose may not exceed) or is deleted.

## The authorities found

The full table with path:line and the nine contradictions are in `odd/tasks/root-cause-2026-10-28-time-authorities.md`. They group as:

| Group | Examples | Relation to the deadline today |
|---|---|---|
| The deadline | `run-time-budget.ts:15-21` (the table), `run-deadline.ts:36-42`, the runtime decorator `run-deadline-runtime.adapter.ts:44-52` | `allowance(purpose)` ignores its purpose; the decorator clamps a turn to all the time left |
| A second clock | `wall-clock-budget.ts:30` (`wallClockBudgetMs`, default 18 cycles × the mode's agent timeout = 90 min in diff) | Independent; above every diff budget, so it never binds by default; its schema comment (`schemas.ts:328-335`) describes a check the code does not make |
| Per-pass budgets | the tier budget (`generate-tests.use-case.ts:207-217`, `diff-stat.ts:56`), dropped when not under the host cap (`generator-time-budget.ts:61`); repair turn 120 s | A snapshot at the pass's start; only the run-level author is bound; ends as `timeCut`, not as the deadline |
| Coordination | `MIN_FLOW_MS`, `MIN_RESERVE_MS`, `RESERVE_SHARE` 0.25 (`lead-sidekicks.ts:79-82`), `leadTurnBudget` (room − 2 × `MIN_FLOW_MS`), the review turn's `min(planBudgetMs, room)`, `planBudgetMs`/`flowBudgetMs` (app config), the per-flow timer of `fan-out-dispatcher.ts:91-95` | Read the deadline at a turn's start; the reserve is not enforced by the runtime, so a long turn spends it; the flow timer and the runtime clamp race |
| Agent runtime | the mode's generator budget and `agentPromptCapMs` (`opencode-client.ts`), the reviewer's 6 min, the stall watchdog 180 s | Defaults for a prompt that states none; the stall watchdog is an activity detector, not a duration |
| Deterministic phases | Playwright suite 900 s (`e2e-execution.runner.ts:33`), static gate 300 s, install 600 s, auth setup 120 s, DOM capture up to 200 s, code-graph build 270 s, dump read 10 s | Ignore the deadline: an execution can overshoot it, and the next turn meets it "before-turn" |
| Tools | `run_spec` per call (reads the deadline at the call's start), the authenticated browser per call | Clamped at the start, with a cleanup reserve for `run_spec` only |
| Callers outside the run | `run-delegate.ts:50` 30 min poll | Shorter than four of the run budgets |

## Proposal

1. **One clock.** `RunDeadline` is the only source of "time left". `wall-clock-budget.ts` and the `wallClockBudgetMs` setting are deleted (the setting retires with a warning, as T14 does for every retired key); `regenerationAllowed` reads the deadline.
2. **Allotment by purpose.** `allowance(purpose)` returns the time left less the reserve held for the phases that still follow that purpose. The purposes are the run's own phases in order (ground, generate, validate, execute, fix, coverage, review, decide); a purpose gets what is left less what the later phases need. Coordination's lead turns, flows and corrections, the run-level author's pass, regenerations, tool calls and deterministic phases all ask the deadline with their purpose; none computes a reserve of its own.
3. **The reserve comes from a signal, not a share (P3).** What a later phase needs is the app's measured duration of that phase in its recent runs (the phase spans the history already stores), read through a port; a phase never measured for the app falls back to today's rule (a quarter of what is left, at least 120 s) until it is. The fallback is the only constant, and it is recorded on the span when used.
4. **Every bounded activity runs under one signal.** The deadline hands out an `AbortSignal` per allotment. The runtime decorator, the fan-out dispatcher's flow timer, a Playwright execution, the static gate, the install, the capture and the code-graph build all run under the smaller of their own safety bound and that signal. A safety bound is kept only where it protects against a hang the deadline would not catch soon enough (the stall watchdog, a dump read); it is an input, named and recorded when it fires.
5. **Per-pass and app-config numbers become caps.** The tier budget, `planBudgetMs`, `flowBudgetMs` and `perCallMs` remain as upper bounds a purpose's allotment may not exceed (the app may want a flow shorter than the deadline allows), never as clocks of their own; a cap that would exceed the allotment is clamped at composition, so the time a turn states is the time it gets. `leadTurnBudget`'s margins are deleted: the lead turn's purpose already holds back what its orders need.
6. **One typed end.** An allotment ended by the deadline ends as `run-deadline` with the purpose that was cut; one ended by its cap ends as that cap (`tier-budget`, `flow-budget`, `plan-budget`, `tool-call`). The turn record and span state which (T32's vocabulary).
7. **Callers outside the run** derive their waits from the longest run budget, as the orphan-session TTL already does (`wire-app.ts:339`).

## What does not change

- The run budget table (`run-time-budget.ts`) and its env overrides: they set the deadline. The tiers that choose its row stay until T22 replaces them with a signal.
  - Amended by [RFC-0014](./0014-diff-tier-signal.md) (T22): the three diff rows became one `diff` row, the tier budget is deleted (the caps that remain are `planBudgetMs`, `flowBudgetMs` and `perCallMs`) and `tier-budget` is no longer produced.
- The deploy gate's wait runs before the deadline is armed (AGENTS.md "Gate").
- A deadline spent after a proven green suite still degrades to `deadline-after-proof`.

## Questions (recommended answers taken, ADR-0017)

1. Cut a deterministic phase mid-way when the deadline runs out, or let it finish? **Recommended: cut it at the deadline.** A phase that overshoots the deadline has no owner of its time; what it proved before the cut is kept by the existing degrade path. Alternative: finish it and refuse the next phase (today's behaviour, contradiction A).
2. The reserve: measured durations or a share? **Recommended: measured, share as fallback** (proposal 3, P3).
3. Keep `wallClockBudgetMs`? **Recommended: delete** (proposal 1); it never binds by default and contradicts the deadline when set.
4. The stall watchdog: delete or keep? **Recommended: keep** as an activity detector with its own typed end; it is not a duration.

## Review questions (ADR-0001 procedure)

- **P1:** identical inputs get identical allotments from identical history; the fallback constant is recorded when used.
- **P2:** the engine decides time; no agent sets or reads a budget except the facts its prompt states.
- **P3:** the reserve reads a measured signal; the remaining constant is a fallback for an absent signal, recorded. The tiers are untouched here (T22).
- **P4:** nothing app-specific; the measured durations are per app, read through a port.
- **P5:** the cause is shown by two runs on different phases (T17 review, interim generate) and by the code map, not by one app's fragment.
- **P6:** a review or execution that keeps its time judges the suite instead of ending `infra-error`; nothing makes a test greener.
- **P7:** removes nine contradictions and about ten independent clocks; adds one port (phase durations) and one signal per allotment. Smaller change considered: clamp each budget at composition only (removes contradiction B and E but not A, C, D, F, I).

## Measurement

The after-measurement T12 reads, from the trace: no turn or phase ended by an authority other than the deadline or a named cap; the reserve's source (measured or fallback) on each allotment span; no phase starting after the deadline is spent.

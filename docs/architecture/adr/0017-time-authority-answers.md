# ADR-0017: RFC-0012's answers (one time authority)

- **Status:** Accepted, 2026-10-30, under the owner's rule of [ADR-0015](0015-owner-decisions-2026-10-30.md) point 2: each answer is the recommended option, chosen by the agent, not words of the owner
- **Decision source:** [RFC-0012](../rfc/0012-one-time-authority.md), questions 1-4; the base cause R2 of [ADR-0016](0016-refactor-review-base-causes.md)
- **Code references at:** be6d70f7

## Decision

1. A deterministic phase (a Playwright execution, the static gate, the install, the capture, the code-graph build) is cut when the run's deadline runs out; what it proved before the cut is kept by the existing degrade path (`deadline-after-proof`).
2. The reserve a purpose holds back for the phases after it is the app's measured duration of those phases in its recent runs; a phase with no measurement for the app falls back to a quarter of the time left, at least 120 s, and the span records which source was used.
3. `wallClockBudgetMs` and `wall-clock-budget.ts` are deleted; the setting retires with a warning.
4. The stall watchdog stays, as an activity detector with its own typed end.

## Consequences

- T33 implements RFC-0012 in that order: one clock (3), allotment by purpose with the reserve's port (2), one signal per allotment including the deterministic phases (1), caps clamped at composition, typed ends.
- AGENTS.md's "Run deadline" and "Effort tier" paragraphs change with the code that changes them.

## Amendments

- 2026-10-30, after T33's independent verifier (recommended options, chosen by the agent under ADR-0015 point 2):
  - To 1: what a phase proved is kept only where no gate is left undecided. A required review with no verdict, or an `enforce` coverage gate with no measurement of the final bytes (none, or one an accepted regeneration made stale), ends the run on its time budget, since publishing would pass the gate unjudged.
  - To 2: the decision holds back only its measured time, never the fallback. Publication takes seconds and is never cut, so a guessed reserve there only took time from the review.
  - To 2: a sample is a run of the same budget row that entered the purpose, finished it and was not cut in it. A purpose no run entered measures 0 only when whole runs with green bytes, or of a kind that executes nothing, passed over it.
  - The run's own deadline and a purpose's share end differently: a spent share ends that turn (its owner's timeout path), and only the run's deadline ends the run.

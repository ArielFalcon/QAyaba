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

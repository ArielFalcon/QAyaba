# ADR-0019: RFC-0014's answers (what replaces the diff tiers)

- **Status:** Accepted, 2026-10-31, under the owner's standing rule: each answer is the recommended option, chosen by the agent, not words of the owner
- **Decision source:** the owner's two standing instructions, quoted from the records. On 2026-10-28: "Las decisiones pendientes no bloqueantes también resuelvelas con tus recomendaciones. Deja todo listo para empezar a implementar" ([ADR-0013](0013-owner-decisions-remaining-questions.md); feature document `odd/tasks/root-cause-2026-10-28.md`, L4). On 2026-10-30: "No te detengas más a preguntarme" ([ADR-0015](0015-owner-decisions-2026-10-30.md) point 2; feature document L26): from then on every open decision takes the recommended option and is recorded in an ADR when it settles an RFC question. The brief's reservation stands for a fork with no recommendation ([ADR-0011](0011-root-cause-fix-policy.md), rule 6); each question below has one.
- **Code references at:** b0402666
- **Related:** [RFC-0014](../rfc/0014-diff-tier-signal.md), [ADR-0001](0001-design-pillars.md) (open question 3 is answered by this record), [RFC-0012](../rfc/0012-one-time-authority.md), [ADR-0017](0017-time-authority-answers.md)

## Context

[RFC-0014](../rfc/0014-diff-tier-signal.md) maps every reader of the diff tier (`DIFF_TIERS`, `qa-engine/src/shared-kernel/diff-stat.ts:41-44`) and proposes to delete it. It closed with eight questions, each with a recommended answer and an alternative. ADR-0001 left the replacement to an RFC ("after the three family slices", open question 3); the slices are done.

## Decision

Every recommended answer of RFC-0014 is taken as written, one row per question:

| # | Question | Decision |
|---|---|---|
| 1 | What bounds a diff run once the tier is gone? | One `diff` row of the run time budget at 60 minutes (today's `diff-broad`); it is a bound on a run that stopped converging, so no signal is read. |
| 2 | The first-pass cap of the run-level author | Deleted (`DIFF_TIME_BUDGET_MS`, `generator-time-budget.ts`, the `timeBudgets` and `promptCapMs` ports). The turn runs under its `generate` allotment, the stall watchdog and the step cap. |
| 3 | The effort rule | One sentence: at most one spec file per affected flow, not a suite rewrite; the affected flows are the use cases the change makes testable that the plan covers. The size sentence stays as a fact. |
| 4 | Operator settings | `QA_RUN_TIME_BUDGET_MS_DIFF` is added. `QA_RUN_TIME_BUDGET_MS_DIFF_TINY\|FOCUSED\|BROAD` keep working for one release with a warning, the largest set value applying when the new name is unset. `QA_DIFF_TIME_BUDGET_MS_TINY\|FOCUSED\|BROAD` retire with a warning (`src/settings/retired.ts`). |
| 5 | History continuity | `recentPhaseRecords` for `diff` also reads the rows stored as `diff-tiny`, `diff-focused` and `diff-broad`; no stored value is rewritten. |
| 6 | `tier-budget` in the closed limit vocabulary | Kept, marked no longer produced; removed with the epoch that prunes the old data. |
| 7 | The benchmark's declared tier | Kept as the operator's own label; the type moves into `scripts/efficiency-benchmark.ts`. |
| 8 | Flow capacity | Unchanged: a ceiling, not a quota; revisited only if the measurement shows planned flows beyond the candidates and their drops. |

RFC-0014's status becomes Accepted. ADR-0001's open question 3 is answered: the signal that replaces the tier thresholds is none for the run's bound and the first-pass cap (a safety bound is not an estimate), and the candidates the plan covers for the effort rule.

## Consequences

- T22 implements RFC-0014 in the order U1, U2, U3, U4; U2 and U3 change settings others consume and ship in their own commits (Risk item 3: a config contract others consume).
- AGENTS.md rows `:179`, "Effort tier" and "Run deadline" change with the code that changes them (U4).
- The runs after U3 form a new epoch: the `time_budget` label and the effort sentence differ. One replicate per measurement (S3); a direction, not proof. No `tiny` or `focused` baseline exists in the records, so the first replicate of a small change is taken on the unchanged head.
- The operator's `.env` files and `docker-compose.override.yml` pass-through lines are the owner's data; the warnings name the replacement.

## Enforcement

The RED tests of RFC-0014's work units, each added with the commit that lands it; the banned term of U4 in `npm run previous-forms:check`.

## Alternatives considered

Each question's alternative, as RFC-0014 states it, set aside by the standing rule.

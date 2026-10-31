# ADR-0018: Owner decisions on RFC-0013

- **Status:** Accepted, 2026-10-31, under the owner's standing instructions (quoted below); the answers are the recommended ones, chosen by the agent under them, not words of the owner on these questions
- **Decision source:** the owner's two standing instructions, recorded in `odd/tasks/root-cause-2026-10-28.md` (L4, L26) and in [ADR-0013](0013-owner-decisions-remaining-questions.md) and [ADR-0015](0015-owner-decisions-2026-10-30.md) point 2:
  - 2026-10-28 (L4), verbatim: "Las decisiones pendientes no bloqueantes también resuelvelas con tus recomendaciones. Deja todo listo para empezar a implementar" (translated: "Also resolve the non-blocking pending decisions with your recommendations. Leave everything ready to start implementing").
  - 2026-10-30 (L26), verbatim: "No te detengas más a preguntarme" (translated: "Do not stop to ask me any more"): from then on every open decision takes the recommended option, recorded in the feature document, and in an ADR when it settles an RFC question.
- **Code references at:** b0402666
- **Related:** [RFC-0013](../rfc/0013-learning-slice.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0009](0009-campaign-freeze-on-server.md), [ADR-0008](0008-product-version-source.md), [ADR-0011](0011-root-cause-fix-policy.md), [ADR-0001](0001-design-pillars.md)

## Context

[RFC-0013](../rfc/0013-learning-slice.md) (task T20) designs the learning slice that ADR-0003 (D1-D4, D14) and ADR-0009 (D10) left to it, and closes with thirteen open questions, each with a recommended answer. ADR-0013 (Correction 2026-10-29) had left two of ADR-0009's points "decided when T20 lands": what the learning arm lifts, and whether `QA_CAMPAIGN_FREEZE` stays.

## Decision

Every recommended answer of RFC-0013 is accepted as written; RFC-0013's status is Accepted.

| Q | Decided |
|---|---|
| 1 | Observations only: migration 0007 adds the append-only `lesson_observations`; a lesson is derived at read, never stored; `learning_rules` is not reused |
| 2 | Every run, frozen or not, writes its observations; only a run whose lessons lever is on reads them |
| 3 | The first kind is per page; an operation kind waits for a surviving page kind |
| 4 | A data-state failure is `dataStateDiffers` (`qa-engine/src/contexts/run-orchestration/domain/failure-data-state.ts:35-41`) for a failed case or call in a delivered lesson's scope, recorded per run |
| 5 | `data-volatility` admits the served states `equal` and `ahead`; every other state is left out as `served-version:<state>` |
| 6 | One cycle is one frozen and one learning replicate of the same commit and snapshot; a direction, never proof |
| 7 | Improvement: data-state failures lower and calls-to-green not higher over the covered flows, with mutants killed, change-covered lines on the final bytes and defects found not lower; never green |
| 8 | A counted cycle without improvement deletes the kind's code (observations stay); an `unproven` cycle repeats; no counted cycle by the end of platform step 6 deletes it (OD-19) |
| 9 | The learning arm is `grounding.lessons` on the run request; absent means on for a run without `campaign` and off for a campaign-tagged one; it lifts the lesson state only, and the replicate isolation and the process audit stay withheld on every campaign-tagged run |
| 10 | `QA_CAMPAIGN_FREEZE` goes with the server-side freeze (unit U1) and joins the retired list; a frozen service-triggered run needs a `campaign` field on the webhook payload (see the note below: superseded 2026-10-31) |
| 11 | Lessons reach a flow's brief as `knownFacts` of a new `lesson` evidence kind, bounded by the window-fit rule; the header at `coordination-context.ts:1` is reworded |
| 12 | `learning_rules`, `curriculum`, `scorecard` and the `run_outcomes` columns `rules_retrieved` and `reflection` are dropped in their own migration (U5), after a copy of the history file |
| 13 | The process audit's second admission (`observesOperatingSignal`) and the context-heal disposition stay as they are |

Note 2026-10-31 on row 10: the webhook payload does not get a `campaign` field. The decision recorded when T20 landed is that a campaign run comes only through the control API and a webhook run is never a campaign run, so a service-triggered run is never frozen. The row's text above is kept as it was decided; `docs/observability-design.md` states the rule as it stands.

Note 2026-10-31 on rows 7 and 8: the cycle's verdict is read pair by pair. Each counted pair is judged on its own, a counted pair without improvement makes the campaign's verdict `not-improved`, else a counted pair makes it `improved`, and it is `unproven` only when no pair counts; runs that pair with nothing and pairs that cannot be compared are listed and decide nothing.

This settles ADR-0009's two points left to T20 (Q9 and Q10) and ADR-0003's "Not decided here" items on the lesson entity and storage, the stand-ins, the vehicle, "bounded size", the data-state failure, the replicates of "one cycle", "improvement" and the process audit's second admission.

**Note, 2026-10-31 (T13 U7, roots renamed):** the deletion of the lesson kind (row 8) is deferred to after the final run, under the owner's standing instruction to take the recommended option and record it (ADR-0015, point 2). It changes the grader catalog the API serves and `GRADER_VERSION` (a contract others consume), and the next counted cycle starts with that run, so the kind stays until that cycle has its answer.

## What this does not grant

[RFC-0001](../rfc/0001-dormant-features.md) OD-11's live service-triggered run (RFC-0013 unit U6) needs the owner's authorization of the repository, the sha and the credential. [ADR-0013](0013-owner-decisions-remaining-questions.md) (Correction 2026-10-30) records the owner's words "tienes permiso para hacerlo cuando necesites" ("you have permission to do it when you need to") for ms-name-restaurants at 3d8f63de, after D10 lands. It names no credential. This record neither renews nor widens that permission and authorizes no credential; U6 does not launch until the credential is authorized and U1 has landed. The cycle's replicates are launched on the owner's go, as T12 is (feature document, S3).

## Consequences

- U1 changes a deliberate guard of ADR-0009: the campaign identity now changes what a run does; variant labels stay inert, the rule keys on the presence of `campaign` and an explicit lever (`docs/observability-design.md:1089` and `src/server/runner.ts:88` are rewritten with it).
- The persisted format changes twice (U2 adds a table, U5 drops three tables and two columns); both are additive or empty-data, and the history file is copied before U5.
- Runs before U2 carry no lesson fact; a comparison across that point states the epoch break.

## Enforcement

The RED tests of RFC-0013 "Work units", each added with the commit that lands its unit (feature document, T20): the freeze through the create-run use case and `enqueueTrackedRun`, the admission through the lesson kind's public seam (the same fact admitted in runs ending pass, invalid and flaky, a left-out read with its typed reason), the delivery through `assembleSidekickBrief`.

## Alternatives considered

Each question's alternative, as RFC-0013 states it (a stored `lessons` table, reuse of `learning_rules`, `equal`-only admission, frozen runs that write nothing, a freeze that stays a process switch), set aside by the standing instructions above.

**Correction, 2026-10-31 (CP4 records review, C):** row 11 says the header at `coordination-context.ts:1` is reworded to say what it protects. That header no longer exists: `112d3d2a` (T13 U2) deleted the retired coordination evidence seam, and `coordination-context.ts` now starts with the `AcceptanceCriterion` type. The lesson evidence kind (`EvidenceKind` `lesson`, `lessonFactsOf` in `lead-sidekicks.ts`) is live. See the correction at the end of [RFC-0013](../rfc/0013-learning-slice.md).

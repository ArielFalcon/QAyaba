# RFC-0013: The learning slice: one lesson kind, a server-side freeze, a kill criterion

- **Status:** Accepted, 2026-10-31, under the owner's rule of [ADR-0015](../adr/0015-owner-decisions-2026-10-30.md) point 2 (the recommended answer of every question below is taken; [ADR-0018](../adr/0018-owner-decisions-rfc-0013.md) records them)
- **Code references at b0402666** (read a line with `git show b0402666:<path>`); `LEARN` = `qa-engine/src/contexts/cross-run-learning`.
- **Related:** [ADR-0003](../adr/0003-learning-layer-rebuild.md) (D1-D4, D14), [ADR-0008](../adr/0008-product-version-source.md), [ADR-0009](../adr/0009-campaign-freeze-on-server.md) (D10), [ADR-0013](../adr/0013-owner-decisions-remaining-questions.md) (Correction 2026-10-29), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [ADR-0001](../adr/0001-design-pillars.md), [RFC-0001](./0001-dormant-features.md) (members 1.3, 1.6, 1.13, 1.14, 7.1, 7.2; OD-10, OD-11, OD-19), [RFC-0002](./0002-platform-steps-0-1.md) (Q7)
- **Task:** T20 of `odd/tasks/root-cause-2026-10-28.md` (spec S4).

## Summary

1. Step 1 deleted the rule loop, the reflector and the curriculum. What is left of `LEARN` is 293 lines: the gates and the process audit. No lesson exists, so the freeze that isolates a learning arm has nothing to isolate, and the frozen arm is still not enforced by the server (0 of 31 campaign-tagged runs were frozen, ADR-0009).
2. Proposal: (a) the server freezes every campaign-tagged run by one function of the request, before any lesson code runs; (b) one lesson kind, DEV data volatility per page, stored as append-only observations from which the lesson is derived at every run, never stored; (c) every run is input and a left-out run carries a typed reason; (d) delivered to the brief of the flows whose pages the lesson names; (e) judged by one frozen replicate against one learning replicate, and deleted when a counted cycle shows no improvement.
3. Both preconditions have landed: ADR-0008 as `gateSignals.servedVersion` (T19, `qa-engine/src/shared-kernel/served-version.ts:9`) and, with this slice's first unit, ADR-0009.

## Problem

### What exists at b0402666

| Part | State | Evidence |
|---|---|---|
| Gates | One consumer, the process audit, keyed by the run's verdict and class: `audit: distill && verdict !== "flaky" && teaches` | `LEARN/domain/learning-gates.ts:31-35`; called at `run-flow/decided-end.ts:382`, `finalize-run.ts:244` |
| Rule, curriculum and scorecard tables | Created by schema 1, no reader and no writer; the repository only empties them on app purge | `src/server/persistence/migrations/0001-initial.ts:228-262`, `src/server/persistence/repositories/learning.repository.ts:8,29` |
| Outcomes | `run_outcomes`, one row per run, append-only; `rules_retrieved` and `reflection` columns unused | `0001-initial.ts:80-92`, `learning.repository.ts:17-20` |
| The raw fact of the first kind | Per captured page: `dataState`, `ready`, `resultExpected`, `resultCount`, `emptyConfirmed`; only a span attribute (`qayaba.route.result_count`, `qayaba.route.empty_confirmed`) | `qa-engine/src/contexts/generation/domain/route-snapshot.ts:72-81`, `generation/infrastructure/dom-capture-trace.ts:40-42` |
| What the run keeps of those reads | Only pages read with results: `confirmedDataRoutes` drops `resultCount <= 0`; an empty-confirmed page is not in the run state or in the outcome | `generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts:246-257`, `run-orchestration/application/run-flow/run-state.ts:72` |
| A data-state failure | `dataStateDiffers(case, confirmed)`: a settled failure capture read an empty state on a page the pack read with results, or another count than the pack's. One consumer, the flaky triage; nothing records it per run | `run-orchestration/domain/failure-data-state.ts:35-41`, `flaky-triage.ts:20` |
| Delivery vehicle | `DelegationBrief.knownFacts` renders as "Known facts"; `knownFactsOf` already filters the pack's data routes to a flow's own pages; `EvidenceKind` is a closed union without a lesson kind | `coordination/application/lead-sidekicks.ts:712,1502-1505`, `coordination-sections/brief-sections.ts:158-159`, `evidence-ref.ts:2-12` |
| Served version | Six states on every run, in `gateSignals.servedVersion` | `shared-kernel/served-version.ts:9`, `run-outcome.ts:103`, `outcome-assembly.ts:128,168` |

### The freeze today: one switch, five readers, one client-side guard

`QA_CAMPAIGN_FREEZE` is read through `resolveCampaignFreeze` (`src/server/campaign-freeze.ts:11`) by: the engine factory once per run (`run-engine-factory.ts:645`: no process audit at `:1279`, suite store read-only at `:1308`, no context-heal request at `:676` and `:691`, `recapture: "skipped"` at `:973`); the boot wiring of the runner's two pre-run steps (`login-bootstrap-wiring.ts:9`, `context-map-wiring.ts:35`, consumed at `runner.ts:370` and `:758`, wired at `wire-app.ts:238,241`); the record (`settings.ts:231`, `wire-app.ts:299`, `effective-config.ts:59`); the telemetry handle (`bootstrap.ts:155`). The only guard is the launcher's (`scripts/campaign.ts:264-266`), which a hand-built `POST /runs` bypasses (ADR-0009). The factory receives no campaign identity (`runner.ts:108-115`, the `run` argument), so a per-request decision needs a new field on it.

### What the records leave to this RFC

ADR-0003 "Not decided here": the lesson entity and its storage, the vehicle and the kind of a lesson fact, "bounded size", the definition of data-state failure, replicates per "one cycle", "improvement", the fate of the process audit's second admission. ADR-0009: how the learning arm is spelled and what it lifts; ADR-0013 (Correction 2026-10-29) recommends "only the lesson state" and that the switch goes with the freeze, "decided when T20 lands". RFC-0001 7.1: the learning precondition "per run, by lesson kind".

### What this does not explain

Whether the lesson helps. The kind is a hypothesis with a kill criterion; no run shows today that a lesson changes a flow's calls-to-green or its data-state failures (no ablation exists, ADR-0003).

## Goals and non-goals

- Goals: the frozen arm cannot be bypassed from any door; one lesson kind, derived from facts, no LLM (D4); every run is input and every exclusion is a typed, countable reason (D14); the lesson reaches only the flows it covers (D3); a measured verdict that can delete the kind.
- Non-goals: business-logic lessons (ADR-0003); an operation-level kind (Q3); changing the replicate count (ADR-0011); the live service-triggered run's authorization (OD-11, below).

## Options

| Option | Removes | Adds | Risk |
|---|---|---|---|
| O0. Freeze stays client-side; lessons later | nothing | nothing | the frozen arm of the first measurement can be bypassed, as the baseline's was |
| O1. A `lessons` table (kind, scope, text, status) beside observations | nothing | a second store that can drift from the facts, the failure ADR-0003 names ("no SHA, no expiry, no check") | a stored lesson outlives its facts |
| O2. **Observations only; the lesson is derived at read** | the table that can go stale | one append-only table | recomputation cost per run (a read of one app's rows for the pages the run captured) |
| O3. Reuse `learning_rules` | one migration | `trigger_text`/`action_text`/`confidence`/`success_rate`/`quarantined_at` columns shaped for free-text rules (`0001-initial.ts:228-246`) and a key of app alone | the rule loop's shape returns |

## Recommendation

**O2, with the server freeze first.** The smallest change that gives a lesson an anchor, an expiry-by-construction and a check: it is a function of stored facts. App-agnostic: the kind reads only what an app declares (`dev.dataState`, ADR-0003 D4: "silent where an app declares none").

### 1. The freeze (unit 1, before any lesson code; ADR-0009 D10)

One function of the request, `frozen = request.campaign !== undefined`, and `lessons = request.grounding?.lessons ?? (request.campaign === undefined)`. A campaign-tagged run is frozen (suite store read-only, no context-heal request, no automatic login bootstrap, no map rebuild ahead of the run, no process audit) whatever the process environment says; a run without `campaign` is unchanged (ADR-0009 decision 1 and the last "Not decided" bullet). The declaration lifts the lesson state only (Q9, ADR-0013). The decision is taken in `enqueueTrackedRun`, recorded as `effectiveConfig.campaignFreeze` (replacing `effective-config.ts:59`), handed to the factory as a new field of its `run` argument, and read by the two pre-run steps per request (their boot-time `resolveCampaignFreeze` early returns go; the closures are always wired). `QA_CAMPAIGN_FREEZE`, `settings.run.campaignFrozen`, `campaign-freeze.ts`, the launcher check at `scripts/campaign.ts:264-266` with `--skip-env-checks` (`:218`, `campaign-model.ts:149-150`) and the report field (`campaign-report.ts:61-62`) are deleted; the variable joins `src/settings/retired.ts` so a set value warns (ADR-0013: "if an experiment needs a frozen service-triggered run, the webhook payload gets a campaign field rather than the switch staying").

### 2. The lesson entity and its storage (Q1, Q2, Q3)

Migration 0007 adds `lesson_observations` (append-only): `id`, `app`, `run_id`, `sha`, `repo`, `kind`, `scope` (the captured route address; the template when the page came from one), `served_state`, `admitted` (0/1), `left_out_reason` (typed, null when admitted), `fact` (JSON: `resultCount`, `emptyConfirmed`, `ready`), `at`. Indexed by `(app, kind, scope)`. The kind is a registry entry in `LEARN/domain/lesson-kinds.ts` that declares: the facts it reads, the served-version states it admits, and a pure `derive(observations) => Lesson[]`. A lesson is `{ kind, scope, statement facts (admitted reads: n with results, m empty-confirmed, time of the latest read), evidence ids }`, produced only when the admitted reads of the scope show both states (volatility), with no count threshold (P3). The ground step derives lessons from observations strictly before the run's start, so identical stored inputs give identical lessons (P1). Every run, frozen or not, writes its observations: they are facts about DEV, like `run_outcomes` (appended for every run, `learning.repository.ts:17-20`), and writing changes nothing the run does; only a run with `lessons` true reads them. Delivered lessons are recorded on the run as `gateSignals.lessons { delivered[{kind, scope, digest}], observed, leftOut: {reason: n}, dataStateFailures }`.

### 3. The data-state failure (Q4) and the exclusions that keep it out of lessons

A data-state failure is `dataStateDiffers` (`failure-data-state.ts:35-41`) true for a failed case or `run_spec` call whose route is in a delivered lesson's scope: two settled reads of one page in one run disagree. It is recorded per run (`gateSignals.lessons.dataStateFailures`) and is the measure, not an input to a lesson. A run whose DEV data state was empty is not removed: its page read is an admitted observation (`emptyConfirmed`), which is what the lesson states. What is left out is a read that cannot be trusted, each with one typed reason: `served-version:<state>` (Q5), `no-data-state` (the page matched no `dev.dataState`, so `snap.dataState` is undefined), `unconfirmed-read` (a result expected and the count unread, or 0 without the two settled reads: `route-catalog.ts:86-89`), `not-captured` (the route is listed as not capturable). The verdict, the error class and the adjudication of the run never decide admission (D14): a fact read in a run that ended pass, invalid or flaky is admitted in all three. The unmet-by-DEV-state backing (`qa-engine/src/contexts/coordination/application/dev-state-backing.ts:48`, "the flow's browser session was shown <path>") is not an input (ADR-0003 D4).

### 4. The learning precondition per kind (Q5)

`data-volatility` admits `equal` and `ahead` and leaves out `behind`, `unrelated`, `unreadable` (with its typed reason) and `undeclared`, each as `served-version:<state>`. `equal`: DEV serves the run's commit. `ahead`: DEV serves a descendant, so it contains the commit under test (hypothesis: the data a route returns does not depend on later code; the smaller alternative, `equal` only, is Q5's other option). `behind` serves code older than the change, `unrelated` has no ancestry, the rest give no state to compare. The kind reads the anchor repo's fact; companions are not read (the pages are the anchor app's). Until an app declares a version source every run of it is `undeclared` and the kind admits nothing: a typed fact, never silence (ADR-0008 consequence: the product-side change is on the critical path).

### 5. Delivery (D3, Q11)

Lessons enter `knownFactsOf` as facts of a new `EvidenceKind` `lesson`, filtered to the flow's pages exactly as the pack's data routes are (`lead-sidekicks.ts:1502-1505`), verified because the engine derived them from stored observations. "Bounded size" is the window-fit rule: one line per lesson, degrading to a count when the brief does not fit, never a constant cut. The header at `coordination-context.ts:1` is reworded to say what it protects (the coordinator projection), as ADR-0003 D3 found nothing there blocks the author brief. The lead and reviewer prompts get nothing.

### 6. Measurement, improvement and the kill criterion (Q6, Q7, Q8)

One cycle is one frozen replicate and one learning replicate (`grounding.lessons: true`) of the same commit, same 12-entry snapshot, same launch parameters (ADR-0011 conditions, S3). One against one shows a direction, never proof (ADR-0011 Consequences). The comparison reads, over the flows whose pages a delivered lesson covers: (1) data-state failures, (2) `run_spec` calls-to-green per spec (per-call spans `qayaba.tool.run_spec`, `qayaba.spec.path`, `qayaba.tool.outcome`, `attribute-registry.ts:443,452`, read at `src/server/evaluation-evidence.ts:178-181`); guards, which must not worsen: mutants killed, change-covered lines on the final bytes, defects found. Improvement: (1) lower and (2) not higher, and no guard lower, in the learning arm. A cycle counts only if a lesson was delivered and at least one arm shows a data-state failure or a spec that needed more than one call; otherwise it is `unproven` (the trigger did not occur, ADR-0011) and repeats. A counted cycle without improvement deletes the kind in one commit: its registry entry, derive function, delivery and grader; the observations stay (they are facts and the raw material of any later kind). RFC-0001 OD-19 still applies: no counted cycle by the end of platform step 6 deletes it too. The criterion is written into the slice's feature document before unit 3 lands (ADR-0003 Enforcement D4).

### 7. Where each piece lives

| Piece | Home |
|---|---|
| Kind registry, `derive`, admission, exclusion reasons (pure) | engine, `LEARN/domain/lesson-kinds.ts`, `data-volatility.ts` |
| Ports `LessonObservationPort` (record, list for scopes) and the use cases that record and derive | engine, `LEARN/application/ports`, `LEARN/application`; wired in `LEARN/composition/build-cross-run-learning.ts` |
| The page reads reach the run | engine, the pre-generation grounding result gains the pages' reads (beside `packConfirmedDataRoutes`, adapter `:452-453`); written at the ground step (`run-flow/phases/ground.steps.ts`) |
| `lesson` evidence kind and `knownFactsOf` | engine, `coordination` |
| Data-state failure and calls-to-green graders | engine, `evaluation` (new grader, `GRADER_VERSION` bump) and `scripts/campaign-compare.ts` |
| Table, repository | platform, migration 0007, `src/server/persistence/repositories/lesson.repository.ts` |
| The freeze function, the `grounding.lessons` lever, retired variable | platform, `src/server/run-freeze.ts` (replaces `campaign-freeze.ts`), `src/contract/commands.ts` (`GroundingInputSchema`, `:158-161`), `create-run.ts`, `effective-config.ts`, `src/settings/retired.ts` |

### Review questions (ADR-0001 procedure)

- **P1:** lessons are a pure function of stored observations before the run's start; the freeze is a function of the request; the frozen arm reads nothing.
- **P2:** the engine derives and verifies; an agent receives a fact line and decides nothing about it; no LLM produces a lesson (D4).
- **P3:** no size or count threshold: a lesson exists when the admitted reads show both states; admission reads the served-version state and the capture's own confirmation flags; the verdict is never read.
- **P4:** nothing app-specific: the kind reads `dev.dataState`, which an app declares; silent where none is declared (declared scope).
- **P5:** the gap is shown by the code (`learning-gates.ts:34`, the four-run table of ADR-0003 on one page) and by 0 of 31 frozen runs; the mechanism does not depend on the page that showed it. The effect of a lesson is a hypothesis until a cycle runs.
- **P6:** the measure is objective signals (kills, change coverage on final bytes, defects found, data-state failures), never green; a lesson that only makes a test pass is not improvement by Q7.
- **P7:** removes the process switch and its five readers, the launcher guard, three dead tables (Q12); adds one table, one lever, one kind. Smaller change considered: store lessons (O1), rejected because it recreates the drift; `equal`-only admission (Q5).

## Work units, in order

| Unit | Content | Tests (RED first, through the public seam) | Risk |
|---|---|---|---|
| U1 | The server freeze: `run-freeze.ts`, the lever, per-request pre-run steps, record, retired variable, launcher cleanup, docs (`AGENTS.md`, `docs/efficiency-benchmark.md`, `docs/observability-design.md:1089`, `runner.ts:80`, settings regenerated, contract regenerated) | The create-run use case and `enqueueTrackedRun`: a request with `campaign` and no lever records `campaignFreeze` true and builds no process audit; with `grounding.lessons: true` it records true and still keeps the isolation; one without `campaign` is unchanged; on a process whose old variable is unset, a frozen request for an app with no verified login and a stale map queues no bootstrap and no rebuild (ADR-0009 Enforcement); a set `QA_CAMPAIGN_FREEZE` warns. Differential check: non-campaign requests identical to the base | item 3 (the record and the lever others read), item 4 not touched; own commit |
| U2 | Migration 0007, repository, kind registry, `derive`, admission with typed reasons, ground-step recording | ADR-0003 D14: the same data-state fact in runs ending pass, invalid and flaky is admitted in all three; a left-out read carries its reason; each of the six served states maps to admit or its reason; two runs with the same stored rows derive the same lessons; schema 6 history adopts with no row rewritten | item 1 (persisted format, additive); own commit |
| U3 | Delivery: `lesson` evidence kind, `knownFactsOf`, brief section, `gateSignals.lessons`, reworded header | `assembleSidekickBrief`: the lesson is in the brief of the flow whose pages it names and in no other; `coordination-seam.contract.test.ts:74-98` and `coordination-evidence.contract.test.ts:25-51` stay green; a brief over its window degrades to a count | none beyond tests |
| U4 | The data-state-failure fact and grader, calls-to-green read, `campaign-compare` section, the kill criterion in the feature document | The fact is recorded for a case whose failure read an empty settled state on a page the pack read with results, and not for an unsettled one; the comparison on two fixture campaigns returns improved, not improved and `unproven` | none |
| U5 | Dead tables: migration 0008 drops `learning_rules`, `curriculum`, `scorecard` and the two `run_outcomes` columns; `deleteApp` loses them (`learning.repository.ts:29`) | A purge still empties the remaining tables; a schema-7 database migrates | item 1 (stored data, 0 rows in `learning_rules`; `curriculum` and `scorecard` rows are dead); own commit, after a copy of the history file |
| U6 | OD-11: one live service-triggered run in shadow mode, after U1 so it is frozen when a campaign is declared; then one cycle (Q6) | Live; the evidence is the runs and their records | owner's authorization, below |

## Patches it supersedes

`campaign-freeze.ts`, `settings.run.campaignFrozen` and its registry entry (`registry.ts:102`), the two boot-time early returns (`login-bootstrap-wiring.ts:9`, `context-map-wiring.ts:35`), `bootstrap.ts:155`, the launcher check (`scripts/campaign.ts:264-266`), the claim at `runner.ts:88` that the campaign identity cannot change what a run does; after U5, the three tables.

## Measurement

Before: 0 of 31 campaign-tagged runs frozen, the lesson state empty. After U1: every campaign-tagged run records `campaignFreeze` true unless it declares `grounding.lessons`; after U2-U3: `gateSignals.lessons.leftOut` counts by reason on every run (an app with no version source shows all reads left out as `served-version:undeclared`); after U6: one cycle's comparison as Q7. Runs before U2 have no lesson fact: an epoch break for the comparison.

## Open questions (recommended answers taken, ADR-0018)

1. Lesson storage? **Recommended: O2**, observations only (migration 0007), lesson derived at read; not `learning_rules`, not a `lessons` table.
2. Do frozen runs write observations? **Recommended: yes**; they never read lessons. Observations are DEV facts, not state that changes the run; 31 of 34 historical runs were campaign runs and would otherwise never feed a lesson.
3. Page or operation? **Recommended: page only** in the first cut (the fact exists per captured page); an operation kind (item counts of `DataShape`) only if the page kind survives a cycle.
4. What is a data-state failure? **Recommended: `dataStateDiffers` (`failure-data-state.ts:35-41`)** on a failed case or call in a delivered lesson's scope, recorded per run; the backing sentence of `dev-state-backing.ts:48` is not read.
5. Served states `data-volatility` admits? **Recommended: `equal` and `ahead`**; the rest left out with `served-version:<state>`. Alternative: `equal` only.
6. Replicates per arm? **Recommended: one frozen and one learning replicate per cycle**, same commit and snapshot (S3, ADR-0011); a direction, not proof.
7. What is improvement? **Recommended:** data-state failures lower and calls-to-green not higher over the covered flows, and mutants killed, change-covered lines on the final bytes and defects found not lower. Never green.
8. Kill criterion? **Recommended:** a counted cycle without improvement deletes the kind's code; observations stay; an `unproven` cycle repeats; no counted cycle by the end of platform step 6 deletes it (OD-19).
9. How is the arm spelled, and what does it lift? **Recommended: `grounding.lessons` (boolean) on the run request**, beside `stitcher` and `domPack`; absent means on for a run without `campaign` and off for a campaign-tagged one; it lifts the lesson state only. The suite store stays read-only, the map is not rebuilt, no login bootstrap, and the process audit stays withheld on every campaign-tagged run (my reading of ADR-0013's "only the lesson state": the audit sets `context_stale`, whose effect is the map rebuild at `run-engine-factory.ts:676`).
10. Does `QA_CAMPAIGN_FREEZE` stay? **Recommended: no**; it goes in U1 and joins the retired list. A frozen service-triggered run needs a `campaign` field on the webhook payload.
11. Delivery vehicle and "bounded size"? **Recommended: `knownFacts` with a new `lesson` evidence kind**; one line per lesson, window-fit degradation to a count; reword the header at `coordination-context.ts:1`.
12. The dead tables? **Recommended: drop `learning_rules`, `curriculum`, `scorecard` and the two `run_outcomes` columns in U5** (RFC-0002 Q7 kept them at step 1 only); history file copied first.
13. The process audit's second admission (`observesOperatingSignal`, `learning-gates.ts:42-44`) and context-heal? **Recommended: unchanged**: class-keyed and observe-only, because a streak of time-budget endings is about the ending, not a lesson; context-heal stays with T27.

## Out of scope

Business-logic lessons; operation-level kinds; delivery to the lead and the reviewer; changing the replicate count; the authorization of OD-11's live run, which stays with the owner (ADR-0018).

**Correction, 2026-10-31 (CP4 records review, C):** four statements above name things that do not exist at 3ee3235d or contradict the accepted answers.

- "Measurement" says every campaign-tagged run records `campaignFreeze` true "unless it declares `grounding.lessons`". It does not: a campaign-tagged run is always frozen, and the declaration lifts the lesson state only (Q9, [ADR-0018](../adr/0018-owner-decisions-rfc-0013.md); `decideRunFreeze` returns `{ frozen: campaignTagged, lessons: request.grounding?.lessons ?? !campaignTagged }`; `recordRunConfig` records both facts, `recorded-run-config.ts:84`).
- Section 7 and U3 cite the header at `coordination-context.ts:1`, `coordination-seam.contract.test.ts:74-98` and `coordination-evidence.contract.test.ts:25-51`. `112d3d2a` deleted the header (the file no longer has one) and `coordination-evidence.contract.test.ts`; `coordination-seam.contract.test.ts` stays, with lines that moved.
- Section 7 names the port `LessonObservationPort`; the port is `LessonStorePort` (`cross-run-learning/application/ports/lesson-store.port.ts`), with the use cases `record-lesson-observations.ts` and `derive-lessons.ts`.
- Section 7 gives the platform homes under `src/`. They are `engine/src/contexts/run-orchestration/domain/run-freeze.ts` (the freeze function, `decideRunFreeze`; no longer in the platform), `platform/entrypoints/contract/commands.ts` (`GroundingInputSchema`), `platform/entrypoints/api/use-cases/create-run.ts`, `platform/entrypoints/effective-config.ts`, `platform/settings/retired.ts` and `platform/persistence/repositories/lesson.repository.ts`.

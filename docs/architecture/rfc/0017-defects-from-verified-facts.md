# RFC-0017: A defect is a verified fact, not the shape of a failing test

- **Status:** Proposed, 2026-11-01. Implemented in the same change under the owner's standing rule of [ADR-0015](../adr/0015-owner-decisions-2026-10-30.md) point 2 (the recommended answer of every question under "Owner decisions needed" is taken; the owner may overturn any of them).
- **Code references at cfc69e3b** (the base of this change; the paths are those of the tree at that commit).
- **Implementation:** the feature document `odd/tasks/no-stubs-fact-based-defects.md`, tasks T2 (the decision), T3 (the adjudicator and the grader) and T4 (the closed-loop analysis).
- **Related:** [ADR-0025](../adr/0025-delivered-specs-do-not-intercept-requests.md) (stubs are refused), [ADR-0001](../adr/0001-design-pillars.md) (P2 the engine/AI boundary by rules, P3 signals not thresholds, P6 test quality forces neither FAIL nor PASS), [ADR-0005](../adr/0005-coverage-enforce-activation.md), AGENTS.md "Engine/AI boundary".

## Summary

1. The owner asked, in two messages of 2026-11-01 (translated; originals under Problem), which flow decides whether a bug is an error, "because clearly it does not work", and why a method that reads a field that does not exist in an endpoint and breaks the interface is not detected as a bug: "that is a very clear and basic error".
2. Today no flow decides it. The only code that calls anything an app defect is the adjudicator, which runs inside the fix loop, which runs only for a failing test, and which classifies by the text of the error. The engine's own facts about the interface (a data contradiction, the change's reach) are "a signal, never a gate", so a green suite wins over them.
3. Proposal: a defect is a fact the engine verifies. A field the consumer's code expects of an answer that the provider's contract does not declare and no live response carries, on a page or operation the change reaches, is a defect of the run by itself: the run ends `fail` and opens an Issue with no failing test needed. The adjudicator's one rule that rests on error-text shape stops claiming a high-confidence defect. The `defect_found` grader counts the verified defects.
4. The closed loop's retirement of the fix loop is not part of this root cause (Closed loop, below).

## Problem

The owner's words of 2026-11-01:

- "no me queda claro cual es el flujo que determina si un bug es error o no, porque claramente no funciona" (I do not understand which flow determines whether a bug is an error or not, because clearly it does not work).
- "Por qué no detecta como bug un metodo que lee un campo que no existe en un endpoint y rompe la interface, eso es un error clarísimo y básico." (Why does it not detect as a bug a method that reads a field that does not exist in an endpoint and breaks the interface, that is a very clear and basic error.)

The case is run `run-ed28973-mvx5tf7x-2742c11b` (app name-webapp, commit ed28973). The frontend reads `activeMenuCuisineType` from `GET /restaurants/countries/ES`; the backend maps the value to `cuisineType` and its OpenAPI schema `GeoRestaurantData` declares `cuisineType`, so the chips are always disabled. The Context Pack carried the fact as a `Possible data contradiction`. The author wrote `[stubbed: ...]` tests that fulfilled the GET, and a live test that asserted the all-disabled state passed. The run ended green, nothing was reported, and the stub test that failed was graded `defect_found = 1`: a real defect left unreported and a test artifact counted as the finding. [ADR-0025](../adr/0025-delivered-specs-do-not-intercept-requests.md) removes the stubs; this record is about the decision that was inverted.

### Where the decision lives at cfc69e3b

| # | What | Where | Consequence |
|---|---|---|---|
| D1 | The verdict reads the execution only | `run-orchestration/domain/run-decision.service.ts:41-61` (`decide(ev)` branches on `ev.verdict`, `needsReview`, `blocksPublish`); `phases/decide.steps.ts:104-112` builds the evidence from `runOf(state).verdict` | A passing execution is a `pass` whatever the grounding established |
| D2 | `adjudicate()` runs only for a failing test | `run-flow/run-steps.ts:60` (`run-fix-loop` runs when `verdict === "fail"`), `domain/fix-loop.aggregate.ts:591` | No failing test, no adjudication, no defect |
| D3 | It classifies by error text | `domain/adjudicate.service.ts:132-181` (rules 2.5 attributed 5xx, 2.6 runtime error, 3 `isLikelyRealBug`); `domain/helpers/progress-gate.ts:64` | Rule 3 calls `app_defect`, `high`, `break-issue` from "unique selectors and every failure a value mismatch"; that is the shape of an assertion message, not a fact about the app |
| D4 | Contradictions decide nothing | `shared-kernel/data-contradiction.ts:37` ("A signal, never a gate"), `generation/domain/expectation-gaps.ts:11`, AGENTS.md "Data contradictions" | The `provider-undeclared` class (the provider never promised the field) is as inert as the class that may be an optional field DEV lacks |
| D5 | The finding is counted from failing cases | `evaluation/domain/graders.ts:563` (`defect_found` = failing cases the causal label puts in reach; `pass` = 0) | A defect with no failing test grades 0; a test artifact in reach grades 1 |

Route availability is read before the adjudicator (`fix-loop.aggregate.ts:490-494`, `availabilityVerdict`): the adjudicator does read one engine fact. It is the only one, and it too is reached only through a failing test.

## Goals and non-goals

- Goal: a defect the engine can verify from facts it already holds is a defect of the run, with or without a failing test, and a passing suite never turns the run green over it.
- Goal: every claim of a defect states the fact it rests on, in the Issue and on the record.
- Non-goal: deciding what the app should do. The fact is that the consumer's code reads what the provider's contract never declared; it is not an opinion on which side is wrong.
- Non-goal: a new agent turn or a new threshold (P2, P3). The rule is a comparison of facts the grounding computed.

## Options

- **A. Keep it a signal and improve the wording.** The Issue and the PR already list the contradiction; the owner's case shows nobody read it, because nothing opened for a green run. Rejected.
- **B. Let the reviewer decide.** The reviewer may cite a contradiction against a spec. It judges tests, not the app, and a green suite with a stub-free live test gives it nothing to reject. Rejected: it moves a fact to an agent (P2).
- **C. Make the `provider-undeclared` contradiction in the change's reach a defect (recommended).** The two inputs are facts: the contract classification (`ProviderContract`) and the change's reach (`requestReach`, `pageReach`, the causal label's own functions).
- **D. Also make `provider-declared-absent` a defect.** The contract declares the field and the live answer lacks it. It may be an optional field DEV's data does not hold, so it stays a signal (Q1).

## Recommendation

1. **The rule** (`objective-signal/domain/contradiction-defects.ts`, pure): a data contradiction is a defect when its provider class is `provider-undeclared` and the change reaches its page (`pageReach` of the route) or the operation it was read from (`requestReach` of the operation's path). Positive evidence only: a run with no change scope, or a fact the scope does not place, finds none. "Declared under another name" needs no rule of its own: the contract describes the answer and does not declare the consumer's name, which is exactly `provider-undeclared`; no similarity between names is read.
2. **The decision** (`run-decision.service.ts`): `RunEvidence.defectFound` and `verdictOf(ev)`; a run whose execution passed and found a defect ends `fail` and takes the existing `fail` path (Issue, `shadow-log` in shadow, silent under `onFailure != github-issue`); every other verdict keeps its own, and `isAccepted` is false so the suite is not kept. `decideRun` (`phases/decide.steps.ts`) computes the defects from `state.grounding.dataContradictions` and `state.grounding.changeScope`, for a run that generated and is not a context run.
3. **What the run says.** The Issue gets a headline for a run with no failing check ("N defect(s) found without a failing check") and a section `Defects found without a failing test` with the contradiction statement and what places it in the change's reach; the defect is not listed again under `Possible data contradictions`. `gateSignals.defects { found, facts[], omitted }` records it. The publication receives the decided verdict, not the execution's. The error class is derived from the execution (a defect beside a green suite is no engine fault), so the process audit never counts it.
4. **The adjudicator** (`adjudicate.service.ts`, rule 3). The rule that rests on the shape of the error text keeps stopping the loop (a possible app defect must not be regenerated into green) but reports `app_defect`, `low`, `break-needs-human`: a hint a human triages. Only facts earn `high`: an attributed 5xx, a captured runtime error, route availability, a verified `test-correct` claim.
5. **The grader** (`defect_found`, `GRADER_VERSION` 4 to 5): the verified defects of `gateSignals.defects` add to the failing cases in the change's reach, so a defect with no failing test is a finding; a stored run before the rule has no `defects` signal and is graded as before.
6. **AGENTS.md**: the "Data contradictions" bullet, step 9 of the run flow, the new Engine/AI row "What makes a run a defect of the app" (in force) and the `defect_found` description change with the code.

### Closed loop (S11)

The owner asked whether the closed loop's retirement of the fix loop belongs to the same root cause. It does not.

- `loopClosedNow` (`phases/generation-services.ts:58`) counts the loop closed when every delivered spec's current bytes were seen passing in `run_spec`. The fix loop then runs with `regenerate` false and stops with `regeneration-retired` (`domain/fix-loop-action.ts:64`) after the adjudication: a retired loop still adjudicates (`fix-loop.aggregate.ts:591`), it only does not repair. It is why a failing final execution of a spec `run_spec` passed is not rewritten, not why a defect went unreported.
- Open, not part of this change: a spec that passed `run_spec` and failed the final execution is two judging executions in conflict, and nothing adjudicates the conflict by facts (it is flaky triage or the fix loop's classification today). Recommended follow-up: record the conflict as `gateSignals.closedLoop.conflicts` before deciding whether it is a rule.

## Patches it supersedes

None: the contradiction signal, the causal label and the adjudicator stay; only what they decide changes.

## Test plan

- `contradictionDefects`: the three classes, a page and an operation in reach, a template page, out of reach, no scope, order kept.
- `decide` and `isAccepted`: a pass with a defect is `fail` / `issue` / not accepted; no other verdict changes; the exhaustive acceptance-equals-would-publish test runs with the new flag.
- Run level (`run-qa.defects.test.ts`): a green run with an in-reach `provider-undeclared` contradiction ends `fail`, publishes the Issue with the defect, records `gateSignals.defects` and no error class; `provider-declared-absent`, an out-of-reach page and a run with no scope stay green and unchanged.
- Render and publication: the headline, the section, the reach line, the existing rendering unchanged without defects.
- Adjudicator and grader: rule 3's new label, the facts rules unchanged; `defect_found` with defects, without a failing case, and a stored run without the signal.

## Measurement

- Before: runs whose Context Pack carried a `provider-undeclared` fact and ended `pass` (`gateSignals.dataContradictions.facts[].provider`, verdict, decision), per app.
- After: the same runs end `fail` with `gateSignals.defects.found > 0`; the count of Issues opened with no failing case; the share of `defects` that a human closes as not a defect (the false-positive rate of the rule; a streak above zero reopens Q2).
- `defect_found` by grader version 4 and 5 over the stored runs, never pooled.

## Owner decisions needed

1. **Q1. Which contradictions are a defect.** Recommended: `provider-undeclared` in the change's reach (the interface is broken whatever data DEV holds). Alternative: also `provider-declared-absent`, which is the provider breaking its own contract but may be an optional field DEV lacks.
2. **Q2. Required fields.** The contract also says which fields are required. Recommended follow-up: `provider-declared-absent` on a field the contract marks required is a defect too (the provider breaks a promise it made, whatever the data). Not done here: the classification does not carry required-ness yet.
3. **Q3. Verdict.** Recommended: a green run with a defect ends `fail` (the existing Issue path, the existing shadow and `onFailure` rules). Alternative: a new verdict `defect`, a contract change for the client, web, SDK and graders.
4. **Q4. Flaky and skipped runs.** Recommended: only a `pass` becomes `fail`. A flaky run stays quarantined and a declared no-op stays `skipped` (AGENTS.md, "Honor the explicit no-op"); the defect is recorded on `gateSignals.defects` and is reported by the next run that passes. Alternative: a defect outranks both.
5. **Q5. Reach.** Recommended: the causal label's reach, positive evidence only. A defect on a page the change does not reach is not this run's finding (it is the same fact on the next run that reaches it).
6. **Q6. The adjudicator's rule 3.** Recommended: demote to a hint (`low`, `break-needs-human`). Alternative: delete the rule, which lets a value-mismatch failure fall to the generated-test-defect rules and be regenerated.
7. **Q7. `defect_found`.** Recommended: verified defects add to the failing cases in reach, version 5. Alternative: count only verified defects, which drops the failing cases from a grader the campaigns read and needs the adjudication persisted first.

## Out of scope

- Persisting the adjudication on the run record (`platform/persistence/types.ts` omits it), which would let graders read the facts-based adjudications.
- Required-field awareness of the provider contract (Q2).
- Making a stored run before this rule follow it: a stored run keeps its verdict.

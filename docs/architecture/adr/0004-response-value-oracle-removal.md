# ADR-0004: Remove the response value oracle

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** D5. On 2026-10-28 15:32Z the owner approved the recommendations D1-D13 together: "Regarding the 13 recommendations I agree with everything" (translated). D5 as put to the owner: "Response value oracle: delete now and accept no objective value signal for backend changes until service-triggered runs work". The recommendation the owner approved: "Delete; redesign with real backend runs". Supporting words, 2026-10-28 14:14Z (translated): "The problem was that at the start, instead of deciding on an MVP and making it work, I kept adding features on top of features in an app that did not work."
- **Code references at 4105c582:**
  - Wiring and switch: `src/server/run-engine-factory.ts:649`, `:973-979`, `:988-993`, `:999-1005`, `:1396`, `src/orchestrator/schemas.ts:253-257`, `:436-445`
  - The oracle and its aim: `qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts:33-71`, `qa-engine/src/contexts/run-orchestration/application/run-flow/fault-aim.ts:32`, `:46`
  - Where operation entries come from: `qa-engine/src/contexts/change-analysis/domain/reach-proofs/handler-serves-operation.ts:26`, `qa-engine/src/contexts/change-analysis/domain/reach-proofs/openapi-operation-diff.ts:14`, `qa-engine/src/contexts/change-analysis/domain/reach-proofs/cross-repo-call-site.ts:9-14`
  - What the run keeps of it: `qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts:169`, `:199-206`, `qa-engine/src/shared-kernel/error-class.ts:159-162`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts:87-93`
  - The fixture, the allowlist and the anchors: `config/e2e/fixtures.ts:264-322`, `:906-916`, `qa-engine/src/shared-infrastructure/process-sandbox/exec-env.ts:49`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts:62-64`, `:207`, `src/server/merge-guard.ts:166`, `:359`
  - Calibration: `qa-engine/src/contexts/objective-signal/domain/fault-calibration.ts:11`, `:51-73`, `scripts/fault-calibration.ts:52-63`, `package.json:42`
  - Documents that describe it: `AGENTS.md:78`, `:850`, `:912`, `config/apps/example.yaml:149-158`
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0005](0005-coverage-enforce-activation.md), [ADR-0006](0006-bundle-mutation-switch.md), [ADR-0007](0007-code-target-removal.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md)

**In one line:** the response value oracle (fault injection into API responses) is deleted in step 1. Until service-triggered runs work, qayaba has no objective value signal for backend changes, and that gap is accepted instead of carried in code that produced no score in the 31 outcomes of the history window (2026-10-26 to 2026-10-28, all under the operation-only aim of `8c574a7d`).

## Context

**What it is.** After a green e2e run, with `qa.valueOracle` on, the engine re-runs the suite against DEV with the JSON responses of the operations the change reaches corrupted: numbers moved by one, booleans flipped, strings and ids kept (`config/e2e/fixtures.ts:906-916`). The score is the share of the exposed, baseline-passing specs that fail (`fault-injection-oracle.adapter.ts:60-69`). It never gates a PR (`value-oracle.port.ts:5`). The same switch also turns on bundle mutation, a different signal that stays ([ADR-0006](0006-bundle-mutation-switch.md)).

**Why it produced no signal in the window.**

| Fact | Evidence |
|---|---|
| Since 2026-10-26 the re-run corrupts only the operations in the change's reach. Before that, it corrupted every JSON response. | Commit `8c574a7d` (2026-10-26, "aim the response oracle at the operations the change reaches"): "With no scope, a degraded scope or no operation in reach nothing is corrupted and no score is given." |
| Every run of the history ran under that aim. The first one (2026-10-26 18:00Z) ran on code that already held `8c574a7d` (dated 2026-10-26 09:56 +0100, in the history of `e6c7d095`, the commit the orchestrator booted on; boot time probable). The database holds no run before it, so what the oracle scored before the aim cannot be read. | History database read on 2026-10-28 |
| The oracle exists to feed rule promotion. `ecdbffd0` (2026-06-10) made it default on for apps out of shadow because "rule promotion/decay was fed ONLY by the oracle's valueScore" and "the oracle was opt-in/off". | Message of commit `ecdbffd0` |
| Without an operation in reach the re-run does not start and the answer is "not measured". | `fault-aim.ts:32`, `:46`; `fault-injection-oracle.adapter.ts:38-40` |
| Operation entries come only from a changed backend handler or from a service's changed contract. A frontend call site of a contract link yields pages. | `handler-serves-operation.ts:26`; `openapi-operation-diff.ts:14`; `cross-repo-call-site.ts:9-14` |
| `valueScore` is null in 31 of 31 outcomes. `valueByCandidate` and `valueStats` are in none. The oracle scorecard holds 24 entries, none with a score. No `mutation_value` grade was ever stored. | History database read on 2026-10-28: name-webapp only, 34 runs from 2026-10-26 18:00Z to 2026-10-28 15:34Z, 33 of them on the commit ed28973. |
| The 28 stored run plans hold 166 use-case candidates: 166 are pages, 0 are operations. | Same read, table `run_plans`. |
| Why a run was "not measured" is thrown away: the port adapter returns the score and the counts, never the `details`. | `objective-signal-port.adapter.ts:169`, `:199-206` |

The window is one app and mostly one commit, so the counts alone say little about other apps. The mechanism does not depend on the app: by the proofs above, a change that touches only the frontend reaches pages and no operation, whatever the stack (principle P5 of [ADR-0001](0001-design-pillars.md)). History before 2026-10-26 is not in the database, so the table cannot say whether the oracle scored anything before the aim; it says it scored nothing in the 31 outcomes since. Hypothesis: the 31 nulls are what the aim gives a change that touches only the frontend, because the reason a run was "not measured" is not stored (last row).

**What would still be wrong if it scored** (code facts; the forgery item is a hypothesis):

- Its re-run is a full-suite DEV execution that nothing budgets (`run-engine-factory.ts:973-979`; the time-authority hypothesis H16 is plausible, not confirmed).
- It flips numbers and booleans only, so a suite that asserts text is never exposed (`fixtures.ts:906-916`).
- A green run with a score under 0.5 becomes the learning class `E-VALUE-SURVIVED`, with no calibration behind 0.5 (`error-class.ts:159-162`).
- The counters it scores from are files the suite's own process writes (`fixtures.ts:315`). Hypothesis: a spec the agent writes could write the same files.
- Calibration cannot pass: it needs three replicates that carry `valueStats` (`qa-engine/src/contexts/objective-signal/domain/fault-calibration.ts:11`, `:51-66`), and no outcome has any.

**What it could only ever cover.** A backend change in a multi-repo product. A cross-repo run measures no change coverage by design (`coverage.steps.ts:90-93`, "status=unknown"), and bundle mutation mutates only served frontend scripts, so the oracle would be the only objective value signal there. But 0 of the 34 runs in the history were triggered by a service repository (`runs.trigger_repo`). The capability it would serve has not run once in the history window.

## Decision

| # | Decided |
|---|---|
| 1 | The response value oracle is deleted now, in step 1 of the approved work order ([RFC-0002](../rfc/0002-platform-steps-0-1.md)), not after a redesign. |
| 2 | Until service-triggered runs work, qayaba has no objective value signal for backend changes. The gap is accepted and recorded here. |
| 3 | The signal is redesigned later, from real backend runs. The design deleted here is not revived. |

**Scope, as mapped from the code** ([RFC-0002](../rfc/0002-platform-steps-0-1.md) owns the file list):

- Goes: the oracle adapter, its score, the aim, the calibration module and script, the null oracle and the port (439 lines in seven files, tests not counted); the `_faultInject` fixture, its two environment allowlist entries and the `faultInject` execution option; `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount` and `killedCount`; the `mutation_value` grader; the oracle scorecard; the class `E-VALUE-SURVIVED`.
- Stays: the counter reader and the `_mutate` fixture. Bundle mutation counts its mutated responses through them (`run-engine-factory.ts:1003`, `fixtures.ts:360`).
- The code target's oracle (Stryker, `stryker-mutation-oracle.adapter.ts:268`) is the only other producer of `valueScore`. It goes with the code target ([ADR-0007](0007-code-target-removal.md)).

**Not decided here** (each was an open owner question, decided 2026-10-28 as recommended, [ADR-0013](0013-owner-decisions-remaining-questions.md); the recommended answer follows it):

1. Do `valueScore`, `valueByCandidate`, `valueStats`, `mutantCount`, `killedCount` and the oracle series leave the persisted and wire contract in step 1, or stay as nulls until a later contract change? Recommended: they leave, with the contract regenerated in the same step. Old rows stay readable.
2. What does "service-triggered runs work" mean, so the gap has a moment to be looked at again? Recommended: at least one completed run triggered by a service repository, with its verdict and coverage reason recorded, and at least one backend-change case among the stored plans.

## Consequences

| Change shape | Value signal before | After |
|---|---|---|
| Frontend change, one repository | Bundle mutation | Same. |
| Backend change in a multi-repo product | None produced in the window: 0 scores in 31 outcomes. The oracle was meant for it and was not aimed in the window. | None. Gap accepted. |
| Cross-repo run | Change coverage `unknown` by design, no value score | Same. |

Nothing that measured is lost in the available history: the score was null in all 31 outcomes (earlier outcomes are not in the database). A suite for a backend change is judged by the run and the reviewer alone. The circular-loop risk in `AGENTS.md` ("The value/trust risk") stays open for those changes.

- **Governance-sensitive paths.** The allowlist (`exec-env.ts:49`) and the setup adapter (`setup.adapter.ts`) are protected paths (`merge-guard.ts:359`, `:166`), and the fixture is system-owned. Each ships as its own commit, then `npm run sandbox:smoke` runs in the stack.
- **Fixture anchors move.** `setup.adapter.ts:62-64` and `:207` insert the failure-capture fixture and the mutation fixture relative to the `_faultInject` text, so both anchors change in the same commit. App repositories already hold a copy of the fixtures. Whether the existing upgrade path removes the fixture from a copy is not verified.
- **`qa.valueOracle` loses its first meaning.** Its other meaning, bundle mutation, is [ADR-0006](0006-bundle-mutation-switch.md).
- **The contract changes** if the fields leave it (question 1 above): the value trend in `src/contract/commands.ts:814` and `:916` and the generated SDK types. That is a change to a contract others consume. Stored outcomes keep their old fields; readers must ignore them (not verified).
- **Calibration stops being the enforce condition.** [ADR-0005](0005-coverage-enforce-activation.md) replaces it.
- **Documents to correct:** `AGENTS.md:78`, `:850`, `:912` and the value-oracle block of `config/apps/example.yaml:149-158`.

## Enforcement

Not enforced yet. What will hold it, added by the step 1 commit that deletes the code:

- The previous-forms gate (`scripts/check-previous-forms.ts:38-52`, run by `npm run previous-forms:check` in `.github/workflows/ci.yml:44`) gets a rule for the retired names: `FaultInjectionOracle`, `QA_FAULT_INJECT`, `_faultInject`, `fault-calibrate`. The records under `docs/architecture` name them on purpose and the gate scans docs (`scripts/check-previous-forms.ts:73-76`), so that commit keeps the new rule from applying to the folder ([RFC-0002](../rfc/0002-platform-steps-0-1.md) Q1, commit G1) or allow-lists the lines (`scripts/previous-forms.allow.json`).
- The factory test that wires the oracle (`src/server/run-engine-factory.test.ts:1446-1450`) and the oracle's own tests are deleted with it.
- `npm run sandbox:smoke` after the two governance commits.

## Alternatives considered

| Alternative | Why it is not the decision |
|---|---|
| Keep it and redesign the aim now | It keeps the only backend design. It costs an aim for frontend-driven changes, an owner for its DEV time, counting a suite cannot forge, safety for corrupted responses the app may write back to the shared DEV (hypothesis: no run exercised it), and calibration campaigns. Nothing shows it would discriminate, and the capability it serves has not run once in the history window. |
| Keep the code, switch it off, delete later | About 440 lines of source and their tests ride through steps 2-6 and return one constant. It is the pattern the owner described: features kept on top of an app that did not work. |
| Cover backend changes with bundle mutation | It cannot: it mutates scripts the browser loads (`AGENTS.md:831-832`, `objective-signal-port.adapter.ts:174-179`). |

# ADR-0003: Learning layer: delete and rebuild one lesson kind

- Status: Accepted, 2026-10-28, owner
- Decision source: D1, D2, D3, D4 and D14, approved by the owner on 2026-10-28; the owner's words are quoted (translated) in Context
- Code references at 4105c582: `LEARN` = `qa-engine/src/contexts/cross-run-learning`, `RF` = `qa-engine/src/contexts/run-orchestration/application/run-flow`, `COORD` = `qa-engine/src/contexts/coordination/application`, `GEN` = `qa-engine/src/contexts/generation/infrastructure`, `SK` = `qa-engine/src/shared-kernel`; also `src/server/run-engine-factory.ts`, `src/server/reflector-switch.ts`, `src/settings/registry.ts`, `src/contract/commands.ts`, `src/server/persistence/repositories/learning.repository.ts`, `scripts/campaign.ts`, `AGENTS.md`
- Related: [ADR-0001](./0001-design-pillars.md), [ADR-0002](./0002-architecture-direction.md), [ADR-0004](./0004-response-value-oracle-removal.md), [ADR-0006](./0006-bundle-mutation-switch.md), [ADR-0008](./0008-product-version-source.md) (precondition), [ADR-0009](./0009-campaign-freeze-on-server.md) (precondition), [ADR-0010](./0010-maintainer-removal.md), [ADR-0011](./0011-root-cause-fix-policy.md), [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md)

## Context

**In short.** The learning layer teaches nothing true today and, in one place, teaches something false. The owner decided to delete its rule loop, reflector and curriculum at step 1 of the platform plan (`docs/engine-platform-architecture.md`), and to rebuild later one engine-owned lesson kind that is measured against a frozen arm and deleted if it does not help. The gates that decide what may teach are redesigned so they select on the fact a lesson reads, never on how the whole run ended.

### What the owner said (translated)

| Date (UTC) | Words |
|---|---|
| 2026-10-28, 14:14 | "The specific idea of the learning layer seems good to me: that the app 'evolves' with the app it tests, learning from errors and decisions between executions, information that is general and reusable, above all about how to react to a problem, or about business logic specific to the app. Even though qayaba is agnostic to what it tests, the idea is that each server that is brought up is tested against one same app at first; it can have several repositories (microservices, frontend, libraries) but all of it belongs to the same logic and product. That is why the learning layer seemed good to me." On the same occasion: "As the app kept failing, it was decided to deactivate things first to be less ambitious and try a simpler version; this has left what was deactivated in a very outdated and probably incorrect state." |
| 2026-10-28, 15:32 | "Regarding the 13 recommendations I agree with everything. I only want to ask about the decision that the learning layer filters out the runs with problems, because in that case it would only learn from the ones that went all well, and those may be exactly the ones that suffer from survivorship bias." |
| 2026-10-28, 15:45 | "That design seems good to me for the learning layer." |

D1 to D4 were approved inside the 15:32 "agree with everything". The 15:32 question produced D14, approved at 15:45.

### Evidence: the current layer teaches nothing, or teaches wrongly

Read-only queries on the history database on 2026-10-28: 34 runs (all one app, 31 campaign-tagged), 31 run outcomes.

| Claim | Evidence |
|---|---|
| No rule exists for any app | `learning_rules` holds 0 rows. The only production `save` of a rule is `LEARN/infrastructure/reflector-port.adapter.ts:157`; the reflector is off by default (`src/settings/registry.ts:74`, `src/server/reflector-switch.ts:12-19`). `effective_config.reflector` is 0 in 34 of 34 runs; 0 of 31 outcomes carry a reflection. |
| The conditions of the reflector's incident still hold | Its input is the class plus six gate signals, with no failing-case text, spec, diff or DOM (`RF/outcome-assembly.ts:134-156`); the rule it writes is saved with no check of its claim (`reflector-port.adapter.ts:113-157`). The incident is told at `src/server/reflector-switch.ts:1-11`. |
| Promotion is unreachable | A candidate becomes active only with `oracleOutcomeCount >= 1` (`LEARN/domain/rule-fold.ts:28`), which grows only on a non-null `valueScore` (`LEARN/application/fold-run-outcome.use-case.ts:48-52`), the response oracle's score (`qa-engine/src/contexts/objective-signal/domain/fault-injection-score.ts:99`). It is null in 31 of 31 outcomes; the scorecard holds 24 entries, `measuredRuns` 0, and `mutantCount`/`killedCount` are null in all 24. The bundle-mutation kill rate never reaches the fold, which reads only `valueScore`, `mutantCount` and `killedCount` (`fold-run-outcome.use-case.ts:24-27`). |
| Lessons reach the lead and the reviewer, and once a run-level author, but not the sidekick authors that write the flows' specs | Rules and exemplars are rendered for the lead's plan turn and the reviewer (`GEN/adapters/generation-turns.adapter.ts:156,176`, `GEN/adapters/review-port.adapter.ts:87`). The sidekick author brief has no section for them (`COORD/coordination-sections/brief-sections.ts:123-213`). Of the 247 recorded turns, none carries a rules section; the exemplar section is in one lead turn of each of 29 runs, in one `qa-author` turn of an early run (`run-ed28973-mvpoel1j-e5a7cee8`) and in none of the 111 `author` turns, the sidekick turns. |
| A reviewer rule could not be cited | The reviewer is told to REJECT on a reject-on-sight rule (`GEN/prompt-builders/reviewer-sections.ts:83-84`), but a finding may cite only `contract`, `execution`, `dom`, `arm`, `availability` or `contradiction` (`qa-engine/src/contexts/run-orchestration/domain/review-finding-filter.service.ts:16`). |
| Nothing anchors or expires a lesson | A rule has no repository, route, file or commit (`LEARN/domain/learning-repository.ts:5-22`); retrieval ignores the sha (`LEARN/infrastructure/sqlite-learning-repository.adapter.ts:49`). |

### The live wrong lesson: run #26 to "PROVEN (1 bug)"

1. Run #26 (`run-ed28973-mvra9a3s-09df0987`, outcome 2026-10-27 23:32:56Z) ended `fail` / `E-EXEC-FAIL`. Its two failing cases are `locator.click` timeouts on a button that is `aria-disabled`, which the test's own title calls inert. The spec never passed `run_spec` (calls: error, refused, refused) and the fix loop ran 0 rounds (`qayaba.fix_loop.rounds` 0, spec bytes unchanged).
2. The curriculum marks `caughtRealBug` only for the adjudication class `app_defect` (`LEARN/domain/curriculum.ts:76,101-108`) and credits every offered archetype (`:95-110`). The stored row shows three archetypes with `caughtRealBug` true, `promotionCount` 1 and `firstCaughtAt` 2026-10-27T23:32:57.035Z, 0.4 s after #26's outcome. #26 is also the only mainline outcome absent from the scorecard, which the fold skips for `app_defect` and for `dev_not_rendered` (`LEARN/domain/should-distill-learning.ts:4-6`). Applying `learningGates` to the 31 stored outcomes reproduces the scorecard for all 31 when #26 is treated as `app_defect` or `dev_not_rendered`; under any class other than those two #26 would be in the scorecard. The scorecard therefore narrows the class to those two, and the curriculum row narrows it to `app_defect` alone, because `caughtRealBug` is set only for that class (`LEARN/domain/curriculum.ts:76`). The class remains an inference from the stored row and the code, not a stored fact. The adjudication itself is not stored (`src/server/persistence/repositories/learning.repository.ts:106-119,146-161`), so which adjudicator rule fired is not recorded.
3. Each of the 8 runs started after #26 (`run-ed28973-mvruzwli-8bb3adcd` to `run-ed28973-mvs9yzjd-bf4eb95c`, the cancelled replicate included) carries, in one lead turn, "PROVEN (1 bug)" on `re-query-after-mutation`, `empty-state` and `boundary-value`, under the sentence "PROVEN (n bugs) counts the application defects past runs caught with that template" (`SK/scenario-catalog.ts:114,120`). Runs #24 to #26 carry the same section with no marker.
4. The sentence is false: the code counts a co-occurrence, credited to every offered template, from a run whose own failure was a test defect. The lead is read-only and writes no test (`AGENTS.md`, "Lead and sidekicks"); the section reaches none of the 111 sidekick `author` turns.
5. With `QA_CAMPAIGN_FREEZE` off the row crossed replicate boundaries (`docs/efficiency-benchmark.md:399` names the risk). The prompts of cycles 2 and 3 and of the baseline replicate differ from cycle 1 by this marker. Its effect on the lead's plan has never been measured (no ablation exists).

### The survivorship question, on the code and the data

The owner asked whether filtering out the runs with problems leaves only the ones that went well. Today every consumer filters per run, on the run's verdict or class:

| Consumer | Admits | Source |
|---|---|---|
| Rule fold and scorecard | every mainline run, and a terminal run only if its class teaches | `LEARN/domain/learning-gates.ts:42` |
| Reflector | only a run whose class teaches and that is not flaky; a clean pass (no class) never | `learning-gates.ts:43`, `RF/decided-end.ts:404,419` |
| Process audit | the same runs as the reflector, and also any outcome whose class is `E-TIME-BUDGET` or `E-REVIEWER-UNAVAILABLE` (both are in `NON_LEARNING`), through a second class-keyed gate, `observesOperatingSignal`; the code checks only that the run is not a context run and the class | `RF/finalize-run.ts:264`, `learning-gates.ts:43,52-54` |
| Curriculum | a pass with a coverage verdict, or an `app_defect`; every other verdict is "inconclusive" and moves no counter | `LEARN/domain/curriculum.ts:77-83,91` |
| All learning | except `app_defect`, `dev_not_rendered` and code-target failures | `should-distill-learning.ts:4-6` |

On the 31 stored outcomes the fold admits 24 and the reflector and audit path admits 12; the 9 clean passes never reach it, and the 8 outcomes ending `E-FLAKY`, `E-NO-AUTHOR` or `E-PRECONDITION` carry a class the gate marks as teaching nothing. No stored outcome ends `E-TIME-BUDGET` or `E-REVIEWER-UNAVAILABLE`, so the audit's second gate admitted none of the 31.

The same observed fact sits under four different run endings. The Context Pack read the route `/restaurantes` of the analyzed app as "0 result(s), empty state confirmed" in four runs and as 2 results in the next three:

| Run | Started (UTC, 2026-10-28) | Verdict / class | Page read | Fold | Reflector, audit |
|---|---|---|---|---|---|
| `run-ed28973-mvruzwli-8bb3adcd` (#27) | 08:35 | pass / none | empty, confirmed | yes | no |
| `run-ed28973-mvrwjx2d-1bf83af5` (#28) | 09:18 | invalid / `E-STATIC` | empty, confirmed | yes | yes |
| `run-ed28973-mvrxb30p-ecfe944b` (#29) | 09:39 | pass / none | empty, confirmed | yes | no |
| `run-ed28973-mvs0onsn-6ad17f30` | 11:14 | flaky / `E-FLAKY` | empty, confirmed | yes | no |
| `run-ed28973-mvs2ukug-c82da7be`, `run-ed28973-mvs49h5y-acdab309`, `run-ed28973-mvs7oo0f-17041c71` | 12:15, 12:54, 14:30 | pass / none, `E-FALSE-POSITIVE`, `E-COVERAGE-GAP` | 2 results | yes, yes, yes | no, yes, yes |

Reading: a per-run gate lets the fact reach the reflector and the audit through one ending only, the static-gate failure of #28; the gate admitted it by its class, whatever the page read (`learning-gates.ts:43`). The filter selects runs by the run's class, which does not take into account what the page read. This does not show that the empty page caused any failure; it shows the selection is blind to the fact.

## Decision

| # | Decision | When |
|---|---|---|
| D1 | Delete the rule loop, the reflector, the curriculum and their twins; later rebuild one engine-owned lesson kind with a kill criterion. No dormant skeleton is kept. | Delete at step 1; rebuild later |
| D2 | Switch the curriculum off and reset name-webapp's stored curriculum row | Together with step 1, not before |
| D3 | A verified lesson reaches the brief of the flow its scope covers | With the rebuild |
| D4 | The first lesson kind is DEV data volatility per page or operation | With the rebuild |
| D14 | Learning gates are keyed per lesson kind on the facts it reads | With the rebuild; holds for every later kind |

### D1: delete now, rebuild later

Approved text: "Delete and rebuild", against "keep the skeleton dormant (~1,650 lines returning a constant)". The learning context holds 1,646 non-test lines (`LEARN/`); the process audit and the gates stay (see below). What goes at step 1:

- the reflector: adapter, role prompt, `QA_REFLECTOR_ENABLED`, `effectiveConfig.reflector`, the policy text at `AGENTS.md:539-558`;
- the rule loop: ledger code, governance, retrieval, injection, promotion by the response oracle and by prevention credit, the quarantine and ledger CLI code, and the `learned-rules` sections of the generator and reviewer prompts;
- the curriculum: learned credit, ranking and the exemplar selection that depends on it (`RF/phases/ground.steps.ts:72-80`);
- the twins: the reviewer-correction classifier copy, and the duplicate `LearningRule`, `StructuredReflection` and `RelevanceBias` declarations.

[RFC-0002](../rfc/0002-platform-steps-0-1.md) holds the file-level inventory and the commit order. The rebuild is not scheduled by this ADR.

### D2: curriculum off, row reset, with step 1

Approved text: "Yes, together with step 1, not before, so the 'before' conditions stay fixed while measuring." Until step 1 the curriculum stays on: `effective_config.grounding.curriculum` is `learning` in 34 of 34 runs, so the baseline replicate (`run-ed28973-mvs7oo0f-17041c71`) and cycle 3 ran under identical curriculum conditions. At step 1 the per-run switch (`src/server/run-engine-factory.ts:1508`) becomes moot because the code is gone, and the owner-authorized reset clears name-webapp's row. The intelligence view treats a corrupt row as "kept for repair, never silently reset" (`src/contract/commands.ts:793-796`); this reset is an explicit decision on a readable row and is recorded in the step's feature document.

### D3: a verified lesson reaches the flow brief

Approved text: "Lift `coordination-context.ts:1` so a verified lesson reaches the brief of the flow its scope covers", answered "Yes: verified facts only, only the flow in scope, bounded size." The audit cited `COORD/coordination-context.ts:1` as the restriction. Verified at 4105c582:

| Question | Finding |
|---|---|
| What is line 1? | The header comment of `CoordinationContext`, the coordinator's minimal projection: "Must never contain OpencodeRunInput (diff, specs, learned rules, DOM, provider)". |
| Who uses the type? | No production code builds one. The barrel re-exports it (`COORD/index.ts:8`); `COORD/delegation-brief.ts:3` imports only `AcceptanceCriterion` from the file. |
| What enforces it? | Two contract tests assert that `learnedRules` is absent. `qa-engine/test/contract/coordination-seam.contract.test.ts:74-98` checks the keys of a sample `CoordinationContext`. `qa-engine/test/contract/coordination-evidence.contract.test.ts:25-51` (the assertion is at `:46`) checks that each `EvidenceRef` the evidence adapters produce has no `learnedRules` property; `EvidenceRef` is the element type of the proposed vehicle `DelegationBrief.knownFacts`. Neither forbids a fact entry about a lesson. |
| What keeps rules out of the author brief? | No written rule: `AUTHOR_BRIEF_SECTIONS` simply has no section for them (`brief-sections.ts:123-213`), and rules travel to the lead and the reviewer through `OpencodeRunInput.learnedRules`. |
| Is there a vehicle for per-flow facts? | Yes. `DelegationBrief.knownFacts` (`COORD/delegation-brief.ts:81`) renders as "Known facts" (`brief-sections.ts:157-162`), and `knownFactsOf` already filters the Context Pack's confirmed data routes to the flow's own routes (`COORD/lead-sidekicks.ts:745,1463-1466`). `EvidenceKind` is a closed union with no lesson kind (`COORD/evidence-ref.ts:2-12`), so a lesson fact needs a kind: a new one or an existing one. |

So nothing at line 1 blocks the author brief: it describes the coordinator projection, and the author brief is a different type. The approved wording assumed that line 1 blocks the brief. That premise does not hold, and the owner decides what happens to the comment (reword it to say what it protects, or delete it); this ADR does not decide it.

Readings of the approved words, not decisions:

- The vehicle: a facts-only entry in the author brief (`knownFacts`, above) would carry the lesson without changing `CoordinationContext`.
- "Verified": the engine verified the fact the lesson states (D4).
- "Only the flow in scope": the pages, routes or files the lesson's scope names, as `knownFactsOf` does.
- "Bounded size": the window-fit rule of prompt assembly in `AGENTS.md` (a section degrades to references, never a fixed cut), as against a constant such as the 5,000-character cap at `LEARN/infrastructure/adapters/learning-port.adapter.ts:15`.

A future learning RFC confirms or replaces each reading; the meaning of "bounded size" is also listed under "Not decided here".

### D4: first lesson kind, DEV data volatility

Approved text: "Yes; produced deterministically from facts, no LLM." The kind states, per page or operation, that its data state differed across runs; it is measured by data-state failures and by `run_spec` calls-to-green per flow, against a frozen arm, and is deleted after one cycle without improvement.

- Inputs that exist today: the Context Pack's per-page `resultCount`, `emptyConfirmed` and unconfirmed-state flag (`qa-engine/src/contexts/generation/domain/route-snapshot.ts:72-81`, `GEN/context-pack.ts:326-335`) and the empty reads of a flow's `run_spec` calls (`COORD/lead-sidekicks.ts:1476-1478`). Both exist only for routes whose app config declares a data state (`dev.dataState`), so the kind is silent where an app declares none. That is declared scope, not a code branch.
- Calls-to-green per spec is derivable today from the per-call spans (`qayaba.tool.run_spec` with `qayaba.spec.path` and `qayaba.tool.outcome`: `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts:418,427`; read by `src/server/evaluation-evidence.ts:178-179`). In the baseline replicate they show, per spec, outcome sequences such as failed, passed, passed, refused.
- No single recorded field names a "data-state failure". The learning-slice RFC defines it. It must not read the unmet-by-DEV-state backing as it stands: for a page the flow's browser was shown but did not read empty, the backing is the sentence "the flow's browser session was shown <path>" with no check against the Context Pack (`COORD/explore-verification.ts:100-104`). That is a code fact; its effect on any run is a hypothesis.

### D14: gates per lesson kind, never per run ending

Approved text: "Learning gates keyed per lesson kind on the facts it reads, not per run on its verdict; every run is input; exclusions recorded with reasons; success measured by objective signals (kills, change covered on final bytes, defects found, data-state failures avoided) against the frozen arm, never by green." This answers the owner's survivorship question:

1. Each lesson kind declares the facts it reads. A fact is admitted or left out by its own state (page captured, version known), never by the verdict, error class or adjudication of the run that held it.
2. Every run is input. A fact that cannot be trusted is excluded with a typed, countable reason, so the exclusion is visible and a bias in it can be measured.
3. A lesson stays only if an objective signal improves against the frozen arm. Green, the verdict and the error class are never the measure.

### What remains of the learning layer after step 1

| Part | Why it stays | Change |
|---|---|---|
| Run outcomes (`run_outcomes`, append-only, 31 rows) | The raw material of every lesson and of the graders; every run is input (D14) | None at step 1. The unused `reflection` column is an open point below. |
| Learning gates (`LEARN/domain/learning-gates.ts:38-54`) | The one owner of what may teach | Redesigned per D14. Until a lesson kind exists, its only consumer is the process audit, which has two admissions keyed by the run's ending: `learningGates().reflect` and `observesOperatingSignal` (`learning-gates.ts:52-54`, called at `RF/finalize-run.ts:264`; classes `E-TIME-BUDGET` and `E-REVIEWER-UNAVAILABLE`). Both stay after step 1. Whether the second is re-keyed with D14 is an open point below. |
| Process audit observe streak (`LEARN/domain/process-audit.ts:57-123`) | Deterministic and fault-isolated; it makes a recurring ending visible without acting | Branches that point at the deleted loop go with it; the `recurring-dev-not-rendered` finding can never fire, because `RunOutcome.adjudication` is not persisted (`learning.repository.ts:106-119,146-161`) and the audit reads `r.adjudication?.class` (`process-audit.ts:79`). Its `engine-fix` edge to the maintainer follows [ADR-0010](./0010-maintainer-removal.md). |
| Campaign freeze | The frozen arm of any lesson measurement | Server-side enforcement: [ADR-0009](./0009-campaign-freeze-on-server.md). Today the only guard is client-side (`scripts/campaign.ts:264-266`); 34 of 34 runs, 31 campaign-tagged, ran with the freeze off. |

### Preconditions of the rebuild

- [ADR-0008](./0008-product-version-source.md): a lesson about DEV is true of the version DEV served. No field of the run record or the outcome stores which version a run read (`gate_signals` keys of run #26 list none), so until the product serves its version the rebuild does not start (D9, recorded as "precondition of learning").
- [ADR-0009](./0009-campaign-freeze-on-server.md): the frozen arm must be enforced by the server for campaign-tagged runs, and a learning experiment declares its learning arm explicitly (D10).

### Not decided here

Decided 2026-10-28: each recommended answer below is accepted ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

- The lesson entity (kind, scope, anchor, evidence references, actor), its storage, and whether it reuses `learning_rules`.
- Whether the no-op repository and `LearningPort` survive step 1, or the lesson store replaces them. The no-op `StubLearningRepository` (`LEARN/infrastructure/stub-learning-repository.adapter.ts:8`) implements the rule-loop port that D1 deletes (`LEARN/application/ports/learning-repository.port.ts:6-13`: `save`, `topRules`, `applyOutcome`, `incrementUsage`, `listAll`), and `LEARN/composition/build-cross-run-learning.ts:26` uses it only as the default repository of `LearningPortAdapter`. [RFC-0002](../rfc/0002-platform-steps-0-1.md) fixes this.
- The vehicle for D3 (`knownFacts` or a new brief section), the `EvidenceKind` a lesson fact would carry (see D3), and the fate of the comment at `coordination-context.ts:1`.
- What "bounded size" in D3 means: the window-fit rule of prompt assembly, a constant, or both.
- Whether the static exemplar templates in `SK/scenario-catalog.ts` and the keyword archetype detector (`SK/structural-pattern.ts`) go with the curriculum. With the curriculum and the rule loop gone nothing references them (Correction 2026-10-29: the run step `read-diff-shapes` also reached the detector; L4 (`0989507c`) removed that step with it), so they leave as dead code unless a measurement shows the templates help.
- The definition of "data-state failure", the number of replicates per arm that makes "one cycle", and what counts as "improvement" (see Consequences).
- Whether the process audit's context-heal disposition stays, and how the audit is admitted once `learningGates` serves it alone. This includes the second class-keyed admission, `observesOperatingSignal`: D14 keys lesson gates on facts, and a streak of time-budget or reviewer-unavailable endings is by nature about the ending, so whether that admission is re-keyed or stays class-keyed as an observe-only signal is not decided here.
- Business-logic lessons (the other aim named in the 14:14 message): a later kind, not scheduled.

## Consequences

- **Removed:** most of the 1,646 non-test lines of the learning context, which produce no lesson; the false statement in every lead prompt (from step 1); and a reflector switch that could be turned on by mistake.
- **Wire contract changes.** `GET /api/apps/:name/intelligence` loses `rules`, `scorecard` and `curriculum` (`src/contract/commands.ts:755-797`); the contract, the SDK, the console and the TUI views are regenerated or edited in their own commit.
- **Documentation changes.** `AGENTS.md:539-558` is rewritten, `QA_REFLECTOR_ENABLED` leaves the settings registry (`src/settings/registry.ts:74`) and `docs/settings.md` is regenerated.
- **Persisted leftovers.** The tables `learning_rules` (0 rows), `scorecard`, `curriculum` and the columns `run_outcomes.rules_retrieved` and `run_outcomes.reflection` stay unless a migration drops them. The history database carries a schema version, so a drop is a persisted-format decision (open point).
- **A measurement difference.** After step 1 the lead prompt loses the exemplar section. The baseline replicate and cycle 3 carry it, including the "PROVEN" marker; cycle 1 (#24 to #26) carries the section without the marker. [ADR-0011](./0011-root-cause-fix-policy.md) must list this difference in every before/after comparison that crosses step 1. With one replicate a comparison shows a direction, never proof, and identical inputs have spread widely (line coverage 0.630 to 0.904 across the baseline replicate and cycle 3).
- **Until step 1** the curriculum stays live and the false statement stays in the lead prompts. D2 accepts this on purpose.
- **The rebuild is gated.** It waits for ADR-0008, ADR-0009 and its own RFC. If the owner does not schedule it, the capability is dropped, not left dormant.
- **Lessons stay separate from agent memory.** The project already rejected an agent-held memory with no SHA, no expiry and no check against DEV (`AGENTS.md:541-544`); a lesson must be engine-owned, anchored and checked.

## Enforcement

None of this is enforced yet; each row names what will hold it.

| Decision | What will hold it | Added by |
|---|---|---|
| D1 deletion | `npm run previous-forms:check` rules for the retired names (the reflector switch and role, the curriculum, the rule ledger, the scorecard) and its dead-path scan; `npm run arch:check` (the shell-exceptions list only shrinks); `npm run contract:check` and `npm run sdk:typecheck` for the intelligence view; `npm run settings:check` for the registry entry; the prompt-contract matrix for the removed sections | Step 1 commits ([RFC-0002](../rfc/0002-platform-steps-0-1.md)) |
| D2 reset | No gate. The step's feature document records the reset and a read-only read of name-webapp's `curriculum` table row, taken before and after the reset (it shows the row cleared). Order inside step 1: the reset is applied and checked before the commit that removes the `curriculum` field of the intelligence view (`src/contract/commands.ts:789-797`), because once that field is gone the view cannot show the reset; the table read works in either order. | Step 1 |
| D3 delivery | A test through `assembleSidekickBrief` (`COORD/sidekick-prompt.ts:9`): the lesson appears in the brief of the flow its scope covers and in no other; `coordination-seam.contract.test.ts:74-98` and `coordination-evidence.contract.test.ts:25-51` stay green | Learning slice |
| D4 kill criterion | Written into the learning slice's feature document before the first lesson ships; the verdict comes from the campaign comparison under ADR-0011's conditions. Nothing deletes the kind automatically. | Learning slice |
| D14 gates | A RED test through the lesson kind's public seam: the same data-state fact in runs ending pass, invalid and flaky is admitted in all three, and a left-out fact carries a typed reason. `qa-engine/test/contexts/cross-run-learning/domain/learning-gates.test.ts` pins the per-run gate being replaced. | Learning slice |

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep the skeleton dormant (~1,650 lines returning a constant) | Rejected by D1. The owner's own diagnosis (quoted above) is that deactivated features fall into an outdated and probably incorrect state. |
| Switch the reflector on with better input | Its output is stored unverified, and its prompt asks for rules "general enough to apply across apps" against per-product scope. Input alone does not fix this. |
| Reset the curriculum row and keep the code | The next run adjudicated `app_defect` credits every offered template again (`LEARN/domain/curriculum.ts:95-110`). The mechanism, not the row, is the defect. |
| Keep the per-run verdict and class gates | Rejected by D14: the table of four runs shows the selection is blind to the fact learned. |
| Learn only from clean runs, or only from failures | Either one selects the population by the run's ending; D14 selects by the fact. |
| Let an agent propose the first lessons | Rejected by D4 (no LLM). An agent's stored text gets authority without a check, which is the reflector's failure. |
| Switch the curriculum off now | Rejected by D2. It would change the "before" conditions while they were being measured. |
| Keep delivering lessons to the lead and the reviewer | That is today's state. Lessons reach the lead, the reviewer and, once in an early run, a run-level author, but none of the 111 sidekick author turns that write the flows' specs (evidence above). |

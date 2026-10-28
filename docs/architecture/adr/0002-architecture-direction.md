# ADR-0002: Architecture direction

- Status: Accepted, 2026-10-28, owner. Decided: Decisions 1, 2 and 4, and the owner's agreement to the eight additions (Decision 3). Decided as recommended on 2026-10-28 ([ADR-0013](0013-owner-decisions-remaining-questions.md)): which additions are scheduled (Decision 3), Decision 5 and the Open questions.
- Decision source:
  - The platform plan as the base, the Command pattern dropped, the eight additions agreed: owner, 2026-10-28 13:36Z (quoted below, translated).
  - The work order: owner, 13:08Z (start from the plan) and 13:58Z (the order). No patches on main: owner, 2026-10-28 15:04Z.
  - Only confirmed causes get a fix: D12, approved by the owner on 2026-10-28 at 15:32Z. It covers fixes and family slices, not the structural additions.
  - A single source of truth behind a facade: the owner's idea of 13:08Z, offered for debate and not decided.
- Code references at 4105c582:
  - The plan: `docs/engine-platform-architecture.md:49-68` (dependency rule), `:70-101` (placement rule and decision table), `:155-203` (migration steps 0-6), `:236-245` (completion checklist)
  - Layering rules: `qa-engine/.dependency-cruiser.cjs:36-39`, `:134`, `:141`, `:148`, `:155`, `:165`, `:172`, `:179`; `qa-engine/.dependency-cruiser-shell-exceptions.json`
  - Ownership tests that exist: `qa-engine/test/arch/kernel-owners.test.ts:1-4`, `:33`; `qa-engine/test/arch/context-dependency-graph.test.ts:1-4`; `qa-engine/test/arch/vcs-write-confinement.test.ts:6-8`; `qa-engine/test/arch/exec-launcher-spawn-sites.test.ts:1`; `qa-engine/test/contexts/coordination/application/prompt-registry-rule.test.ts:61-66`
  - The run flow: `qa-engine/src/contexts/run-orchestration/application/run-flow/run-steps.ts:1-9`, `finalize-run.ts:1-8`, `failure-policy.ts:1-9`, `:41`, `:50`, `:56`
  - Evidence for the additions: `qa-engine/src/shared-kernel/ports/suite-store.port.ts:16-30`; `qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts:9`, `:262-263`, `:471-481`, `:504-516`; `qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts:437`, `:484-492`; `qa-engine/src/contexts/coordination/application/lead-sidekicks.ts:678-679`, `:1241-1242`; `qa-engine/src/shared-kernel/last-json-object.ts:31`, `:57`; `qa-engine/src/contexts/objective-signal/domain/decide-coverage.service.ts:24-30`; `AGENTS.md:462`, `:713`
  - The structure that predates the runs: `odd/tasks/arch-p2-run-state-machine.md`, `odd/tasks/arch-p3-hexagonal-recut.md`
- Related: [ADR-0001](0001-design-pillars.md), [ADR-0003](0003-learning-layer-rebuild.md), [ADR-0011](0011-root-cause-fix-policy.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md), [RFC-0003](../rfc/0003-coverage-dump-harvest.md), [RFC-0004](../rfc/0004-log-level-from-outcome.md), [RFC-0005](../rfc/0005-suite-store-single-writer.md), [Rejected explanations](../rejected-explanations.md)

**In short:**

- The base is the engine/platform plan, with its dependency rule, placement rule and migration steps.
- The order is platform steps 0-1, then one slice per confirmed family (H06, H11, H20), then platform steps 4-6. Nothing is patched on main meanwhile.
- The owner agreed to the eight additions (13:36Z). Confirmed hypotheses evidence two of them (fitness functions that enforce ownership, and a policy rule) and two more at one edge (typed outcomes). Three rest on plausible hypotheses only and one on none. The approved order has no slot for an addition without a confirmed family, so this record does not schedule those four. The owner has not ruled (Open question 6).
- The Command pattern is rejected. A single source of truth behind a facade per domain is under debate: the evidence so far does not support it as the general cause of the families, and does not rule it out.

## Context

On 2026-10-28 the owner asked that every decision of this investigation be written down with its reasons, so that the same mistakes are not made again (13:50Z, paraphrased). This record holds the architecture direction.

The investigation produced two results this record depends on:

- **Investigation phase 2:** a taxonomy of seven failure families (F-A to F-G) and 27 consolidated hypotheses (H01-H27), from 29 runs of one app on ten code epochs.
- **Investigation phase 3:** each hypothesis tried by independent refuters. 3 are confirmed (H06, H11, H20), 17 are plausible and 7 are refuted.

Later "phase 2", "phase 3" and "phase 3b" name these investigation phases. P2 and P3 name the architecture remediation's phases (the run state machine and the hexagonal re-cut).

Epochs (On) and run numbers (#n) are the phase 2 timeline's. The 29 runs began on 2026-10-26 at 18:00Z. O4 is runs #10-#12 on engine commit 94f2b45e, O7 is #23 on e4efa50e, O8 is #24 on 27238792.

**The structure the debate asks for largely predates the runs.** The run state machine (a step table with one closed outcome per step, one failure policy, one place where the run ends: `run-steps.ts:1-9`, `failure-policy.ts:1-9`, `finalize-run.ts:1-8`) and the hexagonal re-cut were finished on 2026-10-26, before the first run. The last commit touching the task document of P2 or P3 is 5d719698 (13:16Z), and every task in both documents is checked. That commit and de42bb62 (the P2 verification, 08:56Z) are ancestors of e6c7d095 (17:40Z), the engine head of the first six runs. The failure families occurred on top of that structure.

## Decision

All quotes are the owner's words, translated from Spanish.

### 1. The base is the engine/platform plan

The owner, 2026-10-28 13:36Z: "The unification plan is `docs/engine-platform-architecture.md`" (the path is given relative to the repository). On 13:08Z: "The idea would be to start from this arrangement, then apply all the structural improvements that we debate and approve, integrating the corrections that come out of this process you are doing."

What is adopted, and what holds it today:

| Part of the plan | What is adopted | Held today by |
|---|---|---|
| Dependency rule (`:49-68`) | The engine never imports the platform. The platform reaches a context only through `application/index.ts`, and builds contexts only from its composition root. The agents container shares no code with either. | `no-src-import-in-qa-engine` (`.dependency-cruiser.cjs:134`), `shell-public-surface` (`:165`), `composition-only-from-shell-root` (`:172`) |
| Placement rule and decision table (`:70-101`) | A module goes to the engine if it decides something about QA or belongs to exactly one context. It goes to the platform if the whole process owns it once, or if it only translates the outside world into a call to the engine. Eight ordered questions place each module. | Not held yet. Step 0 writes it into `AGENTS.md` (`:160-163`). |
| Engine layer rules (`:103-125`) | domain, application, infrastructure and composition keep their import limits. | `domain-imports-nothing-outward` (`:141`), `application-not-infrastructure` (`:148`), `cross-context-internals` (`:155`), `no-circular` (`:179`) |
| Platform rules (`:127-143`) | Six subfolders that meet only in `composition/`. | Not held yet. Step 6 adds the rule (`:196-203`). |
| Migration order and per-commit rules (`:155-226`) | Steps 0-6. A commit moves files or changes code, never both. The exceptions list only shrinks. | Process, and the frozen shell exceptions list (`.dependency-cruiser.cjs:36-39`) |

The plan's line is between engine and platform, by ownership: "the line between them is ownership, not behaviour" (`:67-68`). It is not the line between deterministic code and the AI (pillar P2 of ADR-0001), which has no written rule yet (Open question 3).

### 2. The work order

The owner approved the order on 13:58Z: "The order seems fine to me" (translated).

1. **Platform steps 0-1** ([RFC-0002](../rfc/0002-platform-steps-0-1.md)): encode the target in `AGENTS.md` and the inventory, then delete twins and dead code.
2. **One slice per confirmed root-cause family**, each moving out of `src/` what it touches: H06 ([RFC-0003](../rfc/0003-coverage-dump-harvest.md)), H11 ([RFC-0004](../rfc/0004-log-level-from-outcome.md)), H20 ([RFC-0005](../rfc/0005-suite-store-single-writer.md)). Families that phase 3b confirms join this list (D12).
3. **Platform steps 4-6:** shape what remains into the platform subfolders, rename the roots, tighten the gates.

One rule holds throughout. The owner, 2026-10-28 15:04Z: "Do not add more patches to main; keep those discoveries as information for the refactor process" (translated). The working practice that follows is the assistant's, not the owner's words: a defect found meanwhile becomes a RED test in the slice of its family. Example, from the independent verifier's report on the last patches on main (not rechecked in this record): four confirmed blockers in commits c6a37c9a, d3af69c8 and 4105c582.

### 3. The eight additions: agreed; which are scheduled is not decided

Decided 2026-10-28 ([ADR-0013](0013-owner-decisions-remaining-questions.md)): none is scheduled ahead of evidence (Open question 6, option A).

The owner, 13:36Z: "Regarding the 8 points you mentioned as missing, I agree" (translated). On 13:08Z the owner had said to "apply all the structural improvements that we debate and approve" (translated). That is all the owner decided about the additions: agreement, with no condition and no schedule.

This record's reading, not a decision: the owner's criterion that every decision be grounded (ADR-0001 P7) means an addition earns its place through a failure family that shows the need, and the table names that evidence, or says none exists. The approved order (Decision 2) has a slot for confirmed families only. It has no slot for an addition without one. D12 is about fixes and family slices; it is cited here by analogy only. Whether to schedule any addition ahead of evidence is Open question 6.

Verdicts are phase 3's. "Plausible" means a refuter could not confirm: a mechanism holds in the code, but an alternative explanation was not excluded or the harm was not shown.

| # | Addition | Evidence (family or hypothesis, verdict) | Reading |
|---|---|---|---|
| 1 | Value objects and discriminated unions | F-C ("cannot tell" collapses to a benign value). **H20, confirmed:** the restore result cannot say "named but not restored" (`suite-store.port.ts:16-30`); an unreadable blob is skipped and counted in no field of the result (`suite-store.adapter.ts:262-263`, `:471-481`). Plausible: H22 (evidence left out has no type), H25 (post-execution gates compare literals, so `flaky` fell through), H21 (DEV data state). Refuted: H26. | At the edge of one confirmed family. The pattern already exists for faults (`FailureAction`, `failure-policy.ts:56`). RFC-0005 decides whether the restore result takes it. |
| 2 | Domain events with projections | H02, plausible: the run has no read model. A stale-coverage qualifier is written and read by no surface in 9 of 9 runs, but a narrower cause explains those 9 runs as well. | Plausible only. No confirmed family needs an event log: H11 needs a rule from outcome to level. Run events already exist (`run-qa.use-case.ts:486-492`). Not scheduled. |
| 3 | Anti-corruption layer for LLM output | F-D (hand-wired handoffs between the model's answer and the decision). Plausible: H24 (a reviewer finding travels as three parallel optional arrays across six hops; the transport drop was the but-for cause of a verdict inversion in one run, #12 in O4), H12 (no typed read outcome for the agent's answer; "one local bug" is not excluded), H08 (the agent-facing description is hand-written). | Plausible only. Both operative defects are already removed: one scanner for agent output since O7 (`last-json-object.ts:31`, `:57`, `AGENTS.md:713`), citations carried through the review adapter since O8. The refuter's probe still reproduced an inversion for H24 at db041567. Not scheduled. |
| 4 | Specification or policy objects | **H11, confirmed (narrowed):** no rule, type or test derives a log level from the typed outcome recorded beside it. A login failure is an error at `run-qa.use-case.ts:437` and a warning at `:484-492` when the run goes on. A lost flow is a warning (`lead-sidekicks.ts:678-679`) and lost findings are an error (`:1241-1242`), each with a typed decision recorded. Plausible: H19 (the mutation sample has no owner), H17 (a correction finding has no total typed disposition). | Evidenced by one confirmed hypothesis, which needs one rule. Whether the rule is an object or a function is RFC-0004's option analysis; a function is the smaller. Precedent: `DecideCoverageService.blocks` (`decide-coverage.service.ts:24-30`). |
| 5 | Result types with a closed fault taxonomy | A closed taxonomy already exists for faults that reach a step: `FAILURE_KINDS`, `STEP_CLASSES`, `FailureAction` (`failure-policy.ts:41`, `:50`, `:56`), read by one classifier (`:2-4`). The hypotheses that said fault labelling had no owner were refuted: H03 (narrowed to the login adapter's own refused-host rule) and H10 (the run's ending). **H20, confirmed:** a missing store blob is a per-entry read fault with no typed outcome. | No gap shown in the central taxonomy. One edge (H20), for RFC-0005. |
| 6 | Process manager with compensation | **None evidenced yet.** H27 (a session's end has several owners; disposal cascades into in-flight DEV executions) was refuted: it splits into separate mechanisms, and exactly one run (#26) shows a harm through any member. H18 (DEV time has no owner; plausible) is about leases and patience. No title of the 27 hypotheses names a step whose effects must be undone (a reading of the titles, not a recount of their chains). | The run is already a step table with one end. Not scheduled. |
| 7 | One time authority | H16, plausible: the run deadline holds agent turns only, so the DEV re-runs of the value signal run outside it. The code defect was reproduced by a probe; the harm was not shown, because the runs that spent their deadline have a competing cause (time limits raised fivefold outside git; in one of the two runs the DEV re-runs are a co-cause of comparable size). H18, plausible: four places decide parallelism, grants, concurrency and patience from four facts. H14, refuted. | Plausible only. `AGENTS.md:462` already calls the deadline "the one time authority"; H16 says it does not cover those re-runs. Not scheduled. |
| 8 | Fitness functions that enforce ownership | **H20, confirmed:** the only hypothesis where phase 3 judged that one owner would have prevented the failures, and the owner existed ("One writer", `suite-store.adapter.ts:9`; unreferenced blobs removed at `:504-516`). A reset script outside the repository copied the manifest only, bypassing it. **H11, confirmed:** no test pins a process-log level. | Evidenced by two confirmed hypotheses. The precedents confine who may import a module or a capability (`kernel-owners.test.ts:1-4`, `vcs-write-confinement.test.ts:6-8`, `exec-launcher-spawn-sites.test.ts:1`) and keep frozen lists that only shrink (`prompt-registry-rule.test.ts:61-66`). The addition extends the mechanism to the writer of a fact. RFC-0005 and RFC-0004 name their functions. |

Reading the table:

1. **H06 needs none of the eight.** The refuter found that each step already had one owner (the dump harvest, the decode, the size caps) and that the cause is a decision about where the work runs.
2. **H11 and H20 need addition 8.** H11 also needs 4 (one rule), and H20 also touches 1 and 5 at one edge.
3. **Additions 2, 3 and 7 rest on plausible hypotheses only, and 6 on none.** The approved order has no slot for them, so this record does not schedule them; the owner has not ruled (Open question 6). Recommended: they return as RFCs if phase 3b or later runs confirm a family that needs them.

### 4. The Command pattern is rejected

The owner, 13:36Z: "Regarding the Command pattern, if it brings no real value, do not do it. In general it is not about applying patterns just because; each decision must be grounded, and any added complexity, logical or cognitive, must be justified" (translated).

The owner had proposed it on 13:08Z for reversible state transitions and for actions across domains. No hypothesis shows a reversible transition or a cross-domain action failing for want of it (reading of the 27 titles). It can come back only with a failure family that shows the need, under ADR-0001 P7.

### 5. A single source of truth behind a facade: under debate, not decided

Decided 2026-10-28 ([ADR-0013](0013-owner-decisions-remaining-questions.md)): option B of Open question 1, one owner per evidenced fact, held by an ownership fitness function; option A is revisited after the three slices.

The owner, 13:08Z (translated): "A pattern I see is that the Single Source of Truth (SSOT) rule is constantly violated: an architecture where the state and the actions to perform are centralized in their corresponding domain and protected by a facade service that encapsulates the internal logic, so that the consumer does not hold the logic of how to update a state, it only asks for it to be updated. [...] This is my idea of how it should be; it does not mean it is correct. I want you to analyze it and we debate it."

How the owner's whole proposal stands:

| Element of the proposal (13:08Z) | Status |
|---|---|
| Hexagonal architecture with DDD | Decided. It is the engine's architecture today, and the plan extends it to the whole repository (Decision 1). |
| A state machine for the main system | Exists since before the runs (Context). |
| State machines for subsystems that need one | Open. No evidence yet (Open question 4). |
| Command for reversible transitions and cross-domain actions | Rejected (Decision 4). |
| A facade over a single source of truth per domain | **Under debate.** Evidence below. |
| Other useful patterns ("if I am leaving something out, tell me") | The eight additions, agreed by the owner; which are scheduled is not decided (Decision 3, Open question 6). |

**Evidence so far, from phase 3.** The refuters were asked: would one owner (one type and one module that creates, changes and derives this fact, behind one interface) have prevented these failures, or is the bug in the logic that owner would hold (a wrong rule), or in a value (a limit)? Counted over the 27 hypotheses, by final verdict:

| Judgement | Hypotheses | Confirmed | Plausible | Refuted |
|---|---|---|---|---|
| One owner would have prevented it | 1: H20 | H20 | none | none |
| The bug is in the owner's own logic (a wrong rule) | 5: H02, H13, H19, H21, H23 | none | H02, H19, H21, H23 | H13 |
| Mixed | 21: H01, H03-H12, H14-H18, H22, H24-H27 | H06, H11 | 13: H01, H04, H07, H08, H09, H12, H15, H16, H17, H18, H22, H24, H25 | 6: H03, H05, H10, H14, H26, H27 |
| A value or limit; not an ownership matter | 0 | | | |

Every id H01-H27 appears once.

Caveats on the column:

- It is one refuter's judgement (the alternatives lens; the single combined refuter for H25 and H27). The adjudications settled verdicts, not this column. For the five adjudicated hypotheses (H02, H11, H17, H20, H21) it still comes from the alternatives lens, which had refuted each of them.
- 24 of 27 hypotheses are not confirmed, so for them it judges a cause that was not established.
- The question is narrow: one owner behind one interface.

**What the three confirmed causes say:**

- **H20:** one owner would have prevented it, and the owner already existed: the suite store adapter declares "One writer" (`suite-store.adapter.ts:9`). A script outside the repository bypassed it. What failed was enforcement, which is addition 8, not a missing facade.
- **H11:** one owner "would not have prevented anything observed" (refuter). It would need a rule. The only rule in the code (`run-qa.use-case.ts:484-492`) would demote the very lines that surfaced other defects. The missing piece is a rule that an owner would have to hold.
- **H06:** a single owner would not have prevented the stalls. Each step already had one owner, and the cause is where the work runs.

**Structure that predates the runs.** The hexagonal re-cut and the run state machine existed before the first run (Context), and the families happened anyway. That is evidence against "layering plus a state machine is enough". It is not evidence against a single source of truth: the layering rules constrain imports, not who owns a fact.

**What the evidence supports and does not show:**

- Supported: ownership explains one of the three confirmed families cleanly, and there the owner existed.
- Not supported: a single source of truth as the general cause. In two of the three confirmed causes the cause lies elsewhere, and 5 hypotheses locate the bug in the owner's own logic.
- Not shown: that a facade per domain would not help. 17 hypotheses are still plausible, and all 29 runs tested one app (ADR-0001 P5), so absence of evidence is weak.

No decision is recorded. Open question 1 asks for it.

## Consequences

- The plan's rules apply to every commit of this work. `src/` shrinks as each slice lands.
- Additions 2, 3, 6 and 7 have no slot in the approved order, and this record does not schedule them (Open question 6). Each addition that is applied is named in its RFC's Recommendation with the family that shows the need and the smaller alternative considered.
- The order skips plan steps 2 and 3 as whole steps, since each slice moves what it touches (Open question 2).
- The engine/AI boundary stays a review question until a rule is written (Open question 3).

## Enforcement

| Decision | Held by | Not enforced yet |
|---|---|---|
| 1. Dependency rule, engine layers | The rules listed in Decision 1 and `npm run arch:check`, plus `qa-engine/test/arch/*.test.ts`. The shell exceptions list may only shrink (`.dependency-cruiser.cjs:36-39`). | The new vocabulary (`engine/`, `platform/`) and the platform's internal rule: step 6. |
| 1. Placement rule | Nothing. | Step 0 (RFC-0002) writes it into `AGENTS.md`. |
| 2. Work order, no patches on main | Nothing; it is a working agreement. | Not enforced. |
| 3. Additions grounded in a family (this record's reading) | Review under ADR-0001 P7. | Not enforced. |
| 3. Ownership fitness functions | Precedents listed in the table, for imports and capabilities. | The function for each new use is named by the RFC that applies it, with the step that adds it: RFC-0005 (one writer of the suite store), RFC-0004 (log level from the outcome). |
| 4. No Command pattern | Nothing to enforce. | |
| 5. Single source of truth | The ownership fitness functions of row 3, one per evidenced fact (option B, [ADR-0013](0013-owner-decisions-remaining-questions.md)). | Option A is revisited after the three slices. |

## Alternatives considered

- **Family slices before platform steps 0-1.** Not chosen: the owner approved the order in Decision 2 (13:58Z). The plan puts deletion first because it "shrinks everything that follows" (`docs/engine-platform-architecture.md:167-169`).
- **All of the plan's steps 2 and 3 before the slices.** Not chosen in the approved order; Open question 2 asks what replaces them.
- **A single source of truth behind a facade as a general rule, now.** Not decided (Decision 5). Open question 1 sets out the options.
- **All eight additions as a framework before any family.** Not chosen: ADR-0001 P7 asks that every decision be grounded, and the approved order has no slot for it. The owner has not ruled on scheduling (Open question 6).
- **The Command pattern.** Rejected by the owner (Decision 4).

## Open questions

Decided 2026-10-28: each recommended answer below is accepted ([ADR-0013](0013-owner-decisions-remaining-questions.md)).

1. **A single source of truth behind a facade: a general rule, or an owner per evidenced fact?**
   - A: a general rule. Every domain's state and actions sit behind a facade and a state machine. Cost: a large change before the evidence supports it as the cause of most families.
   - B: an owner per evidenced fact, held by an ownership fitness function (H20 now, H11 next). Cost: ownership gaps that are still only plausible go unfixed until confirmed.
   - C: no new rule beyond the plan.
   - Recommended: B, and revisit A after the three slices, once the plausible hypotheses have been re-tested out of sample.
2. **Who moves what no slice touches?** The approved order skips plan steps 2-3 as whole steps (plan, `docs/engine-platform-architecture.md:172-186`). The plan's completion checklist still requires that "No module in `platform/` holds a decision about a run" (plan `:240-241`), and step 4 regroups "what remains" (plan `:187-191`). Hypothesis: a module that holds a decision no family touches would stay in `src/`. Recommended: after the slices, run plan steps 2-3 over the rows of the step 0 inventory that remain, before step 4.
3. **Where is the engine/AI boundary written?** Phase 3 tagged the hypotheses: 2 engine-should-decide (H01, H24), 3 agent-should-judge-with-facts (H08, H12, H15), 5 signal-instead-of-threshold (H07, H19, H21, H23, H27), 6 mixed boundary (H03, H05, H14, H16, H17, H18), 11 not involved. Recommended: one table in `AGENTS.md`, one row per decision, saying engine, agent with facts, or signal. Each RFC adds the rows for the decisions it touches. No up-front inventory.
4. **State machines for subsystems beyond the run.** No evidence yet. Recommended: none until a confirmed family shows a subsystem with ill-defined states.
5. **What promotes a plausible hypothesis to a design?** D12 fixes only confirmed causes, and phase 3b (narrowed candidates and their independent refutation) is in progress. Recommended: a plausible hypothesis returns to design only after a refutation on runs not used to form it, as phase 3b does.
6. **Schedule any of additions 2, 3, 6 and 7 ahead of evidence?** The owner agreed to all eight additions (13:36Z) and set no order for them. The approved order (Decision 2) holds platform steps and confirmed family slices only. A: schedule none until a confirmed family needs one. B: schedule the ones that rest on plausible hypotheses (2, 3, 7) as RFCs now. C: schedule all four. Recommended: A, and revisit after phase 3b. Cost of A: a plausible gap stays open until confirmed. Cost of B and C: structure added before a failure shows the need (ADR-0001 P7).

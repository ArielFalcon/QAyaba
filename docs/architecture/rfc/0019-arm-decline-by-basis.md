# RFC-0019: An arm no test can take leaves the regeneration by a decline the engine checks

- **Status:** Accepted, 2026-11-01, by the parent orchestrator under the owner's mandate to fix the branch gap's mechanisms at root, recorded in [ADR-0026](../adr/0026-arm-decline-under-the-root-cause-mandate.md); open to the owner's revision. The recommendation, option B, is taken because the code showed nothing unsafe in it (see "Safety check").
- **Code references at cb72b618** (the base of this change).
- **Implementation:** the feature document `odd/tasks/branch-gap-mechanisms.md` (S7, T4).
- **Related:** [ADR-0001](../adr/0001-design-pillars.md) (P2 the engine/AI boundary by rules, P7 justified complexity), [RFC-0006](./0006-review-answer-crosses-whole.md), [RFC-0018](./0018-agent-answers-are-submissions.md), `plan-coverage.ts` (`honorContradictedDrops`), `shared-kernel/drop-basis.ts`.

## Summary

1. The branch gap hands the lead one finding per decision whose arms no test ran. Some of those arms cannot be taken by a test on DEV: a state or a response DEV does not return, a branch no browser action reaches. The lead can answer such a finding only by routing it to a flow (a revision turn that spends the sidekick's time and the run's correction budget on an arm that cannot be taken) or by saying so in prose that nothing reads (`COVERAGE_RULE`, `lead-correction.ts:43`: "change nothing for it and say so in `concerns`").
2. The lead's correction answer has no way to decline a finding: rebuttals are refused for every origin but the reviewer's (`lead-correction.ts:328-329`) and the wire has no decline (`lead-correction.contract.ts`). The plan turn already has the decision, for a use case: `dropped[]` with a basis from a closed set the engine holds to its facts, asked once and then honoured and recorded (`planCoverage`, `honorContradictedDrops`).
3. Decision: the correction answer gains `declines[]`, `{ finding, basis, reason }`, for the findings about a decision's arms, with the plan's basis vocabulary (one vocabulary) and the plan's rule (one check, asked once, then honoured and recorded). A declined arm leaves only the regeneration: it stays in the measurement, the PR, the Issue and every grader input, marked declined with its basis.

## Problem

The decision "this arm needs no test" is the lead's: it reads the change map, the Context Pack and the code graph, and the unit it is shown now carries the arm's source line and where its file is reached (feature document S6). The engine has no fact that says an arm cannot be taken, so it cannot make that decision alone (ADR-0001 P2: the agent judges from facts the engine hands it, and the engine admits or verifies the answer). What is missing is the channel for the judgment.

Without it every untaken arm that reaches the lead is either routed to a flow, which then spends a revision turn on it, or lost in prose. The routing counts as the lead's "correction" and as the flow's time, and the arm is recounted afterwards as untaken, so the next run asks again.

Evidence (feature document L2, L4): in runs `run-ed28973-mvxa8pvu-d4386ad1` and `run-ed28973-mvxbr8hz-82848d23` the reviewer classified the untaken arms by what could close them; only one class was closable by a test. The proportions are this app's and are not a design input; the missing channel does not depend on the app.

## Options

- **A. Keep the prose channel.** The lead says it in `concerns`; the sidekick reads it. Not chosen: nothing reads a lead's prose (the answer is a typed submission since RFC-0018), no record says an arm was set aside, and the flow is still ordered to revise.
- **B. A typed decline with the plan's basis vocabulary, checked by the engine (chosen, recommended).** `declines[]` in the correction answer, read for the findings about a decision's arms of the change-coverage origin. The basis is one of `DROP_BASIS`; the engine holds it to its facts through the same rule a drop is held to (`dropRefusal`) over the use cases the arm's file seeds; a basis the facts contradict is asked about once and, if kept, honoured and recorded as contradicted, never an error.
- **C. The engine decides alone.** A rule from the run's facts (the arm sits on a page read as a confirmed empty state, say) removes the arm from the gap. Rejected: the facts the engine holds say where an arm is reached, not that no test can take it (a confirmed empty state is DEV's data of the moment), and a size or ratio threshold is excluded by P2.
- **D. A new vocabulary for arms.** Rejected: a second closed set of reasons beside `DROP_BASIS` would drift from it, and the three bases already say what an arm needs (a state this run cannot reach, a change nothing observes, a case the suite already proves).

## Design

**The wire.** `LEAD_CORRECTION_WIRE` gains `declines`: `{ finding: int, basis: DROP_BASIS, reason: string }[]`, optional, beside `corrections` and `rebuttals` (`lead-correction.contract.ts`). The tool's argument schema is rendered from it (`npm run submit-contracts:gen`), as every contract.

**What may be declined.** Only a finding about a decision's arms that the change-coverage measurement found untaken (`CorrectionFinding.declinable`, set by the gap's decision units and by nothing else), in a turn of the coverage origin. A decline of any other finding is a contract error returned inside the turn with the number and why (the reader's `unreadable`, as a finding that is not of the turn); declines in a turn of another origin are refused with the reason rebuttals are (`rebuttable`). A finding that is also ordered to a flow is not declined: the order stands and the decline is refused with that reason.

**The check.** `armDeclineRefusal(candidates, basis)` (`shared-kernel/drop-basis.ts`) says why the facts contradict the basis, or nothing: for the use cases the arm's file seeds (`candidatesSeededBy`), the decline is contradicted only when `dropRefusal` contradicts it for every one of them, because one use case of the file that the basis does hold for is enough for the basis to be true of the arm. A file that seeds no use case contradicts nothing. `needs-unavailable-state` names a state the orchestrator cannot see, so it stands, as for a drop.

**Asked once, then honoured.** A decline the facts contradict goes back to the lead in the one re-ask the turn already has (`assembleRefusedCorrection`), with the fact; the lead may keep it, route the finding to a flow, or drop it. What stands after that is honoured and recorded as contradicted (`contradicted` on the decline, `declined` count on the pass's tally), never an infrastructure error and never a reason to ask again. A re-ask the run has no time for leaves the first answer standing.

**What a decline does.** A declined finding is sent to no flow: no revision turn, no maintenance flow, no flow opened for the use case its file seeds, and it is not counted unrouted (it was decided). A flow whose findings are all declined gets no turn; when no finding is left to route and no surviving mutant is routed, the step ends on its existing empty outcome (`regenerateAtGap`: no specs delivered), with no acceptance and no new measurement.

**What a decline does not do.** The arm stays in `state.coverage.untakenArms`, in the ratio and the grader inputs (`branch_coverage_ratio`, `survivors_routed`, the enforce gap's reading), in the survivor closure and in the PR and Issue listings. The record marks it: `gateSignals.branchCases.decisions[].declined = { basis, contradicted? }`, and the PR or Issue line of a held run says `declined: <basis>`. Whether an arm was declined never changes a verdict.

**Engine/AI boundary** (`AGENTS.md`): "Whether an arm no test took needs no test": decides the agent with facts; the rule is this section; status in force.

## Safety check (the recommendation is taken unless the code shows it unsafe)

- **Does a decline change a verdict, a gate or a grader?** No: `DecideCoverageService.blocks` reads the line ratio and the status, not the arms; the branch ratio is signal-only (`gateSignals.branchCoverage`); `untakenArms` is not edited by the pass. Checked by a test that runs the step with a declined arm and compares the recorded arms with a run that declined nothing.
- **Can a lead decline everything to skip work?** It can decline what it likes; each decline carries a basis, the engine contradicts and records the ones the facts refuse, the number is on the record (`declined`, `contradicted`), and the arm is recounted untaken, so the next run asks again. The campaigns read the rate from the record; no threshold is added.
- **Does it add a second reading rule?** No: the admission is the correction reader's, the basis is the plan's closed set, the check is the plan's `dropRefusal`; none is copied.
- **Does it widen what the lead can write?** No: the lead stays read-only; the submit tool writes nothing.
- **A stored run:** a run without `declined` reads as it did; the field is optional everywhere.

## Differential check

For each reader the change touches (`admitLeadCorrection`, the correction contract's `check`), a test runs the answers the previous reader admitted (corrections only, corrections with rebuttals, an order with findings of a coverage turn) and compares the admission with the previous reader's, taken from the base commit in a scratch copy; any difference is a regression. A coverage turn answered with no `declines` produces the admission it did.

## Owner decisions needed

1. Whether a decline of an arm should ever remove the arm from the PR or Issue listing. This RFC keeps it listed, marked (the owner's constraint: no feature is removed, nothing leaves the measurement). Changing it later is a render change only.
2. Whether `needs-unavailable-state` should be verified by a fact (the arm's page read as a confirmed empty state on every read) instead of standing. Left as the plan leaves it; revisit when a campaign shows declines of this basis that a fact could have refused.

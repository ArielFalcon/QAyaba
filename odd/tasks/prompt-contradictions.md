# Prompt contradictions

Objective: remove the 14 contradictions the 2026-11-01 audit confirmed between the agent prompts and between the prompts and the code, without moving any responsibility between the engine and the agents.
Branch: main (owner rule: single branch). Delivery: ask-on-risk. Runner: `npm test -- <files>` (Node v24).

## Specs

- **S1** [no-cleanup]: with no delete affordance the reviewer emits no `[no-cleanup]` correction, since `effectiveFinding` raises that tag to blocking (`verdict-validate.ts:16-19`). The code's anti-downgrade guard stays.
- **S2** expected values: the behaviour a test expects comes from the contract or the commit's intent; the exact string the app renders for it is read from the page after the step that produced it (`brief-sections.ts:69`, `authoring-failure` feedback, `agents/AGENTS.md:35-41`).
- **S3** a flow's task closes by calling `submit_result` (`author-task.ts:36-37`).
- **S4** rebuttals are the run's own task's; in a flow a finding held wrong goes in `concerns` (`qa-author.md` §6).
- **S5** app at fault: a failed `run_spec` call whose facts the orchestrator classifies as an app defect says so in its answer (`note`), and the author delivers that spec as it is instead of spending calls (author task, `qa-author.md` §4 and the closing rule).
- **S6** a spec sent back with no `run_spec` call left is told to correct from the failure, not to run (`verifyInstruction`); `qa-lead.md` states that a spec whose last call failed is not accepted either.
- **S7** the DEV-limits line tells the lead to accept the flow; the criterion is recorded as a DEV limit (`lead-turn-sections.ts:155`, `docs/lead-sidekicks.md:222`).
- **S8** when the prompt lists use cases, the lead is told a no-op is held as dropping each with `no-observable-change`, so use cases DEV cannot show are dropped with `needs-unavailable-state` in a plan of no flows; the no-op keeps its second reason for a prompt that lists none (`qa-lead.md`, L4).
- **S9** `browser-conditions.md` names no `mobile` project; emulation is per file, without grounding.
- **S10** the `test-value-review` verdict example is the structured, cited shape.
- **S11** the scoping example of `locators-and-waiting.md` uses no `..` (XPath).
- **S12** the proposer orients with Serena before glob/grep, as the AGENTS.md orientation rule it cites says (the citation is pinned, L4).
- **S13** context mode maps every route and every operation with an `operationId` (the skill matches `qa-author.md`).
- **S14** the reviewer is told it gets the orchestrator's captured facts, not the author's reasoning or exploration.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S10, S14 | inline | done: `qa-reviewer.md`, `test-value-review` example | — |
| T2 | S2, S3, S4, S5 | inline | done: `agents/AGENTS.md`, `brief-sections.ts`, `authoring-failure.ts` (both), `author-task.ts`, `qa-author.md`, run_spec note in `closed-loop-port.adapter.ts` with RED/GREEN in `closed-loop-port.flow.test.ts` | — |
| T3 | S6, S7, S8 | inline | done: `qa-lead.md`, `verifyInstruction` with RED/GREEN in `lead-review.test.ts`, `lead-turn-sections.ts`, `docs/lead-sidekicks.md` | — |
| T4 | S9, S11, S12, S13 | inline | done: `browser-conditions.md`, `locators-and-waiting.md`, `qa-proposer.md`, `architecture-mapping/SKILL.md` | — |
| T5 | all | inline | done: both baselines re-recorded with a reason, submit contracts regenerated, lint 0 findings, focused tests 3288/3288; full gate in L5 | — |

## Log

- **L1** (2026-11-01, owner, verbatim): "Aplica las 14, revisa que la solución sea la optima para el cuadro general del funcionamiento de la app".
- **L2** (2026-11-01, decision): S1 is fixed in the prompt, not by making `no-cleanup` recoverable: `cc1511d2` forced grave tags to blocking so a reviewer cannot downgrade a real one, and a downgradable `no-cleanup` would reopen that hole where a delete affordance exists. S5 puts the fact in the tool's answer instead of asking the author to judge a 5xx it cannot see: the report's failure facts (`httpStatus`, `runtimeErrors`) are kept for the orchestrator only, and the use case already speaks through `note` from facts (lost session, timeouts). S8 keeps the code: `impliedNoopDrops` cannot infer a basis, and a plan of no flows already carries typed drops (`lead-plan.ts:258-263`). S13 picks "every route": the map feeds route ranking and the context-map validity check, which miss what the map omits.
- **L3** (2026-11-01, out of scope, reported): `qa-author.md` context mode names "Angular routing files", an app-stack-shaped instruction against the golden rule.
- **L4** (2026-11-01, two decisions revised from the code's own guards): (a) the lead's no-op keeps its second reason: `prompts.no-op-reasons.test.ts` pins it, and `213e9830` added it so a change DEV cannot show ends as a decision, not `E-NO-DECISION`; that exit is still the only one when the prompt lists no use case. Only the case with listed use cases, where `impliedNoopDrops` applies `no-observable-change`, is redirected to typed drops. (b) The proposer's "(see AGENTS.md)" is not dangling: `agents-prompts.test.ts:637-644` pins it as the citation of the orientation rule; the step now agrees with that rule (Serena first).
- **L5** (2026-11-01, verification): RED observed and GREEN for the two code changes (the app-defect note: HTTP 503 says it, 404 does not; the spent-calls instruction). Prompt lint 0 findings over 8,168 combinations and 15 coordination prompts. Focused tests (prompt contracts, agents prompts, coordination, agent-tools, generation) 3,288/3,288. Static layers: author 24,625 → 25,186 B, lead 15,171 → 15,397 B. Risk: none of items 1-5; item 6 in part (prompt text is guarded by the size baselines and pinned phrases, its effect on agents is measured by the next campaign run).
- **L6** (2026-11-01, full gate): typecheck, arch:check, seed:lint, embedded:lint, sdk:typecheck, contract:check, settings:check, submit-contracts:check pass; `npm test` 12,508/12,512 (2 skipped, 2 failed). Neither failure is this change's: `no-model-literals.test.ts` reads the gitignored local build `web/dist/js/*.js` (2026-09-18); `agent-browser-port.adapter.test.ts` "an ended session closes its page and stops its call" failed once under the parallel suite and passed 3 of 3 alone (a file this change does not touch). `previous-forms:check` keeps the 4 `legacy` hits of RFC-0016 committed in `cfc69e3b`. Nothing committed.

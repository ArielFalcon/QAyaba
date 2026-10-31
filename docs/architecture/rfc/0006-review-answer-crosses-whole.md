# RFC-0006: The reviewer's answer crosses to the decision whole (N02)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/contexts/generation/application/ports/review.port.ts`, `qa-engine/src/contexts/generation/domain/manifest-repository.ts`, `qa-engine/src/contexts/generation/domain/review-output.ts`, `qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts`, `qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter.ts`, `qa-engine/src/contexts/generation/application/generate-tests.use-case.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review-services.ts`, `qa-engine/src/contexts/run-orchestration/domain/review-finding-filter.service.ts`, `qa-engine/src/contexts/run-orchestration/domain/review-action.ts`, `qa-engine/src/contexts/run-orchestration/application/accept-delivered-specs.use-case.ts`, `qa-engine/src/contexts/evaluation/domain/graders.ts`, `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts`, `src/integrations/verdict-validate.ts`, `src/orchestrator/schemas.ts`, `agents/agent/qa-reviewer.md`, `AGENTS.md`, `qa-engine/test/contexts/generation/infrastructure/adapters/review-port.adapter.test.ts`, `src/integrations/verdict-validate.test.ts`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md) (addition 3), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0004](./0004-log-level-from-outcome.md) and [RFC-0008](./0008-acceptance-records-what-it-ran.md) (edit `review.steps.ts` at other lines; [Correction 2026-10-29: the order is not free: the RFC-0008 slice's test fake (`run-qa.closed-loop.test.ts`) returns the old reviewer shape, `corrections`, and this RFC changes the shape to `findings`, so whichever slice lands second ports that fake; applied together they failed to compile (TS2322) and failed two tests]), [Rejected explanations](../rejected-explanations.md). It belongs in the same slice as none of [RFC-0003](./0003-coverage-dump-harvest.md), [RFC-0004](./0004-log-level-from-outcome.md) or [RFC-0005](./0005-suite-store-single-writer.md).

## Summary

1. Cause N02 (the narrow form of H24), confirmed: at O4 to O7 the review adapter returned a narrower object than the parser built, so every reviewer finding reached the evidence filter uncited and every model rejection became an approval (runs #12, #19, #21, #23; 4 of 4 rejections). Main fixed that hop (`1ff84710`, pinned by `review-port.adapter.test.ts:638-657`).
2. What is alive on main is the class: the engine fills in what the agent did not send (`review.steps.ts:254`, `:286`) and reads what it could not read as the agent's silence (`schemas.ts:545`, `:586`). A replay on 4105c582 turns a model rejection into an approval for a malformed entry, a malformed citation and a port that omits the lists. No stored answer has triggered any of these (0 of 59 entries).
3. Proposal (O3): the answer crosses as one required list of findings that has no place for a made-up value; an entry or field the engine cannot read makes the answer unreadable, which the existing repair turn and the existing parse miss already handle (one re-ask, then fail closed).
4. No new module, no new run ending, no new pattern. The designed rule (a finding the agent left uncited cannot block) is untouched.
5. Five forks are the owner's (F1 to F5). Nothing is patched on main.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at 4105c582, the run record was read, or the code was run); a hypothesis is marked.

### The cause, as confirmed

The agent's structured rejection crossed to the engine, and an engine-side step discarded or replaced part of it. The record then named the model as the author of the engine's result (`decided_by` model, rationale beginning "Rejected:"). Both refuters confirmed the chain at three epochs and replayed the real epoch code on the stored answers. The outcome-level role differs by run, so the claim is the record's, not the verdict's:

| Run | Epoch (engine commit) | Raw reviewer answer | Recorded decision | Role of the adapter loss |
|---|---|---|---|---|
| #12 `run-ed28973-mvpoyt4e-6b1ff206` | O4 `94f2b45e` | `approved: false`, 4 entries | approved, blocking 0 | but-for: only the adapter fix flips it |
| #19 `run-ed28973-mvq9r6vy-7f454004` | O6 `f96f958f` | `approved: false`, 3 entries | approved, blocking 0 | acted first; the path compare of that epoch (fixed in O7, `8c506286`) would also have dropped it |
| #21 `run-ed28973-mvqc7x8j-2da31df4` | O6 `f96f958f` | `approved: false`, 5 entries | approved, blocking 0 | same as #19 |
| #23 `run-ed28973-mvqy1s7l-64c65862` | O7 `e4efa50e` | `approved: false`, 6 entries | approved, `dropped_blocking=6`, `drop_reasons=uncited=6` | record only: the approval stands under the designed DOM-only rule |

The raw answers and the recorded decisions in the table were re-read from the history database for this record. Controls: #25 (O9) and #27 (O10) ran the fixed adapter and recorded `rejected`, blocking 2 each; the replay of the O4, O6 and O7 adapters on their stored answers reproduces `approved` with `uncited` equal to the entry count.

**What it does not explain.** #19 and #21 (second sufficient cause), #23's outcome (designed rule), whether any of the four rejections was right (not enough evidence), the model-approved reviews at O4 to O7, and any run with a clean time-limit setting: all four ran under the hard-limit experiment kept outside git. The chain after the reviewer turn is a pure function of the answer, the run's spec scope and constants, and the replay reproduces the recorded values, including `uncited=6`; the confound can change how often the reviewer rejects, which this record does not claim.

### The chain, and the same form at the sites main still has

Cause removed on main: the adapter returns the port's full type and forwards both lists (`review-port.adapter.ts:67`, `:170-171`). The class is alive at the sites below. Each was opened at 4105c582; the last column is the observed result of running the real chain (parser, adapter, step, filter) on a synthetic answer or port result.

| # | Site | What the engine does | Observed on 4105c582 |
|---|---|---|---|
| S1 | `review.port.ts:17-18`, `manifest-repository.ts:17-19`, `verdict-validate.ts:56-58` | both lists are optional and parallel to `corrections`; an adapter that omits them compiles | a port result with two blocking corrections and no lists: **approved**, `uncited=2` |
| S2 | `review.steps.ts:254`, `:286`; `review-output.ts:87` | the step gives an absent severity the value "blocking"; the parser gives it "advisory". Two defaults, opposite directions, for one field. `:255` and `:287` attach a citation only when present | a port result whose `severities` has one entry for two corrections: the second severity becomes "blocking" and the round is **rejected**, blocking 1 |
| S3 | `schemas.ts:586` | an entry the schema cannot read (no `severity`, or a severity outside the enum) becomes the text "(unparseable correction)", severity blocking, no citation. The agent's text and citation are lost | a rejection whose only entry has no severity: **approved**, `dropped_blocking` 1 `uncited=1`. The comment at `schemas.ts:577-583` says this fails closed; the filter at `review-finding-filter.service.ts:97-98` reverses it |
| S4 | `schemas.ts:545` | a citation with a kind outside the enum, or a non-text `ref`, becomes "no citation" | a rejection with `citation.kind: "network"`, or `ref` a number: **approved**, `uncited=1`. The record says the agent cited nothing; it cited something the engine could not read |
| S5 | `schemas.ts:587` | `corrections` that is not an array becomes `[]` | `approved: false` with a string for `corrections`: outcome **rejected**, blocking 0, no finding |
| S6 | `verdict-validate.ts:99` | a schema failure returns `approved: false`, `corrections: []`, with `parsed: true` and `valid: false`; the adapter reads only `parsed` (`review-port.adapter.ts:136`, `:161`), and no reviewer path reads `valid` | `approved: "false"` (a string): outcome **rejected**, blocking 0, no finding. By code reading (hypothesis, not run), round 0 then goes to a correction with nothing to correct (`review-action.ts:35-39`) |
| S7 | `review.steps.ts:251` | the missing-case extraction runs only when `citations` is present | at O4 to O7 it never ran (code fact; its impact is unmeasured, hypothesis) |

S1, S2 and S7 are the hop's own form. S3 to S6 are the same form inside the parse. They are exercised by the replay and not by any run (next section), so whether they belong to the confirmed cause is F1.

**The mixed case.** `approved: true` with one unreadable entry and nothing else is **approved** on 4105c582 (`dropped_blocking` 1, `uncited=1`). The guard that test `verdict-validate.test.ts:319-343` pins ("a malformed element must keep the gate closed") does hold when a readable blocking sibling exists, because the sibling blocks. It does not hold when the unreadable entry is the only one: the later filter defeated the guard's purpose.

**Why the detector stayed green.** `graders.ts:97-102` treats only an `unresolved` drop as contradicting an approval; `uncited` is read as "the evidence policy working as designed". A loss on the engine's side is recorded under the agent's reason, so `approval_consistent` is true for #12, #19 and #21.

### Are the residual sites live? No stored answer has triggered one

The history database holds 24 reviewer turns, 21 of them with a verdict object and 59 entries. A shape scan (mine, not the engine's reader) finds 0 plain strings, 0 entries without a severity, 0 severities outside the enum, 0 uncited entries, 0 malformed citations, 0 non-boolean `approved` and 0 non-array `corrections`. The baseline `run-ed28973-mvs7oo0f-17041c71` (4105c582) delivered its two reviewer answers whole: round 1 recorded `rejected`, blocking 1, round 2 `approved`. So S3 to S6 are latent (code and replay fact, 0 runs); the hop was live at O4 to O7.

### Where it sits among the other records

- **N01 (H12), removed at the root on main.** Another engine-side loss presented as the agent's own result: the sidekick reader took the first `{` of the turn, and a valid closing answer was recorded as the sidekick's `failed`. The seam is different (where the answer is found, not what is in it), the function is different, the epochs are different, and its fix (one scanner, `AGENTS.md:713`) does not touch this chain; the reviewer verdict already reads through that scanner (`verdict-validate.ts:68`). They share one principle, and `AGENTS.md:713` already states half of it for sidekicks: an unreadable answer is recorded as unreadable, distinct from the agent's own word, and fails closed. This RFC applies that to the reviewer's fields.
- **H24, plausible, of which N02 is the narrow confirmed form.** H24 claimed that a finding has no single typed owner across six hops and that a missing citation is read as an uncited finding. The owner thesis of its refuters was mixed: one typed value would have prevented the hop, not the second cause of #19 and #21, and not the rule that reads lost evidence as silence. This RFC takes from H24 only what N02's chain needs. The rest of H24 (the citation union declared in several places) stays an open question. ADR-0002 addition 3 (an anti-corruption layer for model output) rests on H24, H12 and H08. This RFC applies its narrowest part, a typed read at one seam, and schedules nothing else; whether addition 3 is justified as a general layer stays Open question 6 of ADR-0002.

## Goals and non-goals

**Goals**

- No engine default stands in for a field of an agent's answer.
- A loss between the parse and its consumer is loud and is never an approval.
- A narrowing or omitting adapter does not compile.

**Non-goals**

- The designed rule: a finding the agent left uncited, cited out of scope, or backed only by the DOM cannot block (`AGENTS.md:170`, `qa-reviewer.md:123-124`).
- Which reviewer findings are right.
- Other agents' answers (see Out of scope).

## Options

### O0. Nothing more

Main has the adapter fix and its test.

- **Removes:** nothing further.
- **Adds:** nothing.
- **Risk:** S1 to S7 stay. A future dropped key compiles and falls back to the defaults of S2 (the guard is one test of one adapter, `review-port.adapter.test.ts:638-657`).

### O1. Required lists on the port (the hop only)

`severities` and `citations` become required on the port result, `ReviewJudgment` and the parser's verdict.

- **Removes:** S1 (a narrow adapter fails to compile).
- **Adds:** no module. The parallel lists stay, so alignment by index still rests on `boundReviewFindings` (`review-output.ts:69-90`).
- **Risk:** S2 stays as defensive code that compiles; S3 to S7 stay.

### O2. One required list of findings

The port result, `ReviewJudgment` and the parser's verdict carry `findings`, each `{ text, severity, citation? }`, with `severity` required. The three parallel lists and the step's two re-zips go.

- **Removes:** S1, S2 and S7 (the arm check reads the findings). The two opposite defaults have nothing left to default.
- **Adds:** a type, and one function that derives the text list where a list of strings is still handed to the generator.
- **Risk:** it touches the parser, both adapters, the step and their tests; S3 to S6 stay.

### O3. O2 plus: what the engine cannot read makes the answer unreadable (recommended)

The reviewer-verdict schema loses its three tolerances for entries (`schemas.ts:545`, `:586`, and the plain-string arm, F3). The parser reports `valid: false` with the schema's issues. The adapter treats `parsed && valid` as the answer being readable: otherwise it asks once for the verdict again with the issues (`RepairPort.instruction` already takes them, `generate-tests.use-case.ts:26`, used for the generator at `:278`), and an answer still unreadable is the existing parse miss: `approved: false`, `parsed: false`, fail closed, no round burned (`review-port.adapter.ts:161`, `review-action.ts:32`).

- **Removes:** S1 to S7.
- **Adds:** one condition in the adapter (`!readable`), a parameter change in a call that exists, and the deletion of the tolerances. One bounded attribute on the decision span (F5).
- **Risk:** it reverses two deliberate choices, named under "Patches it supersedes". A malformed advisory note in an approving answer now costs a repair turn (at most the repair cap, `REPAIR_TURN_TIMEOUT_MS`, 2 minutes) and, if the model repeats it, a fail-closed round. The stored answers show 0 such entries in 59, so the cost is nil today (hypothesis for another model or app).

### O4. O3 with a new run ending for an unreadable answer

A typed `review-unreadable` ending instead of reusing the parse miss.

- **Removes:** the same sites.
- **Adds:** a run ending, an error code and a path through `finalizeRun`. A product decision.
- **Risk:** the parse miss already fails closed without publishing and without an Issue on a green run [Correction 2026-10-29: false for an approval. An approval with one malformed advisory entry became an Issue instead of a PR. The owner decided on 2026-10-29: beside an approval an unreadable entry is recorded and the approval stands; a rejection repairs once, then fails closed as a parse miss. Fix commits on the slice branch: `b138043e`, `fed90885`]; a second ending needs an evidenced difference, and none is shown.

## Recommendation

**O3**, with F1 to F5 answered as recommended below.

**The change**

1. **One value.** The reviewer's answer is read into `{ approved, rationale?, findings }`. A finding is `{ text, severity, citation? }`. `citation` absent means the agent sent none. A value the engine could not read has no representation, so it cannot be mistaken for the agent's silence. The pre-check's and the filter's results are the engine's own and keep `decidedBy` (`review.steps.ts:209-216`) as their author.
2. **No zip, no default.** `review.steps.ts:251-256` and `:284-288` read `findings`; the filter already takes this shape (`CitedFinding`, `review-finding-filter.service.ts:24-29`). After the filter the result carries the verified findings, and `:320-321` (constants written over severities and citations; nothing reads them after the filter, by a search of `.severities` and `.citations`) goes.
3. **Unreadable is a parse miss.** As O3. [Correction 2026-10-29: beside `approved: true` an unreadable entry is recorded and the approval stands (owner decision, see O4's risk note); beside `approved: false` the answer repairs once, then fails closed as a parse miss.] A non-array `corrections` beside `approved: true` stays tolerated and is recorded (F4); beside `approved: false`, or with a non-boolean `approved`, it is unreadable.
4. **The record.** The decision span carries the parse issues, bounded (F5), so the loss has a name of its own instead of `uncited`.

**Why it is the smallest change that removes the cause at every site of its class.** The seven sites have one defect: the seam between the agent's JSON and the decision admits an "absent" that does not say whose absence it is. O3 allows an absence only where the agent chose it (an entry with no citation) and routes every other absence to a mechanism that exists (the contract repair and the parse miss, `AGENTS.md:161`, `:468`). Most of the change is deletion: two defaults, three tolerances, two conditional spreads (`review-port.adapter.ts:170-171`, `verdict-parser.adapter.ts:133-134`) and one zip. It adds no module, no pattern and no run ending. O1 closes the hop and leaves the defaults and the reads; O4 adds a product decision without an evidenced difference. It meets the owner's test of 2026-10-28 (translated): "each decision must be grounded and any added complexity (logical or cognitive) must be justified". The ground is four rejections turned into approvals at three epochs by the hop, and a replay of the same form at S3 and S4 on main.

**Why it is app-agnostic.** Nothing in the chain reads the app, a route, a spec name or the model. The reviewer's output contract is the engine's own and is the same for every app (`qa-reviewer.md:107-124`). On another app the mechanism shows the same way: any reviewer entry whose field the schema rejects (a framework's spec naming, a backend's different findings) is replaced by the placeholder or by "no citation" and dropped. The evidence is one app's (name-webapp, ADR-0001 P5), and the rate of unreadable entries on it is 0 of 59; on an app or a model that writes more of them, the loss would be approvals.

**Where it lives.** Engine, in the `generation` context: the reviewer-verdict schema (`schemas.ts:536-590`) and the reviewer half of `verdict-validate.ts` (`:50-100`) decide something about a run, which is row 3 of the decision table (`docs/engine-platform-architecture.md:84-97`; RFC-0002 already places `verdict-validate.ts` in row 3 and splits `schemas.ts`). They move with this change, as the work order asks (hypothesis: the module placement is RFC-0002 step 2's to confirm). The port stays declared by its consumer, `review.port.ts`. The change follows platform steps 0-1 in the approved order and ships as its own commit with its tests.

Correction 2026-10-30 (checkpoint 3, C-J2): the schema and `verdict-validate.ts` did not move. The change landed as `aa34ddc6`, `b572d49f` and `aac2c0e3` (re-applied from `4542a739`, `b138043e` and `fed90885`), and at 17bb77c1 `ReviewerVerdictSchema` is still in `src/orchestrator/schemas.ts` and the reviewer half of the validation is still in `src/integrations/verdict-validate.ts`. The move to the `generation` context is platform step 2's, over the inventory rows no slice moved (feature document, T13); this RFC's placement stands as the destination, not as done. Done in `7261e87e` (T13 U4a): the schemas are `generation/domain/verdict-schemas.ts`, the validation `generation/domain/verdict-validate.ts` and the parser `generation/domain/verdict-parse.ts`, read by the shell through `generation/application/index.ts`.

**The guards it must not regress (`AGENTS.md:20-21`).** Checked against the tests that pin them:

| Guard | Pinned by | What the change does |
|---|---|---|
| A malformed element must keep the gate closed | `verdict-validate.test.ts:319-343` | Kept in purpose, made stronger: the answer is unreadable, so the gate is closed even when the unreadable entry is alone. The test is rewritten to assert `valid: false` and the issues. |
| A botched `corrections` field must not false-block a real approval | `verdict-validate.test.ts:178-187`, `:345-355` | Kept for `approved: true` (F4). |
| A plain string is blocking ("fail-closed backward compat") | `verdict-validate.test.ts:229-256` | Changes (F3): a plain string is unreadable. The purpose, that it never passes the gate, holds. |
| A malformed citation degrades to "no citation" because "the filter drops an uncited finding on its own" | comment at `schemas.ts:537-538` | Changes (F2). It was written before the record could tell the two apart. |

## Patches it supersedes

Past commits that stay: `1ff84710` (the adapter's full return type and the forwarding), `8c506286` (the spec identity compare, a separate cause of #19 and #21), the pinned test `review-port.adapter.test.ts:638-657` (rewritten to findings). What the fix removes or rewrites:

- the zip and the default at the step: `review.steps.ts:251-256`, `:284-288`, and the constants written over the verified result: `:320-321`
- the opposite default and the cast in the bound list: `review-output.ts:76-77`, `:87-88`
- the conditional spreads of the lists: `review-port.adapter.ts:170-171`, `verdict-parser.adapter.ts:133-134`
- the optional parallel lists: `review.port.ts:17-18`, `manifest-repository.ts:17-19`, `verdict-validate.ts:56-58`
- the tolerances and the invented verdict: `schemas.ts:545`, `:586`, `verdict-validate.ts:99`; with F3, `schemas.ts:547-548` and `:562-565`
- tests that pin the removed behavior: `verdict-validate.test.ts:229-256` (F3) and `:319-343` (rewritten)

## Test plan

Per the testing standards, through the public seam: `ReviewPortAdapter.review` with the real `VerdictParserAdapter` and a fake runtime that returns a stored answer (the rig of `review-port.adapter.test.ts`), and the use case's review rig for the decision. Written first.

| Rule | Test | Fails today because |
|---|---|---|
| An entry the engine cannot read is not a finding | a rejection whose entry has a text and an execution citation but no severity; the runtime answers a well-formed rejection on the repair turn. Assert one repair turn naming the entry's path, and findings equal to the restated answer | today: no repair turn, one finding "(unparseable correction)", blocking, no citation (`schemas.ts:586`) |
| A citation the engine cannot read is not "uncited" | the same with `kind: "network"`, and with `ref` a number | today the citation is `undefined` (`schemas.ts:545`) and the round is approved with `uncited=1` |
| An answer still unreadable after the repair fails closed | the runtime repeats the malformed answer. Assert `parsed: false`, `approved: false`, no model round burned | today the round is decided from the placeholder |
| An unreadable `approved`, or a non-array `corrections` beside a rejection, is unreadable | `approved: "false"`; `approved: false` with a string for `corrections`. Assert `parsed: false` | today `parsed: true`, a rejection with no finding (S5, S6) |
| The lists cannot be omitted | a type-level check in the adapter's test file that a port result without `findings` does not compile, run by `npm run typecheck` | today the lists are optional (`review.port.ts:17-18`) |
| The decision is the agent's word, whole | the rejection of the third row through the use case's review rig: the outcome is `parse-miss`, never `approved` | today `approved` |

Previous behavior, one test per touched seam: a well-formed rejection with an execution citation still blocks; an approving answer with advisory entries still approves; a blocking entry the agent left uncited is still dropped as `uncited` and counted in `droppedBlocking` (the designed rule); `approved: true` with a non-array `corrections` still approves (F4).

**Existing tests that change:** `verdict-validate.test.ts:229-256` and `:319-343` (above); `review-port.adapter.test.ts:638-657` asserts `findings`.

**Differential check:** for each seam that shares the changed code (the review adapter, the parser, the experiment harness `accept-delivered-specs.use-case.ts:125-129`, which reads the same port result and needs no change because an unreadable answer is `parsed: false`), run the new input against a copy of the base commit in a scratch directory and against the change; compare stdout, stderr and exit code. The expected differences are the rows above and nothing else.

## Measurement

The signals that show the cause gone, on a run and on the code:

- **On a run.** Every `qayaba.review.decision` span of a model round satisfies: `dropped_blocking` is no greater than the effective blocking count of the stored reviewer turn (at O4 to O7 it equalled the entry count, advisory entries included: #23 recorded 6 for a turn whose effective blocking count was 2), and a parse miss carries its issues (F5).
- **On the code.** The tests above; the replay of the synthetic answers of the Problem table gives `parse-miss` or a repaired verdict, never `approved`.

| | Record | Source |
|---|---|---|
| Before: baseline `run-ed28973-mvs7oo0f-17041c71` (4105c582) | reviewer round 1 `rejected`, blocking 1, round 2 `approved`, both decided by the model; no unreadable entry in its answers | history database |
| After: one replicate on the fix | the same chain with `dropped_blocking` within the bound above; no `issues` attribute unless the model writes an unreadable entry | to be measured |

- **Unproven on a run, by design.** The trigger needs a reviewer entry the engine cannot read, and none of 59 stored entries is one. One replicate can show only that the chain still delivers a rejection whole, if the reviewer rejects at all. The tests carry the proof of the mechanism; the replicate is a direction, never proof (ADR-0011, rule 3).
- **No verdict or coverage effect is expected.** Do not read a coverage difference between the two replicates as this fix: identical inputs spread widely (ADR-0011, cycle 3).

## Owner decisions needed

- **F1. Which option, and does the class belong to the confirmed cause (D12)?** Only the hop has run evidence (4 runs, 3 epochs). S3 to S7 have the same form and a replay on main, with 0 runs. Recommended: O3. If the owner reads D12 as the hop only: O1, accepting that S2 to S7 stay open questions.
- **F2. A malformed entry or citation in a reviewer answer.** Recommended: unreadable (one repair, then the existing parse miss). (Correction 2026-10-29: the owner decided differently for an approval: beside an approval the unreadable entry is recorded and the approval stands; beside a rejection the recommendation holds, one repair, then the parse miss.) The alternative keeps it tolerated and names it (`unreadable-citation` as a drop reason): the record becomes true and a rejection still turns into an approval.
- **F3. Plain-string entries stop being accepted.** The contract says each correction MUST be an object (`qa-reviewer.md:107`); 0 of 59 stored entries is a string. Recommended: yes. If no, the severity of a plain string stays an engine rule and must be named as one in the type.
- **F4. A non-array `corrections` beside `approved: true` stays tolerated, with the loss recorded.** Recommended: keep (the guard at `verdict-validate.test.ts:345-355`). The agent's approval is read intact; the engine converts nothing.
- **F5. Record the parse issues on the decision span.** One bounded attribute and its registry entry (`attribute-registry.ts`). Recommended: yes; without it the loss has no name of its own.

The authority to fix N02 at all is D12, approved on 2026-10-28 (translated: "regarding the 13 recommendations I agree with everything"), for causes phase 3b confirms. The brief fixes the rule for the forks above: "If a fix needs a product or architecture decision, STOP and ask me — do not choose."

## Out of scope

- **The designed rule.** An agent-made absence (no citation, a spec outside the run's scope, a DOM-only finding) stays advisory, and a rejection whose every blocking finding is dropped stays an approval (`review.steps.ts:318`; the agent is told so, `qa-reviewer.md:123-124`). Whether such a rejection should instead stop the run is a product question and a plausible neighbour, not proposed here.
- **The path compare of O4 to O6** (second cause of #19 and #21) and **#23's DOM-only approval**: fixed in O7 and designed, respectively.
- **The grave-tag rule** (`verdict-validate.ts:19-23`): the engine raises an entry's severity from the agent's own tag. The baseline's round 1 recorded `rejected` over a raw `approved: true` with 5 advisory entries (hypothesis: this rule, the same shape as the cycle 3 run `run-ed28973-mvs49h5y-acdab309`, not confirmed). The record cannot say the rejection was the engine's. Not examined as a member of the class: not enough evidence.
- **Findings that leave the list silently:** the cap of six and the removal of empty texts (`review-output.ts:82-84`, `:23`). Blocking entries sort first; no harm shown.
- **`rationale`'s tolerance** (`schemas.ts:574`): a lost rationale is recorded text only and decides nothing.
- **Other agents' answers.** The generator's, the lead's and the sidekicks' answers were not swept for the class; the sidekick reader is N01's, removed at the root.
- **Whether the four overridden rejections were correct**, and the model-approved reviews at O4 to O7: not enough evidence.

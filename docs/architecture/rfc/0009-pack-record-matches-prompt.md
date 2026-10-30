# RFC-0009: The Context Pack's id record lists what the prompt prints (N09)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/contexts/generation/infrastructure/context-pack.ts`, `qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts`, `qa-engine/src/contexts/generation/infrastructure/route-catalog.ts`, `qa-engine/src/shared-kernel/context-item-ids.ts`, `qa-engine/src/shared-infrastructure/telemetry/run-spans.ts`, `qa-engine/src/contexts/generation/infrastructure/telemetry/turn-probe.ts`, `qa-engine/src/contexts/generation/infrastructure/adapters/context-trace.ts`, `qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts`, `qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts`, `qa-engine/src/contexts/generation/domain/window-fit-references.ts`, `qa-engine/src/contexts/generation/domain/pre-generation-grounding.ts`, `qa-engine/src/contexts/generation/domain/opencode-run-input.ts`, `qa-engine/src/contexts/generation/infrastructure/dom-capture-trace.ts`, `qa-engine/src/contexts/evaluation/domain/graders.ts`, `src/server/evaluation-evidence.ts`, `scripts/probe-report.ts`, `docs/observability-design.md`, `qa-engine/test/contexts/generation/infrastructure/context-pack.test.ts`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md) (lists `src/server/evaluation-evidence.ts` in its step 0 inventory; this RFC edits no line of it), [RFC-0003](./0003-coverage-dump-harvest.md), [RFC-0004](./0004-log-level-from-outcome.md), [RFC-0005](./0005-suite-store-single-writer.md), [Rejected explanations](../rejected-explanations.md). Not in the same slice as RFC-0003, RFC-0004 or RFC-0005: it shares no file with them. RFC-0006, RFC-0007, RFC-0008 and RFC-0010 were not written when this was drafted; their code references still have to be compared with this list for overlap.

## Summary

1. Cause N09, confirmed by both lenses: the Context Pack's id record is enumerated from every captured snapshot, while the prompt prints a page only once and prints no seed at all; a page reached by k redirected routes is listed k times (4105c582).
2. Effect, on the record and its readers only: the phantom ids fill the 200-id cap (95 to 110 of the 200 slots in 8 runs), the operations never fit, and `change_pages_grounded` is absent in all 8 while `context_utilization` reads `op n/a`. No verdict, spec or agent decision reads the record.
3. Proposal (O2): the pack counts a page in the record only when the report prints it, using the renderer's own decision, and counts a redirect's reached page once under the path it reached. The cap, the graders and the prompt are untouched.
4. The record's source is the owner's call (F1 to F6): the bytes the prompt carried, recommended. The cap policy stays out; the Capture state lines (N11) stay an open question.
5. Nothing is patched on main.

## Problem

Evidence labels: a statement without a label was read at 4105c582 (the file was opened) or in the run records; a hypothesis is marked. `#N` is the investigation's run number, all one app, in timeline order. Run ids are `run-ed28973-<token>-<suffix>`; the token names the run.

### The cause, as confirmed

The pack builds the text the agent reads and, from the same capture, the list of element ids it records as delivered. The two are made by different code. The renderer knows what it prints (a grounded page once, a redirect's reached page once in an advisory block, no seed). The id enumerator does not ask the renderer. It lists every snapshot the browser returned, once per asked route.

The two lenses agreed on the mechanism and changed four details of the first statement of it:

1. The prompt prints the reached page twice, not once: as its own grounded route and in the advisory block `reached /home, asked for ...`. What is true is that the four redirected asked routes print no tree of their own.
2. The "fifth copy" the first narrowing could not place is the link seed `/`: it is passed to the pack but not printed (`dom-snapshot.ts:475`, `:503-504`). The mechanism therefore has two facets: redirect copies and unprinted seeds. A redirect-only fix leaves the second.
3. The three starved readers are `change_pages_grounded`, the `op` term of `context_utilization` and of `context_utilization_focused`, and the `dom` denominator of `context_utilization`.
4. Raising the cap alone is not the repair (see Options).

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | A route whose browser ended elsewhere is degraded; the renderer prints one line for it (`route /login: (redirected to /home)`) and no tree. | `route-catalog.ts:70-84`, `:94-115`; `dom-snapshot.ts:303-308` |
| 2 | The advisory block groups redirects by reached path and tree and prints that page once: `reached /home, asked for A, B, C:`. | `dom-snapshot.ts:332-349` (key `:338`) |
| 3 | The text is built from the snapshots without the link seeds. | `dom-snapshot.ts:503-509` |
| 4 | `onPages` is told every snapshot, seeds and redirected ones included, each with the kept nodes of the tree the browser rendered at that address. The pack stores a delivery per page, keyed by the asked route. | `dom-snapshot.ts:470`, `:475-502`; `context-pack.ts:383` |
| 5 | The id enumerator lists the elements of every delivery, and a fact for every page, with no report filter. Three other consumers in the same function do filter by the routes the report covers. | `context-pack.ts:118-129` (`:122`, `:123`); filters at `:533`, `:542`, `:547`; trace unfiltered at `:570-571` |
| 6 | An id names its route: `dom:<route>#<element>`. The same tree under three routes is three sets of ids. | `context-item-ids.ts:59-60`, `:108-123` |
| 7 | Produced and delivered are the same list ("no line count cuts the pack"); the span keeps the first 200 unique ids in production order (DOM, facts, operations) and counts the rest. | `context-pack.ts:136-143`; `context-item-ids.ts:73-76`; `run-spans.ts:93` |
| 8 | The delivered span is meant to hold "the items it actually gave the agent". | `turn-probe.ts:90` |
| 9 | Readers: `change_pages_grounded` looks for `dom:<page>#` in the list and abstains when a page is missing and the list overflowed; `context_utilization` takes its denominators from the list; `evaluation-evidence.ts` reads the delivered spans, and names the pages of a stale source from the ids of its produced span; `probe-report.ts` prints both. | `graders.ts:148-153`, `:234-266`, `:283`, `:458-468`; `evaluation-evidence.ts:267-300`, `:318-331`, `:348-357`; `probe-report.ts:169-182` |

The record was exact by construction before O8: delivered ids came from the rendered lines (`lineKeptNodes`), so a copy fell out of `delivered` and was recorded as a `line-cap` omission, the wrong label. `4ad1ff3c` (2026-10-27, in O8 head 27238792, not in O7 head e4efa50e) removed that derivation ("delivered = produced") and left nothing that reconciles the list with the text. The first enumeration per asked route is `86c20267` (2026-10-19); `df8cbef2` (2026-10-20) made it exact under the line cap, by that side effect.

The chain files are byte-identical from O10 bd1d2e46 to 4105c582 (`git diff` empty over `context-pack.ts`, `dom-snapshot.ts`, `context-item-ids.ts`, `run-spans.ts`, `graders.ts`, `evaluation-evidence.ts`). From O9 58151b36 the readers and the id helpers are byte-identical, and the two pack files differ by 29 added and 9 removed lines, none on the ids, redirect, seed or `onPages` path.

### What the runs show

All nine runs of O8 to main carry the failure; each shows the same structure: record = own ids + one H-sized block per redirected asked route + the seed + 5 operations, where H is the id count of the page they reach. The arithmetic closes: #27 = 142 + 5 x 50 + 5 = 397.

| Run | Epoch (engine commit) | DEV input | count / overflow | Copies in the first 200 | `change_pages_grounded` | `context_utilization` comment |
|---|---|---|---|---|---|---|
| #26 mvra9a3s | O9 58151b36 | S1 | 456 / 256 | 95 | absent | dom 1/200, op n/a |
| #27 mvruzwli | O10 bd1d2e46 | S2 | 397 / 197 | 110 | absent | dom 1/200, op n/a |
| #28 mvrwjx2d | O10 | S2 (the grounding ran before a provider incident; same input as #27) | 397 / 197 | 110 | absent | dom 1/200 |
| #29 mvrxb30p | O10 | S2 | 397 / 197 | 110 | absent | dom 2/200 |
| #30 mvs0onsn | O11 40513c1e | S2 | 397 / 197 | 110 | absent | dom 1/200 |
| #31 mvs2ukug | O11 | S3 | 444 / 244 | 99 | absent | dom 1/200 |
| #32 mvs49h5y | O11 | S3 | 444 / 244 | 99 | absent | dom 5/200 |
| baseline mvs7oo0f | 4105c582 | S3 | 444 / 244 | 99 | absent | dom 4/200, op n/a |

The baseline row was re-read for this record from the run's spans (`qayaba.delivered.context-pack`: first 200 = `/home` 54, `/search` 21, `/map` 8, `/restaurantes` 18, `/upload-menu/preview` 54, `/upload-menu` 45) and scores (no `change_pages_grounded` row; `context_utilization` 0.062, `route 11/41; dom 4/200; op n/a`). The other rows are the investigation's readings of the same tables.

Supporting, not counted: #24 mvr4s6br (O8, several changes at once; 456 / 256, absent) and #25 mvr9sbey (O9, a one-commit range by mistake; 220 / 20, 146 of the first 200 are copies under `/login*`; `change_pages_grounded` = 1.0 because its only change page, `/home`, lies inside the first 200). #25 is a boundary of the grader, not a counterexample.

**Controls.**

- Before O8 the same copies were produced and the same cap applied. The produced span overflowed (270 to 295 ids in #18, #19, #21, #22, #23) while the delivered span stayed at 120 to 136 with all operations, and `change_pages_grounded` scored 0.750 and named the two redirected change pages (stored on the six three-commit runs before O8, for instance #23 mvqy1s7l). Copies in a record nobody reads harm nothing; the harm needs them in the delivered record, from `4ad1ff3c`.
- A replay with every asked route rendering its own page gives 193 ids, no overflow and `change_pages_grounded` 0.900 (the investigation's replay).

**Confidence.** The three distinct DEV states S1, S2 and S3 are the independent inputs (#27 to #30 re-derive S2, #31, #32 and the baseline re-derive S3). If the owner counts by redirect structure instead of by DEV input, the count is two (the guard-to-`/home` set, and #25), and this verdict would drop to plausible. The chain reads no time limit and no model (the only constant it reads is `MAX_ITEM_IDS = 200`), so the multiplied limits of the runs do not touch it.

**Re-checked for this record at 4105c582** (a probe through the real `buildContextPack` and `captureDomForRoutes`, with only the browser render faked; three routes, two of them ending on `/home`, `/home` with 50 elements):

- The text prints the `/home` tree twice (grounded, advisory block `reached /home, asked for /upload-menu/preview, /upload-menu, /login:`) and three `(redirected to /home)` lines.
- The delivered ids hold 50 for `/home` and 50 for each of the three redirected routes, each the same hashes as `/home`'s: 200 ids, no overflow.
- `change_pages_grounded` over the change pages `/upload-menu/preview`, `/upload-menu` and `/home` reads 1.0 on that record, and 1.0 with the cap lifted. With the report's rule applied (grounded pages only) it reads 0.333 and names the two redirected pages. The wrong value does not need the cap.
- A link seed that is a real landing page (30 elements, no redirect): none of its text is printed, 30 ids are listed under `/` (synthetic, through `captureDomForRoutes` and the pack's `onPages` closure).

### What it does not explain

- Any verdict, spec, plan or agent decision. The pack text is complete: the `Route availability` section states each redirect, and `availability_*` scores exist beside the starved ones. Quality impact: hides a measurement signal (`change_pages_grounded` is the one signal built to say "the change's own pages had no live tree of their own"); no run shows a worse test because of it. Hypothesis for the harm: none shown.
- Whether the ids past position 200 hold the three templated pages: they cannot be read from the spans. The claim rests on a replay that reproduces the recorded 200 ids and the total for 8 runs (investigation probe), not on observation.
- That the seed `/` redirects to `/home` in the cited runs is an inference (the replay needs it to reach the recorded counts; the capture-time span arithmetic closes on 9 pages, 8 asked and the seed). No capture of `/` was read. Hypothesis.
- Whether the redirects themselves are right.
- `context_fresh` below 1 in 8 of 10 graded runs from O8: the capture-time span shares the 200-id budget by page count, copies and seed included (`context-item-ids.ts:143-153`, `dom-capture-trace.ts:50-54`), so a page recorded as a 22-id prefix in one capture and as 50 ids in the next reads as changed. That is a neighbour (Out of scope), not this mechanism.

## Goals and non-goals

Goals:

1. A page counts in the delivered record exactly when the prompt prints its tree, and once.
2. The rule is the renderer's own decision, not a second copy that can drift.
3. A test fails when the record and the text disagree, for any app.

Non-goals: the cap policy, the Capture state lines, the capture-time span, the graders (a typed abstention is the honest answer to an overflowed list), the prompt.

## Options

The question each option answers: what is the record derived from, and who owns that choice.

### O1. Reshape the cap only

Raise `MAX_ITEM_IDS`, or give the delivered span the page-fair share the capture span already has (`domItemIdsBudgeted`).

- **Removes:** the starvation (operations and templated pages fit).
- **Adds:** a bigger span attribute, or a second cap policy for the delivered span.
- **Risk:** the record is still untrue. The investigation's replay of the cited runs with the cap lifted scores `change_pages_grounded` 0.9, where the intended reading is 0.7: the redirected change pages read as grounded through phantom ids. My probe shows 1.0 on a record that does not even overflow. `context_utilization` keeps a denominator of 392 to 451 instead of 142 to 181. Rejected on evidence.

### O2. The pack counts a page when the report prints it

`onPages` already receives `grounded` per page (`dom-snapshot.ts:480`). It is also told every seed, and the renderer decides at `:503-504` which snapshots are printed and drops that decision. O2 tells `onPages` what the renderer decided (is the page printed, and for a redirect, the path it reached), and the pack's two enumerators (DOM ids and fact ids) use it:

- a grounded, printed page contributes its elements under its own route (templates under their template name, as today);
- a redirected page contributes its elements once, under the reached path, as the advisory block prints it (F2);
- a seed contributes nothing.

`trace.pages` and the `pages` map keep every snapshot: route availability classifies the redirected pages from them (`context-pack.ts:588`), and `confirmedDataRoutes` reads `trace.pages` (`pre-generation-grounding-port.adapter.ts:454`). The filter belongs to the enumeration, not to the storage.

- **Removes:** the copies and the unprinted seed at both sites that enumerate ids (DOM and fact), and with them the starvation in the runs shown.
- **Adds:** two fields on the page the pack is told about (printed; reached path) and one predicate. Hypothesis, not counted: well under 400 authored changed lines with tests.
- **Risk:** the rule exists in the renderer and in the enumerator; if the enumerator reads the renderer's decision the copy is one value, not two rules. The tests below make a later drift fail.

### O3. One page-report value for the whole pack

The renderer returns the pages it printed (grounded pages, advisory pages once, with kept nodes), and the pack derives ids, fact ids, observed pages, requests and shapes from that value alone.

- **Removes:** the second consumer set of the report-membership rule, including the three sites that are correct today (`context-pack.ts:533`, `:542`, `:547`).
- **Adds:** a new return type for `formatDomCapture` / `captureDomForRoutes` (a string today, with every caller and test), a new shared value, and a rewrite of three consumers that are not wrong.
- **Risk:** wider than the cause. It is the owner's "one source of truth per fact" idea ([ADR-0002](../adr/0002-architecture-direction.md), Open question 1, option B) applied to a fact N09 evidences; O2 already puts the decision in one place for the sites that fail. Not recommended now; it stays open for when a second report consumer fails.

### O4. Derive the ids from the pack text

Parse the printed text back into ids, or restore the pre-O8 attribution of rendered lines to routes.

- **Removes:** the divergence by construction.
- **Adds:** a text parser. Ids hash accessible names and carry test ids; the pre-O8 attribution mislabelled the copies as `line-cap` loss.
- **Risk:** the pack carries the structured data already, and the spans' contract is that the ids are "never parsed from the text" (`opencode-run-input.ts:50`). Rejected.

### O5. Teach the readers

Make the graders ignore ids under routes that redirected.

- **Removes:** the wrong score in two graders.
- **Adds:** the same rule in every reader (`graders.ts`, `evaluation-evidence.ts`, `probe-report.ts`), each from a string prefix.
- **Risk:** the span stays untrue and every new reader must re-learn the rule. Rejected.

## Recommendation

**O2, with F1 to F6 as settled below.** The record is derived from the bytes the prompt carried: the pages the report prints, once.

**Why it is the smallest change that removes the cause at every site of its class.** The class is "an enumerator that ignores what the report prints". It has two sites that produce ids: `context-pack.ts:122` (DOM ids from the deliveries) and `:123` (fact ids from `trace.pages`). Both read the same unfiltered trace (`:570-571`). A probe over a changed test id shows `fact:` ids for each asked redirected route and for the seed, a code-level finding no run exercised (no run changed a test id: the change was label-only). One predicate over the page the pack is told about closes both. The three consumers that already filter (`:533`, `:542`, `:547`) are correct and stay.

**Why app-agnostic.** The code has no app branch. The trigger is any captured route whose browser ended elsewhere, plus any link seed. Any web front end with an authentication guard, role-gated routes or an unknown-route fallback redirects; the seed `/` is rendered whenever the map has a templated route a link can instantiate (`context-pack.ts:425`). On another app the record is own ids + k x H, with k = redirected captured routes + a redirecting seed. For k of 2 or more and H of 40 or more, the first 200 end inside the copies (hypothesis for the numbers; the structure is the code). A change on a gated page, where the pack matters most, is the case that triggers it. Backends with no DOM capture have no pack ids and are not affected. The rule reads `grounded`, the printed flag and the reached path, never a route name.

**Where it lives.** The rule is the generation context's: it is a decision about what the pack reports (placement rule, row 3 of [the platform plan](../../engine-platform-architecture.md)). `dom-snapshot.ts` and `context-pack.ts` keep it beside the renderer; `context-item-ids.ts` stays the shared kernel's naming of ids. The graders (evaluation context) and `src/server/evaluation-evidence.ts` are readers and do not change. Nothing here depends on platform steps 2 to 6.

**What changes for a reader.** The delivered span of a run like the baseline would hold the pages' own ids plus the operations and no overflow (hypothesis, from the investigation's replay of the state of that run: 174 ids), `change_pages_grounded` becomes scorable and names the redirected change pages (0.700 in that replay), `context_utilization.op` becomes a measured 0 over 5 operations (the documented reading, `docs/observability-design.md:1209`), and the `dom` denominator is the number of elements the prompt printed.

**Risk.** The values of two graders move on future runs, so a series of `context_utilization` crosses a break at this commit. No stored data is touched and old runs keep their spans (F6). The ids are the contract graders read (item 3 in spirit, but tightened to the contract the span already states at `turn-probe.ts:90`), so it ships as its own commit, test first.

## Patches it supersedes

There is no compensating patch on main to remove: the line attribution that hid the copies went with `4ad1ff3c`, and this RFC does not restore it. What it replaces is text that states the old premise:

| Where | What the fix replaces |
|---|---|
| `context-pack.ts:140` | The comment "the same as what it produced, since no line count cuts the pack": the premise that made the two lists one, with no step reconciling them with the text. |
| `pre-generation-grounding.ts:9` | "computed from the kept lines": the derivation was removed in `4ad1ff3c`. |
| `opencode-run-input.ts:50` | "computed at pack-build time from the kept lines": the same. |
| `docs/observability-design.md:352`, `:949` | State what the record lists (the elements the prompt printed, once) next to "capped at 200" and the `change_pages_grounded` row. |

`context-pack.ts:122` and `:123` change in place. `domItemIds` and `changedValueFactIds` keep their signatures. The renderer's seed and redirect rules (`dom-snapshot.ts:332-345`, `:503-504`) stay: they are the source the enumerator now reads.

## Test plan

Per the testing standards (`AGENTS.md`, "Testing standards"): through the public seam, a bug fix starts with a test that fails for the bug's reason, one test per rule, plus one test pinning the behavior of what the change touches. The tests go in `qa-engine/test/contexts/generation/infrastructure/context-pack.test.ts`. The existing id tests (`:48`, `:77`, `:105`) stub both the text and the pages, so they cannot see the two disagree; the new ones fake only the browser.

| # | Test (named by behavior) | Seam | Fails today because |
|---|---|---|---|
| T1 | A route that redirected has no ids of its own: the delivered ids name only routes whose tree the pack text prints | `buildContextPack` with the real `captureDomForRoutes`, a fake `render` (three routes, two ending on `/home`) → `packDeliveredItemIds` | 50 ids exist under each redirected route, equal to `/home`'s, and the text prints no tree for them |
| T2 | A redirect's reached page is listed once, under the path it reached | same capture; the reached page is not itself asked | the ids sit under the asked routes (F2: with the other answer the test asserts none) |
| T3 | A link seed that is a landing page is not listed | `captureDomForRoutes` with `linkSeeds` and the pack's `onPages` | 30 ids under `/`, none printed |
| T4 | A changed test id on a reached page makes one fact for that page, not one per asked route | same capture with `changedElements` | one `fact:` per asked route and for the seed |
| T5 | The record never names a route the text does not: table-driven over the shapes (no redirect, redirect, seed, template page) | the same capture | T1 to T3 as cases; a later drift fails here for any shape |
| T6 | A page asked and printed keeps all its ids, a template page keeps its template name, an operation is listed | the existing tests `:48`, `:77`, `:105`, `:132` stay as they are | green today; they pin that nothing else moved |
| T7 | A change page that redirected is not grounded by the page it reached | `change_pages_grounded` over the pack's capped record (`GRADERS`) | reads 1.0 today (0.333 with the fix, in the probe) |

The existing test at `:132-150` asserts delivered = produced; it keeps passing under F3's recommendation.

**Differential check** (`AGENTS.md`, test discipline): run the same captures on the base commit in a temporary copy and on the change; the only difference must be the ids under redirected asked routes and seeds. Everything else (own pages, template names, operations, omissions) is identical. Committed tests never read git history.

## Measurement

One replicate before (D13, one per version): run-ed28973-mvs7oo0f-17041c71 on 4105c582 (pass; 56 min). The deterministic mechanism is proven by T1 to T5; the replicate shows the record the fix changes, and one run against one shows a direction, never proof ([ADR-0011](../adr/0011-root-cause-fix-policy.md)).

| Signal | Before (baseline) | After, if the cause is gone |
|---|---|---|
| `qayaba.delivered.context-pack` item ids under a redirected asked route | `/upload-menu/preview` 54, `/upload-menu` 45 in the first 200 (and `/login`, `/upload-menu/confirm` beyond it, hypothesis) | none |
| `qayaba.context.items.count` / `item_ids.overflow` | 444 / 244 | own ids + operations (about 174 in the replay of that state, hypothesis); no overflow while own ids are under 195 |
| `change_pages_grounded` | absent | present; names the redirected change pages (0.700 in the replay, hypothesis) |
| `context_utilization` comment | `dom 4/200 ... op n/a` | `dom k/<printed elements> ... op 0/5` |

Read the structure, not the counts: DEV state moves them (456, 397 and 444 across the three states). If the after replicate overflows with no copy in the record, own ids alone exceed the cap: that is the evidence that opens F4, and a signal for the cap, not for this RFC. A run with no redirected route and no seed is the control the replicate will not give; T5 is that control.

## Implementation notes

Landed as `88d2a300` and `2af99d58` (picked from `0b8382cc` and `8907e0bf`), 2026-10-29. What the code does at 17bb77c1, where it differs from or fills in the text above:

- **The renderer states what it prints.** `reportedRouteOf` (`dom-snapshot.ts`) decides under which route a page is reported; the captured page carries that decision (printed, reached), and the pack's DOM and fact enumerators read it: a grounded page under its route (a template page under its template), a redirect's reached page once under the path it reached, nothing for a link seed or for a route that redirected. A test fails when the record and the text disagree for any shape.
- **An unprinted page still weighs on the absence guard.** A link seed, or a failed or empty render, supplies no ids or facts, but its unconfirmed data state reaches the fact guard, because it bears on whether the absence of a changed test id is proof (checkpoint 1, B2).
- **The window fit keeps the advisory's ids.** It no longer prunes the elements of a page it left out of the Live DOM while the redirect advisory still prints the same tree (checkpoint 1, J4).
- **A tree printed under one name by several routes keeps the ids of every print**, not the last one's (checkpoint 1, m10).
- **F4 and F6.** The cap policy is unchanged. The break of F6 is recorded as epoch O14 in the run index of [Rejected explanations](../rejected-explanations.md#run-index): `context_utilization` and the pack series change meaning there and are not pooled across it.

## Owner decisions needed

- **F1. Source of the record.** The bytes the prompt carried (the pages the report prints, once), not the capture's list of asked routes. Recommended: yes.
- **F2. Advisory-block elements.** They are in the prompt, so they count as delivered, once per reached page, under the reached path (A2). The alternative (A1) lists only grounded pages and treats the advisory block as orientation (its own wording: "it is not the page of the route that was asked for"). No cited run differs (the reached page is also an asked route); on an app where a guard sends the browser to a page nobody asked for, A1 under-counts what the agent was given and reports its elements as `referenced_not_provided`. Recommended: A2.
- **F3. One enumerator for the produced and delivered spans.** Today they are one function. Recommended: keep it one, so the produced span loses the copies too. Two readers of the produced pack ids were found: `probe-report.ts` prints them, and the freshness reader names the pages of a stale source from them (`evaluation-evidence.ts:348-357`, so a stale pack would name the redirected routes; hypothesis, no stale pack span was read).
- **F4. The cap policy.** The first 200 in production order, operations last (`context-item-ids.ts:73-76`), against the page-fair share the capture span uses (`:143-153`). With the copies removed the margin to the cap in this app is 7 to 26 ids (147, 186 and 174 of 200 in the replays); no run shows overflow without copies. Recommended: leave it; revisit when an after replicate overflows with no copy.
- **F5. Fact ids in this change.** Same function, same predicate, shown by a probe, never by a run. Recommended: include them (T4).
- **F6. Old runs.** Their spans hold the copies and their stored scores are what the code of their epoch computed. Recommended: no regrade; record the break at this commit in the timeline's epoch table.

## Out of scope

Plausible neighbours; none is a confirmed mechanism, and none gets a fix here (rule D12).

- **N11, the Capture state lines cut (unconfirmed).** Same upstream trigger: the pack keeps one entry per asked route, so redirect aliases are separate pages (`context-pack.ts:383`). Different consumer and different cut: the prompt text takes `[...pages.values()].filter(dataState).slice(0, MAX_ROUTES + 1)` (`context-pack.ts:473`, `MAX_ROUTES = 4` at `dom-snapshot.ts:90`), a count of 5 against this record's 200 ids, and the fact lost is the line of a template-instance page. This RFC leaves `pages` whole and edits no line of `:473`. If N11 is confirmed, its fix may reuse the printed flag; that is a hypothesis, not a commitment.
- **The capture-time span** (`dom-capture-trace.ts:50-54`) lists every non-error snapshot and shares the 200-id budget by page count, copies and seed included (22 ids per page on a capture of 9 pages). It is read by the freshness reader; the `context_fresh` reading and the equality of truncated id sets (`evaluation-evidence.ts:334`) are a separate question.
- **The cap as a policy** (F4).
- **Whether the starved scores are used to judge test quality.** No decision reads them today.
- **Platform steps 2 to 6**, and moving `src/server/evaluation-evidence.ts` ([RFC-0002](./0002-platform-steps-0-1.md)).

Not verified here (and so not stated as fact above): how `packDegrade` treats the advisory block when the window gives way (`window-fit-references.ts:20-37` prunes ids by the `route <r>:` pages of the DOM section, and the advisory block lies in another section; hypothesis that a copy would then stay in the record); whether a record-semantics change needs a grader version change.

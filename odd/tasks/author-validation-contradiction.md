# Author validation contradiction

Objective: the `qa-author` prompt must state one obligation about running the spec it wrote, conditioned on the grant the brief already declares, so that "the orchestrator validates what you deliver" and "deliver only bytes you saw pass" stop being two incompatible instructions.
Status: **proposal, not authorized to implement**. Its first measurement was wrong and is corrected in L2; the text defect stands, the causal link to behaviour is **not** established.
Branch: none. Delivery: ask-on-risk. Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S1** (owner, verbatim): "no me vale que se arregle una contradiccion cambiando el orden para ver que instruccion gana. Quiza me estoy equivocando dime si es esto lo que sucede o es realmente el orden".
- **S2** (text defect): `agents/agent/qa-author.md` states three incompatible definitions of "done" — validation is the orchestrator's (`:151`), delivery requires a seen pass (`:163`), writing is the end (`:203`). No single action satisfies all three; this is a contradiction of obligation, not an ordering defect.
- **S3** (measured, corrected): the run that motivated this document made **23 `run_spec` calls** (`gateSignals.closedLoop`), 26 entries in the turns' tool sequences, spread over 8 of the 10 author turns; one turn called it zero times and wrote nothing; two turns hit the 480 s flow budget. The text defect is **not** shown to be the cause of any of that.
- **S4** (resolution 1): one obligation, conditioned on the fact the brief already states (`author-task.ts:27-31` already branches on "the task states a budget"):
  - with a budget: write the spec, submit it to `run_spec` before reporting, report only bytes whose last call passed, and treat a failed call as the failure to fix;
  - with no budget: the orchestrator validates and runs what is delivered, and delivery requires no run of its own.
- **S5** (resolution 2): the true part of `:151` survives as a statement about what happens **after** delivery (typecheck, lint, listing, suite, reviewer), never as "none is needed".
- **S6** (resolution 3): the closing rule stops calling writing the end of the turn; it bounds re-exploration after the last write without forbidding the run that S4 requires when a budget exists.
- **S7** (evidence rule): no fix may rest on "which sentence comes first", and no claim may rest on a derived field until the field's own definition has been read. The acceptance test is that the delivered text contains no pair of instructions a reader cannot satisfy at once, whatever the reading order.
- **S8** (scope): text and its recordings only. Binding the obligation (refusing an unverified delivery instead of deferring it) is a separate behaviour change in `lead-review.ts`, decided on campaign evidence, not bundled here.
- **S9** (invariants kept): the orchestrator still owns the static gate, the suite and the reviewer; a spec still never fakes responses; `run_spec` still runs one spec, retries 0, in its own namespace, under the DEV lease; a flow refused for writes still delivers and is judged by the run's execution.
- **S10** (recordings and tests): the prompt-contract coordination baseline is re-recorded with `--record-coordination`; the two regexes pinned in `lead-sidekicks.test.ts` are updated with the text; the stable-prefix and section tests still pass; `npm test`, `typecheck`, `arch:check` stay green.
- **S11** (acceptance): every claim about a flow's validation reads `gateSignals.closedLoop.calls` and the turn's tool sequence, never a call bucket; text and behaviour are reported apart, and the behaviour of the two campaign commits is re-measured, not inferred.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S2, S4, S5, S6, S7 | inline | proposed: rewrite `qa-author.md` §4 and the closing rule | — |
| T2 | S4, S5 | inline | proposed: align `author-task.ts` (already branches on the budget) with the new obligation | — |
| T3 | S10, S11 | inline | proposed: re-record the coordination baseline; update the two pinned regexes | — |
| T4 | S8, S11 | inline | proposed: decide on evidence whether binding `lead-review.ts` is worth a behaviour change | — |
| T5 | S4 | inline | proposed (optional): give the sidekick brief a step milestone, which only the generator prompt has today | — |

Route declaration: every task inline. No Writer-trigger reason holds: the units share the same two files (`qa-author.md`, `author-task.ts`) and the same recording, so none is independent.

## Log

- **L1** (2026-11-01, owner, verbatim): "ahora, analiza que parte de la contradiccion es la que tiene la razon segun el codigo. que es lo que debe hacer esa fase para que sea optima, como se debe resolver la contradiccion y si esto afecta algo mas del codigo que se deba reajustar." and, earlier, the challenge quoted as S1.
- **L2** (2026-11-01, corrected measurement; supersedes the first version of this section). First version claimed "zero `run_spec` calls across ten turns", read from `callBuckets.validate_run`. That field is the wrong instrument: `bucketForTool("run_spec")` falls through every pattern to `other` (`generation/domain/tool-call-taxonomy.ts`, `bucketForTool`), and `validate_run` counts only shell calls whose command classifies as a validation (`bucketForShellCommand` over `classifyShellCommand`). The author holds no shell, so `validate_run` was structurally zero. The record's own ledger says otherwise: `gateSignals.closedLoop = { calls: 23, devWrites: 2, granted: 36, writesRefused: 3, closed: false }`, and the turns' `toolSequence` holds 26 `run_spec` entries. Per author turn: r0 1, r1 1, r2 **0**, r3 1, r4 2, r5 1, r6 2, r7 2, r8 3, r9 1 — plus the run's own authoring turns after the pass. The run ended `flaky` at `learn`, `flows 9 / delivered 8`, `changeCoverage 0.293`, `branchCoverage 26/93` with 45 decisions skipped as build-added, and a reviewer that rejected twice (`rounds: 2`, `approved: false`, 4 blocking corrections).
- **L3** (2026-11-01, observed, the brief of round 0, verbatim): "Granted by this run:" / "- run_spec: run the spec you wrote" / "Not granted: playwright." and "run_spec: at most 4 calls, 120 seconds each, up to 2 requests that write to DEV while the run's shared cap lasts (20 left now). It runs e2e/flows/login-buttons.spec.ts and no other file. Run it until it passes, then finish." The grant was real and the tool was used.
- **L4** (2026-11-01, discarded hypotheses with their evidence):
  - *No loop handle (grant 0)*: `perFlowGrant` returns 0 for `run_spec` only with `held: false` (`flow-capacity.ts:71-78`), and the app schema floors `maxCalls` at 1; the ledger's 23 calls settle it.
  - *No DEV writes left*: 20 were left at the flow's start and the ledger ended with 2 used and 3 refusals — a real constraint on some calls, not a blanket refusal.
  - *Mutual exclusion with the authenticated browser*: false. `sidekickAuthoring` picks the browser when granted (`sidekick-authoring.ts:37`) and `sidekickGrants` computes `run_spec` and `authbrowser` independently (`:71-72`); this run used both.
  - *Runtime cannot call it*: the predicate that gates the loop and the one that gates the browser are the same expression (`run-engine-factory.ts:1097`, `:1136`).
  - *"The author never validated"*: refuted by L2. What survives is narrower: one flow (r2) never called the tool and never wrote, and two flows exhausted the 480 s budget.
- **L5** (2026-11-01, what the engine enforces, read from the code):
  - Delivery requires no proof: `aggregateFlowOutcomes` reads only file names (`flow-outcomes.ts:64-86`), and the static gate states that a call proves a spec runs, not that it passes tsc, lint or the listing (`execute.steps.ts:119-123`).
  - The only reader of the proof is the lead's accept (`lead-review.ts:176-194`): sent back when `!verified`, a call remains and a review turn is left; a flow refused for writes is accepted outright; with no review turn left it is accepted and "the run's execution judges it". `verified` is `loop.isClosed()` (`lead-sidekicks.ts:966`), and `loopClosed` requires each delivered file's current sha to equal the sha of its last **passed** call (`run-spec-capability.ts:256-265`). `MAX_REVIEW_TURNS = 3` (`lead-review.ts:33`).
  - What a call is worth: the flow's own spec, `retries: 0`, `countWrites: true`, namespace `<runId>-flow-<id>-rs<n>`, a control load in its own child, cleanup after, path confined to that one spec. It proves nothing about the static gate, the manifest, the reviewer or the whole suite.
- **L6** (2026-11-01, the text conflict): the author receives the three sentences quoted in S2 in the same file, plus the closing rule. "Run no command, none is needed" is written without a subject: it means the suite and the commands, but it reads as "no run at all". The run's behaviour shows the conflict did **not** stop the authors from calling the tool (L2); it remains a defect of the text that a reader must resolve by guessing which sentence governs, and it is unproven whether it shaped the one flow that never called it.
- **L7** (2026-11-01, decision, why not a reorder): a reorder changes which sentence is violated, not that one is. The acceptance test of S7 is satisfiable only by removing the conflict: one obligation, conditioned on the grant.
- **L8** (2026-11-01, batch of decisions, each with its reason):
  - *Fix the text even though the behaviour was not globally broken*: a prompt whose duties cannot all be met forces every reader to discard one, and the discarded one is not the same for every model or every turn.
  - *Condition on the grant rather than on an environment fact*: the brief already carries that distinction (`author-task.ts:27-31`), so the obligation needs no new fact and no new plumbing.
  - *Keep the orchestrator's validation statement, scoped to "after delivery"*: it is true (`execute.steps.ts:110-116`) and it is what makes a `run_spec` absence safe for a run-level author.
  - *Do not bundle the binding change*: refusing an unverified delivery is behaviour (`lead-review.ts`), it has its own tests, and the campaign must show whether coherent text alone changes anything before paying for it.
  - *Do not raise `flowBudgetMs`*: the repository's own analysis found that author turns over 480 s followed failing or refused `run_spec` loops rather than change size (`docs/architecture/rejected-explanations.md`, H14), and a budget above the transport cap already caused a `fetch failed` at 962.8 s (H27).
  - *Measure with the field that owns the fact*: `closedLoop.calls` and the tool sequence, never a derived bucket (S11 came out of this).
- **L9** (2026-11-01, blast radius read from the code):
  - `agents/agent/qa-author.md:149-165` and the closing rule `:201-206` — text; static-layer budget recorded at 24,600 B (`odd/tasks/structured-agent-answers.md:51`).
  - `agents/AGENTS.md` (Protocol 1 and "Authoring-time DEV exploration") — text; same budget.
  - `coordination/application/author-task.ts:27-31` — text; two regexes pinned in `lead-sidekicks.test.ts:469,475`.
  - `coordination-sections/brief-sections.ts` (`tools` at `:44-59`, `task` at `:128`) — the `tools` section is `stability: "static"`, so changing it moves the stable prefix: `coordination-sections.stable-prefix.test.ts`, `coordination-sections.test.ts:117-127`, and `prompt-registry-rule.test.ts`.
  - `scripts/prompt-contract-matrix.ts` plus `scripts/prompt-contract-coordination-baseline.json` — re-record with `--record-coordination`.
  - `step-milestone`/`EFFORT_TEXT` exist only for the generator prompt (`task-builders.ts:213,280`, `step-limit.ts:15`); a sidekick equivalent is a new registry definition with its `reason`, plus `prompts.scope-guard.test.ts` and `prompts.listing.test.ts`.
  - `lead-review.ts:176-194` and `lead-review.test.ts` — only if S8 is paid.
  - `docs/lead-sidekicks.md:172` — describe the brief's sections; re-read for consistency.
  - No copy of the text lives in `engine/src/**/embedded`.
- **L10** (2026-11-01, open): the text defect is a fact; its behavioural cost is not measured. The two questions the campaign still answers: (a) does the one flow that never called the tool repeat across replicates, and (b) does `flowBudgetMs` bind before the flows converge. The instruments are `gateSignals.closedLoop` and each turn's `toolSequence`, not a call bucket.

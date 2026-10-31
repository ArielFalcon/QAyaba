# Review log: root-cause fixes 2026-10-28

Every problem or suggestion a reviewer, verifier or writer reports while the plan of `odd/tasks/root-cause-2026-10-28.md` is implemented, kept for later analysis (owner, 2026-10-29: "ve llevando un log con los problemas y sugerencias que te vayan reportando para luego analizarlas"). One row per item. Status: `fixed` (commit), `open` (to fix), `follow-up` (outside every record; for the owner to schedule), `decided` (owner answer), `noted` (no action).

IDs: a checkpoint's rows carry its own prefix from CP2 on (`A-`, `B-`, `C-`, `D-` per CP2 reviewer); the unprefixed B1-B3 of CP1 are not ADR-0011's verifier defects B1-B3.

Sources: CP1 to CP4 are the owner's quality checkpoints (Opus 5.5, maximum effort, read-only, cumulative); V is an independent verifier of one high-risk change; W is a writer's own report.

## Checkpoint 1 (465cb6d0..4b22a5db and the five slice commits)

| ID | Source | Severity | Where | Problem | Suggestion | Status |
|---|---|---|---|---|---|---|
| B1 | CP1 | blocker | 9cf6e8e4, `odd/tasks/root-cause-2026-10-28-inventory.md` | The step-0 inventory of `src/` (170 module rows, Q15 proposals) was replaced by the dormant-feature audit; the parent named the wrong source | Restore the 4fffd9b4 content; keep the dormant-feature inventory as a second file; correct T1 | fixed 180dd073 |
| B2 | CP1 | blocker | T10 0b8382cc, `context-pack.ts:123-126` | An unprinted page lost its unconfirmed data state, so a changed test id was recorded as absent (21 of 400 seeded scenarios) | Every captured page feeds the absence guard; unprinted pages add no ids | fixed 8907e0bf |
| B3 | CP1 | blocker (security) | T11 10aa4667, `opencode-tool-outcome.ts:13,28-34` | A tool error was cut before redaction, so a credential straddling the cut leaked its prefix into spans, ledger and event | Redact a window of twice the cap, then cut | fixed 32451b21 |
| J1 | CP1 | major | T9 fc527a14 x T7 4542a739, `run-qa.closed-loop.test.ts:501` | T9's new fake returns `corrections`; T7 changes the reviewer answer to `findings`; together: TS2322 and 2 failing tests | The slice that lands second ports the fake; correct RFC-0006's "landing order is free" | RFC fixed 05a92c77; fake open (integration) |
| J2 | CP1 | major | T7, RFC-0006 line 117 | The RFC said a parse miss fails closed "without an Issue on a green run"; false: an approval with one malformed advisory entry opened an Issue instead of a PR | Owner chose: beside an approval an unreadable entry is recorded and the approval stands; a rejection still repairs then misses | decided L11; code fixed b138043e, fed90885; RFC fixed 05a92c77 |
| J3 | CP1 | major | T7, `review.steps.ts:305-311` | Verified findings were picked again by text, so a dropped finding with the same text came back blocking | The filter returns the verified objects | fixed b138043e |
| J4 | CP1 | major | T10, `window-fit-references.ts:32-36` | The window fit pruned the ids of a page the redirect advisory still printed | Keep the ids of routes printed elsewhere | fixed 8907e0bf |
| J5 | CP1 | major | T11, `attribute-registry.ts:284` | `qayaba.tool.attempted` (agent-chosen text) was emitted in `off` capture | Declare it as text | fixed 32451b21 |
| J6 | CP1 | major | T11 tests | RFC-0010 test-plan row 5 had no test; new modules in no mutation preset; 3 hand mutants survived | Injectable redactor, row 5 test, preset entry | fixed 32451b21 |
| J7 | CP1 | major | T4, `suite-store.adapter.ts:460,477` | No test carries a verified login through export and restore | Add the test | fixed 6bfb327c |
| J8 | CP1 | major | T4, `scripts/warm-suite.ts:500-511` | Nothing pins snapshots to the data volume, out of the agents container's reach | Pure path function, asserted under the data dir | fixed 6bfb327c |
| J9 | CP1 | major | T9, `regeneration-acceptance.ts:136-143` | The only test of the no-execution branch was deleted; a mutant survives 574 tests | Test with no changed spec files | fixed 490372e3 |
| J10 | CP1 | major | M2 e37a03b5, `src/server/runner.ts:681` | The crash-incident assertion was deleted with no log-line pin, against ADR-0010 ("a test per converted producer") | Assert the error-level line | fixed 244264f9 |
| J11 | CP1 | major (record) | e64f618a, `AGENTS.md:157-178` | 7 of 12 engine/AI boundary rows state rules not landed yet as current fact; contradicts other AGENTS.md lines and ADR-0002 Q3 | A status column, or add each row with its RFC | fixed 4fd185d0 |
| J12 | CP1 | major (record) | RFC-0002:265,376; ADR-0003:155 | The diff keyword detector is also reached by the run step `read-diff-shapes`, not only through the curriculum | L4 handles the step; correct the records | code fixed 0989507c (step, state and outcome field removed; nothing else read them); records fixed 05a92c77 |
| J13 | CP1 | major (record) | ADR-0013:10,24 | Three open points have no recommended answer: ADR-0008's declaration format, ADR-0009's learning-arm scope, whether `QA_CAMPAIGN_FREEZE` stays | Record a recommendation or name the owning task (T19, T20) | fixed 05a92c77 |
| m1 | CP1 | minor | bc100d1e, `shell-public-surface.test.ts:85` | The ceiling asserts `<=`, so each shrink reopens a slot | `assert.equal` | fixed 8efeec0a |
| m2 | CP1 | minor | T23, `web/public/js/console.js:655`, `docs/observability-design.md:1158-1159` | Model names remain; the guard scans only `.ts` under `src` and `qa-engine/src` | Remove them; widen the guard to web and docs | fixed b18b4d92 |
| m3 | CP1 | minor (record) | feature document | Stale task statuses; M1-M4 progress; pending owner edits; no task for Q11, OD-14's strict schema, OD-18, RFC-0003's second unit, ADR-0005:75, the P1-P7 checklist | Update; add tasks | statuses updated in L11-L12; missing tasks open |
| m4 | CP1 | minor (record) | RFC-0002 vs ADR-0013 | RFC-0002 gives the `.env.example` edit to M2; ADR-0013 to the owner | Align the RFC with ADR-0013 | fixed 05a92c77 |
| m5 | CP1 | minor | M2 leftovers | `setShuttingDown` dead (fixed c3e54817); stale "protected" comments (`mirror-prune.ts:10-11`); two signals now info-only and not shipped (`runner.ts:832`, `process-audit-port.adapter.ts:28`); `qayaba-self` mirror (deleted, L11); retired `SELF_MAINTAINER_*` ignored silently | Fix the comments; ship the two signals; warn on retired env names | fixed c3e54817, 87c2b54e (retired variables warn at load from `src/settings/retired.ts`) |
| m6 | CP1 | minor | M1/M3 tests | Health-poller boundary mutants survive; `run-event.test.ts:13-23` is a tautology; `docs/execution-sandbox.md:18-19` stale | Boundary tests; rewrite the tautology; fix the doc | fixed 09d94400 |
| m7 | CP1 | minor | T4 | Purge keeps snapshots; the RFC's digest check is not done; AGENTS.md calls a count "paths"; the campaign skill's `suite-store.sh` copies the manifest alone | Fix in the slice; switch the skill script to `store-export`/`store-restore` before T17 | wording and digest check fixed 6bfb327c (the restore now compares the written manifest's digest with the snapshot's); purge fixed 4cdfcdb0 (a purge removes `data/suite-snapshots/<app>`, which holds a stored login; plain delete keeps it); skill script before T17 |
| m8 | CP1 | minor | T7 | Stale comments and docs; `qayaba.review.issues` undocumented; schemas stay in `src/` though RFC-0006:134 says they move | Fix docs; decide the schema move | docs fixed b138043e; move open |
| m9 | CP1 | minor | T9 | A kept file with no case drops out of the record; guard at `review.steps.ts:553` survives; stale text `fix-loop.aggregate.ts:115-117`; tests pin `"loop-run-acc0"` | Fix in the slice | stale text and namespace literal fixed 490372e3 (`acceptanceNamespace`); silent kept file on a pass and the guard: parent read RFC-0008's rule (every kept file has a case; deletions exempt; guard-free replace): fixed be067673; the guard hid a real defect (a deleted file's stale cases stayed in the record); note: the fix loop passes no `independentSpecs`, so a silent file there rejects the whole adopted round |
| m10 | CP1 | minor | T10 | Delivery key last-write-wins; `printedRoutes` counted error lines | Merge deliveries; count only routes with a tree | fixed 8907e0bf |
| m11 | CP1 | minor | T11 | Absent `outcome` meant three things; `denied` no longer sticky; collector comments contradicted docs; `contract:check` does not cover the Go types; `RunRecordMode*` rename is generator noise | Documented absence (32451b21); make `contract:check` cover Go types | fixed 32451b21, 0f4c36ea; the separate Go freshness step in `.github/workflows/ci.yml` is now redundant (follow-up) |
| m12 | CP1 | minor (record) | records | 56 vs 60 owner questions; "after-measurement count undecided" stale; ADR-0008's "version unknown" not in the accepted state set | Correct the records | fixed 05a92c77 |

## Verifiers and writers

| ID | Source | Severity | Where | Problem | Suggestion | Status |
|---|---|---|---|---|---|---|
| V1 | V (G1) | advisory | `.gitignore` `/docs/architecture/*` | A new non-record file there needs `git add -f` to be seen by the checker | none | noted |
| V2 | V (T4) | advisory | `restoreSnapshot` | A snapshot of another app restores without a word (app, repo, spec dir ignored) | Refuse a snapshot whose app differs | fixed b13b1df0 |
| V3 | V (T4) | advisory | `suite-store-writers.test.ts` | The ownership scan matches only `appSuiteStoreDir(`; a hand-built path or manifest write escapes it | Widen the scan | follow-up |
| V4 | V (T4) | advisory | `warm-suite --leave-out` | A path not in the store is ignored silently | Warn | fixed b13b1df0 |
| V5 | V (gov) | advisory | model resolution | A missing `agents/opencode.json` is no longer loud at boot | Warn at boot | follow-up |
| V6 | V (gov) | advisory | proposer | Now follows the operator's `AGENT_PRIMARY_MODEL` | none (matches the settings text) | noted |
| V7 | V (gov) | advisory | M4 rule | Does not cover `scripts/` | Decide whether scripts are launchers | follow-up |
| W1 | W (C2/C3) | follow-up | sandbox env allowlists, `docs/execution-sandbox.md:31` | Still pass `JAVA_HOME`, `GOPATH`, `CARGO_*`, `GRADLE_*`, `MAVEN_*` after the code target left | Remove them | follow-up |
| W2 | W (C3) | follow-up | Dockerfile | `python3-venv` has no user found | Remove after a check | fixed (T24 commit) |
| W3 | W (T11) | noted | Go client types | The generator renamed unused `RunRecordMode*` constants | Keep Go generator churn out of unrelated commits | noted |
| W4 | W (T11) | process | test runners | A writer ran `pkill -f scripts/run-tests.mjs` (kills every worktree's runner) and used `git stash` (shared across worktrees) | Forbidden in every brief since | fixed (briefs) |
| W5 | W (M2) | owner | `.env.example:30-32`, GitHub, data volume | `SELF_MAINTAINER_AUTOMERGE` lines; 18 `qa/maintainer-*` pull requests; the auto-merge setting; five maintainer files in the data volume | Owner edits (ADR-0013 point 3) | done on the owner's go (L13): PRs closed, branches deleted; auto-merge already off; no maintainer data files exist (the claim was wrong); `.env.example` still the owner's |
| W6 | W (LC-L4) | record | J12 above | | | see J12 |
| W7 | W (LC-L4) | follow-up | history schema | Unread now: tables `learning_rules`, `curriculum`, `scorecard` (read by the signals view, written by nothing), columns `run_outcomes.rules_retrieved`, `run_outcomes.reflection`; no migration added (stored data, high-risk item 1) | A migration decision for the learning rebuild (T20) | follow-up |
| W8 | W (LC-L4) | follow-up | `docs/architecture-remediation.md`, `docs/testing-standards.md` | Historical text still describes the reflector, curriculum, rule fold and exemplar facts | Decide whether historical documents are kept as history or trimmed | follow-up |
| W9 | W (LC-L4) | process | scratch cleanup | The parent's `gate-*.log` cleanup removed a running writer's logs | Writers name logs per task; the parent removes only paths a writer reported | fixed (process) |

## Step 1 deletions after CP1 (T16, V1-V3, VF, Z, T18)

| ID | Source | Severity | Where | Problem | Suggestion | Status |
|---|---|---|---|---|---|---|
| V8 | V (V-series) | advisory | Z a1b1c44b | Stored `gate_signals` JSON key order changed to the engine's assembly order; keys and values identical; every reader parses | none | noted |
| V9 | V (V-series) | gap | T16 | The retired `qa.valueOracle` got only the generic warning; ADR-0006 Q2 wants the replacement named | Name the replacement | fixed f9a10040 |
| V10 | V (V-series) | advisory | T16 | Shadow apps now run bundle mutation; a retired `valueOracle: off` no longer turns it off | Owner moves portfolio's off to the new key | done (portfolio YAML, L13) |
| W10 | W (V2) | follow-up | `dump-sanitizers.ts`, `FaultCounterRecord` | `byOperation`, `test`, `parseFaultCounterFields`, `MAX_FAULT_COUNTER_*` dead but pinned by tests; `countInjectedResponses` lost its factory test | Remove the dead fields; restore a wiring test | follow-up |
| W11 | W (V2) | record | `docs/testing-standards.md`, `docs/architecture-remediation.md` | Historical narrative still mentions the oracle and fault injection | Correct | follow-up |
| W12 | W (T18) | owner | OD-13 | `recurring-test-failure` rename has no name in the record | Owner names it or keeps it | decided L15: the name stays (the misleading "rule promotion (oracle)" advice was the defect and is gone) |
| W13 | W (T18) | follow-up | wire | Judge residue: `llm_judge` source, `judgeModel`, catalog `status`, `run_scores.judge_model`, tables `judge_attempts`/`judge_calibrations`, `scoreSink` in telemetry health, `langfuse.*` span attributes; coordination event field `tier`; `OpenSessionOpts.model` | One contract change | follow-up |
| W14 | W (T18) | follow-up | OD-17 row 8.2 | The adapter still accepts a static `contextMap` and `prChangedFiles` nothing in production sets | Remove | follow-up |
| W15 | W (T18) | review | OD-7, OD-9 | A webhook with a retired mode reads as `diff`; `intentLock` `enforce` fails config load | Verifier judges against the warn-first policy | see V11, V12 |
| V11 | V (T18) | blocker | OD-7 49f5b43e; `src/cli.ts`, `src/server/webhook.ts`, `create-run.ts` | A request naming `complete` or `exhaustive` started a diff run and reported success (CLI, webhook 202, API 202) | Refuse: CLI exit 2, webhook and API 400 | fixed 1f117aab (RED: 3 tests, 202 vs 400; GREEN; gate 11115 pass, 0 fail) |
| V12 | V (T18) | advisory | OD-9 81628a8f, `listAppConfigs` | `intentLock.mode: enforce` now fails schema validation, and `listAppConfigs` skips a malformed config with a warn line only, so an operator who left it set silently stops watching that app; no current app sets it | Warn-first like the retired keys, or make a skipped config loud | follow-up |
| V13 | V (T18) | noted | OD-7 | Stored runs with mode `complete`/`exhaustive` would not match the response enum; the RFC counts 0 such runs | none | noted |

## Checkpoint 2 (465cb6d0..5c001bfb and the five slice branches; four reviewers)

Verdicts: A (465cb6d0..4d4a8675, CP1 re-validation) no code defect, CP1 fixes hold except m12; B (4d4a8675..15228726) PASS; C (slices) T4, T7, T10, T11 pass, T9 FAIL; D (records) FAIL.

| ID | Source | Severity | Where | Problem | Suggestion | Status |
|---|---|---|---|---|---|---|
| A-B1 | CP2 A | blocker (CP1 fix incomplete) | RFC-0005:184 | Still says the after-measurement replicate count is unconfirmed (m12 corrected :195 only) | Correction note: one per version (ADR-0013) | fixed 4089ca70 |
| D-B1 | CP2 D | blocker | feature doc T4, T17, Lanes; m7 | T17 needs ADR-0011's proven 12-entry snapshot, made only by T4's `store-export`, which lands after T17 | Owner: T4 before T17, or T17 from O0 recorded unproven | decided L16: T4 lands before T17 |
| C-B1 | CP2 C | blocker | T9 be067673, `regeneration-acceptance.ts:155-169`, `playwright-report.ts:58` | The report drops skipped tests, so a changed spec whose tests all skipped counts as silent: restored without a reason, or the fix loop's whole green round rejected | Carry skipped tests; silent only for a file that did not load; tests at both sites | open (integration) |
| D-J1 | CP2 D | major | `AGENTS.md:887`, `docs/observability-context.md:111`, `docs/architecture-remediation.md:354` | Name `qa.coveragePolicy.mode`; the key is `qa.changeCoverage.mode` (ADR-0005:75) | Correct | fixed 3b558bda |
| D-J2 | CP2 D | major | feature doc verifier-defects line, ADR-0005:77, T21 | ADR-0011 B1 (a flaky verdict replaced under enforce, `review.steps.ts:599-601`) has inconsistent carriers; V2 and VF edited its function without it | One carrier: T21, first; note step 1 passed over it | fixed 4089ca70 (ADR-0005 note) and the T21 row |
| D-J3 | CP2 D | major | feature doc | Accepted items with no task: RFC-0002 Q11 (Dockerfile), RFC-0003 decision 2, OD-14 strict schema, OD-18, OD-13 context-heal check (m3) | Add tasks | fixed (tasks T5, T24-T28, L16) |
| D-J4 | CP2 D | major | T18 | W13 (OD-1 judge residue), W14 (OD-17 row 8.2), V12 (OD-9) belong to decided ODs, not "outside every record" | Finish them under T18 | fixed 532ec2f9, 649058a1, 7bbee8d3, 17dfc4f5, b44706b9 (tables kept, unread) |
| D-J5 | CP2 D | major | L13 vs ADR-0010 point C, S1 | The PR closing and branch deletion ran on a go that named no PR numbers | Record the owner's words as a correction to ADR-0010 | fixed 4089ca70 (ADR-0010 correction with the owner's words) |
| D-J6 | CP2 D | major | T3, T23 rows | T3 still pending; T23 says two sites pending though 7dff1828 and 58d42e70 removed them | Correct | fixed (T3, T23 rows, L16) |
| D-J7 | CP2 D | major | Lanes; RFC-0007 F6 | T8 must ship ahead of any other closed-loop change (T9, T11) | Order T8 before T9 and T11, or record the owner's call | fixed (T8 row and the order, L16) |
| C-J1 | CP2 C | major | T9 on main | T9's review-correction tests fail on main (the always-on filter drops the fake's uncited rejection); 13 + 3 tests need its per-spec fakes | Fake with a verifiable citation; port the fakes | open (integration) |
| C-J2 | CP2 C | major | T7 on main, `qa-engine/test/support/cited-rejection.ts` | Helper on the old `corrections` shape; ~142 TS errors after merge (loud) | Port to `findings` | open (integration) |
| A-m1 | CP2 A, D-m4 | minor | `docs/efficiency-benchmark.md:528-529` | Describes the removed rule fold, `learningRepo`, rule deprecation | Correct | fixed 3b558bda |
| A-m2 | CP2 A | minor | `learning-gates.ts:24-25,41` | `LearningGates.fold` has no reader after L3; stale comments; test pins it | Remove | fixed 0d6685e7 |
| A-m3 | CP2 A | minor | RFC-0002:298 | Z row names fields L3/L4 removed | Correction note | fixed 4089ca70 |
| A-a1 | CP2 A | advisory | `scripts/campaign-model.ts` | `--grounding stitcher=` token changed from 1d/0d to on/off | none | noted |
| B-m1 | CP2 B | minor | `coordination-events.ts:117` | Two mutants survive since the two-delegating-run test left with escalation | Restore that half of the test | fixed 3245288e (1 equivalent survivor left) |
| B-m2 | CP2 B | minor | `docker-compose.override.yml:51-52` | Forwards the retired COMPLETE/EXHAUSTIVE budgets | Delete | fixed 2d100ea2 |
| B-m3 | CP2 B, D-m10 | minor | `scripts/coordination-benchmark.ts:75,85`, `lead-sidekicks.ts:1332`, `README.md:137`, `docs/observability-design.md:981`, `docs/observability-context.md:106` | Escalation residue | Remove | fixed 7eda6ded |
| B-m4 | CP2 B | minor | `web/public/API.md:105-107`, `web/public/js/data.mock.js:85` | Empty Engram table; oracle step in the mock | Remove | fixed 1a1e9fad |
| B-m5 | CP2 B | minor | `run-engine-factory.test.ts:883`, `fault-injection-counter-reader.test.ts:1` | Stale oracle text | Reword | fixed 8cf002ec |
| B-a1 | CP2 B | advisory (baseline) | CLI, API, webhook | Any unknown mode (a typo) still runs diff with success | Refuse any mode outside RUN_MODES | follow-up |
| B-a2 | CP2 B | advisory | `src/qa/value-report.ts` | CLI report lost its oracle row; bundle mutation not shown | Optional row | follow-up |
| C-m1 | CP2 C | minor | T11, `call-efficiency-tracker.ts:268` | Target redaction window 1000 -> 400 chars | Larger window or a straddle test | open (integration) |
| C-m2 | CP2 C | minor | T4, `suite-store.adapter.ts:473-485` | `restoreSnapshot` skips `assertWithinLimits` and the app check (V2); a test patches a private writer | Check limits and app | fixed b13b1df0 |
| C-m3 | CP2 C | minor | T10, `window-fit-references.ts:33` | Ids kept for a page the advisory prints under the same path with a different tree | none or narrow | noted |
| D-m1 | CP2 D | minor | ADR-0011 B2, B2', B3 | No carrier task | Name carriers | fixed (T28) |
| D-m3 | CP2 D | minor | `docs/lead-sidekicks.md:417` | Read-only concurrency text after OD-5 | Correct | fixed 3b558bda |
| D-m5 | CP2 D | minor | `src/settings/registry.ts:102`, `docs/settings.md:96` | QA_CAMPAIGN_FREEZE description | Correct | fixed 3b558bda |
| D-m6 | CP2 D | minor | `config/apps/example.yaml:31-36` | Says the loader strips unknown keys | Correct | fixed 3b558bda |
| D-m7 | CP2 D | minor | inventory | T18 deletions unmarked; judge modules have no row | Mark | open (re-marked at T13) |
| D-m8 | CP2 D | minor | `docs/architecture/README.md:136` | Stale sentence on records above RFC-0005 | Correct | fixed 4089ca70 |
| D-m9 | CP2 D | minor | RFC-0003:210 | Cites a test file C2 deleted | Correction | fixed 4089ca70 |
| D-m11 | CP2 D | minor | T19, T20 rows | Omit the ADR-0013 corrections decided when they land | Add | fixed (T19, T20 rows) |


## Checkpoint 3 (b900bc7e: step 1 plus T4-T11 integrated; four Opus 5.5 reviewers at max effort)

Verdicts: A T5 unit 1 PASS, T8 FAIL (A-B1, A-B2); B T6, T7, T10 PASS, T11 PASS with B-J2, T9 FAIL (B-B1); C records FAIL (C-B1-C-B3); D whole branch PASS (invariants hold, no unrequested output change, the worker-exit flake did not recur in five full runs). Decisions on open points take the recommended option (owner, L26: "No te detengas más a preguntarme").

| ID | Severity | Where | Problem | Decision / correction | Status |
|---|---|---|---|---|---|
| A-B1 | blocker | `e2e-execution.runner.ts:1033,1082`, `control-load.run.cjs:46` | The control waits for `networkidle` with the whole call's time; a never-idle launch page (SSE, polling) has the call killed before the spec child starts (probe: `infra-error` timed out, base passes in 1.4 s) | The control gets its own bound well below the call; on time-out it keeps what it saw and the spec child starts with the time left; RFC-0007 :126 amended; RED with a never-idle page | fixed b690fa8c |
| A-B2 | blocker | runner `:548` `readControls`, `control-load.ts:5` | The control file sits in the sandbox-writable capture dir and is read after the spec child: a spec rewrites it and charges 0 (base 7) | Read the control when its child closes, before the spec child starts, keep it in memory; any control file found later is forged; RED with a rewriting spec | fixed b690fa8c |
| A-J2 | major | `run-dump-bridge.ts:198` | The counters' own-budget guard (11d111db) no longer fails when broken | Fake clock advancing during the coverage job; counters keep their full budget | fixed 86f903e3 |
| A-J3 | major | runner `:1100`, `control-load.run.cjs:47` | A failed control still exempts what it saw; RFC-0007 says a failed control leaves everything charged | Follow the RFC: a control that failed or timed out without closing cleanly exempts nothing (with A-B1: a time-out that closed cleanly keeps what it saw, said in the RFC) | fixed b690fa8c |
| A-J4 | major | `control-load.ts:5`, `dump-sanitizers.ts:4`, `run-spec.use-case.test.ts:343`, `seed-dev-write-counter.test.ts:1` | Comments misstate the code | Rewrite | fixed b690fa8c, 86f903e3 |
| A-m1 | minor | `off-loop-executor.ts:80` | `worker.terminate()` on abort unguarded | Test the worker exits on abort | fixed 86f903e3 |
| A-m2 | minor | runner `:496,:503,:512` | Three T8 guards unguarded (no-sender ledger as page, project-name bound, control entry cap) | Tests through `readDevWrites` | fixed b690fa8c |
| A-m3 | minor | `run-output-reader.ts:21,73` | `OutOfTimeError` never thrown | Remove | fixed 86f903e3 |
| B-B1 | blocker (also at base; the path L26 meant to close) | `eslint.config.js:32`, `regeneration-acceptance.ts:173-182`, `playwright-report.ts`, `review.steps.ts:93,517` | A failing test still turns green with nothing run: `test.fixme`, `info().skip()`, aliases, `test.fail()` pass the lint; Playwright reports them skipped/expected; the acceptance keeps and proves the file (use-case probe: verdict pass, side effect pr) | Engine rule from the report, any app: a test of a changed file that ran in its prior bytes (or a correction named) and is now skipped, or runs with `expectedStatus: "failed"`, is not a pass: the file is restored or the round rejected; a kept file with no executed case gets no proof; the lint adds `disallowFixme` as an early hint; RED at the acceptance and the fix loop | fixed a6cded89 (RED at the acceptance and the fix loop; the lint half is `disallowFixme`). Note: the part "or a correction named" is not implemented, the rule reads the prior cases of the run only; recorded in ADR-0015 |
| B-J1 | major | `setup.adapter.ts:400,541,553`, AGENTS.md :206, :1041 | The lint refusal reaches only projects bootstrapped from this seed | B-B1's engine rule removes the dependence; correct both sentences | fixed by the records unit (AGENTS.md static-gate and per-file acceptance paragraphs, ADR-0015) |
| B-J2 | major (change-caused) | `opencode-tool-outcome.ts:13,37` | The tool-target redaction window fell from 1000 to 400 chars: an 800-char JWT keeps up to 200 chars | Window max(1000, 2x cap) or whole string under a safety bound; test with a straddling token | fixed 9b243fab (window `max(EVIDENCE_TEXT_SAFETY_BOUND, 2 x cap)`) |
| B-J3 | major | RFC-0008 :78, :183 | RFC-0008 says every kept file has a case; C-B1 and the skip decision are in no record | ADR-0015 records C-B1, the skip decision and B-B1; RFC-0008 correction note | fixed by the records unit (ADR-0015, RFC-0008 correction) |
| B-m1 | minor | `review-port.adapter.ts:163` | The new parse-miss line logs error though the run carries on | Carried-on level, asserted | fixed c71b0438 |
| B-m2 | minor | `failure-policy.ts:119,126` | `FailureAction` has no `satisfies Record` effect mapping | Add it | fixed c71b0438 |
| B-m3 | minor | `flow-outcomes.ts:24-31`, `regeneration-acceptance.test.ts:147-165` | Two surviving mutants | Assert the over-window level; give the infra-error fixture a case | fixed c71b0438 |
| B-m5 | advisory | `carry-on-level.test.ts:15`, `opencode-tool-outcome.test.ts:63-70` | Whole-file exemption; scan limited to `sse/` | Narrow and widen | fixed c71b0438 (the arch rule exempts one line), 9b243fab (the ownership scan covers the engine and the shell). Note on B-m4 (not a row of this table): the extension of the tool-state ownership scan to the engine and the shell, made in c71b0438 and 9b243fab, is recorded here as that note |
| C-B1 | blocker | AGENTS.md :172, :174, :178 | Boundary table rows still "lands with RFC-0006/0007/0004" | "in force" | fixed by the records unit (AGENTS.md rows now "in force") |
| C-B2 / D-m4 / A-J1 | blocker | `docs/execution-sandbox.md:198` | Describes the rejected per-worker control | Rewrite to the final design | fixed by the records unit (`docs/execution-sandbox.md`, AGENTS.md closed-loop paragraph; `docs/observability-design.md` already agreed) |
| C-B3 | blocker | RFC-0009 F6, `rejected-explanations.md:165-181`, README :38 | The accepted epoch break is unrecorded | Epoch rows: baseline, T17, the RFC-0009 break at 2af99d58, the slices epoch | fixed by the records unit (second table of the run index: O12-O16; README extended) |
| C-J1-C-J8, C-m1-C-m5 | major/minor | see reviewer C's table (CP3 C) | Record corrections, missing ADR for owner decisions, order line, verifier list | As reviewer C proposed | fixed by the records unit (C-J6 fixed 17bb77c1); see "Records unit" below |
| C-J6 | major | `scripts/check-previous-forms.ts` | No `qa.coveragePolicy` banned term | Add it with `exemptPrefixes` | fixed 17bb77c1 |
| D-J1 | major | `eslint.config.js:32` | Same as B-B1's lint half | With B-B1 | fixed a6cded89 |
| D-m1 | minor | `agents/package.json`, `agents/Dockerfile:22` | Plugin 1.16.0 beside OpenCode 1.17.7, no test ties them | Record why (no pin moved; smoke scripts unchanged) in the test's comment | fixed 17bb77c1 |
| D-m2 | minor | `agents/.gitignore` | Ignores the tracked files and itself | Keep only `node_modules`, `bun.lock` (only if OpenCode accepts it: prove with the EROFS probe) | fixed 17bb77c1 |
| D-m3 | minor | `src/settings/retired.ts` | `REFLECTOR_TIMEOUT_MS` missing | Add it | fixed 17bb77c1 |
| D-m5, D-m6 | minor | feature doc, ADR-0014 :4 | Stale rows; untranslated quote | Records | fixed by the records unit (Tasks rows; ADR-0014 translated) |
| D-m7 | advisory | `fixtures.ts:350`, `control-load.run.cjs:10` | Duplicated 300-char cut | Pin equal in a test | fixed b690fa8c |
| D-m8 | advisory | dead exports listed by D | Dead since step 1 | T13 | list regenerated at f2f7203b (T13 U1, section "D-m8 regenerated" at the end of this log); deletions in T13 U2 |

### Records unit (CP3 C rows, done in the records commit)

Reviewer C's table itself was not kept in the repository; each row below is the correction made, from the finding's one-line description in the records unit's brief.

| ID | Correction |
|---|---|
| C-J1 | README "How records cite code" and ADR-0011 Enforcement row 7: the previous-forms gate skips the path and citation checks for `docs/architecture/` since `a4cde318`. |
| C-J2 | RFC-0006: the schema and `verdict-validate.ts` did not move (carrier T13). |
| C-J3 | RFC-0005 (:195) and feature document T17: T17 is RFC-0005's after; the readout (12 restored, digest fc7ad52e, freeze off). |
| C-J4 | The interim replicate on b900bc7e is the after of everything at b900bc7e against T17; T12's version is after T5 unit 2 and the CP3 corrections and its before is T17. T5 and T12 rows, ADR-0011 Correction 2026-10-30. |
| C-J5 + B-J3 | ADR-0015 written; RFC-0008 correction; corrections quoting L13, L15 and L22 in RFC-0001 OD-13, ADR-0013 point 3 and ADR-0007 point B. |
| C-J7 | Implementation notes in RFC-0009 and RFC-0010 (the window is `max(EVIDENCE_TEXT_SAFETY_BOUND, 2 x cap)`). |
| C-J8 | Feature document: the Order line is the landed order; the verifier rule is "every task whose Risk line names a high-risk item"; T28 says "functions". |
| C-m1-C-m5 | RFC-0003 and RFC-0007 cite the integrated commits (`59196a16`, `1e962563`; `9666dc56`, `e58085a5`, `b690fa8c`); README pin claims; ADR-0001 correction (the owner accepted the proposed parts, ADR-0013); RFC-0011 `serviceImpacted` carried by T29 U2; feature document header (ADR-0014, ADR-0015) and S7's assumption settled by ADR-0014; T25 (strict at step 6) and T27 wording; T18's "context-heal pending, T27"; L27's "seed-owned" marked orchestrator-owned. |

### Accepted items with no carrier

Reviewer C's own list was not in the repository, so this list is derived by reading the accepted records against the Tasks table (ADR-0012, ADR-0013, RFC-0001 OD-1 to OD-20, RFC-0002 Q10-Q15, ADR-0002, ADR-0001). Each item now has a carrier or an owner.

| Accepted item | Where | Carrier |
|---|---|---|
| The publication adapter's fate (merges through REST when auto-merge fails, waits for no check) | RFC-0001 OD-20 | T30 (new), triggered by the first non-shadow publication |
| The review procedure: each RFC answers the P1-P7 questions | ADR-0001, ADR-0013 point 1 | T31 (new), standing rule |
| One owner per evidenced fact held by an ownership fitness function; option A revisited after the slices | ADR-0002 open question 1 (ADR-0013) | T13 |
| The three proposed owners (operator assistant, egress origins, the context-map rule), decided at step 2 | RFC-0002 Q15 | T13 |
| The fate of `src/server/metrics.ts` and `scripts/baseline-agent.ts` | RFC-0002 Q12 | T13 |
| The RFC-0006 schema and `verdict-validate.ts` move | RFC-0006 :134 (C-J2); m8 | T13 |
| Dead exports since step 1; the CP2 inventory marks | D-m8, D-m7 | T13 |
| Follow-ups W1 (sandbox env allowlists), W10 (dead fault-counter fields), V3 (ownership scan), V5 (missing `agents/opencode.json` loud at boot), V7 (M4 rule and `scripts/`) | review log, "follow-up" | T13 (dead code and the step 6 gates) |
| The reference set with human labels and a delivered-recall grader as a later record | RFC-0001 OD-2 | Owner (human labels; L22) |
| The retired selectors in `.env.example` | RFC-0001 OD-15 | Owner (the agent's permissions deny `.env*`; L22) |
| The repository's auto-merge setting | ADR-0010 point B | Owner (found off, L13) |
| The strict app-config schema | RFC-0001 OD-14 second half | T25 (with T13, step 6) |

Items outside every record (B-a1, a typo'd mode runs `diff`; B-a2, the CLI report's oracle row; W8 and W11, historical documents) stay `follow-up` for the owner to schedule, as the status column says. W7 (the history schema migration) is T20's decision.


## Refactor review 2026-10-30 (five sections, before 4105c582 against after 84c34afa)

Asked by the owner (L31). Five Opus 5.5 reviewers at max effort, read-only, each over one section, the finished work only, with the runs before and during the refactor read from their telemetry (baseline `run-ed28973-mvs7oo0f-17041c71`, T17 `run-ed28973-mvuspjsx-a31b6838`, interim `run-ed28973-mvv7lrgu-65aff66e`, the earlier campaigns). Every section returned **concerns**, none a blocker. Removals are real (about −32k lines, about 45 mechanisms deleted, no assertion weakened to pass: 557 flagged assertion changes sampled). What is wrong is method: S5 ("the rule searched across the whole codebase") was applied at the site where each defect was found, so the same classes survive elsewhere. The findings group into seven base causes; each becomes one task (ADR-0016).

| Base cause | Findings (section: id) | Task |
|---|---|---|
| R1. An ending without a typed record | A failed turn gets no row, no `chat` children, no usage (`agent-transport-policy.ts:620-627`; interim: 2 of 12 `invoke_agent` spans, 32 of 51 min, out of `/turns`, cost and agent time; same shape before the refactor, runs mvra9a3s, mvrwjx2d) (obs 1, agents gaps); the transport cut read `error.type=unknown`, `limit.fired=none` (obs 2); run-level limit and degrade not on the record or the root span (T17: reviewer `limit_fired=run-deadline`, run `limit_fired` null, `end_reason=decided`) (obs 3, xcut gaps); the decision spelled three ways (obs 4); the lead review turn drops admitted orders with no event when the room left is under `MIN_FLOW_MS` (`lead-sidekicks.ts:795,821-824`, probed) (agents 1); a flow whose session fails emits no coordination event (obs 6); an aborted coverage decode reads `no-changed-file-mapped` (`coverage-dump-reader.ts:41-42`, `objective-signal-port.adapter.ts:67`) (obj 3); no harvest/decode span, an opaque 8.5-min measure, control and spec children both `playwright-test` (obj gaps, obs 7); `run_spec` failures without a kind; no engine version on a run (obs 9); a browser exec span that never ends (obs 8); probe-report's own phase timing (obs 5); the baseline trace never reached Tempo and nothing says so | T32 |
| R2. More than one time authority | Transport timeout under the turn budget (fixed, `a6a1532b`); the tier budget limits only a run-level author while a coordinated first pass runs on `planBudgetMs`/`flowBudgetMs` (`generate-tests.use-case.ts:207-217`, AGENTS.md first-pass text) ; a second run clock (`wall-clock-budget.ts:30`); coordination gates and its 25 % `reserve()` guess phases it does not own; margins at single call sites (B2' `leadTurnBudget`); `allowance(purpose)` ignores its purpose (agents 2, xcut M1, obs 2) | T33 |
| R3. A test case's identity is lossy and keyed on its title | Prior cases drop the declared mode (`qa-case.ts:3`, `playwright-report.ts:68-73`), matched by `t.name` (`regeneration-acceptance.ts:239-249`): an unchanged `test.fail()` blocks regeneration, a renamed then skipped or `test.fail()` test passes (probed); two proof writers with different rules: the first pass proves skipped and `test.fail()`-only files (`fix-loop.steps.ts:400-414`, probed to `pass` and a PR); the skip guard enforced twice with different scope and outcome (seed lint, engine rule) (obj 1, 2, 4; xcut M3) | T34 |
| R4. Agent answers read by several readers | Lead review skips unreadable entries silently (`lead-review.ts:143-148`), lead correction coerces any action to `revise` (`lead-correction.ts:236`), delegation reading fills defaults and requires an unread `recommendation`; findings identified by text (`review.steps.ts:284-287`); a rejection with no findings skips the evidence filter (`:273`); the experiment harness's own gate (agents 4-7) | T35 |
| R5. A turn fault read as a dead session | Any fault but a timeout disposes the session and forces `replace` (`sidekick-executor.ts:116-121`, `lead-sidekicks.ts:540-547`, `lead-review.ts:139`); in the interim run it threw away the flow's four `run_spec` calls and the third sidekick's spec was delivered unproven, which failed the run (agents 3) | T35 |
| R6. One rule, two copies (S5 applied at the found site) | `dev` optional plus a refine plus the engine twin, dead throws, 27 `dev?.` reads (plat M1); `run-event.ts` mirror of the kernel schema (plat M2); retired modes as a deny-list at three entry points while unknown modes default to diff (xcut M2); cut-then-redact still at `prompt-body-logs.ts:115,150`, `prompt-text.ts:18` (xcut M2); two retired-variable lists, two model-name derivations, the agent roster read from the image copy while step limits are read live (plat m1, m2, M4); four same-spec helpers, `MAX_REVIEW_ROUNDS` twice, three printed-route derivations, the 300-char cut copied into the control script (xcut, agents 8-9); the log-level row claims more than the code (17 `carryOn` against 255 literal calls) | T36 |
| R7. Placement and process | Row-3 logic written into the shell: app-config validation, the bundle-mutation switch, context-heal qualification (plat M3); no file moved out of `src/` (ADR-0002 decision 2 unmet); commits with a Risk item and no verifier: b690fa8c, a6cded89, 86f903e3, 9b243fab, 84c34afa, T6, T7, T9-T11, T28 (xcut M4); stale records: T24 row, T28 cites a missing L30, L20 and L28 misread where time went, ADR-0011 "B1-B3 closed", RFC-0003 measurement, ADR-0015 points 3-4 hold only on the acceptance path | T37 (records now, verifiers at CP4), T13 (moves) |

Live evidence confirmed: T6 (Loki ERROR 1, 1, 0 across baseline, T17, interim), T10 (the DOM denominator change of O14), T4 (12 restored, `not_restored=0`, digest `fc7ad52e` equal), T8 (control children 3.5-14.7 s, about 47 s of the interim's 43.2-min generate: not its cause), T5 (identical measurement on the interim's real dumps; unit 2 slower by 1.6-2.5 s a read, unproven live). T17 against the baseline is a direction only (O11 ranged 0.74-0.90 on the same app commit). Probe tests that reproduced R1, R3 and R5 are kept for the RED tests of their tasks.

## D-m8 regenerated: exported symbols no other module imports (T13 U1, code at f2f7203b)

Method (a throwaway script on the TypeScript compiler API, not committed): the program holds every .ts/.tsx/.mts file of `src`, `qa-engine/src`, `qa-engine/test`, `scripts`, `packages` and `agents`; each identifier and each destructured property of an `await import(...)` is resolved through aliases to its declaration; an export counts as imported when a file other than its own resolves to it. A barrel re-export (`export { x } from`) is not a use; the symbol it re-exports is. Test files are `*.test.ts`, `qa-engine/test/**`, `__fixtures__`, `test-support`. An export of a test-support module is listed like any other. Dynamic loads by a computed specifier, string references and non-TypeScript consumers (the Go client, `web/public`) are not seen: a symbol named below was also searched by name across the repository before it was deleted.

| Class | Count | Meaning |
|---|---|---|
| A | 70 | no importer and no reference at all, in its own file or elsewhere |
| B | 58 | imported only by tests, no reference in its own file |
| C | 943 | no importer; used only inside its own file (the `export` keyword is the only excess) |
| D | 532 | imported only by tests; also used inside its own file |

Classes A and B are the candidates for deletion (T13 U2 records its decisions below this list). Classes C and D are not dead code: the symbol is live, only its `export` is unused, so they are listed for the ownership work of steps 3 to 6 (a module that narrows its surface drops the keyword) and are not changed by U2.

### Class A (no reference anywhere)

```
qa-engine/src/contexts/coordination/application/coordination-sections/index.ts:CoordinationPromptId
qa-engine/src/contexts/coordination/application/lead-correction.ts:renderRefusedCorrection
qa-engine/src/contexts/coordination/application/lead-plan.ts:renderRejectedPlanRequest
qa-engine/src/contexts/coordination/application/lead-review.ts:ReviewAction
qa-engine/src/contexts/evaluation/domain/grader-catalog.ts:StepIntent
qa-engine/src/contexts/generation/domain/manifest-repository.ts:ContextPackResult
qa-engine/src/contexts/generation/domain/manifest-repository.ts:DomGrounding
qa-engine/src/contexts/generation/domain/manifest-repository.ts:PlanObjectiveView
qa-engine/src/contexts/generation/domain/selector-check.ts:CatalogSelectors
qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider.ts:defaultWorkRoot
qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts:prepareSandboxWorkdir
qa-engine/src/shared-infrastructure/telemetry/run-spans.ts:withRunChildSpan
qa-engine/src/shared-kernel/agent-browser.ts:AgentBrowserSetting
qa-engine/src/shared-kernel/context-item-ids.ts:IdKind
qa-engine/src/shared-kernel/contract/events.ts:RunEventType
qa-engine/src/shared-kernel/file-classes.ts:isLowRelevance
qa-engine/src/shared-kernel/file-classes.ts:isStyleSheet
qa-engine/src/shared-kernel/ports/plan-snapshot.port.ts:NO_PLAN_SNAPSHOTS
qa-engine/src/shared-kernel/route-availability.ts:factsOfClass
qa-engine/src/shared-kernel/telemetry/genai-semconv.ts:GenAiAttrKey
qa-engine/src/shared-kernel/telemetry/genai-semconv.ts:GenAiMetricName
src/contract/commands.ts:AgentActivity
src/contract/commands.ts:AgentConfigApplyResult
src/contract/commands.ts:AgentRestartRequest
src/contract/commands.ts:AgentRestartResponse
src/contract/commands.ts:AgentTurnView
src/contract/commands.ts:ApiError
src/contract/commands.ts:AppView
src/contract/commands.ts:AskRequest
src/contract/commands.ts:AskResponse
src/contract/commands.ts:BoundaryProfileWire
src/contract/commands.ts:CampaignInput
src/contract/commands.ts:ChatEntry
src/contract/commands.ts:ConfirmBoundariesInput
src/contract/commands.ts:ContextMapView
src/contract/commands.ts:ContinueRequest
src/contract/commands.ts:ContinueResult
src/contract/commands.ts:CreateAppInput
src/contract/commands.ts:CreateAppResult
src/contract/commands.ts:CreateRunInput
src/contract/commands.ts:CreateRunResult
src/contract/commands.ts:DeleteAppResult
src/contract/commands.ts:LoginBootstrapResult
src/contract/commands.ts:LoginRequest
src/contract/commands.ts:LoginResponse
src/contract/commands.ts:OnboardingJobStatus
src/contract/commands.ts:OnboardServiceInput
src/contract/commands.ts:ProposeBoundariesInput
src/contract/commands.ts:QueueStatus
src/contract/commands.ts:RegradeJob
src/contract/commands.ts:RegradeRequest
src/contract/commands.ts:RegradeStarted
src/contract/commands.ts:RepoInfo
src/contract/commands.ts:RepoListItem
src/contract/commands.ts:RepoListResponse
src/contract/commands.ts:RoleAssignment
src/contract/commands.ts:RunEvaluation
src/contract/commands.ts:RunReportView
src/contract/commands.ts:Score
src/contract/commands.ts:SignalsView
src/contract/commands.ts:SpecRecord
src/contract/commands.ts:UpdateAppInput
src/integrations/opencode-client.ts:getOpenSessions
src/orchestrator/config-loader.ts:RepoMatch
src/orchestrator/schemas.ts:GeneratorRebuttal
src/orchestrator/schemas.ts:ServiceConfig
src/orchestrator/schemas.ts:ValidatedGeneratorVerdict
src/orchestrator/schemas.ts:ValidatedReviewerVerdict
src/orchestrator/schemas.ts:ValidatedWebhookPayload
src/server/onboarding/proposer-verdict.schema.ts:ProposerVerdict
```

### Class B (tests only, no use in its own file)

```
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.page-readers.ts:isVisibleChallenge  <- login-discovery.challenge.test.ts
qa-engine/src/contexts/coordination/application/coordination-context.ts:CoordinationContext  <- coordination-seam.contract.test.ts
qa-engine/src/contexts/coordination/application/coordination-decision.ts:CoordinationDecision  <- coordination-seam.contract.test.ts
qa-engine/src/contexts/coordination/application/coordination-decision.ts:isCoordinationAction  <- coordination-seam.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromBudget  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromChangeAnalysis  <- coordination-evidence.contract.test.ts, coordination-sanitization.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromCoverage  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromExecution  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromFailureClass  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromFixLoop  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromGeneration  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromReview  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromSelectors  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-from.ts:evidenceFromValidation  <- coordination-evidence.contract.test.ts, coordination-phases-5-14.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-precedence.ts:agentClaimInvalidatedBy  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-precedence.ts:confidenceRank  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/evidence-precedence.ts:preferredEvidence  <- coordination-evidence.contract.test.ts
qa-engine/src/contexts/coordination/application/kind-session.ts:openKindSession  <- kind-session.test.ts
qa-engine/src/contexts/coordination/application/lead-correction.ts:renderLeadCorrection  <- lead-correction.test.ts, lead-turns.window-fit.test.ts, model-agnostic-prompts.test.ts
qa-engine/src/contexts/coordination/application/lead-review.ts:renderLeadReview  <- lead-review.test.ts, lead-turns.window-fit.test.ts
qa-engine/src/contexts/coordination/application/plan-coverage.ts:renderReplanRequest  <- plan-coverage.requests.test.ts, plan-coverage.test.ts
qa-engine/src/contexts/coordination/application/pushback.ts:validateDelegationAuthority  <- coordination-pushback.test.ts
qa-engine/src/contexts/coordination/application/sidekick-kinds.ts:REGISTERED_SIDEKICK_KINDS  <- sidekick-kinds.test.ts
qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts:resetSharedCoordinationTelemetryForTests  <- build-coordination.test.ts
qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts:captureDomByRoute  <- dom-snapshot.test.ts, dom-snapshot.testid-grounding.test.ts
qa-engine/src/contexts/generation/infrastructure/prompt-builders/context-assembler.ts:section  <- context-assembler.adapter.wrap.test.ts, context-assembler.test.ts, prompts.test.ts
qa-engine/src/contexts/run-orchestration/application/run-flow/run-flow.ts:next  <- run-flow.test.ts
qa-engine/src/contexts/test-execution/domain/output-token-filter.ts:MIN_OPAQUE_TOKEN_CHARS  <- output-token-filter.test.ts
qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts:matchFailureDumps  <- e2e-execution.runner.test.ts
qa-engine/src/shared-infrastructure/egress/dns-filter.ts:buildDnsQuery  <- dns-filter.test.ts
qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts:authSessionEnv  <- auth-session.adapter.test.ts, auth-session-env.test.ts
qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts:resetExecSandboxWarnings  <- exec-sandbox.test.ts, exec-trace.test.ts, tool-trace.test.ts
qa-engine/src/shared-infrastructure/process-sandbox/git-hardening.ts:setVerificationTimeout  <- git-hardening.test.ts
qa-engine/src/shared-kernel/agent-browser.ts:AGENT_BROWSER_TOOLS  <- prompts.live-browser.test.ts, agent-tool-surface.test.ts
qa-engine/src/shared-kernel/code-graph-tools.ts:CODE_GRAPH_TOOLS  <- agent-tool-surface.test.ts
qa-engine/src/shared-kernel/context-budget.ts:bytesOfTokens  <- context-budget.test.ts
qa-engine/src/shared-kernel/ports/logger.port.ts:memoryLogger  <- lead-sidekicks.test.ts, review-port.adapter.test.ts, failure-policy.test.ts ...
qa-engine/src/shared-kernel/ports/process-logger.ts:resetProcessLoggerForTests  <- lead-sidekicks.test.ts, process-audit-port.adapter.test.ts, review-port.adapter.test.ts ...
qa-engine/src/shared-kernel/result.ts:map  <- result.test.ts
qa-engine/src/shared-kernel/telemetry/genai-semconv.ts:GENAI_SEMCONV_REV  <- attribute-registry.test.ts
qa-engine/src/shared-kernel/telemetry/guarded-telemetry.ts:ThrowingTelemetry  <- guarded-telemetry.test.ts, runner.telemetry.test.ts, agent-turn-trace.test.ts ...
src/agent-runtime/declared-model.ts:declaredModelsFrom  <- declared-model.test.ts
src/contract/commands.ts:QaCase  <- commands.test.ts
src/integrations/fixtures/opencode-roster.ts:loadRoster  <- opencode-roster-fixture.test.ts
src/integrations/fixtures/opencode-roster.ts:rosterFixturePath  <- opencode-roster-fixture.test.ts, run-engine-factory.step-limit.test.ts, run-engine-factory.test.ts
src/integrations/opencode-client.ts:setAgentsConfigPath  <- run-engine-factory.step-limit.test.ts, run-engine-factory.test.ts
src/no-console.scan.ts:consoleCallLines  <- no-console.scan.test.ts, no-console.test.ts
src/server/engine-root.ts:wireEngine  <- engine-root.test.ts, seam-parity.contract.test.ts
src/server/web-console/console-harness.ts:appView  <- console-views.test.ts, fleet-model.test.ts
src/server/web-console/console-harness.ts:controlApi  <- console-login.test.ts, console-views.test.ts, fleet-model.test.ts
src/server/web-console/console-harness.ts:loadConsole  <- console-login.test.ts, console-views.test.ts, fleet-model.test.ts ...
src/server/web-console/console-harness.ts:runRecord  <- console-views.test.ts, fleet-model.test.ts
src/server/web-console/console-harness.ts:sseEvent  <- console-views.test.ts, run-stream.test.ts
src/settings/active.ts:resetActiveSettingsForTests  <- active.test.ts
src/settings/registry.ts:isRegisteredSetting  <- compose-parity.test.ts
src/telemetry/instrument-table.ts:checkInstrumentTable  <- agent-turn-trace.test.ts, instrument-table.test.ts, run-trace.test.ts
src/telemetry/process-telemetry.ts:resetProcessTelemetryForTests  <- process-telemetry.test.ts
src/telemetry/trace-harness.ts:traceHarness  <- evaluation-service.test.ts, run-engine-factory.test.ts, runner.after-run.test.ts ...
```

### Class C (no importer, used inside its own file), by file

```
qa-engine/src/contexts/agent-tools/composition/build-agent-tools.ts: AgentToolsApi
qa-engine/src/contexts/agent-tools/domain/authoring-failure.ts: AuthoringFailureKind, RUN_SPEC_FAILURE_KINDS, RunSpecFailureKind
qa-engine/src/contexts/agent-tools/domain/closed-loop.ts: ClosedLoopSignals
qa-engine/src/contexts/agent-tools/domain/code-graph-query.ts: CodeGraphQuery
qa-engine/src/contexts/agent-tools/domain/explore-answer.ts: Size
qa-engine/src/contexts/agent-tools/domain/run-geolocation.ts: GEOLOCATION_REFUSAL, GeolocationChange, GeolocationRefusal, RunGeolocationInit
qa-engine/src/contexts/agent-tools/infrastructure/adapters/agent-browser-port.adapter.ts: MAX_AGENT_BROWSER_RENEWALS
qa-engine/src/contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts: MAX_RUN_SPEC_RENEWALS
qa-engine/src/contexts/agent-tools/infrastructure/adapters/tool-call-trace.ts: ToolCallTrace
qa-engine/src/contexts/agent-tools/infrastructure/geolocation-registry.ts: BoundGeolocation
qa-engine/src/contexts/app-catalog/composition/build-app-catalog.ts: AppCatalogApi
qa-engine/src/contexts/app-catalog/domain/app-repository.ts: ServiceConfig
qa-engine/src/contexts/app-catalog/domain/app.aggregate.ts: AppConfigInput, AppServiceConfig
qa-engine/src/contexts/app-catalog/domain/auth-session.ts: AuthResolution, AuthResolutionMethod
qa-engine/src/contexts/app-catalog/domain/helpers/login-evidence.ts: FormState, LoginMarkers, LoginRequest
qa-engine/src/contexts/app-catalog/domain/repo-resolution.service.ts: RepoResolution
qa-engine/src/contexts/app-catalog/infrastructure/auth-session.adapter.ts: ContextRoute, ContextRouteMap
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.page-readers.ts: IS_VISIBLE_CHALLENGE_SOURCE
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.runner.ts: LOGIN_DISCOVERY_KILL_HEADROOM_MS, LoginDiscoveryCrash, LoginDiscoveryRunnerDeps
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.script.ts: DEFAULT_LADDER_BUDGET_MS
qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts: ConfigLoaders, ConfigSkipLogger
qa-engine/src/contexts/change-analysis/composition/build-change-analysis.ts: ChangeAnalysisApi, ChangeAnalysisDeps, CodeGraphDeps
qa-engine/src/contexts/change-analysis/domain/change-scope.ts: ScopeDisagreement
qa-engine/src/contexts/change-analysis/domain/commit-classification.ts: CommitAction, CommitClassification, CommitIntent, CommitType
qa-engine/src/contexts/change-analysis/domain/page-files.ts: PageFilesDisagreement
qa-engine/src/contexts/change-analysis/domain/reach-proof.ts: WalkChain
qa-engine/src/contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts: ScoredSymbolRef
qa-engine/src/contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts: ChangeScopePortAdapterDeps
qa-engine/src/contexts/change-analysis/infrastructure/adapters/structural-signal-port.adapter.ts: DOSSIER_LIMITS, StructuralDossier
qa-engine/src/contexts/change-analysis/infrastructure/adapters/suite-enrichment.ts: MAX_SUITE_FILES_READ, MAX_SUITE_FILE_BYTES
qa-engine/src/contexts/coordination/application/acceptance-report.ts: AcceptanceReport, AcceptanceReportDefectReason, MAX_DEV_STATE_PAGES, UNMET_CAUSES
qa-engine/src/contexts/coordination/application/answer-reading.ts: EntriesRead, MAX_UNREADABLE_LISTED
qa-engine/src/contexts/coordination/application/author-dispatch.ts: AuthorRequest, RunAuthorTarget
qa-engine/src/contexts/coordination/application/brief-change.ts: ChangeFacts, boundedSteps
qa-engine/src/contexts/coordination/application/coordination-sections/brief-sections.ts: BriefPromptContext
qa-engine/src/contexts/coordination/application/coordination-sections/feedback-sections.ts: FeedbackPromptContext
qa-engine/src/contexts/coordination/application/coordination-sections/lead-turn-sections.ts: CorrectionPromptContext, FAILURE_BYTES_NOTE, RefusedCorrectionPromptContext, RejectedPlanPromptContext, ReviewPromptContext, UnreadableAnswerPromptContext
qa-engine/src/contexts/coordination/application/coordination-sections/replan-sections.ts: ReplanPromptContext
qa-engine/src/contexts/coordination/application/coordination-telemetry.ts: CoordinationRouteCounts, CoordinationTelemetryKind, LeadDecisionAction
qa-engine/src/contexts/coordination/application/delegation-brief.ts: ArtifactReference, DelegationScope
qa-engine/src/contexts/coordination/application/delegation-failure-class.ts: DelegationFailureClass
qa-engine/src/contexts/coordination/application/delegation-result.ts: FileChange
qa-engine/src/contexts/coordination/application/dev-state-backing.ts: pathOfRef
qa-engine/src/contexts/coordination/application/evidence-ref.ts: EvidenceKind
qa-engine/src/contexts/coordination/application/fan-out-dispatcher.ts: DEFAULT_ABORT_GRACE_MS, FanOutDispatcherDeps, FanOutOptions, FlowResult, FlowSlot
qa-engine/src/contexts/coordination/application/flow-capacity.ts: CapacityInput, GrantInput
qa-engine/src/contexts/coordination/application/flow-outcomes.ts: FlowOutcomeKind, IncompleteFlow
qa-engine/src/contexts/coordination/application/lead-correction.ts: CorrectionAdmission, flowsHoldingFile
qa-engine/src/contexts/coordination/application/lead-plan.ts: DropBasis, MAX_ACCEPTANCE_CHARS, MAX_ACCEPTANCE_ITEMS, MAX_CANDIDATE_ID_CHARS, MAX_DROPPED, MAX_FLOW_CANDIDATES, MAX_FLOW_ID_CHARS, MAX_NOOP_REASON_CHARS, MAX_OBJECTIVE_CHARS, MAX_ROUTES, MAX_ROUTE_CHARS, PlanDowngrade, ROUTE, isRecord, slugOf, text
qa-engine/src/contexts/coordination/application/lead-review.ts: ReviewAdmission
qa-engine/src/contexts/coordination/application/lead-sidekicks.ts: CorrectionTally, FlowProposals
qa-engine/src/contexts/coordination/application/maintenance-flow.ts: CandidateFlowInput, MaintenanceFlowInput, confinedSpecFile
qa-engine/src/contexts/coordination/application/plan-coverage.ts: dropRefusal
qa-engine/src/contexts/coordination/application/pushback.ts: DevStateBacker, PUSHBACK_REASONS, PushbackFinding, PushbackReason
qa-engine/src/contexts/coordination/application/sidekick-authoring.ts: SidekickAuthoringDecision
qa-engine/src/contexts/coordination/application/sidekick-executor.ts: SidekickExecutorDeps, SidekickRender
qa-engine/src/contexts/coordination/application/sidekick-kinds.ts: AuthorTargetSpec, DelegatingKindSpec, ReviewKindSpec, SidekickBudget, SidekickKindSpec, SidekickWorkspace
qa-engine/src/contexts/coordination/application/sidekick-turn-end.ts: SidekickEnd
qa-engine/src/contexts/coordination/composition/build-coordination.ts: CoordinationApi
qa-engine/src/contexts/coordination/domain/delegation-workspace.ts: WorkspaceChangeKind
qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts: defaultCoordinationTelemetryFsDeps
qa-engine/src/contexts/coordination/infrastructure/adapters/delegation-workspace.adapter.ts: DEFAULT_WORKSPACE_LIMITS, FsDelegationWorkspaceDeps, WorkspaceLimits
qa-engine/src/contexts/cross-run-learning/composition/build-cross-run-learning.ts: CrossRunLearningApi, CrossRunLearningDeps
qa-engine/src/contexts/cross-run-learning/domain/learning-gates.ts: LearningGateInput, LearningGates
qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts: AppliedAudit, Disposition
qa-engine/src/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts: ProcessAuditPortDeps
qa-engine/src/contexts/evaluation/application/grade-run.use-case.ts: GradeRunDeps
qa-engine/src/contexts/evaluation/application/regrade.use-case.ts: RegradeDeps
qa-engine/src/contexts/evaluation/domain/benchmark-dataset.ts: DATASET_NAME_PATTERN, DATASET_VERSION_PATTERN, DatasetItem, MAX_DATASET_ITEMS, MAX_GUIDANCE_CHARS
qa-engine/src/contexts/evaluation/domain/campaign-comparison.ts: ArmStat, ArmSummary, Assessment, CONFIDENCE, CompareOptions, DataType, Difference, Interval, MIN_REPLICATES, Polarity, RenderOptions, ScoreComparison
qa-engine/src/contexts/evaluation/domain/campaign-runs.ts: EvaluationState
qa-engine/src/contexts/evaluation/domain/context-refs.ts: ExtractReferencesInput, ExtractedReferences
qa-engine/src/contexts/evaluation/domain/evidence.ts: RegradeJobStatus
qa-engine/src/contexts/evaluation/domain/grader-catalog.ts: CONTEXT_FOCUSED_SOURCES, COVERAGE_CLASSES, FLAKY_CLASSES, REVIEW_VERDICTS, ScoreSpec
qa-engine/src/contexts/evaluation/domain/graders.ts: Grader
qa-engine/src/contexts/evaluation/domain/score.ts: SCORE_DATA_TYPES, SCORE_POLARITIES, SCORE_SOURCES, ScoreSource, ScoreValue
qa-engine/src/contexts/evaluation/domain/use-case-reference.ts: REACHABILITY, Reachability, ReferenceChange, ReferenceUseCase
qa-engine/src/contexts/generation/application/generate-tests.use-case.ts: LeadSession, PlanResult
qa-engine/src/contexts/generation/composition/build-generation.ts: GenerationApi
qa-engine/src/contexts/generation/domain/agent-error-class.ts: MAX_CAUSE_DEPTH, ProviderErrorPayload
qa-engine/src/contexts/generation/domain/call-sequence.ts: CallStatus
qa-engine/src/contexts/generation/domain/changed-values.ts: CHANGED_VALUES_LEGEND
qa-engine/src/contexts/generation/domain/data-state-route.ts: fillsDataStateTemplate
qa-engine/src/contexts/generation/domain/deterministic-review-precheck.ts: ReviewPrecheckFinding, ReviewPrecheckInput, ReviewSpecSource, precheckSpecAgainstDom
qa-engine/src/contexts/generation/domain/expectation-gaps.ts: GapSources
qa-engine/src/contexts/generation/domain/generation-end.ts: GenerationEndFacts, GenerationNoteInput, GenerationTurnFacts
qa-engine/src/contexts/generation/domain/generation-input.ts: CommitType, FeBeLink, FlowEntry, RouteEntry
qa-engine/src/contexts/generation/domain/generator-time-budget.ts: GeneratorTimeBudgetInput
qa-engine/src/contexts/generation/domain/harness-facts.ts: MAX_PROJECT_NAME_LENGTH, PlaywrightConfigFacts, PlaywrightProjectFact
qa-engine/src/contexts/generation/domain/nav-outcome.ts: NavOutcome
qa-engine/src/contexts/generation/domain/pack-pages.ts: LeftOutPage, pageIsNamed, wantedPages
qa-engine/src/contexts/generation/domain/pack-requests.ts: PageRequestFacts, RequestFact
qa-engine/src/contexts/generation/domain/pre-exec-grounding.service.ts: PreExecGroundingInput, PreExecGroundingResult
qa-engine/src/contexts/generation/domain/prompt-contract-lint.ts: ESTABLISHED_TRUST_LEXICON, FLOOR_PHRASES, LintBudget, LintOptions, LintRule, NEGATED_TRUST_LEXICON
qa-engine/src/contexts/generation/domain/review-change-view.ts: HunklessSection, ReviewFlowSlice
qa-engine/src/contexts/generation/domain/review-output.ts: ReviewCorrectionClass
qa-engine/src/contexts/generation/domain/route-availability-classifier.ts: AvailabilityContext
qa-engine/src/contexts/generation/domain/route-availability-section.ts: availabilityReason
qa-engine/src/contexts/generation/domain/route-instantiation.ts: MISSING_PAGE_SEGMENT
qa-engine/src/contexts/generation/domain/route-ranking.ts: RankableMap, RankingChange
qa-engine/src/contexts/generation/domain/route-table.ts: MAX_UNRESOLVED_LINKS, MatchStep, RouteMatch
qa-engine/src/contexts/generation/domain/selector-check.ts: PresenceResult, extractProposedSelectors, hasNonExtractableLocator, selectorKey, selectorUnique
qa-engine/src/contexts/generation/domain/step-intent.ts: StepIntent, StepOfCalls
qa-engine/src/contexts/generation/domain/step-limit.ts: TurnShape
qa-engine/src/contexts/generation/domain/suite-listing.ts: ListingEntry, ListingOptions
qa-engine/src/contexts/generation/domain/tool-outcome.ts: ToolCallReading
qa-engine/src/contexts/generation/domain/tool-sequence.ts: ToolCallSubject, ToolSubjectKind
qa-engine/src/contexts/generation/domain/turn-efficiency-summary.ts: BuildTurnCallMetricsInput
qa-engine/src/contexts/generation/infrastructure/adapters/changed-decisions.ts: MAX_FILES_READ_FOR_DECISIONS
qa-engine/src/contexts/generation/infrastructure/adapters/changed-label-lines.ts: MAX_FILES_READ_FOR_LABELS
qa-engine/src/contexts/generation/infrastructure/adapters/generation-turns.adapter.ts: GenerationTurnsContext
qa-engine/src/contexts/generation/infrastructure/adapters/implementation-resources.ts: MAX_DECLARED_FILES_PER_ROUTE, MAX_IMPLEMENTATION_FILES_READ_PER_MAP, MAX_IMPLEMENTATION_FILES_READ_PER_ROUTE
qa-engine/src/contexts/generation/infrastructure/adapters/pre-exec-grounding-port.adapter.ts: PreExecGroundingStaticContext
qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts: PreGenerationGroundingStaticContext, readHarnessFacts
qa-engine/src/contexts/generation/infrastructure/adapters/review-dom-grounding-port.adapter.ts: ReviewDomGroundingStaticContext
qa-engine/src/contexts/generation/infrastructure/adapters/review-port.adapter.ts: ReviewPortCollaborators, ReviewPortStaticContext
qa-engine/src/contexts/generation/infrastructure/adapters/route-change-evidence.ts: RouteEvidenceInput
qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts: AgentDepsCollaborators, AttemptUsage, DEFAULT_ABORT_SETTLE_MS, WatchdogFactory
qa-engine/src/contexts/generation/infrastructure/consumer-expectation/consumer-expectations.source.ts: MAX_CONSUMER_SOURCES, MAX_CONSUMER_SOURCE_BYTES
qa-engine/src/contexts/generation/infrastructure/consumer-expectation/typescript-expectations.ts: MAX_DECLARED_TYPE_CHARS, TypeScriptExpectationInput
qa-engine/src/contexts/generation/infrastructure/context-pack.ts: ContextPackTrace
qa-engine/src/contexts/generation/infrastructure/dom-capture-trace.ts: pageOf, routeEventAttrs
qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts: MAX_CAPTURE_OUTPUT_CHARS, MAX_LINK_SEEDS, MAX_NAMES_RESOLVED, MAX_REPEATED_PER_ROUTE, MAX_SCOPE_CHARS, MAX_SCOPE_DEPTH, MAX_SHAPE_BODY_BYTES, MAX_SHAPE_DEPTH, MAX_SHAPE_ITEMS, MIN_DATA_STATE_READ_MS, RawAttr, RawNavigationFacts, SHAPE_READ_TIMEOUT_MS, reportedRouteOf
qa-engine/src/contexts/generation/infrastructure/manifest-repository.adapter.ts: ManifestFns
qa-engine/src/contexts/generation/infrastructure/openapi-response-fields.source.ts: MAX_OPENAPI_DOCUMENTS, MAX_OPENAPI_DOCUMENT_BYTES
qa-engine/src/contexts/generation/infrastructure/pack-availability.ts: PackAvailability
qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-context.ts: LiveBrowser
qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts: GeneratorPrompt
qa-engine/src/contexts/generation/infrastructure/prompt-builders/review-render.ts: ReviewSpecsOutcome
qa-engine/src/contexts/generation/infrastructure/prompt-builders/reviewer-change-sections.ts: ChangeItem, ReviewerChangeContext
qa-engine/src/contexts/generation/infrastructure/prompt-builders/reviewer-sections.ts: ReviewerContext, ReviewerContextOpts
qa-engine/src/contexts/generation/infrastructure/prompt-builders/task-builders.ts: EffortTier, TaskGuards, TaskParts
qa-engine/src/contexts/generation/infrastructure/prompt-rendering.adapter.ts: PromptWindows
qa-engine/src/contexts/generation/infrastructure/resilience/circuit-breaker.ts: CircuitOpenError
qa-engine/src/contexts/generation/infrastructure/resilience/stall-watchdog.ts: StallWatchdogOptions, StallWatchdogTimers
qa-engine/src/contexts/generation/infrastructure/route-catalog.ts: DegradeReason, RouteCatalog, RouteStatus
qa-engine/src/contexts/generation/infrastructure/route-table/angular-router.extractor.ts: RawChildRef, RawExport, RawGuard, RawImport
qa-engine/src/contexts/generation/infrastructure/route-table/route-tables.source.ts: MAX_ROUTE_SOURCE_FILES, RouteTablesInput
qa-engine/src/contexts/generation/infrastructure/sse/agent-activity.ts: DropReason, RawEvent, RouteResult, RoutedActivity
qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts: EventStreamReconnectOptions, OpenStreamFn
qa-engine/src/contexts/generation/infrastructure/sse/opencode-tool-outcome.ts: ToolOutcomeDeps, defaultToolOutcomeDeps
qa-engine/src/contexts/generation/infrastructure/telemetry/turn-children.ts: ChildrenInput, ChildrenSummary
qa-engine/src/contexts/generation/infrastructure/telemetry/turn-probe.ts: TurnProbeDeps
qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts: VerdictParsers
qa-engine/src/contexts/objective-signal/composition/build-objective-signal.ts: ObjectiveSignalApi, ObjectiveSignalDeps
qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts: addedLines, executableChanged
qa-engine/src/contexts/objective-signal/domain/causal-label.ts: CausalBasis, CausalCaseLabel, CausalFlow, CausalReach, MAX_CAUSAL_VIA
qa-engine/src/contexts/objective-signal/domain/coverage-collector.ts: BranchArm, CoveredLines, DumpsThatRan
qa-engine/src/contexts/objective-signal/domain/coverage-exclusions.ts: UnreachableInput
qa-engine/src/contexts/objective-signal/domain/decide-coverage.service.ts: CoverageMode
qa-engine/src/contexts/objective-signal/domain/dump-outcome.ts: COVERAGE_READ_FAULTS, DUMP_OUTCOMES
qa-engine/src/contexts/objective-signal/domain/dump-sanitizers.ts: MAX_FAULT_INJECTION_COUNT
qa-engine/src/contexts/objective-signal/domain/enforce-readiness.ts: CaseReadiness, UntrustedReason
qa-engine/src/contexts/objective-signal/domain/observed-difference.ts: MAX_MOVED_TESTS, UnmutatedPages
qa-engine/src/contexts/objective-signal/domain/per-candidate-coverage.ts: CandidateUnmeasured
qa-engine/src/contexts/objective-signal/domain/render-coverage-gap.ts: renderObservedDifference
qa-engine/src/contexts/objective-signal/domain/select-mutants.ts: MAX_RERUN_TESTS, MutantSelection, SelectedMutant
qa-engine/src/contexts/objective-signal/domain/test-intent-contract.ts: Anchoring, IntentViolationRule
qa-engine/src/contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts: ObjectiveSignalPortCollaborators, ObjectiveSignalPortStaticContext
qa-engine/src/contexts/objective-signal/infrastructure/coverage-decode.ts: DecodeSinks, DecodedDump, Lines, decodeDump
qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts: createCoverageDecodeExecutor
qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-counter-reader.ts: FAULT_INJECTION_COUNTER_LIMITS
qa-engine/src/contexts/objective-signal/infrastructure/v8-branch-coverage.ts: MAX_MUTANT_TEXT, MAX_SOURCE_LINE_TEXT, ReadDecision, ReadSite, ScriptBranchRead, ScriptBranchReader, analyzeScript, countsAt
qa-engine/src/contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts: ReadV8Coverage, resolveUrlToRepoFile, sourcePathOf
qa-engine/src/contexts/run-orchestration/application/accept-delivered-specs.use-case.ts: ACCEPTANCE_RUNS, AcceptDeliveredSpecsDeps, AcceptanceRun, combineRunVerdicts
qa-engine/src/contexts/run-orchestration/application/regeneration-acceptance.ts: AcceptanceInput, AcceptanceOutcome, AcceptanceProofEntry, RegenerationAcceptanceDeps
qa-engine/src/contexts/run-orchestration/application/run-flow/degrade.ts: DegradeFacts, deadlineNote
qa-engine/src/contexts/run-orchestration/application/run-flow/failure-policy.ts: FAILURE_ACTION_EFFECT, FailureAction, FailureKind
qa-engine/src/contexts/run-orchestration/application/run-flow/outcome-assembly.ts: ErrorClassEnds, OutcomeExtras
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts: GapUnit, closeSurvivors, gapReference
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/decide.steps.ts: causalLabelOf
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/execute.steps.ts: deliveredNow
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/generation-services.ts: LEAD_CORRECTION_BUDGET_SPENT, Regenerated, withoutProbeSpecs
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review-services.ts: ReviewDecisionRecord
qa-engine/src/contexts/run-orchestration/application/run-flow/review-change.ts: ReviewChangeInput
qa-engine/src/contexts/run-orchestration/application/run-flow/route-availability-grounding.ts: AvailabilityGrounding, routeConfigEvidence
qa-engine/src/contexts/run-orchestration/application/run-flow/run-end.ts: ABORT_SUPERSEDES, NotedFailure, UnreachedVerdict
qa-engine/src/contexts/run-orchestration/application/run-flow/run-flow.ts: FlowOutcome
qa-engine/src/contexts/run-orchestration/application/run-flow/run-state.ts: Classification, FixLoopOutcome, FlakyTriageOutcome, GenerationOutcome, Grounding, RegressionStandIn, ReviewOutcome, ReviewRoundScratch, SetupOutcome, initialLoopCounters
qa-engine/src/contexts/run-orchestration/application/run-phase-spans.ts: PhaseSpansDeps
qa-engine/src/contexts/run-orchestration/composition/build-run-orchestration.ts: RunConfigDeps
qa-engine/src/contexts/run-orchestration/domain/adjudicate.service.ts: AdjudicatorClass, AdjudicatorConfidence
qa-engine/src/contexts/run-orchestration/domain/availability-triage.ts: AvailabilityDecision, AvailabilityMatch
qa-engine/src/contexts/run-orchestration/domain/context-map-validity.ts: ContextMapValidity
qa-engine/src/contexts/run-orchestration/domain/coverage-regen.ts: BranchCasesAction, BranchCasesInput, CoverageRegenAction, CoverageRegenInput
qa-engine/src/contexts/run-orchestration/domain/fix-loop.aggregate.ts: FixLoopDeps, FixLoopRerun, FixLoopResult, FixLoopTriage
qa-engine/src/contexts/run-orchestration/domain/flaky-triage.ts: FlakyClass
qa-engine/src/contexts/run-orchestration/domain/helpers/generation-end-terminal.ts: GenerationTerminal
qa-engine/src/contexts/run-orchestration/domain/helpers/progress-gate.ts: GateDecision
qa-engine/src/contexts/run-orchestration/domain/lead-correction-budget.ts: LeadCorrectionAction
qa-engine/src/contexts/run-orchestration/domain/pre-exec-regen.ts: PreExecAction, PreExecInput
qa-engine/src/contexts/run-orchestration/domain/review-action.ts: ReviewNext
qa-engine/src/contexts/run-orchestration/domain/review-finding-filter.service.ts: FilteredReviewFindings, ReviewCitation, ReviewCitationKind
qa-engine/src/contexts/run-orchestration/domain/review-rebuttals.service.ts: RebuttalBasis, VerifiedRebuttals
qa-engine/src/contexts/run-orchestration/domain/run-deadline.ts: FALLBACK_RESERVE_MIN_MS, FALLBACK_RESERVE_SHARE, Reserve, ReserveSource, RunDeadlineDeps
qa-engine/src/contexts/run-orchestration/domain/run-decision.ts: SideEffect
qa-engine/src/contexts/run-orchestration/domain/run-phase-cursor.ts: PhaseSnapshot
qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts: RunDeadlineNoteInput
qa-engine/src/contexts/run-orchestration/domain/static-fix.ts: StaticFixAction
qa-engine/src/contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts: DeployGatePortConfig
qa-engine/src/contexts/run-orchestration/infrastructure/adapters/served-version-http.adapter.ts: SERVED_VERSION_READ_TIMEOUT_MS
qa-engine/src/contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts: RunDeadlineRuntimeOptions
qa-engine/src/contexts/service-topology/application/onboarding-service.ts: OnboardingBudget, ScoredCandidate
qa-engine/src/contexts/service-topology/composition/build-service-topology.ts: ServiceTopologyApi, ServiceTopologyDeps
qa-engine/src/contexts/service-topology/domain/link-graph.ts: FrontierRepo
qa-engine/src/contexts/service-topology/domain/operation-diff.ts: CONTRACT_KEYS, OperationChangeKind
qa-engine/src/contexts/service-topology/infrastructure/adapters/cross-repo-impact-port.adapter.ts: CrossRepoImpactPortAdapterDeps
qa-engine/src/contexts/service-topology/infrastructure/adapters/service-links-port.adapter.ts: ServiceLinksStaticContext
qa-engine/src/contexts/service-topology/infrastructure/call-pattern-catalog.ts: CallPatternOccurrence
qa-engine/src/contexts/test-execution/application/agent-browser.use-case.ts: AgentBrowserBudget, AgentBrowserDeps, AgentBrowserPageReport
qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts: DURATION_GRANULARITY_MS, MAX_FACT_RUNTIME_ERRORS, MAX_FACT_TEXT_CHARS, MAX_FAILURE_DOM_CHARS, MAX_GREP_CHARS, RUN_SPEC_INVALID, RunSpecLoadError, RunSpecReport, RunSpecTestReport
qa-engine/src/contexts/test-execution/composition/build-test-execution.ts: TestExecutionApi
qa-engine/src/contexts/test-execution/domain/agent-browser-capability.ts: AgentBrowserCapabilityInit, AgentBrowserRefusal
qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts: GuardRequest
qa-engine/src/contexts/test-execution/domain/agent-browser-session-invalidation.ts: Invalidation, InvalidationHints, InvalidationKind, PageObservation
qa-engine/src/contexts/test-execution/domain/dev-write-charge.ts: TestCharge, WriteSender
qa-engine/src/contexts/test-execution/domain/failure-category.ts: ClassifyContext
qa-engine/src/contexts/test-execution/domain/output-token-filter.ts: MIN_OPAQUE_TOKEN_ENTROPY
qa-engine/src/contexts/test-execution/domain/playwright-report-plan.ts: AttemptStatus, CaseStatus, MAX_PLANNED_ATTEMPTS, MAX_PLANNED_FILES, PlannedFile, ReportPlan, START_SLACK_MS
qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts: CLEANUP_RESERVE_MS, CallReservation, ClosedLoopRefusal, RunSpecCapabilityInit
qa-engine/src/contexts/test-execution/domain/stubbed-state.ts: StubbedTest, StubbedViolation, StubbedViolationKind
qa-engine/src/contexts/test-execution/infrastructure/adapters/execution-port.adapter.ts: ExecutionPortStaticContext, ExecutionPortStrategies
qa-engine/src/contexts/test-execution/infrastructure/adapters/validation-port.adapter.ts: ValidationPortStrategies
qa-engine/src/contexts/test-execution/infrastructure/agent-browser/chromium-sandbox.launcher.ts: SandboxedChromiumLauncherDeps
qa-engine/src/contexts/test-execution/infrastructure/agent-browser/playwright-agent-browser.host.ts: BLOCK_SERVICE_WORKERS_SCRIPT, PlaywrightAgentBrowserHostDeps
qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts: CHILD_EXIT_WAIT_MS, ControlsByProject, DEFAULT_CLEANUP_TIMEOUT_MS, E2eCleanupDeps, E2eDataState, E2eRunResult, PW_PROJECT_RE, PlaywrightReportRead, cleanupArgs, failureDumpsOf, suiteRelativeLoadErrors, titleSegments
qa-engine/src/contexts/test-execution/infrastructure/observation-reader.ts: OBSERVATION_LIMITS
qa-engine/src/contexts/test-execution/infrastructure/playwright-report.ts: PwCase, ReportOptions
qa-engine/src/contexts/test-execution/infrastructure/report-spans.ts: MAX_SPANS_PER_REPORT, MAX_SPANS_PER_RUN, ReportSpanDeps
qa-engine/src/contexts/test-execution/infrastructure/run-dump-bridge.ts: DumpBridge, DumpBridgeInput
qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts: DEFAULT_VALIDATE_CHECK_TIMEOUT_MS, ESLINT_COMMAND, GATE_LINT_OPTIONS
qa-engine/src/contexts/test-execution/infrastructure/static-gate.trace.ts: ValidateCheckName
qa-engine/src/contexts/workspace-and-publication/application/publish-workspace.use-case.ts: PublishOutcome
qa-engine/src/contexts/workspace-and-publication/composition/build-workspace-and-publication.ts: WorkspaceAndPublicationApi
qa-engine/src/contexts/workspace-and-publication/domain/publish-decision.service.ts: PublishContext, PublishDecision, PublishOutcome
qa-engine/src/contexts/workspace-and-publication/domain/render-publication.ts: AdjudicationLabel, CausalLabelView, RenderIssueInput, RenderPrBodyInput, TestedItem
qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts: ClassifiedStrays, ParsedChange, UnstagedRenamePairing
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/cleanup-port.adapter.ts: CleanupFn, CleanupPortStaticContext
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/multi-repo-checkout.adapter.ts: DeclaredService, MultiRepoCheckoutStaticContext, StagedServiceRef
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts: PublicationRenderCollaborator, PublishDecisionCollaborator, ShadowLogCollaborator
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/setup-port.adapter.ts: SetupFn
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/spec-snapshot-validation.adapter.ts: MAX_REMEMBERED_RUNS, SpecSnapshotDeps, snapshotSpecs
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/suite-store-trace.ts: SkipClass
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/workspace-port.adapter.ts: WorkspacePortStaticContext
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/workspace-registry.ts: WorkspaceRecord
qa-engine/src/contexts/workspace-and-publication/infrastructure/mirror-provision.adapter.ts: Git
qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts: DEFAULT_E2E_INSTALL_TIMEOUT_MS, FAILURE_CAPTURE_FIXTURE_MARKER, InstallGuard, MUTATION_FIXTURE_MARKER, SOURCE_MAPS_MARKER, SetupAdapterDeps, SetupOptions
qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts: AUTH_STATUS, AuthStatus, DEFAULT_SUITE_STORE_LIMITS, SUITE_ENTRY_KIND, SUITE_MANIFEST_SCHEMA, SUITE_SNAPSHOTS_DIR, SuiteAuthRecord, SuiteEntry, SuiteEntryAdmission, SuiteEntryKind, restoredSetDigest
qa-engine/src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts: VcsCommitResult
qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts: ConfinementResult, Git
qa-engine/src/shared-infrastructure/bounded-tree-removal.ts: DEFAULT_TREE_REMOVAL_LIMITS, TreeRemovalClock, TreeRemovalLimits
qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts: CodegraphCodeGraphDeps
qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts: DEFAULT_ENGINE_TIMEOUTS, EngineTimeouts, REQUEST_CHUNK
qa-engine/src/shared-infrastructure/code-graph/codegraph-store-cache.ts: MAX_STORE_BYTES, StoreCacheTuning, StoreLock
qa-engine/src/shared-infrastructure/code-graph/codegraph-workspace.ts: ExportWorkspaceInput, WorkspaceExport
qa-engine/src/shared-infrastructure/code-graph/git-co-change.adapter.ts: HISTORY_COMMITS, MIN_COUPLING, MIN_CO_CHANGES
qa-engine/src/shared-infrastructure/decision-listing.ts: FileDecisions
qa-engine/src/shared-infrastructure/egress/address-class.ts: AddressClass
qa-engine/src/shared-infrastructure/egress/destination-sniffer.ts: Sniff
qa-engine/src/shared-infrastructure/egress/dns-filter.ts: DnsFilterDeps
qa-engine/src/shared-infrastructure/egress/egress-controller.ts: DnsPort, EgressHooks, ProxyPort
qa-engine/src/shared-infrastructure/egress/iptables-runner.ts: CommandRunner
qa-engine/src/shared-infrastructure/egress/transparent-proxy.ts: TransparentProxyDeps, isLoopbackAddress
qa-engine/src/shared-infrastructure/module-resolution/dynamic-loads.ts: ModuleLoads
qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts: EXEC_COMMAND_CLASSES
qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider.ts: ExecScopeProviderDeps
qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts: FileBoundaryOutcome, FileBoundaryProbeKind, FileBoundaryProbeResult
qa-engine/src/shared-infrastructure/process-sandbox/git-hardening.ts: TrustedGitTree, resolveTrustedGitTree
qa-engine/src/shared-infrastructure/process-sandbox/mirror-access.ts: nodeMirrorFsOps
qa-engine/src/shared-infrastructure/process-sandbox/orphan-browser-sweep.ts: procFsDeps
qa-engine/src/shared-infrastructure/process-sandbox/sandbox-reaper.ts: DEFAULT_REAP_TIMEOUT_MS, SandboxReaperDeps, TrackableChild
qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts: ChownRunner
qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts: ScrubEnvOptions
qa-engine/src/shared-infrastructure/repo-reader.ts: RepoReaderLimits
qa-engine/src/shared-infrastructure/spec-path-confinement.ts: OpenedFileStats, OwnedDirListing, PurgeStat, RepoWalk, SpecTree, UnwalkedPath
qa-engine/src/shared-infrastructure/suite-tree.ts: EntryKind, MAX_TREE_ENTRIES, TreeEntry
qa-engine/src/shared-infrastructure/telemetry/run-auth-notes.ts: SuiteAuthNotes
qa-engine/src/shared-infrastructure/telemetry/run-spans.ts: ContextRecord
qa-engine/src/shared-infrastructure/worker/off-loop-executor.ts: OffLoopRunHooks, OffLoopTiming, WORKER_START_BUDGET_MS, WorkerExecutorOptions
qa-engine/src/shared-kernel/address-cut.ts: segmentsBefore
qa-engine/src/shared-kernel/allotment-cap.ts: CapLimit
qa-engine/src/shared-kernel/case-proof.ts: ModeRefusal, ModeTally
qa-engine/src/shared-kernel/change-map.ts: ChangeMapCandidate, SeededCandidate, Seeding
qa-engine/src/shared-kernel/change-slice.ts: ReferenceWhy
qa-engine/src/shared-kernel/code/index.ts: INDEX_OUTCOMES
qa-engine/src/shared-kernel/context-budget.ts: BYTES_PER_TOKEN_ESTIMATE, FitRequest, PromptSize
qa-engine/src/shared-kernel/context-item-ids.ts: CONTEXT_SOURCES, MIN_DOM_IDS_PER_ROUTE, MapLike, ServiceLinkLike
qa-engine/src/shared-kernel/contract/events.ts: ActivityStatusSchema, LogLevelSchema, TodoStatusSchema
qa-engine/src/shared-kernel/coordination.ts: FlowBudgets
qa-engine/src/shared-kernel/cycle-budget.ts: CycleBudgetInput
qa-engine/src/shared-kernel/data-contradiction.ts: MAX_DATA_CONTRADICTIONS_RECORDED
qa-engine/src/shared-kernel/diff-hunks.ts: SectionStat
qa-engine/src/shared-kernel/diff-parser/changed-literal.ts: isClassList, isLabelLike
qa-engine/src/shared-kernel/egress-policy.ts: EgressRule, PUBLIC_SUFFIXES
qa-engine/src/shared-kernel/error-class.ts: ResolveErrorClassInput
qa-engine/src/shared-kernel/exec-purpose.ts: EXEC_PURPOSES
qa-engine/src/shared-kernel/geolocation.ts: GeolocationScope
qa-engine/src/shared-kernel/language-id.ts: ExpectationSyntax
qa-engine/src/shared-kernel/ports/exec-scope.port.ts: ExecScopeSession, SandboxRefusal
qa-engine/src/shared-kernel/ports/logger.port.ts: LogEntry, MemoryLogger, silentLogger
qa-engine/src/shared-kernel/ports/plan-snapshot.port.ts: PlanCandidateState, PlanSnapshotFlowCandidate
qa-engine/src/shared-kernel/ports/suite-store.port.ts: DEMOTE_REASON_CLASS, DemoteReasonClass
qa-engine/src/shared-kernel/prompt-sections.ts: DegradedSection, SectionStability, WindowFit
qa-engine/src/shared-kernel/route-availability.ts: RedirectMechanism
qa-engine/src/shared-kernel/route-capturability.ts: ClassifiedRoute, RouteClassification, RoutePartition, UncapturableRoute
qa-engine/src/shared-kernel/run-outcome.ts: ErrorClass
qa-engine/src/shared-kernel/run-secret-redaction.ts: MAX_SECRET_VALUES, MIN_ENCODED_VARIANT_CHARS
qa-engine/src/shared-kernel/run-trace-facts.ts: RUN_DECISIONS, RUN_DEGRADATIONS
qa-engine/src/shared-kernel/runtime-error-class.ts: RuntimeErrorVerdict
qa-engine/src/shared-kernel/served-version.ts: UNREADABLE_REASONS, UnreadableReason
qa-engine/src/shared-kernel/service-links.ts: MatchTier
qa-engine/src/shared-kernel/sidekick-session.ts: SidekickIdentity
qa-engine/src/shared-kernel/telemetry/attribute-registry.ts: AttrKey, AttrType, AttrValue, Cardinality, ContentClass, MAX_ITEM_IDS_PER_SPAN, TemplateKey
qa-engine/src/shared-kernel/telemetry/genai-semconv.ts: ConventionTokenUsage, RuntimeTokenUsage
qa-engine/src/shared-kernel/telemetry/telemetry.port.ts: SpanLink
qa-engine/src/shared-kernel/turn-limit.ts: TIME_LIMIT_SOURCES
qa-engine/src/shared-kernel/working-room.ts: EstimateWorkingRoomInput, MIN_HISTORY_SAMPLES, RecordedTurn, USUAL_PERCENTILE
src/agent-runtime/config.ts: AgentConfigValidation, KeyPresence, ReviewerIndependence
src/agent-runtime/index.ts: AgentConfigValidation, AgentFacadeDeps, AgentRuntimeStatus, KeyPresence, ReviewerIndependence, tierForRole
src/agent-runtime/run-context-budget.ts: InstallRunContext
src/agent-runtime/types.ts: AgentFacadeDeps, AgentRuntimeStatus, tierForRole
src/contract/commands.ts: AgentAssignmentsSchema, AgentConfigValidationSchema, AgentHealthMapSchema, AgentRuntimeStatusSchema, ArchitectureApiOperationSchema, ArchitectureFeBeLinkSchema, ArchitectureFlowSchema, ArchitectureRouteSchema, BoundaryEdgeSummarySchema, BoundaryEdgeTransportSchema, BoundaryProfileSchema, BreakdownItemSchema, CaseStatusSchema, CoordinationSignalsSchema, DurationTrendSchema, EffectiveConfigSchema, EventBoundaryProfileSchema, ExpectedStatusSchema, FlowStabilitySchema, HttpBackendBoundaryProfileSchema, HttpBoundaryProfileSchema, InsightIntentSchema, InsightUnitSchema, KeyPresenceSchema, LoginBootstrapStatusSchema, LoginProgressSchema, MappingProgressSchema, NetworkClassSchema, NetworkErrorSchema, OnboardOutcomeSchema, RepoIndexStatusSchema, ReportChartSchema, RunStatusSchema, ToolSequenceEntryViewSchema, TurnUsageViewSchema
src/contract/login-path.ts: LOGIN_PATH_MAX_LENGTH, LOGIN_PATH_PATTERN
src/contract/openapi.ts: API_VERSION
src/index.ts: main
src/integrations/fixtures/opencode-roster.ts: Roster, RosterRole
src/integrations/github.ts: defaultGitHubDeps
src/integrations/logger.ts: JsonLogger, JsonLoggerOptions
src/integrations/opencode-client.ts: EventStreamOpenerDeps, NO_WRITE_TOOLS, defaultAgentListDeps
src/integrations/opencode-server-auth.ts: OpenCodeServerAuth
src/integrations/redacting-logger.ts: LogSink, RedactingLoggerDeps
src/integrations/repo-mirror.ts: assertHexSha
src/integrations/verdict-parse.ts: FinalVerdict
src/integrations/verdict-validate.ts: RepairInstructionOpts, ReviewerFinding, ReviewerVerdict, VerdictCheck
src/orchestrator/config-loader.ts: RepoRole
src/orchestrator/schemas.ts: SpecMetaSchema
src/qa/value-report.ts: ReportOptions
src/server/agent-runtime.ts: AgentRuntimeManager, CreateAgentRuntimeManagerOptions
src/server/api-token.ts: ApiTokenDeps
src/server/api/api-error.ts: ApiErrorOptions
src/server/api/deps.ts: LoginOutcome
src/server/api/request.ts: ParseBodyOptions
src/server/api/route-table.ts: ApiRoute, RouteMatch, RouteMethod, createMatcher
src/server/api/use-cases/continue-run.ts: Continuable
src/server/auth.ts: MACHINE_PRINCIPAL
src/server/chat.ts: ContextLimits
src/server/coordination-events.ts: CoordinationEventsFilter, defaultCoordinationLedgerFsDeps
src/server/create-app.ts: LOGIN_WINDOW_MS
src/server/dns-forward.ts: firstNameserver
src/server/durable-run-events.ts: DurableRunEventDeps
src/server/effective-config.ts: RecordedRunFacts, RunConfigRequest, agentsOfTurns
src/server/egress-wiring.ts: RegistryGroups, RunEgressOrigins
src/server/evaluation-evidence.ts: SpecCounts, deliveredSpecNames, deliveredSpecsOf, planEvidenceOf, referenceEvidenceOf, runSpecCallsOf, sidekickReportsOf
src/server/evaluation-service.ts: CampaignRunsView, CatalogScoreView, EvaluationServiceDeps, HistoryRunSelector, RegradeJobView, RunEvaluationView, SqliteRegradeJobStore, SqliteScoreStore
src/server/exec-sandbox-factory.ts: ExecWiring, ExecWiringInput, ScriptExec, ScriptMirrors, gateCredsFrom
src/server/metrics.ts: ArtifactSizeEntry
src/server/mirror-prune.ts: ActiveRunLookups, MirrorPruneResult
src/server/onboarding/onboarding-job.ts: ConfirmResult, ContextMapRunRequest, ContextMapRunSnapshot, LoginProgress, LoginRunRequest, LoginStatus, MappingProgress, OnboardOutcome, OnboardState, OnboardingJob, ProposeBoundariesRequest, ProposeResult, REPO_INDEX_STATUS, RepoIndexStatus
src/server/onboarding/patch-app-yaml.ts: AppYamlPatch, AppYamlPatchOptions
src/server/onboarding/resolution-summary.ts: BoundaryEdgeSummary
src/server/persistence/database.ts: OpenHistoryOptions
src/server/persistence/json-column.ts: JsonColumnSite
src/server/persistence/migrations/index.ts: MIGRATIONS
src/server/persistence/repositories/evaluation.repository.ts: RegradeJobRow, ScoreRow
src/server/persistence/repositories/run.repository.ts: CampaignRunRecord, RunPhasesPatch, RunRecordPatch
src/server/persistence/repositories/telemetry.repository.ts: AgentTurnTraceRecord, RecentTurnFigures
src/server/persistence/retention.ts: PruneReport, RUN_SPAN_PRUNE_CHUNK
src/server/phase-history.ts: StoredPhaseRecord
src/server/port.ts: ServerErrorListenerDeps
src/server/run-delegate.ts: DelegateRunDeps
src/server/run-engine-factory.ts: AcceptanceHarness, AcceptanceHarnessInput, TurnTelemetryContext, buildMirrorGc, githubHttpDeps
src/server/run-history-sqlite-adapter.ts: defaultRunHistorySqliteAdapterDeps
src/server/run-report-view.ts: RunReportInput
src/server/run-trace.ts: EnqueueMark, RUN_TRIGGERS
src/server/runner.ts: LOGIN_BOOTSTRAP_GUIDANCE
src/server/sandbox-health.ts: SandboxHealth
src/server/service-context.ts: OmittedEntry, StageServiceContextInput, StagedServiceContext
src/server/shutdown.ts: SignalSource
src/server/static.ts: ServeDashboardOptions
src/server/tools-endpoint.ts: MAX_TOOLS_BODY_BYTES, QA_TOOLS_LISTEN_HOST_ENV, QA_TOOLS_PORT_ENV, QA_TOOLS_TOKEN_ENV, RUN_SPEC_PATH, TOOLS_BODY_TIMEOUT_MS, TOOLS_HEADERS_TIMEOUT_MS, TOOLS_REQUEST_TIMEOUT_MS, ToolsHandlerDeps, ToolsRateLimiter, ToolsRateLimiterOptions, ToolsResponse, ToolsServerOptions
src/server/trends-view.ts: TrendsInput
src/server/turn-telemetry-config.ts: StepIntentConfigInput
src/server/web-console/console-harness.ts: ConsoleApi, ConsoleHarness, JsonReply, LoadOptions, Routes, RunHandlers, SseReply
src/server/webhook.ts: WebhookPayload, WebhookResult
src/server/wire-app.ts: WiredApp
src/settings/registry.ts: SettingGroup, SettingType
src/settings/settings.ts: SettingProblem
src/telemetry/backend-health.ts: BACKEND_HEALTH_TTL_MS, BACKEND_PROBE_TIMEOUT_MS, BackendFetchInit, BackendHealthDeps, BackendResponse, DISK_USED_DEGRADED_RATIO, QUEUE_FILL_DEGRADED_RATIO
src/telemetry/bootstrap.ts: DEFAULT_SHUTDOWN_TIMEOUT_MS, PruneFns
src/telemetry/config.ts: BatchProcessorOptions, MAX_SPAN_RETENTION_DAYS, TelemetryMode
src/telemetry/host-health.ts: DEFAULT_THRESHOLD_MS, EVENT_LOOP_BLOCKED_MS, EVENT_LOOP_SAMPLE_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, HostClocks, HostHealthDeps, HostHealthSnapshot, ZOMBIE_SCAN_INTERVAL_MS, systemClocks, systemProcFs, systemScheduler
src/telemetry/instrument-table.ts: InstrumentSpec, InstrumentType
src/telemetry/ledger.ts: DEFAULT_FLUSH_EVERY, LedgerOptions, LedgerStats, PRUNE_EVERY_MS
src/telemetry/log-shipper.ts: LogShipperDeps
src/telemetry/otel-telemetry.adapter.ts: CONTENT_CAP_CHARS, ERROR_TYPE_CAP_CHARS, METRIC_VALUE_CAP_CHARS, NAME_CAP_CHARS, NONE_CAP_CHARS, OtelTelemetryDeps, TelemetryAdapterStats, toHrTime
src/telemetry/prompt-body-logs.ts: BodyKind, PromptBodyDeps, PromptBodyInput
src/telemetry/score-metrics-sink.ts: ScoreMetricsSinkDeps
src/telemetry/telemetry-health.ts: TelemetryModeName
src/telemetry/trace-harness.ts: Measurement
src/telemetry/with-prompt-bodies.ts: PromptBodyDecoratorDeps, PromptBodyHost
src/types.ts: ActivityKind
src/util/net.ts: AgentTransportFetchDeps
```

### Class D (imported only by tests, used inside its own file), by file

```
qa-engine/src/contexts/agent-tools/composition/build-agent-tools.ts: AgentToolsDeps
qa-engine/src/contexts/agent-tools/domain/code-graph-query.ts: CODE_GRAPH_ACTION, MAX_EXPLORE_TERMS, MAX_TERM_CHARS
qa-engine/src/contexts/agent-tools/infrastructure/agent-browser-registry.ts: LiveBrowser
qa-engine/src/contexts/agent-tools/infrastructure/closed-loop-registry.ts: LiveLoop
qa-engine/src/contexts/agent-tools/infrastructure/code-graph-tool-registry.ts: LiveCodeGraph
qa-engine/src/contexts/app-catalog/domain/auth-precondition.ts: CLASSIFIED_PRECONDITION_KIND
qa-engine/src/contexts/app-catalog/infrastructure/auth-session.adapter.ts: AUTH_SETUP_ENV, AuthDiscoveryDeps, AuthSessionSpawnResult
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.page-readers.ts: ChallengeCandidate
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.runner.ts: LOGGED_TEXT_MAX, LOGIN_DISCOVERY_HARD_KILL_MS
qa-engine/src/contexts/app-catalog/infrastructure/login-discovery/login-discovery.script.ts: DEFAULT_ACTION_CALL_MS, DEFAULT_NAV_TIMEOUT_MS, LOGIN_WELL_KNOWN_PATHS, MAX_GATED_ROUTES, POST_SUBMIT_MIN_WAIT_MS
qa-engine/src/contexts/change-analysis/domain/commit-classification.ts: classifyCommit
qa-engine/src/contexts/change-analysis/domain/reach-proof.ts: ScopeInput, tierOf
qa-engine/src/contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts: BlastRadiusSignalInput
qa-engine/src/contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts: entryPointsOf
qa-engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts: MAX_FILE_AT_CHARS
qa-engine/src/contexts/coordination/application/acceptance-report.ts: AcceptanceStatus
qa-engine/src/contexts/coordination/application/brief-change.ts: MAX_PROOF_STEPS
qa-engine/src/contexts/coordination/application/coordination-decision.ts: COORDINATION_ACTIONS
qa-engine/src/contexts/coordination/application/coordination-sections/brief-sections.ts: BRIEF_DECISIONS_SECTION_ID
qa-engine/src/contexts/coordination/application/coordination-sections/index.ts: COORDINATION_PROMPTS
qa-engine/src/contexts/coordination/application/lead-correction.ts: DEFAULT_CORRECTION_INSTRUCTION, flowOfFinding
qa-engine/src/contexts/coordination/application/lead-plan.ts: PlanDeps, PlanLimits
qa-engine/src/contexts/coordination/application/lead-sidekicks.ts: CoordinateInput, LeadSidekicksDeps, MIN_FLOW_MS, PassCorrection
qa-engine/src/contexts/coordination/application/plan-coverage.ts: MAX_ADMISSION_CANDIDATES
qa-engine/src/contexts/coordination/application/sidekick-authoring.ts: AuthoringFacts
qa-engine/src/contexts/coordination/application/sidekick-executor.ts: SidekickExecuteOpts
qa-engine/src/contexts/coordination/application/sidekick-kinds.ts: AGENT_TOOL, AgentTool, SIDEKICK_BUDGET, SIDEKICK_WORKSPACE
qa-engine/src/contexts/coordination/composition/build-coordination.ts: CoordinationDeps
qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts: CoordinationTelemetryFsDeps, FileCoordinationTelemetryAdapter, MAX_LEDGER_EVENTS, ROTATE_TO_EVENTS
qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts: AuditInput, AuditRouterDeps, ProcessFinding
qa-engine/src/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts: PROCESS_AUDIT_TIMEOUT_MS
qa-engine/src/contexts/evaluation/application/grade-run.use-case.ts: GradeRunResult
qa-engine/src/contexts/evaluation/application/regrade.use-case.ts: MAX_JOB_ERROR_CHARS, REGRADE_PROGRESS_EVERY
qa-engine/src/contexts/evaluation/domain/campaign-comparison.ts: armKey, bootstrapDiffCi, bootstrapMeanCi, mean, seededRandom
qa-engine/src/contexts/evaluation/domain/campaign-runs.ts: matchesVariant
qa-engine/src/contexts/evaluation/domain/context-refs.ts: matchRouteTemplate, normalizeRoutePath
qa-engine/src/contexts/evaluation/domain/grader-catalog.ts: CONTEXT_SOURCES
qa-engine/src/contexts/evaluation/domain/graders.ts: GRADERS
qa-engine/src/contexts/generation/application/generate-tests.use-case.ts: AuthoringPorts
qa-engine/src/contexts/generation/composition/build-generation.ts: GenerationDeps
qa-engine/src/contexts/generation/domain/abort-race.ts: AbortRaceError
qa-engine/src/contexts/generation/domain/agent-error-class.ts: AGENT_ERROR_TYPES, carriedAgentErrorType
qa-engine/src/contexts/generation/domain/changed-values.ts: MAX_ROUTES_NAMED_PER_VALUE, WORDING, nodeShowsText
qa-engine/src/contexts/generation/domain/consumer-expectation.ts: OperationExpectation
qa-engine/src/contexts/generation/domain/declared-resources.ts: MAX_DECLARED_PER_FILE
qa-engine/src/contexts/generation/domain/deterministic-review-precheck.ts: parseDomRouteBlocks
qa-engine/src/contexts/generation/domain/expectation-gaps.ts: MAX_GAPS_PER_PAGE, PageShapes
qa-engine/src/contexts/generation/domain/generator-time-budget.ts: DIFF_TIME_BUDGET_ENV
qa-engine/src/contexts/generation/domain/harness-facts.ts: MAX_ATTRIBUTE_NAME_LENGTH, MAX_DECLARATION_LENGTH, MAX_DECLARATION_LINES, MAX_EXPORT_NAME_LENGTH, MAX_FIXTURE_EXPORTS, MAX_PROJECTS, isSafeIdentifier
qa-engine/src/contexts/generation/domain/nav-outcome.ts: NAV_OUTCOMES
qa-engine/src/contexts/generation/domain/objective.ts: Flow
qa-engine/src/contexts/generation/domain/pre-exec-grounding.service.ts: RouteTree
qa-engine/src/contexts/generation/domain/prompt-contract-lint.ts: BLIND_COMPLIANCE_PHRASES, DELEGATED_AUTHORITY_PHRASES, DIRECTIVE_LEXICON, MIN_DUPLICATE_LINE_BYTES, TRUST_LEXICON, hasFloorLanguage, hasTrustLanguage
qa-engine/src/contexts/generation/domain/provided-context.ts: PROVIDED_CONTEXT_MATCH_RATIO, PROVIDED_CONTEXT_MIN_LINE_LENGTH, PROVIDED_CONTEXT_MIN_SAMPLE_LINES, PROVIDED_CONTEXT_SAMPLE_LINES
qa-engine/src/contexts/generation/domain/review-fingerprint.ts: normalizeSpecForReview, reviewSpecsKey
qa-engine/src/contexts/generation/domain/review-output.ts: REVIEW_CORRECTION_CLASSES
qa-engine/src/contexts/generation/domain/route-availability-classifier.ts: ClassifyInput, classifyRouteAvailability
qa-engine/src/contexts/generation/domain/route-ranking.ts: ROUTE_LINK_FIELDS
qa-engine/src/contexts/generation/domain/selector-check.ts: ProposedSelector
qa-engine/src/contexts/generation/domain/shell-command-class.ts: ShellCommandClass
qa-engine/src/contexts/generation/domain/step-exhaustion.ts: TurnPart, detectStepExhaustion
qa-engine/src/contexts/generation/domain/step-intent.ts: STEP_INTENTS
qa-engine/src/contexts/generation/domain/step-limit.ts: STEP_LIMIT_MIDPOINT_FRACTION, stepMidpoint
qa-engine/src/contexts/generation/domain/suite-listing-render.ts: PLAIN_LISTING_NOTE, everyDeliveredLine
qa-engine/src/contexts/generation/domain/suite-listing.ts: LISTING_ENTRY_SAFETY_BOUND, SuiteListingInput
qa-engine/src/contexts/generation/domain/tool-call-taxonomy.ts: AgentActivityKind
qa-engine/src/contexts/generation/domain/tool-link.ts: LINK_TOLERANCE_MS, LinkableCall
qa-engine/src/contexts/generation/domain/turn-efficiency-summary.ts: tallyBuckets
qa-engine/src/contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts: MAX_CONTEXT_MAP_BYTES, MAX_FIXTURES_FILE_BYTES
qa-engine/src/contexts/generation/infrastructure/context-pack.ts: ContextPackInput, MAX_LISTED_UNCAPTURABLE, NODE_SAFETY_BOUND_REASON, TEMPLATE_LEFT_OUT
qa-engine/src/contexts/generation/infrastructure/dom-capture-trace.ts: recordDomCapture
qa-engine/src/contexts/generation/infrastructure/dom-snapshot.ts: CAPTURE_LIMITS, CAPTURE_ROUTE_READ_MS, CaptureDataState, CaptureDomInput, DEGRADED_ROUTE_LABEL, MAX_NODES_PER_PAGE, MAX_SHAPES_PER_ROUTE, MAX_SHAPE_KEYS, MAX_SHAPE_KEY_CHARS, MAX_SHAPE_NAMES, buildCaptureScript, buildChangedMarker, capDomLines, captureTimeoutMs, extractTargetRoutes, formatRedirectAdvisory, isPriorityNode, mergeAttrs, navigationFactsOf, navigationOf, normalizeKey, normalizeRoutes
qa-engine/src/contexts/generation/infrastructure/loggable-route.ts: MAX_LOGGED_ROUTES, MAX_LOGGED_ROUTE_CHARS
qa-engine/src/contexts/generation/infrastructure/prompt-builders/architecture-context.ts: MAP_ITEMS_SAFETY_BOUND
qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-context.ts: LIVE_BROWSERS
qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-renderers.ts: BACKEND_TO_BACKEND_LABEL, HTTP_UNKNOWN_LABEL, IMPACTED_MARKER_PREFIX, MILESTONE_OUTCOME_PHRASES, SETTLE_LABELS, describeResultCount, describeSettle, impactedMarker
qa-engine/src/contexts/generation/infrastructure/prompt-builders/generator-sections.ts: PACK_CONTRACTS_NOUN
qa-engine/src/contexts/generation/infrastructure/prompt-builders/reviewer-change-sections.ts: REVIEWER_CHANGED_FILES_SECTION_ID, REVIEWER_FLOW_SLICES_SECTION_ID, REVIEWER_UNASSIGNED_CHANGE_SECTION_ID
qa-engine/src/contexts/generation/infrastructure/prompt-builders/reviewer-sections.ts: REVIEWER_STEP_LIMIT_SECTION_ID
qa-engine/src/contexts/generation/infrastructure/prompt-builders/task-builders.ts: ANTI_WEAKENING_RULE, EFFORT_BY_TIER, EFFORT_NO_OP_CLAUSE, EFFORT_PER_BEHAVIOUR, NO_OP_REASONS, OBJECTIVE_HEADING, OBJECTIVE_QUESTION
qa-engine/src/contexts/generation/infrastructure/prompt-cap.ts: EVIDENCE_TEXT_SAFETY_BOUND
qa-engine/src/contexts/generation/infrastructure/prompt-rendering.adapter.ts: PromptBuilders
qa-engine/src/contexts/generation/infrastructure/resilience/circuit-breaker.ts: CIRCUIT_THRESHOLD
qa-engine/src/contexts/generation/infrastructure/route-catalog.ts: REDIRECT_PATH_MAX_CHARS
qa-engine/src/contexts/generation/infrastructure/sse/agent-activity.ts: routeEvent
qa-engine/src/contexts/generation/infrastructure/sse/call-efficiency-tracker.ts: NAV_OUTPUT_MAX_KEPT, OBSERVATION_READY_TIMEOUT_MS, TrackerTimer
qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts: EventStreamManager, startEventStreamWithReconnect, startScopedEventStream
qa-engine/src/contexts/generation/infrastructure/sse/opencode-tool-outcome.ts: TOOL_ERROR_MAX_CHARS
qa-engine/src/contexts/generation/infrastructure/telemetry/turn-probe.ts: recordDeliveredContextSpans
qa-engine/src/contexts/generation/infrastructure/telemetry/turn-trace-registry.ts: DEFAULT_TRACE_MAX_AGE_MS
qa-engine/src/contexts/generation/infrastructure/telemetry/with-turn-telemetry.ts: TurnTelemetryDeps
qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts: listSuiteSpecFiles
qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts: computeChangeCoverage
qa-engine/src/contexts/objective-signal/domain/causal-label.ts: CausalInput, CausalMatchers, CausalScope, MAX_CAUSAL_CASES
qa-engine/src/contexts/objective-signal/domain/coverage-exclusions.ts: ReachScope
qa-engine/src/contexts/objective-signal/domain/dump-sanitizers.ts: MAX_FAULT_COUNTER_KEY_CHARS, MAX_FAULT_COUNTER_OPERATIONS, MAX_FAULT_COUNTER_TEST_CHARS
qa-engine/src/contexts/objective-signal/domain/enforce-readiness.ts: ReplicateSignals, untrustedReasons
qa-engine/src/contexts/objective-signal/domain/observed-difference.ts: MAX_MOVED_ITEMS
qa-engine/src/contexts/objective-signal/domain/per-candidate-coverage.ts: PerCandidateInput
qa-engine/src/contexts/objective-signal/domain/render-coverage-gap.ts: renderSurvivedMutant
qa-engine/src/contexts/objective-signal/domain/select-mutants.ts: MAX_MUTANTS, specFilesOf
qa-engine/src/contexts/objective-signal/domain/test-intent-contract.ts: anchoring
qa-engine/src/contexts/objective-signal/infrastructure/coverage-dump-reader.ts: V8_DECODE_BUDGET_MS, V8_DUMP_LIMITS
qa-engine/src/contexts/objective-signal/infrastructure/fault-injection-counter-reader.ts: readFaultCounters
qa-engine/src/contexts/objective-signal/infrastructure/v8-branch-coverage.ts: MAX_BRANCH_DECISIONS
qa-engine/src/contexts/run-orchestration/application/accept-delivered-specs.use-case.ts: AcceptInput
qa-engine/src/contexts/run-orchestration/application/run-flow/checkpoint.ts: RunCheckpoint
qa-engine/src/contexts/run-orchestration/application/run-flow/failure-policy.ts: FAILURE_KINDS, POLICY, STEP_CLASSES
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts: GapRegeneration, coverageExclusionsOf, gapFindings, gapUnits
qa-engine/src/contexts/run-orchestration/application/run-flow/phases/generation-services.ts: BoundText
qa-engine/src/contexts/run-orchestration/application/run-flow/route-availability-grounding.ts: CHANGE_CLOSURE_POLICY, runBaseRef
qa-engine/src/contexts/run-orchestration/application/run-flow/run-flow.ts: StepEvent, validateTable
qa-engine/src/contexts/run-orchestration/application/run-flow/step-ids.ts: STEP_IDS
qa-engine/src/contexts/run-orchestration/domain/fix-loop-action.ts: FixLoopTransition
qa-engine/src/contexts/run-orchestration/domain/fix-loop.aggregate.ts: FixLoopAcceptanceOutcome, FixLoopExecuteInput, FixLoopGenerateInput, FixLoopGenerateResult, FixLoopIntegrity, FixLoopRun
qa-engine/src/contexts/run-orchestration/domain/flaky-triage.ts: classifyFlakyCase
qa-engine/src/contexts/run-orchestration/domain/review-action.ts: ReviewTransition
qa-engine/src/contexts/run-orchestration/domain/review-finding-filter.service.ts: CitedFinding, ReviewScope
qa-engine/src/contexts/run-orchestration/domain/run-deadline.ts: measuredPurposeDurations
qa-engine/src/contexts/run-orchestration/domain/run-time-budget.ts: RUN_TIME_BUDGET_ENV, RUN_TIME_BUDGET_KEYS, RUN_TIME_BUDGET_MS
qa-engine/src/contexts/run-orchestration/domain/static-fix.ts: StaticFixInput
qa-engine/src/contexts/service-topology/domain/operation-url-pattern.ts: MAX_OPERATION_PATTERN_CHARS, operationUrlPattern
qa-engine/src/contexts/service-topology/infrastructure/call-pattern-catalog.ts: CallPatternExtractor
qa-engine/src/contexts/service-topology/infrastructure/call-site-catalog.ts: CallSiteExtractor
qa-engine/src/contexts/service-topology/infrastructure/event-pattern-catalog.ts: EventPatternExtractor
qa-engine/src/contexts/service-topology/infrastructure/openapi-http-resolver.adapter.ts: extractEnclosingMethodFallback
qa-engine/src/contexts/service-topology/infrastructure/yaml-boundary-profile.adapter.ts: parseEventBoundaryProfile, parseHttpBackendBoundaryProfile, parseHttpBoundaryProfile
qa-engine/src/contexts/test-execution/application/agent-browser.use-case.ts: LOW_CALLS, MAX_REPORTED_BLOCKS, MAX_SNAPSHOT_CHARS, MAX_TYPED_CHARS, MAX_URL_CHARS
qa-engine/src/contexts/test-execution/application/run-spec.use-case.ts: MAX_ERROR_CHARS, MAX_REPORTED_LOAD_ERRORS, MAX_REPORTED_TESTS, MAX_TITLE_CHARS, RunSpecDeps, SPEC_PATH_PATTERN, escapeGrep
qa-engine/src/contexts/test-execution/composition/build-test-execution.ts: TestExecutionDeps
qa-engine/src/contexts/test-execution/domain/agent-browser-capability.ts: MAX_RENEWALS
qa-engine/src/contexts/test-execution/domain/agent-browser-route-guard.ts: RouteGuardPolicy
qa-engine/src/contexts/test-execution/domain/agent-browser-session-invalidation.ts: INVALIDATION_KIND
qa-engine/src/contexts/test-execution/domain/failure-category.ts: FAILURE_CATEGORY
qa-engine/src/contexts/test-execution/domain/output-token-filter.ts: OPAQUE_TOKEN_REMOVED
qa-engine/src/contexts/test-execution/domain/playwright-report-plan.ts: MAX_PLANNED_CASES
qa-engine/src/contexts/test-execution/domain/playwright-types.ts: PwDialog, PwFrame, PwGeolocation, PwLocator, PwResponse, PwRoute, PwWebSocketRoute
qa-engine/src/contexts/test-execution/domain/run-spec-capability.ts: CLOSED_LOOP_REFUSAL, LedgerEntry, MIN_CALL_MS
qa-engine/src/contexts/test-execution/domain/stubbed-state.ts: StubbedStateReport
qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts: DEFAULT_E2E_TIMEOUT_MS, E2E_STDERR_KEEP_CHARS, E2eExecuteOptions, E2eRunOutput, FAILURE_DUMP_LIMITS, FailureDump, MAX_FAILURE_DUMPS_TOTAL_BYTES, MAX_FAILURE_DUMP_BYTES, MAX_FAILURE_DUMP_FILES, MAX_PLAYWRIGHT_REPORT_BYTES, MAX_STREAM_EVENT_LINE_CHARS, SPEC_FILE_RE, StreamEvent, allFailuresAreRunnerInfra, parseStreamEvent, playwrightArgs, readControlFiles, readFailureDumps, readPlaywrightReport, segmentsAreTail, specListContent, streamStatusToCase
qa-engine/src/contexts/test-execution/infrastructure/run-dump-bridge.ts: DUMP_CHECK_BUDGET_MS, createDumpExecutor
qa-engine/src/contexts/test-execution/infrastructure/static-gate.adapter.ts: StaticGateChecks
qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts: CHECK_OUTPUT_KEEP_CHARS, runCheck, validateManifest
qa-engine/src/contexts/test-execution/infrastructure/static-gate.trace.ts: countCheckErrors, firstCheckError
qa-engine/src/contexts/workspace-and-publication/composition/build-workspace-and-publication.ts: WorkspaceAndPublicationDeps
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/multi-repo-checkout.adapter.ts: MultiRepoCheckoutDeps, ServiceStageInput
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/publication-port.adapter.ts: PublicationPortCollaborators, PublicationPortStaticContext
qa-engine/src/contexts/workspace-and-publication/infrastructure/adapters/suite-store-trace.ts: SKIP_CLASS, classifySkipReason
qa-engine/src/contexts/workspace-and-publication/infrastructure/github-http.ts: GITHUB_MAX_BODY, GITHUB_MAX_TITLE
qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts: FAILURE_CAPTURE_MARKER, MAX_INSTALL_MARKER_BYTES, MAX_LOCK_FILE_BYTES, SetupAdapterFsDeps, failureCaptureBlockFrom
qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts: SuiteManifest, SuiteStoreDeps, SuiteStoreLimits, TrackedFile, gitBlobOid, parseStagedListing, suiteEntryKind
qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts: WriteConfinementAdapterDeps
qa-engine/src/shared-infrastructure/bounded-tree-removal.ts: TreeRemovalLimitError
qa-engine/src/shared-infrastructure/code-graph/codegraph-store-cache.ts: StoreMeta
qa-engine/src/shared-infrastructure/code-graph/codegraph-workspace.ts: selectWorkspacePaths
qa-engine/src/shared-infrastructure/code-graph/git-co-change.adapter.ts: BULK_COMMIT_FILES, couplingOf, parseHistory
qa-engine/src/shared-infrastructure/egress/dns-filter.ts: parseDnsQuestion
qa-engine/src/shared-infrastructure/egress/egress-controller.ts: EgressControllerDeps
qa-engine/src/shared-infrastructure/process-sandbox/exec-env.ts: ExecEnvInput, SANDBOX_PROFILES
qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts: ExecSandboxDeps, ExecSpawnOptions
qa-engine/src/shared-infrastructure/process-sandbox/orphan-browser-sweep.ts: OrphanSweepDeps
qa-engine/src/shared-infrastructure/process-sandbox/sandbox-reaper.ts: ProcessInfo, ProcessTable, createSandboxReaper, procTable
qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter.ts: containsSecrets
qa-engine/src/shared-infrastructure/repo-reader.ts: REPO_READER_LIMITS
qa-engine/src/shared-infrastructure/spec-fixtures-import.ts: importsTestFromFixtures
qa-engine/src/shared-infrastructure/spec-path-confinement.ts: MAX_SPEC_WALK_ENTRIES, SpecPurgeDeps, SpecReadDeps, SpecWriteDeps, defaultSpecPurgeDeps, defaultSpecReadDeps, defaultSpecWriteDeps, specReadDepsFor, specWriteDepsFor
qa-engine/src/shared-infrastructure/worker/off-loop-executor.ts: OffLoopOutcome, workerExecArgv
qa-engine/src/shared-kernel/case-proof.ts: tallyOf
qa-engine/src/shared-kernel/context-budget.ts: roomTokens
qa-engine/src/shared-kernel/context-item-ids.ts: ID_KIND, MAX_ITEM_IDS, MAX_ITEM_ID_CHARS
qa-engine/src/shared-kernel/contract/events.ts: AgentActivityKindSchema, RunStepSchema
qa-engine/src/shared-kernel/diff-stat.ts: DIFF_TIERS
qa-engine/src/shared-kernel/error-class.ts: errorClassFromCorrections, errorClassFromVerdict
qa-engine/src/shared-kernel/manifest/manifest-entry.ts: ManifestEntrySchema, ManifestSchema
qa-engine/src/shared-kernel/observed-requests.ts: MAX_LOGGED_HOSTS, MAX_LOGGED_PATH_CHARS, MAX_LOGGED_TOTAL_CHARS
qa-engine/src/shared-kernel/route-availability.ts: MAX_AVAILABILITY_FACTS_RECORDED
qa-engine/src/shared-kernel/route-capturability.ts: RouteReason
qa-engine/src/shared-kernel/run-secret-redaction.ts: MAX_OPAQUE_BYTES, MIN_ACCOUNT_SECRET_CHARS, MIN_SESSION_VALUE_CHARS, RunSecretScope
qa-engine/src/shared-kernel/served-version.ts: SERVED_VERSION_STATES
qa-engine/src/shared-kernel/telemetry/attribute-registry.ts: ATTRIBUTES, ATTRIBUTE_TEMPLATES
qa-engine/src/shared-kernel/working-room.ts: COLD_START_STEP_GROWTH_TOKENS
src/agent-runtime/config.ts: providerConfig
src/agent-runtime/index.ts: providerConfig
src/agent-runtime/run-context-budget.ts: roleOfRecordedTurn, samplesOfRecordedTurns
src/cli.ts: delegateRunInput, parseArgs
src/contract/commands.ts: OnboardStateSchema, RepoIndexOutcomeSchema, ResolutionSummarySchema
src/contract/openapi.ts: ARTIFACT_PATH
src/integrations/github.ts: GitHubDeps
src/integrations/logger.ts: createJsonLogger
src/integrations/opencode-client.ts: AgentListDeps, NO_TOOLS, answeredFrom, createRawEventStreamOpener, fallbackModelFromConfig, hidesBrowserTools, hidesCodeGraphTools, hidesGeolocationTool, openCodePromptBody, promptFailure, sessionToolDeny, turnStepLimit
src/integrations/opencode-server-auth.ts: OPENCODE_SERVER_PASSWORD_ENV, OpenCodeAuthError
src/integrations/redacting-logger.ts: ShippedLine, createRedactingLogger
src/integrations/repo-mirror.ts: MirrorDeps
src/orchestrator/schemas.ts: WebhookPayloadSchema
src/qa/test-data.ts: shortSha
src/qa/value-report.ts: RunReportInput, ValueSignals, deriveAction
src/server/api/route-table.ts: routes
src/server/auth.ts: LOCAL_CONSOLE_PRINCIPAL, allowLocalWebLogin, isLoopbackAddress, isLoopbackHost, localWebLoginAllowed, validateSession
src/server/campaign-freeze.ts: CAMPAIGN_FREEZE_ENV
src/server/context-map-wiring.ts: ContextMapQuestionDeps
src/server/coordination-events.ts: CoordinationLedgerFsDeps, parseCoordinationLedger, readCoordinationLedger
src/server/create-app.ts: AppDeps, LOGIN_ATTEMPTS_PER_WINDOW
src/server/evaluation-evidence.ts: EvidenceDeps, LedgerSpan, countPassedSpecs, defaultEvidenceDeps
src/server/evaluation-service.ts: catalogView
src/server/file-boundary-check.ts: probeFailureReason, probeSpawnFor, writeStatus
src/server/github-auth.ts: FetchLike
src/server/guidance.ts: MAX_GUIDANCE_LENGTH
src/server/health-poller.ts: BACKUP_INTERVAL_TICKS, HEALTH_POLL_INTERVAL_MS, HealthPollerDeps, PRUNE_INTERVAL_TICKS
src/server/metrics.ts: ArtifactBytesDeps, collectArtifactBytes
src/server/mirror-prune.ts: MirrorEntry, MirrorPruneDeps, PRUNE_MAX_AGE_MS, computeActiveRepoSlugs, repoSlug
src/server/onboarding/llm-profile-proposer.adapter.ts: commonSessionRoot
src/server/onboarding/onboarding-job.ts: LOGIN_STATUS, ONBOARD_OUTCOME, ONBOARD_STATE, OnboardingJobDeps, OnboardingJobStatus
src/server/persistence/index.ts: History, createHistory
src/server/persistence/migrations/index.ts: LATEST_SCHEMA_VERSION
src/server/persistence/repositories/telemetry.repository.ts: AgentTurnEventInput
src/server/persistence/retention.ts: DELETE_MAX_AGE_DAYS, RetentionPolicy
src/server/phase-history.ts: phaseRecordOf
src/server/port.ts: listenErrorHint
src/server/run-delegate.ts: DELEGATE_WAIT_BUFFER_MS
src/server/run-engine-factory.ts: RunEngineFactoryDeps, STEP_LIMIT_READ_TIMEOUT_MS, buildConfinement, buildEngineRootDeps, engineAgentDeps, publishWiring, roleToAgentName
src/server/run-history-sqlite-adapter.ts: RunHistorySqliteAdapterDeps
src/server/run-view.ts: RunViewDeps
src/server/runner.ts: ONBOARDING_INDEXING_CEILING_MS, ONBOARDING_JOB_CEILING_MS, ONBOARDING_MIRROR_CEILING_MS, ONBOARDING_WAIT_MARGIN_MS, ONBOARDING_WAIT_MAX_MS, sourceOfTrigger
src/server/service-context.ts: ServiceContextManifest, StageDeps, defaultStageDeps
src/server/shutdown.ts: ShutdownDeps
src/server/tools-endpoint.ts: AUTHBROWSER_PATH, CODEGRAPH_PATH, GEOLOCATION_PATH, MIN_TOOLS_TOKEN_CHARS, ToolsRequest, createToolsRateLimiter, handleToolsRequest
src/server/version.ts: CAPABILITIES, MIN_CLIENT_VERSION, SERVER_VERSION, WIRE_API_VERSION, engineVersionOf, revisionOf, versionGte
src/server/web-console/console-harness.ts: ConsoleRequest, Reply
src/server/webhook-handler.ts: MAX_WEBHOOK_BODY
src/server/webhook.ts: parseWebhook, verifySignature
src/settings/settings.ts: SettingsError, describeSettings
src/telemetry/backend-health.ts: BackendFetch
src/telemetry/bootstrap.ts: BootstrapDeps, retentionPrune
src/telemetry/config.ts: parseMaxCapture
src/telemetry/host-health.ts: EventLoopMonitor, HostScheduler, ProcFs, countSandboxZombies
src/telemetry/log-shipper.ts: LOG_BODY_CAP_CHARS
src/telemetry/otel-telemetry.adapter.ts: ARRAY_CAP
src/telemetry/prompt-body-logs.ts: MAX_BODY_CHARS, MAX_LINE_BYTES, chunkBody, splitSections
src/telemetry/trace-harness.ts: FakeClock, T0
src/util/net.ts: createAgentTransportFetch
```

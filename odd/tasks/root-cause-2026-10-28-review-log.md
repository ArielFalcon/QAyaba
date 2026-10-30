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
| V2 | V (T4) | advisory | `restoreSnapshot` | A snapshot of another app restores without a word (app, repo, spec dir ignored) | Refuse a snapshot whose app differs | follow-up |
| V3 | V (T4) | advisory | `suite-store-writers.test.ts` | The ownership scan matches only `appSuiteStoreDir(`; a hand-built path or manifest write escapes it | Widen the scan | follow-up |
| V4 | V (T4) | advisory | `warm-suite --leave-out` | A path not in the store is ignored silently | Warn | follow-up |
| V5 | V (gov) | advisory | model resolution | A missing `agents/opencode.json` is no longer loud at boot | Warn at boot | follow-up |
| V6 | V (gov) | advisory | proposer | Now follows the operator's `AGENT_PRIMARY_MODEL` | none (matches the settings text) | noted |
| V7 | V (gov) | advisory | M4 rule | Does not cover `scripts/` | Decide whether scripts are launchers | follow-up |
| W1 | W (C2/C3) | follow-up | sandbox env allowlists, `docs/execution-sandbox.md:31` | Still pass `JAVA_HOME`, `GOPATH`, `CARGO_*`, `GRADLE_*`, `MAVEN_*` after the code target left | Remove them | follow-up |
| W2 | W (C3) | follow-up | Dockerfile | `python3-venv` has no user found | Remove after a check | follow-up |
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
| C-m2 | CP2 C | minor | T4, `suite-store.adapter.ts:473-485` | `restoreSnapshot` skips `assertWithinLimits` and the app check (V2); a test patches a private writer | Check limits and app | open (integration) |
| C-m3 | CP2 C | minor | T10, `window-fit-references.ts:33` | Ids kept for a page the advisory prints under the same path with a different tree | none or narrow | noted |
| D-m1 | CP2 D | minor | ADR-0011 B2, B2', B3 | No carrier task | Name carriers | fixed (T28) |
| D-m3 | CP2 D | minor | `docs/lead-sidekicks.md:417` | Read-only concurrency text after OD-5 | Correct | fixed 3b558bda |
| D-m5 | CP2 D | minor | `src/settings/registry.ts:102`, `docs/settings.md:96` | QA_CAMPAIGN_FREEZE description | Correct | fixed 3b558bda |
| D-m6 | CP2 D | minor | `config/apps/example.yaml:31-36` | Says the loader strips unknown keys | Correct | fixed 3b558bda |
| D-m7 | CP2 D | minor | inventory | T18 deletions unmarked; judge modules have no row | Mark | open (re-marked at T13) |
| D-m8 | CP2 D | minor | `docs/architecture/README.md:136` | Stale sentence on records above RFC-0005 | Correct | fixed 4089ca70 |
| D-m9 | CP2 D | minor | RFC-0003:210 | Cites a test file C2 deleted | Correction | fixed 4089ca70 |
| D-m11 | CP2 D | minor | T19, T20 rows | Omit the ADR-0013 corrections decided when they land | Add | fixed (T19, T20 rows) |


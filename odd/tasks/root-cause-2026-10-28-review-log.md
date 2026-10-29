# Review log: root-cause fixes 2026-10-28

Every problem or suggestion a reviewer, verifier or writer reports while the plan of `odd/tasks/root-cause-2026-10-28.md` is implemented, kept for later analysis (owner, 2026-10-29: "ve llevando un log con los problemas y sugerencias que te vayan reportando para luego analizarlas"). One row per item. Status: `fixed` (commit), `open` (to fix), `follow-up` (outside every record; for the owner to schedule), `decided` (owner answer), `noted` (no action).

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
| W5 | W (M2) | owner | `.env.example:30-32`, GitHub, data volume | `SELF_MAINTAINER_AUTOMERGE` lines; 18 `qa/maintainer-*` pull requests; the auto-merge setting; five maintainer files in the data volume | Owner edits (ADR-0013 point 3) | open (owner) |
| W6 | W (LC-L4) | record | J12 above | | | see J12 |
| W7 | W (LC-L4) | follow-up | history schema | Unread now: tables `learning_rules`, `curriculum`, `scorecard` (read by the signals view, written by nothing), columns `run_outcomes.rules_retrieved`, `run_outcomes.reflection`; no migration added (stored data, high-risk item 1) | A migration decision for the learning rebuild (T20) | follow-up |
| W8 | W (LC-L4) | follow-up | `docs/architecture-remediation.md`, `docs/testing-standards.md` | Historical text still describes the reflector, curriculum, rule fold and exemplar facts | Decide whether historical documents are kept as history or trimmed | follow-up |
| W9 | W (LC-L4) | process | scratch cleanup | The parent's `gate-*.log` cleanup removed a running writer's logs | Writers name logs per task; the parent removes only paths a writer reported | fixed (process) |

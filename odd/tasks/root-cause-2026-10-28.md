# Root-cause fixes 2026-10-28: confirmed causes, removed at the root, in the approved order

Objective: implement the accepted records (docs/architecture/, ADR-0011 to ADR-0013) in the approved order. Branch: fix/root-cause-2026-10-28 (worktree qayaba-root-cause), rebased on main 4105c582. Delivery: work-unit commits on this branch; push, PR and merge stay with the owner. Test runner: npm test (node:test via tsx, Node v24.11.0); the full gate of AGENTS.md "Commands" closes every task.

## Specs

- S1. The brief (L1), whose rules hold for every task: "Never push, merge, or touch other existing worktrees." "Never print credentials or tokens." "If a fix needs a product or architecture decision, STOP and ask me — do not choose." Only confirmed causes are fixed, test-first, one commit per root cause, superseded patches removed, before and after measured ([ADR-0011](../../docs/architecture/adr/0011-root-cause-fix-policy.md)).
- S2. "no agregues mas parches a main, ten esos descubrimientos como informacion para el proceso de refactor": every change lands on this branch.
- S3. "las replicas van a demorar demasiado las 3 por separado una tras otra, lanza 1 sola" and "habiamos quedado en 1 sola replica, por que lanzaste 3?": one replicate per measurement; one against one shows a direction, not proof.
- S4. "respecto a las 13 recomendaciones estoy de acuerdo con todo" (D1-D13) and "me parece bien ese diseño para la capa de aprendizaje" (D14): ADR-0003 to ADR-0011. "Apruebo todas las decisiones con tu recomendación": every recommended answer of RFC-0002 to RFC-0010, recorded in ADR-0012. "Las decisiones pendientes no bloqueantes también resuelvelas con tus recomendaciones. Deja todo listo para empezar a implementar": every remaining recommended answer (RFC-0001 OD-1 to OD-20, ADR-0001 to ADR-0011, the README), recorded in ADR-0013. Each task implements its record as accepted, nothing more.
- S5. The owner's code implementation standard in AGENTS.md (commit 855457c1) is every task's done-criteria: precedent and reuse first, the smallest change, the rule searched across the whole codebase, the full gate green.
- S6. "me parece bien el orden": platform steps 0-1, then one slice per confirmed family, then platform steps 4-6.

## Tasks

| ID | Specs | Work | Route | Status | Commit |
|---|---|---|---|---|---|
| T1 | S4-S6 | RFC-0002 step 0: placement rule and decision table in AGENTS.md (Q14), pointer to ADR-0001, test-support sentence; inventory appendix root-cause-2026-10-28-inventory.md | delegated (L5 lane A) | done | b49ffb50, 9cf6e8e4 |
| T2 | S4 | RFC-0002 Q1 (G1): previous-forms skips path and citation checks under docs/architecture/; own commit, before the first deletion. Risk item 5 (CI) | delegated (L5 lane A) | done; independent verifier PASS | a4cde318 (RED: dead path under docs/architecture reported) |
| T3 | S4 | RFC-0002 step 1: deletions in the order D11, D1 with D2, D8, D5 (Q9); twins and dead code; derived stored run outcome last (Z). D2 statement only on the owner's authorization (Q8); D11's GitHub part only on the owner's go. T14 opens step 1; T16 lands before V2; VF goes ahead (ADR-0004 point 1 answered). Risk items 1, 3, 5 | inline; a writer only by the Writer trigger | pending | |
| T4 | S1, S4 | RFC-0005 (H20): one writer for the suite store; ahead of the after-replicates | delegated (L5 lane B) | done on its branch, lands after T17 | 0644a714 (fix/root-cause-slice-rfc0005-suite-store) |
| T5 | S1, S4 | RFC-0003 (H06): coverage dump harvest off the event loop, one worker per call | inline | pending | |
| T6 | S1, S4 | RFC-0004 (H11): log level derived from the typed outcome | inline | pending | |
| T7 | S1, S4 | RFC-0006 (N02 residual): an agent's answer crosses whole; a loss is loud, never an approval | delegated (L5 lane B) | done on its branch, lands after T17 | 4542a739 (fix/root-cause-slice-rfc0006-review-answer) |
| T8 | S1, S4 | RFC-0007 (N04): a write the spec caused, measured against a control load; own commit. Risk item 2 (guard) | inline | pending | |
| T9 | S1, S4 | RFC-0008 (N06): an acceptance records what it ran | delegated (L5 lane B) | done on its branch, lands after T17 | fc527a14 (fix/root-cause-slice-rfc0008-acceptance-record) |
| T10 | S1, S4 | RFC-0009 (N09): the pack record lists what the prompt carried | delegated (L5 lane B) | done on its branch, lands after T17 | 0b8382cc (fix/root-cause-slice-rfc0009-pack-record) |
| T11 | S1, S4 | RFC-0010 (N12): a tool call's record carries its outcome | delegated (L5 lane B) | done on its branch, lands after T17 | 10aa4667 (fix/root-cause-slice-rfc0010-tool-call-record) |
| T12 | S1, S3 | After-measurement: one replicate on the owner's go, conditions of ADR-0011 (12-entry snapshot, freeze off) | owner's go | pending | |
| T13 | S6 | Plan steps 2-3 over the inventory rows no slice moved (ADR-0002 open question 2), then platform steps 4-6: the test-support root at step 4 (OD-16); a redesign member with no record by the end of step 6 is deleted (OD-19) | later | pending | |
| T14 | S4 | RFC-0001 OD-14: warn per unknown app-config key; the first commit of step 1, before T2 (G1) and ahead of C1 and L2 (RFC-0002, note under the commit table) | delegated (L5 lane A) | done | 860b9356 (RED: 3 tests, 0 warnings) |
| T15 | S4 | ADR-0002 open question 3: the engine/AI boundary as one table in AGENTS.md; a docs commit of step 0, after T1 | delegated (L5 lane A) | done | e64f618a |
| T16 | S4 | ADR-0006: the key `qa.changeCoverage.bundleMutation` (signal or off, default signal; the retired key warns through T14), in step 1 before V2 removes `qa.valueOracle`, the switch bundle mutation runs under today | inline | pending | |
| T17 | S1, S3 | Step 1's closing live run (RFC-0002 Q10): one replicate on the owner's go; it becomes the slices' "before" (ADR-0011) | owner's go | pending | |
| T18 | S4 | RFC-0001 removals after Z, each in its own commit gated by its answer (RFC-0002 Q12): OD-1, OD-3 (its helpers moved first), OD-4, OD-5, OD-7, OD-8, OD-9, OD-12 (each contract removal with contract:check), OD-13 (context-heal only if it does not fire over the next campaign cycle), OD-17. Risk items 3 and 5 where the record names them | inline | pending | |
| T19 | S4 | ADR-0008 with RFC-0001 OD-10: the six version states as a standalone change before the learning slice; the deploy gate waits only when the run is deploy-triggered and the version is `behind` | inline | pending | |
| T20 | S4 | Learning slice (ADR-0003 D1-D4 and D14, with ADR-0009 D10): its RFC first (lesson entity and storage, data-state failure, replicates per arm, improvement, kill criterion); the server-side freeze before the first lesson kind runs; then OD-11's live service-triggered run on the owner's authorization of repository, sha and credential | RFC first; owner's go for OD-11 | pending | |
| T21 | S4 | ADR-0005 (D6): enforce activation per its record (criterion, read-only operator script, typed fact for left-out evidence); its latent defect B1 first, as a RED test | later | pending | |
| T23 | S4 | Golden rule (L6): remove `DEFAULT_MODELS` (`src/agent-runtime/config.ts:23-31` at 4105c582); the defaults come from `agents/opencode.json` only; own commit in step 1; then the other model-id sites the guard lists (`FALLBACK_MODELS`, `PROPOSER_MODEL`), each its own commit (S5: the rule searched across the whole codebase) | delegated (L5 lane A) | DEFAULT_MODELS done; two sites pending | 979f0857 (RED: guard `src/no-model-literals.test.ts` named config.ts) |
| T22 | S4 | ADR-0001 open question 3: an RFC naming the signal that replaces the tier thresholds (`DIFF_TIERS`), after the three family slices | later | pending | |

Order: T1, T15, T14, T2, T3 (with T16 and T23), T18, T17, then T4-T11 and T12; T19 to T22 and T13 after the slices. T18 runs before T17 so the slices' "before" already holds every removal (OD-3 and OD-4 change what the lead does).

Route rule: every task runs inline unless the Writer trigger fires (independent units launched together); an independent verifier only for a task that names a high-risk item (T2, T3, T8, T18).

Lanes (L5): lane A runs steps 0-1 in order on this branch, one delegated writer per batch (context backstop: about 30 commits do not fit the parent's context). Lane B develops the family slices whose surfaces step 1 does not touch in worktrees of their own, branched from this branch (Writer trigger: independent units launched together): first T4, T7 and T9, then T10 and T11; T5, T6 and T8 wait for step 1, whose deletions touch their files (the value oracle beside the coverage harvest, the learning wiring beside the log sites, the seed fixture beside the write ledger). A slice lands on this branch after T17, rebased on step 1, so the measurement order of ADR-0011 holds. At most four writers run at once (10 cores; each runs the full suite).

Verifier defects (ADR-0011, ADR-0013): each gets its own RED test and fix commit, carried by the first task that edits its function. Lines at 4105c582: B1 `review.steps.ts:631-633` (a flaky verdict replaced under enforce; with T21); B2 `lead-sidekicks.ts:480` and `replan-sections.ts:71` (the stated flow capacity); B2' `lead-sidekicks.ts:1273-1278` (a zero-margin correction turn when the reserve is pinned); B3 `lead-sidekicks.ts:1045` and `run-qa.use-case.ts:272` (a missing corrections record).

## Log

- L1 (2026-10-28 10:21Z, the brief, verbatim):

  > 
  > ultracode 
  > 
  > <pasted_content id="692e">
  > Root-cause architecture investigation — QAyaba
  > Goal
  > Find the systemic root causes in QAyaba’s architecture that keep producing
  > recurring failures across executions — including ones that were patched over
  > or never detected — and fix them at the root with solutions that fit the
  > existing architecture. A one-off error is NOT a target; a structural defect
  > that explains a family of failures is.
  > Setup
  > Repo: Create a dedicated worktree from main(branch fix/root-cause-<date>). All edits and commits happen there.Never push, merge, or touch other existing worktrees. Create all needed woktrees as you understand are optimal for sub-agent work.
  > Record a baseline first: test suite result and current failure rates.
  > Telemetry sources: OpenTelemetry traces (Grafana), app logs, run history and evaluation results via the public API (/telemetry/*).Never print credentials or tokens. This project uses Loki, Tempo, has evals and graders.
  > Phases (parallelize inside each phase, not across them)
  > Map (parallel):a. Architecture: layers, boundaries, data flow, ADRs, conventions.b. Telemetry harvest: every failed or degraded execution with trace ID, span, error, phase, config. Separate infra-error from code failures.c. Patch archaeology: git history of fix commits — files and areas fixed repeatedly, workarounds, retries, try/except swallowing, TODO/HACK.
  > Taxonomy: cluster failures by mechanism (not by message text).Each cluster: count, affected runs, first/last seen, example trace IDs.
  > Hypotheses: for each cluster with recurrence, propose a root cause.Each hypothesis MUST include:
  > the causal chain from architectural defect → symptom, with file:line;
  > ≥3 concrete trace/run IDs it explains, and which failures it does NOT;
  > a falsifiable prediction (what else must be true if it is right);
  > which past patches it explains.
  > Refutation (independent agents, one per hypothesis): try to DISPROVE it — check the prediction, look for alternative explanations, reproduce it when possible. Verdict: confirmed / plausible / refuted, with evidence.Only “confirmed” moves on. Discard anything refuted; report “plausible”as open questions, never fix them.
  > Design: for each confirmed cause, one fix that removes the cause for the whole family, consistent with the architecture and ADRs. Name the patches it makes redundant. If a fix needs a product or architecture decision, STOP and ask me — do not choose.
  > Implement (worktree): test-first — a test that reproduces the failure mechanism (RED), then the fix (GREEN). One commit per root cause.Remove the patches the fix supersedes.
  > Verify: full suite against the baseline; re-run the affected scenarios and compare failure rates before/after. A fix without measured improvement is reported as unproven.
  > Evidence rules (non-negotiable)
  > No claim without evidence: trace/run IDs, log lines, or file:line.
  > Never generalize from one run. Recurrence must be shown with counts.
  > Do not attack symptoms nor straw men: if the evidence does not support a cause, say “not enough evidence” instead.
  > Label every conclusion as confirmed (evidence) or hypothesis.
  > Final report
  > Per root cause: failure family + counts, causal chain, evidence, refuter
  > verdict, fix, patches removed, tests, before/after metrics, commit.
  > Plus: refuted hypotheses (and why), open questions, residual risks.
  > </pasted_content id="692e">
  > 
  > 

- L2 (2026-10-28): investigation done. Phase 3 confirmed H06, H11, H20; phase 3b confirmed N02, N04, N06, N09, N12 alive on main (N01, N18 already removed at the root); the test-quality strand confirmed none. Before-measurement: run-ed28973-mvs7oo0f-17041c71 on 4105c582 (one replicate).
- L3 (2026-10-28 ~20:30Z): records committed (aff06b95 tracks docs/architecture records in .gitignore, 0794e37f the records); branch rebased on 4105c582; previous-forms clean. The owner asked to economize quota ("agiliza un poco el proceso que queda poco para el limite de cuota"); implementation starts with T1 on the owner's go.
- L4 (2026-10-28): the owner, verbatim: "Las decisiones pendientes no bloqueantes también resuelvelas con tus recomendaciones. Deja todo listo para empezar a implementar". Recorded in ADR-0013: every remaining recommended answer accepted; README open question 2 was carried out by narrowing the ignore rule (aff06b95) instead of removing it; the actions the records give the owner stay the owner's when their step runs (operator data edits, the auto-merge setting and the maintainer PRs, OD-11's live run, the D2 statement). Added T14-T22, the order line and the verifier-defect rule; T3 and T13 amended. Found while planning, not decided: `src/agent-runtime/config.ts:23-31` names model ids (`DEFAULT_MODELS`, a copy of agents/opencode.json), against the golden rule of AGENTS.md; raised to the owner when step 1 starts.
- L5 (2026-10-29): the owner, verbatim: "Comienza con la implementación del plan de forma autónoma hasta el final. Si es posible sin inconvenientes paralelizar trabajo con worktrees hazlo". Read as: run every task in order without asking between them; the actions ADR-0013 point 3 gives the owner stay the owner's (the D2 statement before LC, the GitHub part of D11, operator data edits, OD-11's credential), and a product or architecture decision a record does not settle stops its task (S1). Receipt-driven review is off (global), so no native review runs. Lanes recorded under the route rule.
- L6 (2026-10-29): asked whether the removal of `DEFAULT_MODELS` (model ids in `src/agent-runtime/config.ts`, a copy of `agents/opencode.json`, against the golden rule) goes into step 1, the owner answered, verbatim: "Si, inclúyelo". Added as T23. Lane A writer 1 landed T1, T15, T14, T2 (G1) and G2 (bc100d1e), gate green (12288 pass, 0 fail, 2 skipped). Carried forward: the first deletion commit that adds a retired-name rule also adds the per-rule exemption for `docs/architecture/` (RFC-0002 Q1, part b); `config/apps/example.yaml:41-42` says the loader ignores `boundaries`, which the schema declares (to fix with the first commit that touches that file).
- L7 (2026-10-29): lane A landed A1-A8 (a9dea539..70789640; A1 carries the per-rule `exemptPrefixes` for `docs/architecture/`, RFC-0002 Q1 b) and T23 (979f0857), gate green (12282 pass, 0 fail, 2 skipped). Lane B slices T4, T7, T9, T10, T11 committed on their branches; T7, T9 and T11 carry dead citations in their own RFCs that clear on rebase over G1. T4 verifier PASS (manifest swap atomic; a rejected restore leaves the store byte-identical). Advisories, not fixed (no record asks): a snapshot of another app restores without a word (`restoreSnapshot` ignores the snapshot's app, repo and spec directory); the suite-store ownership scan matches only `appSuiteStoreDir(`; a `--leave-out` path not in the store is ignored silently. T11 regenerated the Go client types, which also renamed unused `RunRecordMode*` constants (generator output). Writers must not run `pkill` on test runners or `git stash` (both cross worktrees). The sandbox smoke M2, C2 and V3 require runs once against the live stack before T17.
- L8 (2026-10-29): the owner, verbatim: "en varios checkpoints mandale un agente opus 5.5 esfuerzo max a revisar toda la implementacion y los RFC y ADR generados para ver si cumple con todo, tiene calidad y no hay algun bug que quede sin ver, en general para supervisar la calidad de la implementacion." Checkpoints: CP1 on `465cb6d0..4b22a5db` and the five slice commits; CP2 when step 1 closes (after Z and T18, before T17); CP3 with the slices integrated and T5, T6, T8 done (before T12); CP4 at the end. Each is read-only on fixed commits; a confirmed blocker gets its own fix commit before the next step. The owner stopped every agent once (C2 was mid-work, CP1 had not reported) and then said, verbatim: "retoma todo"; both were relaunched.
- L9 (2026-10-29): lane A landed M1-M4 and the model-id follow-ups (7dff1828, 58d42e70, 239094fd, e37a03b5, e4a23409, 4b22a5db; verifier PASS on the governance commits), then C1 (0cea90f1), C2 (b3deb252), C3 (9fe30859), A9 (c6ee81f4) and the unused shutdown flag (c3e54817); gate green, 11826 pass, 0 fail, 2 skipped. Pending live checks before T17: image rebuild (C3), `docker compose up --build` and `/api/health` (no boot guard since M2), `npm run sandbox:smoke` (M2, C2, V3). Owner actions listed by the writers: `.env.example` lines 30-32 (`SELF_MAINTAINER_AUTOMERGE`), the 18 `qa/maintainer-*` pull requests and branches, the auto-merge setting, five maintainer files in the data volume, the qayaba app config. Follow-up candidates, not in any record: the sandbox environment allowlists still pass `JAVA_HOME`, `GOPATH`, `CARGO_*`, `GRADLE_*`, `MAVEN_*`; `python3-venv` has no user found. D2 read before the reset (read-only, 2026-10-29): one `curriculum` row, app `name-webapp`, `updated_at` 2026-10-28T15:26:24.432Z, 1608 bytes.

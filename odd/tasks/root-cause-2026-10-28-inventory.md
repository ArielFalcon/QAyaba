# Inventory: disabled, staged, inert and dead features (appendix to the root-cause feature document)

Appendix of [`root-cause-2026-10-28.md`](root-cause-2026-10-28.md). Checkout `4105c582` (main), 2026-10-28; every repository path in it was
checked to exist at the branch head when the appendix was added. It merges four read-only sweeps of one audit, deduplicated and grouped
by area. The sweeps are working notes that are not committed; their tags stay as provenance:

- **[S]**: switches and defaults, live environment, read-only history database
- **[C]**: code reachability, live API (GET), maintainer mirror
- **[H]**: git history, decision records, drift since the disable, test runs
- **[L]**: the learning layer, with its deep dive

Abbreviations: `CRL` = `qa-engine/src/contexts/cross-run-learning`, `RF` = `qa-engine/src/contexts/run-orchestration/application/run-flow`,
`SK` = `qa-engine/src/shared-kernel`, `REF` = `src/server/run-engine-factory.ts`. H-numbers are the phase-2 hypotheses
(under refutation when the audit ran); T-numbers are the phase-2 taxonomy. Both are working notes of the investigation and are not committed.
The operator YAMLs under `config/apps/` are gitignored user data, so a row that cites one names the key and not a file of the repository.

Labels: **confirmed** (code and/or live data), **hypothesis** (inferred), **not enough evidence**. The sweeps' verdicts are recorded as
inputs for the reviewers; they are recommendations (hypotheses), not decisions.

## Re-checked in this merge (parent spot checks at `4105c582`)

| Claim | Result |
|---|---|
| Only rule writer is the reflector | `CRL/infrastructure/reflector-port.adapter.ts:157` `await repo.save(rule)`; `rg 'distiller:'` outside tests: only `rule-governance.service.ts:10` (**confirmed**) |
| Promotion needs an oracle outcome | `CRL/domain/rule-fold.ts:28` `if (oracleOutcomeCount < 1) return "candidate"` (**confirmed**) |
| Author sidekick briefs exclude learned rules | `coordination/application/coordination-context.ts:1` "Must never contain OpencodeRunInput (diff, specs, learned rules, DOM, provider)" (**confirmed**) |
| Reflector default | `src/settings/registry.ts:74` `QA_REFLECTOR_ENABLED` default `"false"` (**confirmed**) |
| DevLease exclusive | `REF:366-371` "The proxy has no read-only mode yet … every action is exclusive" (**confirmed**) |
| Value-oracle default is shadow-aware | `src/orchestrator/schemas.ts:440-445` `qa.valueOracle ?? (qa.shadow ? "off" : "signal")` (**confirmed**) |
| Judge block staged | `agents/pending/qa-judge.opencode-block.json` exists (**confirmed**) |
| `qa-explore` used? | run `run-ed28973-mvs49h5y-acdab309` turns: `qa-lead` 6, `author` 8, `qa-reviewer` 2, `qa-explore` 0 (**confirmed**) |
| Maintainer push 403 | Taxonomy T40 "Maintainer self-repair push refused (403) from shadow runs", environment, never patched (**confirmed**) |

## Discrepancies between sweeps, and how they are resolved

1. **`qa-explore`**: [S] §D lists it "active, every e2e run"; [H] §15 counts 0 explore turns in 32 runs and 0 of 243 coordination events.
   Resolved: **unused** (turn count above). The role is granted, never asked for.
2. **Did #26 mint the curriculum's "PROVEN"?** [C] §2.3 and [H] §5: hypothesis (the API strips `firstCaughtAt`). [S] §F (DB) and [L] §6:
   confirmed. Resolved: **confirmed** by three independent facts: the DB timestamps (#26 outcome 2026-10-27T23:32:56.628Z, flags set
   23:32:57.035Z); #26 is the only mainline run missing from the scorecard, and a fold is suppressed only for `app_defect` or
   `dev_not_rendered` (`should-distill-learning.ts:5`); the lead prompts show "PROVEN (1 bug)" from #27 on and in none of #24-#26.
   Which adjudicator rule fired is still **not enough evidence** (not recorded).
3. **`valueScore` null count**: [S] 30/30 outcomes (DB); [C]/[H]/[L] 23/23 scorecard entries (API). Both hold: 23 runs folded, 30 outcomes.
4. **Intent lock would-rejects**: [H] §9 "not enough evidence" (API); [S] §B read the DB: `opacityHigh` true in 23/23 outcomes that
   recorded intent, 5 would-rejects, 7 violations in 30 outcomes. Resolved: **confirmed** from the DB.
5. **Why the 2026-10-27 maintainer commits are not on GitHub**: [C] "not enough evidence"; [S] T40 push 403. T40 (Loki C06, runs #24,
   #26) makes the 403 the likely cause for those branches (**hypothesis** for the specific branches; T40 itself confirmed).
6. **Verdicts diverge** on the curriculum ([S] fix-first or discard; [L] discard the learned credit; [C] replace or drop; [H] keep but
   freeze per commit) and on the judges ([S] discard or park; [H] enable as written or delete). Left to the reviewers.

## Cross-cutting dependency map (which root-cause slice unblocks or protects which feature)

| Family | Effect on dormant features |
|---|---|
| H10 (run ending has no typed owner; error class = stage, lossy learning key) | rule keys, prevention credit, reflector input, audit streaks (`E-COVERAGE-GAP` read as "recurring test failure"), coverage `enforce` class (hard-coded 0.7, `RF/outcome-assembly.ts:18,118`) |
| H01 (proof of a spec's bytes has no owner) | curriculum `app_defect` credit (#26), `E-FALSE-POSITIVE` on proven bytes (#25 `mvr9sbey`), reflector lessons |
| H02 (no read model) | audit `recurring-dev-not-rendered` (adjudication not persisted), oracle "not measured" reason not persisted, shadow log keeps only body length |
| H03 (run-induced conditions read as app facts) | adjudication Rule 2.6 `pageerror` → `app_defect` → curriculum "bug" (hypothesis) |
| H07 (cuts by local constants) | learned-rules section cut at 5,000 chars |
| H08 (agent-facing prose not derived from code) | "PROVEN (n bugs)" claim (`SK/scenario-catalog.ts:114`) |
| H13 (coverage denominator has no owner) | coverage `enforce` would block on a disputed denominator |
| H16 / H18 (DEV time of value signals / DEV concurrency have no owner) | response oracle re-runs unbudgeted; DevLease shared mode, `maxParallel` |
| H22 / H26 ("cannot tell" collapses to a benign value) | oracle "measured nothing" indistinguishable from "measured fine" |
| H24 (reviewer finding has no typed owner) | reflector class derived by regex over reviewer correction text |

---

## G1. The learning layer (cross-run learning)

The owner's main interest. The whole `cross-run-learning` context (~1,650 lines, [C] §2.5) plus its delivery and its experiment switch.
Headline (**confirmed**): the rule loop has no producer (reflector off, distiller never built), no closing signal (promotion needs an
oracle score never produced), and no delivery to the agents that write tests. The two parts that do run (curriculum, process audit)
act on labels the run produces wrongly.

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 1.1 | Reflector (`qa-reflector`, the only rule producer) | off-by-default | `QA_REFLECTOR_ENABLED` default false (`src/settings/registry.ts:74`; `src/server/reflector-switch.ts:14-19`; `REF:762`); not wired when off (`REF:1466`); retrieval policy `reflectorUnproven: reflectorEnabled` (`REF:1032`) | live unset; 0 reflector turns and `reflection` NULL in 30/30 outcomes; input = 6 of 48 gate-signal fields (`RF/outcome-assembly.ts:134-156`), no error text, spec, diff or DOM; output stored unchecked (`reflector-port.adapter.ts:114-157`); keys on `errorClass` or regex over reviewer corrections (`:136-143`, `distill-rule.ts:69-97`); prompt asks for rules "general enough to apply across apps" (`:77`); prompt file `agents/agent/qa-reflector.md` unchanged since 2026-06-14, still names the deleted generator role (`0aafe807`); `updateRunOutcomeReflection` backfill (`learning.repository.ts:182`) only it calls; 993 repo commits since the disable, 4 on the reflector; tests pass (347 incl.) | `0674bb8a` 2026-10-12: "invented a cause from a false-positive gate signal"; rule told a shell-less author to run `tsc`. [S] hypothesis: ~11 of 30 outcomes would reach it today, ~10 with disputed labels (H10, H01) |
| 1.2 | Deterministic distiller | dead-code (never built) | governance reserves `DETERMINISTIC_RULE_SOURCE_PREFIX = "distiller:"` (`CRL/domain/rule-governance.service.ts:10-14`); no producer | `git log -S'distiller:'` = only `cf640922`; only writer path `historyLearningStore.upsert` (`REF:345-356`) via `SqliteLearningRepository.save` (`sqlite-learning-repository.adapter.ts:45-47`) from the reflector; comments still describe one (`learning.repository.ts:249-251,283-288`; the "distiller" there is the dedup helper `decideDistill`, `distill-rule.ts:48-57`); legacy distiller deleted `33082dc9` | `cf640922` 2026-10-12: let a distiller's candidates keep normal governance while the reflector is off |
| 1.3 | Rule ledger, governance, retrieval, injection (incl. exploration slots, ledger-heal `noise-rule`, 5,000-char cap) | inert | no producer, so nothing to retrieve (`RF/phases/ground.steps.ts:54-64`) | `learning_rules` 0 rows for all 5 apps (DB and `GET /api/apps/<app>/intelligence`); `rules_retrieved` `[]` 30/30; `retrieve(sha)` ignores the sha (`sqlite-learning-repository.adapter.ts:49`); scope is the app only (`learning-repository.ts:5-22`, key `learning.repository.ts:186-205`), no repo/route/file/commit anchor; `lastVerified` = last fold time (`:279`); exploration slots (`rule-governance.service.ts:50,96-101`); noise-rule needs usage ≥3 (`process-audit.ts:150-164`); cap `DEFAULT_RULES_CHAR_BUDGET = 5000` (`learning-port.adapter.ts:15,63-79`, H07); a candidate has no demotion path (`rule-fold.ts:24-36`); data dir recreated 2026-10-26, so the ledger existed only with the reflector off | skeleton from June (`fa5d7496`) and July (`a6a78e47`, `8bfe05e5`, `d69cb868`) |
| 1.4 | Rule promotion via the response oracle, and prevention credit | inert | `oracleOutcomeCount < 1 → candidate` (`rule-fold.ts:25-30`); the count rises only when `valueScore !== null` (`fold-run-outcome.use-case.ts:48-52`) | `valueScore` null 30/30 outcomes, scorecard `measuredRuns 0` of 23; the measured bundle-mutation kill rate (0.33, 0.33, 0 on `mvs2ukug`, `mvs49h5y`, `mvqy1s7l`) never reaches the fold; prevention credit 0.6 to every attributable rule on a run with no class (`rule-fold.ts:39-46`), self-described as not objective (`:15`); same stuck state diagnosed in `ecdbffd0` 2026-06-10 and reintroduced by the P6.3 narrowing `8c574a7d` 2026-10-26 | `8bfe05e5` 2026-07-07 anti-Goodhart gate |
| 1.5 | Oracle scorecard | inert | written on every fold with null fields (`fold-run-outcome.use-case.ts:18-29`) | name-webapp 23 entries, `valueScore`/`mutantCount`/`killedCount` null; `GET /api/apps/name-webapp/trends` `measured: false`; duplicates the per-run graders | none recorded |
| 1.6 | Learned-rule delivery to the roles that write tests | partially-wired | rendered in the generator registry (`generator-sections.ts:712-719`, no `!planningTurn` guard, `generator-context.ts:140`) = the lead's plan turn and run-level author turns (`generation-turns.adapter.ts:156,176`); author sidekick briefs exclude it (`coordination-context.ts:1`) | live: in `mvs49h5y` the lead's round-0 prompt holds the exemplars section, 0 of 8 author turns do; every generating e2e run is coordinated | `dd176520` 2026-09-16 (coordination the only mode), `cd50d26b` 2026-10-26 (lead stops authoring alone); none recorded |
| 1.7 | Reviewer "reject-on-sight" rules | partially-wired | active rules rendered as REJECT (`render-learned-rules.ts:36-49`, `reviewer-sections.ts:83-85,308-312`) | the finding filter has no rule citation kind (`review-finding-filter.service.ts:16,79-145`), so such a rejection is uncited, against the evidence-bound review | none recorded |
| 1.8 | Curriculum learned credit (`caughtRealBug`, "PROVEN (n bugs)") | other (active, mislearning) | on unless frozen or `grounding.curriculum=false` (`REF:1508`); fold ungated (`RF/decided-end.ts:388-399`) | "bug" only from `app_defect` (`curriculum.ts:74-83`); credit to every offered archetype (`:85-113`); proven ranked first (`:119-135`); offered to the lead only (`ground.steps.ts:72-80`, `curriculum-model.ts:11`); live: `empty-state`, `boundary-value` evaluated 17 credited 9 (identical), `re-query-after-mutation` 10/6, all `caughtRealBug`, `promotionCount 1`, set by #26 (test-side failure: `aria-disabled` click, spec never passed `run_spec`, fix loop 0 rounds; T02, T07, T49); 31/32 runs are one sha `ed28973`, so replicates count as independent evidence; section reason "restored in 8379da09 to give its module a caller, no observed failure behind it" (`generator-sections.ts:678`); "Skill exemplars and learned rules: unused" over 56 runs (`docs/observability-context.md:244`) | origin `8d508042` (June); 7 commits since 10-12, 0 feat/fix |
| 1.9 | Archetype keyword detector as the learning key | other (active) | keyword regex over the raw diff (`SK/structural-pattern.ts:4-74`, e.g. `:55` `list|table|…`, `:58` `empty|no results|…`) | used for rule archetype, retrieval bias (`ground.steps.ts:37-45`), fold attribution (`rule-fold.ts:70-74`) and curriculum offer; does not read the change map, code graph or use cases (pillar: adapt from signals that read the flow); selectivity not measurable (no rules) | none recorded |
| 1.10 | Process audit: observe streaks and context-heal | other (live) | runs when the class teaches or is an observed operating class (`RF/decided-end.ts:419`, `RF/finalize-run.ts:264`); off under the freeze | context-heal marks the map stale and the next run rebuilds it (`REF:785-799`) — works; `recurring-test-failure` (`process-audit.ts:139-147`) fired on `E-COVERAGE-GAP` streaks of accepted passes (audits 2026-10-26T20:26:54Z, 2026-10-27T07:30:40Z; H10) and advises "needs rule promotion (oracle)", a path that cannot fire; `E-STEP-BUDGET` observe-only (`:23-24`) | June |
| 1.11 | Process audit: `recurring-dev-not-rendered` | inert (missing producer) | reads `adjudication` from stored outcomes (`process-audit.ts:77-80`); `run_outcomes` has no such column (`migrations/0001-initial.ts:80-92`), the mapper drops it (`learning.repository.ts:146-161`), E-PRECONDITION runs are not audited (`finalize-run.ts:264`) | tests bypass the store (`process-audit.test.ts:92,108`) (H02) | `e5f74d73` |
| 1.12 | Process audit Layer-2 diagnosis | dead-code (never built) | `ProcessFinding.diagnosis` has no producer (`process-audit.ts:15`) | `REF:1486-1489` "deferred — see process-audit.ts's own SCOPE NOTE"; no SCOPE NOTE exists (rg) | June, "deferred" |
| 1.13 | Quarantine + ledger CLI (veto/restore/release) | inert | operator-only; nothing to act on with 0 rules | `CRL/application/quarantine-learned-rules.use-case.ts`, `scripts/learning-quarantine.ts`, `src/qa/learning/ledger-cli.ts:20-44` | `0674bb8a` 2026-10-12 (safety valve after the incident) |
| 1.14 | Learning gates | other (live) | one owner of "what may teach" (`CRL/domain/learning-gates.ts:8,38-45`) | `E-STEP-BUDGET` teaches (absent from `NON_LEARNING`) while the audit treats it as observe-only "never an engine fix" (`process-audit.ts:23-24`); inputs inherit H01/H10 | — |
| 1.15 | Campaign freeze | experiment-only | `QA_CAMPAIGN_FREEZE` default false (`registry.ts:107`; `campaign-freeze.ts:11-16`; `REF:760,1459,1466,1476,1508,1526`); exposed empty in `docker-compose.override.yml:60` | off in 32/32 runs, 29 of them campaign-tagged (`t7-*`, `validation-*`); curriculum state crossed replicates (cycle 2/3 lead prompts differ from cycle 1 by the PROVEN marker); `docs/efficiency-benchmark.md:399` names this risk; the suite-store isolation digest does not cover the curriculum; 0 commits since | `cc43025e` 2026-10-12: keep learning out of A/B campaigns |
| 1.16 | Learning twins | dead-code | duplicate definitions outside the engine | `CRL/domain/distill-rule.ts:69-97` vs `SK/error-class.ts:50-79`; `src/qa/learning/learning-rule.ts:6-32` vs `CRL/domain/learning-repository.ts:5-22`; `src/types.ts:299` vs `CRL/domain/learning-repository.ts:24`; `CRL/domain/learning.ts:7-10` vs `rule-governance.service.ts:30-33`; SQL-ranked list `learning.repository.ts:72`; shim `src/qa/learning/curriculum.ts`; `stub-learning-repository.adapter.ts:1` "The v1 wiring: learning is OFF-PATH" | step 1 of the approved order |
| 1.17 | Agent memory (engram) | removed-but-referenced | removed `21e69a91` 2026-10-24 | residue: telemetry bucket `generation/domain/tool-call-taxonomy.ts:102-106` | "held what the agent believed, with no SHA, no expiry and no check against DEV" — the design rule for any future lesson |

What the layer does **not** learn from, though the orchestrator verifies these every run ([L] §5): route-availability classes
(`route-availability-classifier.ts:151`), data contradictions (`expectation-gaps.ts:111`), DEV-state unmet backed by the orchestrator's
reads (`explore-verification.ts:92`), plan drops contradicted by facts (`SK/coordination.ts:102`), authoring-failure classes
(`authoring-failure.ts:26`), verified review citations and rebuttals (`review-finding-filter.service.ts:79`, `review-rebuttals.service.ts:93`),
`run_spec` outcomes per flow, survivors' `moved` observables, flaky-triage classes, the accepted suite's objectives, the context map.
Scope fact (**confirmed**): the ledger key is the app, and an app with `services[]` (name-webapp, 5 services) is one product across
repos, which matches the owner's "one server, one product, several repositories"; nothing records which repo or service a rule concerns.

Sweep recommendations (inputs, hypotheses): keep the skeleton (gates, ledger, governance, quarantine, veto, audit observe and
context-heal); discard the reflector as built, prevention credit, scorecard, reviewer reject-on-sight, the curriculum's learned credit
(or freeze it), the keyword archetype as key, the twins and the dead distiller branch (or fill it with a real one); build a
deterministic producer from typed, scoped, commit-anchored orchestrator facts, delivered in the author sidekick brief and measured by
scoped outcomes (`run_spec` calls-to-green, kills on the lesson's scope), only after the H10, H01, H03 and H02 slices. Turn the
campaign freeze on for experiments.

## G2. Objective-signal value oracle and enforce gates

The value signals and the gates that would turn them into blocks. Coupled: promotion (G1.4), coverage `enforce` and fault calibration
all wait on the response oracle's score.

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 2.1 | Response value oracle (e2e fault injection) | inert | on by config: `qa.valueOracle` (`schemas.ts:257`), resolver `schemas.ts:440-445`; wired `REF:988-993`; aim `fault-aim.ts:30-46`, adapter `fault-injection-oracle.adapter.ts:18-61` | `valueOracle: signal` on name-webapp, jhipster-store, petclinic (off on portfolio); `valueScore` null 30/30 outcomes, scorecard 0/23 measured, trends `series: []`, report "not measured this run"; which `notMeasured` branch fires is not persisted (no `oracle` key in `attribute-registry.ts`, info log not shipped): **not enough evidence** ([C] hypothesis: no `operation` entry point in reach); schema comment `schemas.ts:253-256` still says "off (default) … opt-in"; re-runs unbudgeted (H16) | shadow-aware default `ecdbffd0` 2026-06-10; narrowed to operations the change reaches `8c574a7d`, `1d6f77b9`, `c4c8eaca` 2026-10-26 (P6.3, owner P6 L7: no global fallback); calibration `f8c86816` |
| 2.2 | Fault calibration and per-candidate value (`npm run fault-calibrate`, `valueByCandidate`, `valueStats`) | inert | consumes the oracle's per-candidate scores | `scripts/fault-calibration.ts`; nothing to calibrate while 2.1 scores nothing; the coverage `enforce` move waits on its S3 calibration | P6 S3 |
| 2.3 | Bundle mutation tied to the `valueOracle` switch | off-by-default (for shadow apps) | the same flag switches bundle mutation (`REF:999`); default `off` when `shadow` | the one value signal that measures: `bundleMutation` on 17/30 outcomes, `mutation_kill_rate` graded; a new app onboarded in shadow without an explicit `valueOracle` gets neither signal | `ecdbffd0` |
| 2.4 | Change-coverage `enforce` | off-by-default | `qa.changeCoverage.mode` default `signal` (`schemas.ts:229-238`; `REF:707`; `effective-config.ts:46`; `cli.ts:268`); blocking in `decide-coverage.service.ts:31` | no app sets `enforce`; coverage is measured on name-webapp (0.15, 0.74, 0.90 in the evaluations read); `E-COVERAGE-GAP` uses a hard-coded 0.7, not the app's `minRatio` (`RF/outcome-assembly.ts:18`, H10); denominator disputed (H13); `branchCases: regenerate` (default) already gives one gap regeneration per green diff run | owner decision P6 L7 2026-10-25 (`docs/architecture-remediation.md:354`): "none until a local-frontend run with source maps measures coverage in 3 replicates and the S3 calibration passes" |
| 2.5 | Intent lock `enforce` | off-by-default | `app.qa.intentLock?.mode ?? "signal"` (`REF:708`); forced off when `reviewLoopIntegrity` is false (`run-services.ts:55-57`) | no app sets it; DB: `opacityHigh` true in 23/23 outcomes that recorded intent, 5 would-rejects, 7 violations in 30 outcomes: the extractor cannot read most clauses on the live app | `129949c4` 2026-10-22: switch default on, lock stays signal |

## G3. LLM judges and evaluation calibration

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 3.1 | LLM judges and the `qa-judge` role (incl. `npm run judge-calibrate`) | staged | `QA_JUDGES_ENABLED` default false (`registry.ts:151`; `judge-settings.ts:25-27`; `wire-app.ts:142`); role absent from `agents/opencode.json`, block parked in `agents/pending/qa-judge.opencode-block.json`; `judge-settings.ts:61-70` refuses ("declares no qa-judge role", and a judge on the author's or lead's model) | live unset; `judge_attempts`/`judge_calibrations`/judge `run_scores` 0/0/0 against 1,385 deterministic scores; campaign runs or regrades only (`judges-composition.ts:4`); scores `spec_relevance`, `failure_root_cause`, `use_case_coverage`, inert to verdicts (`judges.ts:21`, `judge-service.ts:1-11`); staging condition "a second model" met since 2026-10-26 13:37 (`2f99a052`, `cd4fb3c2`, `fe1f1a34`: lead, author, reviewer on three models), five hours after P4 L22 (`cfbceaea` 08:09) logged it; parked block stale (names `qa-generator`, Serena keys, deprecated `maxSteps`; last touched `21e69a91`); judge code maintained (15 commits since 10-18, 4 feat/fix), tests pass | `61d39363`, `d65e192d` 2026-10-18; P4.6 (`docs/architecture-remediation.md:349,432`) "until a second model is available"; activation steps `docs/observability-design.md:1370-1382` |
| 3.2 | Langfuse score sink and human labels | off-by-default | `LANGFUSE_*` unset (`registry.ts:137-140`); `docker-compose.langfuse.yml` is a separate, not running stack | judge calibration needs human labels through `npm run langfuse:labels`; without them the judges stay `experimental` by design | optional profile, 2026-10-17/18 |
| 3.3 | OpenCode OTel "Option A" | staged | deferred in the design | `docs/observability-design.md:513-518` (S0.5 spikes unproven) | 2026-10-17/18 |

## G4. Self-maintainer and the self-repair loop

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 4.1 | `qa-maintainer` (incident-triggered fix PRs on this repo) | other (live; output lost or unmerged) | armed: any pending incident while idle triggers it (`health-poller.ts:44-58`; `wire-app.ts:360-369,399,470-473`; `maintainer-runtime.ts:132`); incident sources include warn-level health checks and `runner.ts:693,843` | 4 local branches on 2026-10-27 in `/app/.mirrors/qayaba-self` (`qa/maintainer-mvr5xwm0`, `-mvrbe1lx`, `-mvrbhwj9`, 1 commit each) about the orphan-session sweep the owner fixed by hand (`93ee3941`), none on GitHub; its own branch title "stop paging the maintainer for routine orphan-session sweeps"; push refused 403 from shadow runs (T40, Loki C06: #24, #26); 18 older remote `qa/maintainer-*` branches; PRs #19-#23 open since 2026-06-23..07-02; incidents in memory, lost on restart (`/api/maintainer/status` idle, 0); spends the shared OpenCode quota; 102 commits since June (55 feat/fix) | June 2026 |
| 4.2 | Auto-merge and canary hot-swap (`SELF_MAINTAINER_AUTOMERGE`, `merge-guard.ts`) | off-by-default | `registry.ts:147` default false; read at `wire-app.ts:176` | live unset | `9707a11f` / `db8bd730` 2026-06-08: opt-in, needs branch protection |
| 4.3 | Process-audit `engine-fix` → incident | partially-wired | 3 consecutive `E-STATIC` (`process-audit.ts:131-138`) → `REF:1482` → in-memory incident (`src/server/maintainer.ts:41-58`) | lost on restart; feeds lossy classes (H10) into an LLM maintainer whose push 403s | June |

## G5. Lead and sidekick optional capabilities

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 5.1 | `qa-explore` (lead-requested exploration before the plan) | partially-wired (granted, never used) | no switch; the lead may ask once (≤3 questions) and never does | 0 explore turns in 32 runs; 0 of 243 coordination events mention exploration; `mvs49h5y` turns have none; verification code `coordination/application/explore-verification.ts:92`; stale `qa.explorer: true` (the v1 switch) in the operator YAMLs of two apps, silently stripped by the non-strict schema, while `docs/architecture-remediation.md:135` says "No `qa.explorer` config or code remains" | v1 removed `01b668e1` 2026-10-25 ("no run used the explorer unless it asked for one"); re-added as `qa-explore` `cbcc6b84` 2026-10-26 |
| 5.2 | Escalated model for a lead `replace` | partially-wired | `COORDINATION_ESCALATED_MODEL` unset (`registry.ts:71`); `REF:1069-1070` → `resolve-sidekick-model.ts:5-10`; `lead-sidekicks.ts:667,916` | 5 live `replace` decisions ran on the same model: a fresh session only | since `dd176520` 2026-09-16; none recorded |

## G6. Parallel DEV access

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 6.1 | DevLease read-only shared mode | staged | production builds `new DevLease()` without `readOnlyEnforced` (`REF:366-371`; `dev-lease.ts:1-13,18,28-29,102`) | every DEV action is exclusive, so `qa.coordination.maxParallel 3` (`SK/coordination.ts:54-58`) serializes on DEV (H18) | `1415e8a7` 2026-10-12: the proxy has no read-only mode; 1 commit since |
| 6.2 | Multi-account pool (`auth.accounts`) | staged (off-tree) | code only on branches `feat/parallel-runs-v2`, `pr2/accounts`, `pr2/integrate` (`f0902f88` 2026-10-27), not in HEAD | one operator YAML declares it; zod strips it silently (probe: parse succeeds, `auth.accounts kept: false`), so the second account is dropped without a word | 2026-10-27 "lease one test account per run from an optional per-app pool" |

## G7. Run triggers, modes and targets never exercised live

DB window 2026-10-26..28 (the history before is gone): 32 runs, all name-webapp; `diff` 29, `manual` 2 (login bootstrap), `context` 1.

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 7.1 | Deploy gate (wait until DEV serves the SHA) | inert | `dev.versionUrl` absent → always-ready gate (`build-run-orchestration.ts:25`; `REF:1421-1430`) | `versionUrl: ""` for every app in `GET /api/apps`; `dev.deployTimeoutMs: 300000` in the YAML is inert; campaigns replay `ed28973` against today's DEV, so outcomes (and anything learned) may describe another version | not recorded (per-app config) |
| 7.2 | Service-triggered cross-repo runs (`triggerService`) | other (never exercised) | needs a service repo's post-deploy webhook (`REF:780-800`) | 0 runs; name-webapp declares 5 services; the topology itself is live in grounding (`grounding.stitcher: "signal"`); change-coverage is `unknown` for these runs | — |
| 7.3 | `complete` and `exhaustive` modes | other (never exercised) | chosen per run (`--mode`) | 0 runs; differ only in task wording and budget rows (`task-builders.ts:134,169-180,324-334`, `review-render.ts:27`, `run-time-budget.ts:10`); tasks still tell the agent to use Serena (`task-builders.ts:175`); hypothesis: untested since the coordination rewrite | — |
| 7.4 | `code` target with the Stryker mutation oracle (the `qayaba` self app) | other (never exercised) | the self app's operator YAML sets `code: true`, `shadow: false`, `onFailure: github-issue` | 0 code runs; `StrykerMutationOracleAdapter` JS/TS only, Java "not available" (`stryker-mutation-oracle.adapter.ts:149-284`); ecosystem detection `code-execution.runner.ts`; the first code run would publish against this repository | — |

## G8. Dead code, kill-switch paths and residue of removed features

Step 1 of the approved order (delete twins and dead code). The learning twins are in G1.16, the stale judge block in G3.1, the stale
`valueOracle` comment in G2.1, the stale `qa.explorer` key in G5.1.

| # | Member | Kind | How disabled / inert | Key evidence | When / why |
|---|---|---|---|---|---|
| 8.1 | Unreachable production modules | dead-code | no entry point reaches them (dependency-cruiser reachability from `src/index.ts`, `src/cli.ts`, every `package.json` script, `agents/tool/*`) | `app-catalog/application/ports/repo-info.port.ts`; `change-analysis/application/ports/symbol-extractor.port.ts` with `complexity-`, `pattern-`, `relation-`, `semantic-diff-extractor.port.ts` and `change-analysis/domain/static-signal.ts`, `vcs-read.ts` (an extractor family the code graph replaced, hypothesis); `generation/application/ports/plan-parser.port.ts`, `dom-grounding.port.ts`; `test-execution/application/ports/code-validate.port.ts`; `qa-engine/src/index.ts` ("public entry is unused") | mostly one-method ports left by `a4400060` ("one port per file") |
| 8.2 | Inert composition seams | inert | `EngineRootDeps.prChangedFiles` never set (`engine-root.ts:216,422`; fallback `pre-generation-grounding-port.adapter.ts:420`); static `EngineRootDeps.contextMap` never set (`engine-root.ts:212,420`; the map arrives via `loadContextMap`, `REF:1138-1148`) | — | — |
| 8.3 | `reviewLoopIntegrity: false` (pre-switch review flow) | experiment-only | `qa.reviewLoopIntegrity` default true in the shell (`REF:1049`), engine fallback false (`run-qa.use-case.ts:64`); false forces the intent lock off (`run-services.ts:57`) | no app sets it | `129949c4` 2026-10-22: kill switch for the review-loop slice |
| 8.4 | Silent stripping of unknown app-config keys | other (defect that hides removed and staged config) | non-strict `z.object` in `src/orchestrator/schemas.ts`; only `qa.structuralSignals` is `.strict()` (`:266`) | probe: parse succeeds and drops `qa.explorer` and `auth.accounts` (G5.1, G6.2); stale `config/apps/example.yaml:41-42` says the loader ignores `boundaries` (it is live) | — |
| 8.5 | Retired runtime selectors | removed-but-referenced | `AGENT_RUNTIME_MODE`, `AGENT_SINGLE_PROVIDER`, `AGENT_{PRIMARY,REVIEWER,CHAT}_PROVIDER` warn when set (`src/agent-runtime/config.ts:56-68`) | benign warning list | Codex and dual mode removed `58a08e6c`, `a7b2b01e`, `17b869da`, `e3861da1` 2026-10-26 |
| 8.6 | Prose and field residue with no feature behind it | removed-but-referenced | — | `docs/observability-design.md:3` "Status: … No code yet" (implemented); `src/server/persistence/telemetry-analysis.query.ts:184` `avgCorrectionsRound1: null` "deferred"; judge-settings test name "the generator's model"; `npm run previous-forms:check` cannot catch prose, prompt or JSON residue | — |
| 8.7 | Test support in production folders; API routes with no first-party client | other | placement | `src/telemetry/trace-harness.ts`, `src/server/web-console/console-harness.ts`, `src/integrations/fixtures/opencode-roster.ts`, `src/no-console.scan.ts`; `GET /apps/:name/telemetry` and `GET /telemetry/health` have no caller in `web/public/js/api.js` or `client/` | — |
| 8.8 | Removed with a stated decision (completeness) | other (removed cleanly) | — | `980f362f` 09-27 `parallelDiff`/`sessionContinuity`/`specTriage` (schema-only, never read); `b4b15caf`, `ada9a23c` 10-12 parallel worker path, file-count router; `9ef2f79b` 10-12 `QA_PRESERVE_UNTRACKED_SUITE`; `21e69a91` 10-24 engram memory (G1.17); `01b668e1` 10-25 explorer v1 (G5.1); `56f717a1` 10-25 single coordination mode; `dcff6a7c` 10-25 codebase-memory-mcp; `15e8e7a4` 10-26 structural and dossier levers; `8033f2b8`, `48ed0335`, `fe1bdff7`, `bfdcac94` 10-26 engine selector, dead contexts, escalation policy, planner leftovers | each with a stated reason; residue only in prompts and comments |

---

## Not features: switches that are correct operating configuration

| Switch | Live value | Why it is not a dormant feature |
|---|---|---|
| `qa.shadow: true` (all 4 e2e apps) | on | The owner's rollout choice ("initial rollout", `example.yaml`); publication code exists and is wired. Side facts for the reviewers: the PR/auto-merge/Issue path has not run against a real repo in the DB window (25/32 notes "shadow … would: pr/issue"), and the shadow log keeps only `body-length` of the would-be PR/Issue at info without `ship` (`shadow-log.adapter.ts:8,12`; H02) — a visibility defect in an active feature. |
| `QA_TELEMETRY_MAX_CAPTURE=full`, per-run `captureMode` | full | Capture level; the owner's rule for campaigns (default `metadata`). |
| `WEBHOOK_ALLOW_UNSIGNED=true` without `WEBHOOK_SECRET`; `QA_WEB_AUTO_LOGIN=true` (`docker-compose.override.yml:41`) | relaxed | Local single-operator deployment settings; a production-hardening item, not a dormant capability. |
| `QA_EXEC_SANDBOX=required`, `QA_EGRESS_MODE=enforce`, `CODE_SANDBOX` | strict | Security boundary at its strict default; nothing disabled. |
| `e2e.specCredentials: none` | default | Security opt-in by design (only the `login` profile carries the account). |
| `AGENT_ALLOW_PROJECT_CONFIG` unset (`docker-compose.yml:212`) | off | Off is the security invariant ("a watched repo cannot configure the agent"); on exists only for the baseline experiment arm. |
| `qa.domPack`, per-run overrides `closedLoop`, `agentBrowser`, `grounding.{stitcher,curriculum,domPack}` | on | A/B levers whose default is on; they decide no default (`effective-config.ts:39-74`). |
| x5 time experiment: `qa.coordination.planBudgetMs 900000`, `flowBudgetMs 2400000`, `closedLoop.perCallMs 600000`, `dev.deployTimeoutMs` | set in the YAML | Operating experiment, not a dormant feature; it masks the defaults (11 runs exceeded a default plan/flow budget, taxonomy, family F-E, H14). |
| `QA_DIFF_TIME_BUDGET_MS_*`, `QA_RUN_TIME_BUDGET_MS_*` empty; `iterationBudget`, `wallClockBudgetMs` unset | defaults | Tuning knobs at their defaults; the deadline table is live. |
| `AGENT_*_MODEL` unset | defaults | Each role runs its `agents/opencode.json` model; operating configuration. |
| `qa.changeCoverage.branchCases: regenerate`, `qa.fixLoop.maxRetries 2`, `qa.closedLoop`, `qa.agentBrowser`, `qa.reviewLoopIntegrity: true`, code-graph tools | on | Active features at their defaults (620 agent-browser calls over the outcomes). |
| `qa.changeCoverage.mode` / `qa.intentLock.mode` = `signal` | signal | The signal itself is the live, correct mode; only the `enforce` half is a staged feature (G2.4, G2.5). |
| Serena MCP on for author, maintainer, proposer | on | Tool policy per role. |

## Gaps (not enough evidence)

- Why the response oracle returned null on every outcome: the `notMeasured` details string is not persisted; Loki and traces were not
  queried.
- Which adjudicator rule labelled #26 `app_defect` (not recorded).
- History before 2026-10-26 (the data directory was recreated): what the reflector produced before the reset cannot be checked; "never
  run" claims cover only the DB window.
- Who set `shadow: true` and when (gitignored user data).
- Whether the lead uses the exemplars or the PROVEN marker (no ablation).
- Symbol-level dead code beyond the learning context was not enumerated.
- `config/benchmarks/` and `.env.example` were not swept; `.env` was deliberately not read.

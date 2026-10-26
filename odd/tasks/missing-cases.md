# Missing cases: tests for every behaviour the change decides

Objective: make E2E generation cover the behaviours the changed code decides, not only its happy path, for any app. Three parts: (A) the generator prompt, (B) one regeneration from the branch arms no test ran, and (C) a reviewer that judges missing cases against that same objective list.
Branch: `main`, as the owner asked ("directo en esta rama"), one commit per task, no push without asking. Delivery: single branch (owner rule). Forecast: about 1 200 authored lines. Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S0** (any app, any model): rules are written in terms of what the changed code decides and what the page can be brought to through the UI against DEV. Nothing names an app, framework or model.
  - No network mocks, ever.
  - `DecideCoverageService` and the keystone (`unknown` never blocks) are unchanged.
  - The prompt-contract lint rules hold. The effort texts carry no digits and no directive or trust words.
  - The prompt baseline is raised only through `--allow-increase` with a reason.
- **S1** (A, prompt; owner: "Prompt de generación (E2E): que el techo cuente specs (flujos), no tests. Dentro del spec de cada flujo afectado, pedir un test por cada comportamiento que el cambio introduce: el camino feliz más cada estado de error, vacío o validación que el código cambiado decide"):
  - The diff-mode effort tiers bound **spec files** (one per flow), not tests.
  - The generator and sidekick static layers ask for one test per behaviour the changed code decides, inside the flow's spec:
    - the outcome when it succeeds;
    - each other state it handles (error, empty, rejected input, missing permission) that the page can be brought to through the UI against DEV.
  - A state the page cannot be brought to that way is not a case.
  - Mirrors live in `agent/`.
- **S2** (B, regeneration; owner: "pasarle al agente las ramas no recorridas como lista de casos que faltan, en una sola regeneración. Esto funcionaría también en modo `signal`"):
  - **Trigger.** After the first measurement of a green per-commit diff run, when the change has untaken arms on changed lines and `qa.changeCoverage.branchCases` is `regenerate` (the default), one regeneration receives those arms as the cases still missing.
  - **One regeneration per run.** When the enforce-mode coverage regeneration runs, it already carries the arms, and no second regeneration runs.
  - **Unreachable arms.** The turn may deliver nothing for an arm the page cannot be brought to through the UI.
  - **Acceptance.** Empty, rejected or capped turns keep the prior bytes and the first measurement, exactly as the coverage regeneration does. A spent run deadline keeps the first measurement.
  - **Order.** It runs before the review, so the reviewer judges its specs.
- **S3** (B, fresh arms):
  - **Recount.** After an accepted coverage or branch regeneration whose changed specs all executed, the change-coverage (ratio, uncovered lines, branches, untaken arms) is recounted from the dumps the run already holds: the first measurement's dumps minus those of the re-run spec files, plus the acceptance's dumps. This needs no new DEV execution and does not re-run the value oracle or the mutation pass.
  - **Proof reused.** When a changed spec did not execute (a reused proof), the arms are unknown and the reviewer receives none.
  - **Enforce final re-measure.** It also refreshes the uncovered lines and untaken arms.
  - **Record.** `gateSignals.branchCases` records what happened: the outcome, the arms before and the arms after.
- **S4** (C, reviewer; owner: "Reviewer: que también juzgue si falta un caso de los que el cambio decide, apoyándose en esa lista objetiva y no en su propia opinión"):
  - **Input.** The reviewer receives the current untaken arms (S3), when known.
  - **Finding.** It may emit a `missing-case` finding cited as `arm:<file>:<line>`. The orchestrator keeps it only when that arm is in the list.
  - **Advisory.** Such a finding is advisory. It never rejects the run and is never rebutted, because whether the page can reach an arm is not objectively provable.
  - **Record.** It is recorded with the review and shown in the published PR or Issue.
- **S5** (docs): `docs/agent-reference.md`, `AGENTS.md` (value/trust risk) and `config/apps/example.yaml` (`branchCases`) describe S1-S4.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1 | inline | done (RED→GREEN scope-guard; prompt-sync, matrix, generation + coordination suites 2321 green after the recorded baseline raise) | see git log |
| T2 | S3 recount port (collector over several namespaces, dump exclusion, `recount` on the port and its traced wrapper) | inline | done (RED→GREEN: dump names, reader filter, recollect, bridge recount, trace span; objective-signal 274 + orchestration infra 917 green, arch ok) | see git log |
| T3 | S2, S3 regeneration step, config key, gate signal, persistence | inline | done (RED→GREEN use-case tests: regen + recount + record, no regen without arms/off/unset/enforce-blocking, empty keeps first, no recount → armsAfter absent; orchestration + server 4010 green, 1 known base fail) | see git log |
| T4 | S4 | inline | done (RED→GREEN: takeMissingCases + arm guard, parser arm citation, reviewer section, use case records/publishes and never rejects, no arms after an unrecounted regen, PR/Issue render, adapter mapping; reviewer contract v6; broad suites 4716 green, 1 known base fail) | see git log |
| T5 | S5 | inline | pending | |

## Log

- **L1** (2026-10-26, owner, verbatim): "Aplica las 3, directo en esta rama. Antes de aplicar analiza bien y genera el plan de implementación robusto y de calidad". The three: (1) prompt, (2) branch regeneration, (3) reviewer.
- **L2** (2026-10-26, evidence): the generator prompt has no breadth instruction for E2E ("Include edge cases" exists only for `--target code`, `prompts.ts:368`). The diff tiers cap the work ("at most one or two focused specs", "one focused spec per affected flow"), and the reviewer judges false positives, never missing cases. The untaken arms reach the agent only in the enforce-mode coverage regeneration.
- **L3** (design decision, S4): missing-case findings are advisory, not blocking.
  - Blocking would need a rebuttal for "the page cannot reach this arm" (defensive code, a server error that cannot be forced without mocks). Any accepted rebuttal would let the generator dismiss every arm, and refusing all of them would block PRs on unreachable code.
  - (B) already spends the one regeneration on those arms. The reviewer's role is the judged, visible list of what is still missing.
- **L4** (design decision, S3): arms are recounted from dumps already on disk, not with a new whole-suite run. Without the recount, the reviewer would see the pre-regeneration arms and ask for cases just written. The base namespace's dumps of re-run spec files are excluded by their name prefix (the rule `specFilesOf` already uses), so a rewritten spec's old tests do not count.
- **L5** (explorer findings):
  - The YAML key is `qa.changeCoverage`.
  - The acceptance cap (`MAX_ACCEPTANCE_EXECUTIONS = 4`) is shared, so the branch regeneration takes one from the review rounds.
  - `renderCoverageGap([])` returns a sentence, not `""`, so an arms-only gap must not include it.
  - The enforce re-measure leaves `uncovered` and `untakenArms` stale (fixed in S3).
- **L6** (2026-10-26, T3): the branch regeneration reuses the coverage regeneration's acceptance and lead routing (one `regenerateAtGap`). The engine default is off when a caller states nothing; real apps get `regenerate` from the factory (`qa.changeCoverage.branchCases`). The regeneration's gap framing now covers arms-only gaps and says an arm the UI cannot reach is not a case. The prompt baseline was raised with that reason. Stale `scripts/mutate.ts` lines for `coverage.steps.ts`/`review.steps.ts` were resynced by content.
- **L7** (2026-10-26, T4): missing cases are taken out of the reviewer's findings before the evidence filter, whatever the integrity switch, so an arm citation can never block. A rejection that rested only on arm-cited blocking findings becomes an approval. The arms reach the reviewer only while they describe the bytes under review (not after a review-round regeneration). The reviewer contract version is 6.

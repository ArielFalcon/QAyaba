# Persistent test problems

Objective: close the problems that survived the no-stubs and fact-based-defects change, each fixed at the owner of the concept it belongs to (no second implementation of a rule, no second source of truth).
Branch: `worktree-agent-aa4282239b93783b2`. Delivery: ask-on-risk (single branch, no PR split). Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24). Base: e7adef68.

## Specs

- **S1** (owner, verbatim): "Asegúrate de que la solución encaje bien con la arqueta hexagonal y DDD respetando lo que ya existe sin duplicar lógica, darle responsabilidad equivocada a una clase o generar dos fuentes de verdad."
- **S2** (fix 1, proof conflict): when every failed file has a green `run_spec` proof on its current bytes, the existing triage stage re-reads once, whatever the failure class (trigger `proof-conflict`), inside the single re-read budget (`spendExecution`, `allowanceMs`). The re-read passes: the existing flaky path. It fails: adjudication and regeneration as the other rules allow. The regeneration stays retired only when the re-read agrees with the proof. `gateSignals.closedLoop.conflicts` records the conflict.
- **S3** (fix 2, mutant selection): the targeted phase of `select-mutants.ts` spreads across files the way the second phase does, with the one round-robin that exists; the skipped sites (file:line and reason) are recorded in `bundleMutation.skippedSites`; the survivor closure's kills are their own figure and `mutation_kill_rate` stays first-pass.
- **S4** (fix 3, moved signal): requests are compared by shape (digit runs in a pathname segment collapsed) where the observed request key is defined, so ids, tiles and pagination are not "moved"; a different endpoint or a different non-numeric id still is.
- **S5** (fix 4, live-value pins): the ambient-data-state detector (same pin record, same `ambient` citation, same single gap regeneration) also flags a passing case whose as-loaded assertions hold a literal whose whole number equals the read result count (> 0) of the page they ran on.
- **S6** (fix 5, contradiction facts reach flows): a flow brief (and the lead) receives the run's contradiction and defect facts when the flow's pages or seed files reach the fact's call site or read sites, by the existing reach and seed definitions. The section states the rule: a candidate whose only reachable state is the defect is dropped with `needs-unavailable-state`, and the engine reports the defect.
- **S7** (fix 6, verified citations): a verified `contradiction` or `ambient` citation is a blocking correction routed through the existing correction path, whatever severity the reviewer gave.
- **S8** (fix 7, lead criteria): a criterion that asks for the defective state or a live count is caught by the engine rules of S5-S7; prompt text only where a section's declared `reason` justifies it, through the section registries.
- **S9** (fix 8): `String(p.error)` of an OpenCode session error object no longer prints `[object Object]`; its name and `data.message` render through the existing redaction and bounding.
- **S10** (fix 9, open questions): the ~48 s fixed cost of each mutant and closure re-run is traced to its source and fixed only if it is a contained qayaba defect; whether `map.component.ts:260`-type equivalent mutants need handling (no app-specific rule). Decisions and evidence recorded in the Log.
- **S11** (RFC-0017 Q2, owner: "Respecto a las preguntas abiertas estoy de acuerdo con las recomendaciones"): a `provider-declared-absent` field the provider contract marks required is also a defect, if the contract reader can carry required-ness through `ProviderContract` and the response-fields path; otherwise the reason is recorded.
- **S12** (RFC-0017 Q4 changed): a verified defect opens its Issue whatever the execution verdict: a flaky run is still quarantined for its flaky case and the defect is reported; a declared no-op still reports the defect.
- **S13** (RFC-0017 Q7 changed): `defect_found` counts verified facts only (verified defects and failures the adjudicator classified as an app defect from a fact), which needs the adjudication persisted on the run record first (existing persistence and record path, schema migration by the repository convention, stored runs stay readable); `GRADER_VERSION` bumps.
- **S14** (RFC-0017 Q1, Q3, Q5, Q6 kept; ADR-0025): `route.abort()` and `route.continue()` stay refused, no exception.
- **S15** (owner, verbatim: "Respecto a las otras decisiones acepto las recomendaciones y las preguntas abiertas solucionarlas como entiendas"): RFC-0017 "Owner decisions" and the AGENTS.md rows are updated in the same commits as the code.
- **Out of scope:** problem B (the lead plan's malformed or cut JSON, contract repair of agent answers, `last-json-object.ts`, the plan re-ask).

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T0 | S1, S15 | inline | this document | |
| T1 | S2 | inline | pending | |
| T2 | S3 | inline | pending | |
| T3 | S4 | inline | pending | |
| T4 | S5 | inline | pending | |
| T5 | S6, S8 | inline | pending | |
| T6 | S7 | inline | pending | |
| T7 | S9 | inline | pending | |
| T8 | S13 (persist the adjudication) | inline | pending | |
| T9 | S12 | inline | pending | |
| T10 | S13 (grader), S11 | inline | pending | |
| T11 | S10 | inline | pending | |

## Log

- **L1** (2026-11-01, owner and parent agent, verbatim where quoted): S1 as quoted in Specs. Concretely: "before writing each piece, find the existing owner of that concept (bounded context, aggregate, domain service, port) and extend it; never add a second implementation of a rule that exists (e.g. reach = the causal label's `pageReach`/`requestReach`; the single gap regeneration; the existing triage re-read; the existing pin record and `ambient` citation; the review finding filter; the one JSON scanner); never compute the same fact in two places; domain code stays pure and receives what it needs through ports; pass the existing `npm run arch:check` rules. If a fix seems to need a new abstraction, justify it in the feature document against these rules first." Owner decisions applied: RFC-0017 Q1 provider-undeclared only (keep); Q2 follow-up (implement if the contract reader can carry required-ness, otherwise record why not); Q3 verdict `fail` (keep); Q4 CHANGED (a verified defect opens its Issue whatever the execution verdict; a flaky run is still quarantined for its flaky case and the defect is reported; a declared no-op still reports the defect); Q5 positive reach (keep); Q6 rule 3 demoted (keep); Q7 CHANGED (`defect_found` counts verified facts only; the adjudication is persisted on the run record first; `GRADER_VERSION` bumps). Keep refusing `route.abort()`/`route.continue()`. Owner, verbatim: "Respecto a las preguntas abiertas estoy de acuerdo con las recomendaciones" and "Respecto a las otras decisiones acepto las recomendaciones y las preguntas abiertas solucionarlas como entiendas".
- **L2** (2026-11-01): evidence from the investigations, per fix (verified again against the code before each task): run-ed28973-mvxd673z-3f761608 (proof conflict; same bytes red then green in one suite, about 58 s after a fresh login where a page read 0 results; `loopClosed` at `run-spec-capability.ts:256`; `fix-loop.steps.ts:245`; the triage re-read at `fix-loop.aggregate.ts` did not fire because packConflict needs every case on a grounded route and the absent-selector path takes only locator and timeout failures); `v8-branch-coverage.ts` and `select-mutants.ts` (same 3 sites of one directory every run while the change spans 31 files); `observed-difference.ts` (map tile requests whose pathname carries coordinates read as moved); `ambient-data-state.ts` and `page-data-read.ts` (as-loaded assertions flagged only on confirmed-empty pages; run-ed28973-mvxd673z-3f761608 `flows/list-to-detail.spec.ts` and run-ed28973-mvxbr8hz-82848d23 where the reviewer flagged RESULT_COUNT=4 as advisory); contradiction facts attached to /home and /restaurantes/madrid only while /search and /map read the same field; `review-finding-filter.service.ts` (a verified `contradiction` keeps the reviewer's severity, `ambient` is forced advisory); lead criteria "(DEV data: 4 results)" and "unavailable (as DEV renders now)"; `agent-activity.ts:114` `String(p.error)`.
- **L3** (2026-11-01): base e7adef68 (the worktree was created at an ancestor, fast-forwarded to main before any change). Route declaration: every task inline, no Writer trigger (units depend on each other and share the AGENTS.md, the grader and the record), no Mapping trigger (bounded reads and codegraph calls).

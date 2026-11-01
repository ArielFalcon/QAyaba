# No stubs, defects from verified facts

Objective: delivered specs cannot intercept requests (an engine refusal, not a prompt request), and a run is a defect from facts the engine verifies, not from the shape of an error string.
Branch: `worktree-agent-a0d1f9e6b8f0007a9`. Delivery: ask-on-risk (single branch, no PR split). Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S1** (problem 1, owner, verbatim): "Qayaba no debe poder hacer stubs, eso tapa errores."
- **S2** (problem 1): delivered specs can no longer stub. The syntax-tree detector becomes an engine refusal of the delivered spec, in the family of the refusal of skipped and `test.fail()` tests (`shared-kernel/case-proof.ts`: `refuseOutright`, `verdictAfterRefusal`, `modeRefusals`), and reaches the author as a typed correction it must act on (a failing refused case the fix loop, `run_spec` and the regeneration acceptance all read).
- **S3** (problem 1): the whole stubbed-test exception is removed: prompt sections and skills under `agents/`, the prompt registries, the `[stubbed: ...]` title convention, `gateSignals.stubbedState`, the `qayaba.stubbed_state` span, the PR/Issue section "Tested against a stated response, not DEV", `StubbedTest.fulfils` under data contradictions, `docs/stubbed-state.md`, the AGENTS.md "Stubbed tests" bullet and invariant, the reviewer's rules about stubbed tests. A stored run that carries the retired field stays readable. `npm run previous-forms:check` bans the retired form.
- **S4** (problem 1): the e2e seed's own infrastructure (`config/e2e/fixtures.ts`: the `_mutate` fixture, the capture and observation blocks) legitimately routes requests and is not touched; the rule targets what the agent delivers.
- **S5** (problem 2, owner, verbatim): "no me queda claro cual es el flujo que determina si un bug es error o no, porque claramente no funciona"
- **S6** (problem 2, owner, verbatim): "Por qué no detecta como bug un metodo que lee un campo que no existe en un endpoint y rompe la interface, eso es un error clarísimo y básico."
- **S7** (problem 2): a consumer field that the provider's contract does not declare (or declares under another name) and no live response carries, on code the change reaches, is reported as a defect of the run by itself, without a failing test: the run ends `fail` and opens an Issue that lists it.
- **S8** (problem 2): a test that passes by asserting the state such a contradiction produces does not turn the run green.
- **S9** (problem 2): the defect decision is driven by facts the engine verifies, not by the shape of an error string (`adjudicate.service.ts` Rule 3).
- **S10** (problem 2): the verdict, the decision, the Issue rendering, the graders (`defect_found`) and the Engine/AI boundary table of AGENTS.md say the same thing; the new records quote the owner's words and amend the AGENTS.md rows in the same commit as the code that makes them true. Every product decision taken is named as an assumption.
- **S11** (problem 2): whether the closed loop's retirement of the fix loop (every delivered spec seen passing through `run_spec`, then a failing final execution) is part of the same root cause is answered with code evidence.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S2, S3, S4 | inline | pending | |
| T2 | S5, S6, S7, S8, S10 | inline | pending | |
| T3 | S9, S10 | inline | pending | |
| T4 | S11, S10 | inline | pending | |

## Log

- **L1** (2026-11-01, owner, verbatim): "Qayaba no debe poder hacer stubs, eso tapa errores." / "no me queda claro cual es el flujo que determina si un bug es error o no, porque claramente no funciona" / "Por qué no detecta como bug un metodo que lee un campo que no existe en un endpoint y rompe la interface, eso es un error clarísimo y básico."
- **L2** (2026-11-01): evidence from run `run-ed28973-mvx5tf7x-2742c11b` (app name-webapp, commit ed28973, a 3-commit range): the frontend reads `activeMenuCuisineType` from `GET /restaurants/countries/ES`; the backend maps it to `cuisineType` and its OpenAPI schema `GeoRestaurantData` declares `cuisineType`, so every cuisine chip is always disabled: a contract defect. The Context Pack reported it as a possible data contradiction; the author wrote `[stubbed: geo collection with activeMenuCuisineType]` tests that fulfil the GET with the missing field; a live test asserted the all-disabled state and passed; the stub test's own failure ("expected true, received false") was graded `defect_found=1`.
- **L3** (2026-11-01): base cfc69e3b; assignment brief by the parent agent: no live runs, no docker, no push; Conventional Commits without attribution.

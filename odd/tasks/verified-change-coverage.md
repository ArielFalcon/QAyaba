# Verified change coverage

Objective: change coverage counts only executable changed lines and credits what a killed mutant proved. Branch: `main` (local
commits, owner rule). Delivery: `exception-ok` (one feature, local commits). Runner: `node --test` via `npm test`.

## Specs

- **S1 — Denominator.** "Denominador: solo líneas ejecutables según los segmentos del source map, con "no cargado" como categoría
  aparte." A changed line counts only when a segment of a loaded script's source map maps code to it (a script that is the changed
  file itself: its non-blank lines). A changed file no loaded script maps is "not loaded": its non-blank added lines stay uncovered
  and are listed apart. Native collectors (lcov, Istanbul, JaCoCo) keep their current denominator. "En vez de MCR aplica la solución
  que recomendaste de reutilizar el código del sourcemap y los diffs".
- **S2 — Verified coverage.** "Cobertura verificada: cubierta = ejecutada por un test que pasa ∪ ejecutada solo bajo un mutante que
  la suite eliminó. Se informa por separado de la cobertura por ejecución." The dumps of a killed mutant's re-run are read with the
  mutant's edit undone, so lines and arms land on the served script's own positions.
- **S3 — Targeted mutants.** "Selección de mutantes orientada: priorizar la negación de la condición de cada decisión cambiada que
  tenga un brazo sin tomar." (A logical decision has no negation site: its operator swap is its targeted mutant.)
- **S4 — Gap.** "El hueco y la regeneración por casos de rama dejan de pedir lo que ya está probado por mutación."
- **S5 — Honest residual.** "Lo que quede, como home.page.ts:454, que no está detrás de ninguna decisión cambiada que se pueda
  mutar, sigue contando como no cubierto. Es honesto."
- **S6 — Recount.** (Diagnosis cause b.) A recount that could not read one of its dump sources keeps the previous measurement; a
  recount carries the killed mutants' proofs of the spec files it did not re-run.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1 | inline | done (tests green) | pending |
| T2 | S2, S5 | inline | done (tests green) | pending |
| T3 | S3 | inline | done (tests green) | pending |
| T4 | S4, S6 | inline | done (tests green) | pending |
| T5 | all | inline | done (gate green: 11322 pass after the parity fix) | docs (AGENTS.md value/trust section, gate signal) + full gate |

## Log

- L1 (2026-10-26, owner): "Cuantos commits y líneas de código tiene la muestra con la que se hicieron las ultimas tres pruebas?,
  respecto al defecto de cobertura teniendo todo esto definido más los puntos que habías determinado anteriormente puedes hacer el
  arreglo de este problema. En vez de MCR aplica la solución que recomendaste de reutilizar el código del sourcemap y los diffs, si
  te parece lo óptimo." (+ the five points quoted in S1–S5.)
- L2: MCR spike rejected for the denominator (5/32 lines mapped, misattributed arms). Stryker spike: hybrid only; not adopted in
  this feature (S3 is met by our own sites; Stryker site generation stays a later option). Route: inline, the units depend on one
  another (S2–S4 consume S1's report shape), so no writer reason.
- L3: implemented inline. Executable lines come from the source-map segments of loaded scripts (`v8-browser-coverage.adapter.ts`),
  killed-mutant dumps are read with the edit undone (`undo-mutant.ts`), proofs flow measure → state → recount, the record is
  `gateSignals.changeCoverage`. Not done: a recount still cannot count a spec whose acceptance reused a run_spec proof (its dumps
  live in the run_spec session copy); it keeps the previous measurement, as before.

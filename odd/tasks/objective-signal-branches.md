# Objective signal: branches and bundle mutation

Objective: make the objective signal tell a suite that only walks the happy path from one that checks the change's logic, for any app: the change's own lines (without the repo's tests), source maps behind a DEV gate, branch coverage of the changed code, and mutants of the changed code in the served bundle.
Branch: `feat/objective-signal-branches` (single-branch rule; governance-sensitive tasks T3 and T6 each in their own commit). Delivery: ask-on-risk, slices as commit ranges (forecast ~1 600-2 000 authored lines). Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S0** (any app, any model): every behaviour is defined on the language registry's declared scope and on what a browser runs (V8 block coverage plus the scripts' source maps), never on one app's layout, framework or naming. Nothing names or assumes a model. Every new signal is `signal` only: `DecideCoverageService` and its keystone (`unknown` never blocks) are unchanged.
- **S1** (point 1, engine): the changed lines change-coverage counts exclude the repo's own test files, as the language registry defines them, on both targets. Evidence: R11 counted `changed_lines: 871`, the commit's whole insertion count, of which about 140 lines are production code.
- **S2** (point 1, config): name-webapp declares `qa.valueOracle: signal` in its own (gitignored) config, so the response oracle runs while it stays in shadow. The shadow-aware default (`off`, "don't double-run DEV during onboarding") is a deliberate guard and stays.
- **S3** (source maps behind a gate — found while doing S1/S2): the seed's coverage fixture fetches a script's source map through the browser context (the run's HTTP credentials and cookies), not through a bare `fetch()`. A script with no `sourceMappingURL` comment tries `<script url>.map`. Anything that does not parse as a source map (`version`, `sources[]`, `mappings`) is no map. Suites that already hold the previous seed code are upgraded in place, hash-pinned like the failure-capture block. A fixtures file someone edited is left as is. Evidence: DEV answers 401 to a `.map` request without the gate, and 200 with it.
- **S4** (branch coverage — owner: "medir que caminos de ejecución se prueban en la función"): the decisions of the generated code whose condition maps, through the script's source map, to a changed line of a non-test file are the change's branches:
  - Decisions are `if`/`else` including the implicit else, `?:`, `&&`/`||`/`??`, and `switch` clauses.
  - An arm is taken when V8's block count says it ran in at least one test:
    - an explicit arm: its own count is above 0;
    - an implicit else or a short circuit: the decision's count exceeds the arm's.
  - `ChangeCoverage.branches` holds `{ changedBranches, takenBranches, ratio }`. It is null when no decision was mapped.
  - The run's gate signals and the coverage span carry it.
  - The enforce regeneration gap names the arms that never ran (file, line, which arm).
- **S5** (bundle mutation — owner: "la implementación que comentas"): after a passing suite whose coverage was measured, the e2e value oracle mutates the served script at up to 3 decision or comparison sites that map to changed non-test lines and that ran. One mutant per re-run, re-running only the spec files whose tests executed that site.
  - Operators: negate a condition; swap `===`/`!==` and `==`/`!=`; move a comparison's boundary; swap `&&`/`||`.
  - A mutant is applied only to a response whose body hashes to the script the coverage saw.
  - A mutant that keeps every re-run test green survived.
  - The result is `{ applied, killed, survived[] }` (each survivor with file, line, operator). It sits beside the response oracle's `valueScore`, whose semantics stay unchanged.
  - No applied mutant → no score, never a fabricated 0.
  - Off whenever `qa.valueOracle` is off.
- **S6** (docs): `docs/agent-reference.md`, `docs/observability-design.md` and `AGENTS.md` (value/trust risk section) describe S1-S5. `config/apps/example.yaml` describes the source-map requirement.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1 | inline | done (RED→GREEN, bridge suite 25/25) | 6219eb5d |
| T2 | S2 | inline | done | (gitignored config) |
| T3 | S3 | inline, governance commit (setup.adapter.ts protected) | done (setup tests 151/151, seed tsc strict in container) | 3e7e6f3c |
| T4 | S4 | inline | done (real-V8 tests; full suite 10581 pass / 5 known base fails) | 7e1b3112 |
| T5 | S5 seed fixture (`_mutate`, `PW_MUTANT`) | inline, governance commit (setup protected) | done (setup tests; seed tsc strict in container) | 4c7cd783 |
| T6 | S5 sites, selection, oracle, runner env, wiring | inline, governance commit (exec env) | done (full suite 10597 pass / 5 known base fails; real-Chromium smoke) | 7ad00166 |
| T7 | S6 | inline | done (structural readback) | this commit |

## Log

- **L1** (2026-10-25, owner, verbatim): "Aplica el punto 1 y luego la implementación que comentas". Point 1 = exclude the repo's tests from the changed lines and turn the response oracle on in shadow. "La implementación que comentas" = branch coverage over the V8 dumps, then bundle mutation of the changed branches, signal only.
- **L2** (2026-10-25, owner, verbatim): "quiero que evalúes si sería provechoso alguna herramienta como las que usa sonarqube para medir que caminos de ejecución se prueban en la función … recuerda que son test E2E".
- **L3** (2026-10-25, evidence): the clean DEV runs R11 and f303 recorded `coverageRatio: null` (`unmeasured: no-source-maps`) and `valueScore: null` (the oracle was off in shadow).
  - Two causes:
    - (a) engine: the fixture fetches maps without the DEV gate's credentials (401);
    - (b) app: name-webapp's DEV bundles carry a Sentry `debugId` and no `sourceMappingURL`, and `<script>.map` answers with the SPA's index.html.
  - (b) is an app/DEV build property: the engine cannot fix it, and live validation of S4/S5 on name-webapp needs DEV to serve maps.
- **L4** (design): branches and mutants are found in the generated script, mapped back through its source map, not in the original TypeScript.
  - One parser and one mapping direction.
  - It works for any language that compiles to browser JS with a map, Angular templates included (their control flow compiles to JS mapped to the `.html`).
  - V8's per-block counts give implicit else and short circuits.
- **L5** (2026-10-26, decision): three mutants per run, not four: each costs a re-run against DEV, and the sites are picked one per changed line across files, so three already reach three lines.
- **L6** (2026-10-26, evidence): real Chromium in the orchestrator image, a local server behind HTTP Basic with a hidden map. The new seed attached the map, the previous one did not; lines 86 %, branches 33 % (the implicit else, both ternary arms, the right of `||` untaken). Mutant `=== → !==` was applied and killed; `|| → &&` was applied and survived; a wrong sha was never applied and left no counter.
- **L7** (2026-10-26, bug found by L6): an operator site was dropped when its right side short-circuited, because V8 opens that range at the operator token. Fixed by placing the site at the expression's start (RED first, real-V8 test), in 7ad00166.
- **L8** (next step): live validation of S4/S5 on name-webapp needs its DEV build to serve source maps (app-side change); until then both signals stay `unknown`/null there.

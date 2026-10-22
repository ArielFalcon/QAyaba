# Failure observation conflict

Objective: a failure-point capture says whether the page had settled and what data state it showed, and a failure whose data state contradicts the Context Pack's own read of the same route is re-read once and never treated as a test defect.
Branch: `fix/failure-observation-conflict`. Delivery: ask-on-risk. Runner: `node --import ./test-setup.mjs --import tsx --test` (Node v24).

## Specs

- **S1** (cause 1): the failure capture records, for a failed case, whether the page was settled at the failure point: data requests (fetch/xhr) still in flight, milliseconds since the last data response, and whether the accessibility tree changed in a short second read. The user asked: "agrega lo que comentas de la causa a la foto del momento de fallo".
- **S2** (cause 1): when the app declares a data state for the failed page's route (`dev.dataState`), the capture records the result count that state's selector shows at the failure point, with the same route matching the Context Pack uses.
- **S3** (cause 1): the regeneration prompt states each failing case's settle facts next to its failure tree; a tree captured while the page was still changing is stated as not settled, never as DEV's data state.
- **S4** (cause 2): a failed case whose failure-point result count is 0 on a route where this run's Context Pack confirmed results (> 0) is an observation conflict. With the review-loop integrity switch on, the fix loop spends its one triage re-read on it (same bytes, no retries) instead of regenerating: a pass makes the run flaky; a second read that again shows 0 ends the loop as `dev_not_rendered` (infra-error of the precondition class), never as a test defect. The user asked: "aplica luego la correccion de la causa 2".
- **S5**: the capture block twin in `setup.adapter.ts` stays byte-identical to the seed, and repos holding the previous block are upgraded in place (outgoing revision recorded).

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S2, S5 | inline | pending | |
| T2 | S3 | inline | pending | |
| T3 | S4 | inline | pending | |

## Log

- **L1** (2026-10-22, user, verbatim): "primero dime por que el context-pack si resuelve bien los 3 restaurantes pero el test no? luego agrega lo que comentas de la causa a la foto del momento de fallo. aplica luego la correccion de la causa 2."
- **L2** (2026-10-22): evidence from campaign `diag-2026-10-22-r4-deepseek-a` (runs `run-ec03222-mvjtgyxy-547ca0b4`, `run-ec03222-mvjtwhag-77ccdb90`): the pack read 3 results on `/restaurantes/madrid[/madrid]`, execution read 0 there; the fix loop retired/skipped the correct spec. The existing triage (fix-loop.aggregate.ts) needs a green `run_spec` proof and a role:name-absent selector, neither present in R4 (closed loop off; "Cambiar filtros" appears in other components), so it never fired.

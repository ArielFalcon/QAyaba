# ADR-0016: The refactor review's base causes, one task each

- **Status:** Accepted, 2026-10-30, under the owner's rule of ADR-0015 point 2 (every open decision takes the recommended option); the owner's own words that set the method are quoted below
- **Decision source:** the refactor review of 2026-10-30 (feature document L31; findings in the review log, "Refactor review 2026-10-30") and the owner's rules of L30: "los problemas que aparezcan se analizan primero para encontrar la causa base, la que puede estar causando más problemas además de ese y corregirla de raíz, no un parche al problema concreto. Qayaba no se optimiza para ñame ni para una app en específico, sino para probar cualquier app web" and "las ejecuciones siempre se revisan con los datos de telemetría, y también se evalúa si la telemetría es ineficiente porque deja sin explicación espacios de tiempo de la ejecución, o no muestra datos útiles de algún aspecto importante"
- **Code references at:** 84c34afa (the reviewed tree) and a6a1532b
- **Related:** [ADR-0001](0001-design-pillars.md), [ADR-0002](0002-architecture-direction.md) (addition 7, one time authority), [ADR-0011](0011-root-cause-fix-policy.md), [ADR-0015](0015-owner-decisions-2026-10-30.md), [RFC-0003](../rfc/0003-coverage-dump-harvest.md), [RFC-0006](../rfc/0006-review-answer-crosses-whole.md), [RFC-0008](../rfc/0008-acceptance-records-what-it-ran.md)

## Context

Five reviewers compared the code before the refactor (4105c582) with the finished work (84c34afa), section by section, reading the runs before and during the refactor from their telemetry. The refactor removes much more than it adds, and no test was weakened to pass. But each defect was fixed where it was found, not searched across the codebase as S5 asks, so its class survives at other sites, and some fixes added a second copy of a rule beside the first. The findings group into seven base causes.

## Decision

Each base cause is one task, fixed once across the whole codebase; no finding is fixed at its own site alone. The owner's rules of L30 are the method of every task: the cause is the one that may produce other problems too, the fix holds for any web app, and every run is read from its telemetry, with any stretch of time or important fact the telemetry leaves unexplained treated as a defect.

| Base cause | Rule after the fix | Task |
|---|---|---|
| R1. An ending without a typed record | Every way a turn, flow, phase or run ends is a typed outcome recorded at the one place that ends it, on the record and on the trace; nothing about an ending is found only in a log line | T32 |
| R2. More than one time authority | The run deadline is the one authority; it allots time by purpose, and every other budget is an input to it or is deleted | T33 (RFC-0012 first) |
| R3. A test case's identity is lossy and keyed on its title | Every execution records each case's declared mode; one proof rule serves every path (the first pass, `run_spec`, the regeneration acceptance, the experiment acceptance, the review's green files, the mutation baselines); rules read modes and counts per file, never titles; a case names its suite-relative file; the engine is the one skip authority for every app | T34 |
| R4. Agent answers read by several readers | One reader with RFC-0006's contract for every agent answer; a finding has an id from admission | T35 |
| R5. A turn fault read as a dead session | A turn ends with a typed end; a session is disposed only when the runtime says it is gone | T35 |
| R6. One rule, two copies | One copy per rule, each searched across the whole codebase | T36 |
| R7. Placement and process | Row-3 logic leaves the shell (T13); every commit whose Risk line names an item gets a verifier (CP4); records are corrected when the code shows them wrong | T37 |

The order is T32, T33, T34, T35, T36, then the after-measurement T12: a measurement taken before R1 cannot be read, and one taken before R2-R5 would measure the faults it is meant to rule out. The owner's decision of ADR-0015 point 1 ("Prohibir test.skip") is kept and widened by T34: the engine refuses a skipped test for every app on every pass, where the seed lint reaches only apps bootstrapped from the seed.

## Consequences

- ADR-0002 addition 7 is scheduled (T33). It has live evidence now: T17's review cut by the deadline after coordination's reserve, and the interim run's turns cut by the transport (a6a1532b removes that one authority).
- ADR-0011, ADR-0015 and RFC-0003 carry corrections dated 2026-10-30.
- The after-measurement waits for T32-T35.

# ADR-0015: Owner decisions of 2026-10-30

- **Status:** Accepted, 2026-10-30, owner (the two answers quoted below); the rules taken under the second answer are recommended options the agent chose, labelled as such
- **Decision source:** two answers of the owner on 2026-10-30, recorded in the feature document `odd/tasks/root-cause-2026-10-28.md`, L26. The question was whether the seed's static gate keeps only warning on a skipped test or refuses it (the finding that raised it, C-B1 of checkpoint 2, is in the review log); the owner chose "Prohibir test.skip (Recomendado)" (translated: "Forbid test.skip (Recommended)"). Then the owner said "No te detengas más a preguntarme" (translated: "Do not stop to ask me any more").
- **Code references at:** 17bb77c1
- **Related:** [RFC-0007](../rfc/0007-dev-write-attribution.md), [RFC-0008](../rfc/0008-acceptance-records-what-it-ran.md), [ADR-0011](0011-root-cause-fix-policy.md) (rule 6, decisions stop the work), [ADR-0013](0013-owner-decisions-remaining-questions.md), [ADR-0014](0014-owner-decisions-rfc-0011.md)

## Context

The acceptance of a regeneration (RFC-0008) records what it ran. The report dropped skipped tests, so a changed spec file whose tests all skipped counted as one that did not load (checkpoint 2, C-B1); carrying the skipped tests let such a file stand, and with it a correction that skips the test it was asked to fix turns its round green with nothing run. The seed's lint only warned on `test.skip`. Checkpoint 3 then found that the lint, even as an error, reaches only an app whose suite was bootstrapped from this seed, and that other forms (`test.fixme`, `testInfo.skip()`, `test.fail()`, an alias) still turned a failing test green (B-B1, B-J1).

The same checkpoint found three faults in the DEV-write control of RFC-0007 (A-B1, A-B2, A-J3, all in the feature document's review log, "Checkpoint 3").

## Decision

**The owner's decisions.**

1. `test.skip` is forbidden: `playwright/no-skipped-test` is an error in the seed's static gate, `cleanup.spec.ts` stays exempt (`b900bc7e`). The options of the question other than the chosen one are not recorded in L26.
2. From the second answer on, every open decision takes the recommended option and is recorded in the feature document, and in an ADR when it settles an RFC question. A decision that the brief reserves (a product or architecture decision no record settles, S1) is the one thing this does not cover: ADR-0011 rule 6 stands for a fork with no recommendation.

**Taken under the second answer** (the recommended option of each; not words of the owner):

3. **The engine's rule against a test that stops being a pass** (B-B1, `a6cded89`). For any app, whatever its own lint, a test of a changed spec file that ran in the file's prior bytes and is now skipped, runs with an expected status of failed, or (when it was failing) is gone while the file reports fewer cases than before, is not a pass. The file gets its prior bytes back when the acceptance is judged file by file, or the round is rejected when it is judged whole. A test that never ran before and is skipped is simply no case. The seed's lint adds `disallowFixme` as an early hint for projects bootstrapped from it; the engine rule is what holds for every app. Not implemented: the part of the finding that read "or a correction named" (a test a correction named but that never ran before); the rule reads only the cases of the run before the regeneration.
4. **A kept file with no executed case gets no proof** (B-B1, `a6cded89`; C-B1, `31306add`; the silent-file rule, `80ab4482`). A file whose tests all skipped loaded and stands, with no case recorded for it and no proof, so the suite store never captures bytes nothing ran. A file the report says nothing of did not load and is never kept.
5. **The DEV-write control** (A-B1, A-B2, A-J3, `b690fa8c`; the first design `e58085a5`). The control load is bounded apart from the call (one fifth of its time for the page load), a load that ends at its bound keeps what it saw and closes cleanly; the runner reads the control files when the control child closes, before the spec child starts, and ignores any control file found later; a control that failed exempts nothing, whatever it left. RFC-0007 carries the text.
6. **The tool-target redaction window** (B-J2, `9b243fab`) is the larger of the evidence safety bound and twice the cap, and the cut comes after the redaction. RFC-0010 carries the text.

Correction 2026-10-30 (refactor review, review log): points 3 and 4 hold on the acceptance path only. The first pass proves every delivered spec after a green run without reading its cases (`fix-loop.steps.ts:400-414`), so a file whose tests all skip, or that holds only a `test.fail()` test, ends `pass` and is captured; and the rule matches prior cases by title on a record that drops the declared mode, so an unchanged `test.fail()` blocks its file's regeneration and a renamed test turns green. The seed lint is a hard gate, not a hint, and misses `test.fail()`, `test.info().skip()` and an alias. T34 carries the base cause (ADR-0016 R3).

## Consequences

- [RFC-0008](../rfc/0008-acceptance-records-what-it-ran.md) gets a correction: a kept file may have no case when all its tests skipped, and it then gets no proof.
- `AGENTS.md` (the static gate and "Per-file acceptance") and `docs/execution-sandbox.md` state the final design.
- A skipped test is not a tool for a state DEV cannot be brought to: that is the lead's to drop with its basis.

## Enforcement

RED tests through the public seams, each added with the commit that fixed it: `regeneration-acceptance.test.ts` and `run-qa.closed-loop.test.ts` (the acceptance rules, `a6cded89`, `80ab4482`, `31306add`), `playwright-report.test.ts`, the seed lint's rules test (`b900bc7e`, `a6cded89`), and the control's tests in `control-load.test.ts` and `e2e-execution.runner.test.ts` (`b690fa8c`).

## Alternatives considered

- **Keep the lint as a warning.** Set aside by the owner's answer.
- **Make the lint the only guard.** Not chosen: it reaches only a project bootstrapped from the seed, and other forms still skip (B-B1, B-J1). The engine reads the report, which is the same for every app.
- **A control per worker, run from the capture block.** The first design; it read the control after the spec's own code ran and from a directory the sandbox writes (RFC-0007, implementation notes).

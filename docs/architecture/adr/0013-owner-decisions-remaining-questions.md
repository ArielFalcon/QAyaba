# ADR-0013: Owner decisions on the remaining open questions

- **Status:** Accepted, 2026-10-28, owner
- **Decision source:** the owner's message of 2026-10-28, "Resolve the pending non-blocking decisions with your recommendations too. Leave everything ready to start implementing" (translated).
- **Code references at:** 4105c582
- **Related:** [RFC-0001](../rfc/0001-dormant-features.md), [RFC-0002](../rfc/0002-platform-steps-0-1.md), [ADR-0001](0001-design-pillars.md) to [ADR-0011](0011-root-cause-fix-policy.md), [ADR-0012](0012-owner-decisions-rfc-0002-0010.md), [README](../README.md)

## Context

[ADR-0012](0012-owner-decisions-rfc-0002-0010.md) settled the questions that blocked implementation. The rest stayed open because they block neither platform steps 0-1 nor the slices: OD-1 to OD-20 of RFC-0001, the open questions of ADR-0001 and ADR-0002, the "not decided here" points of ADR-0003 to ADR-0011, and the three open questions of the README. Each carries a recommended answer in its record.

## Decision

1. Every recommended answer to those questions is accepted as written; the record that asks a question holds its answer. ADR-0001's numbering P1-P7, its review questions and its review procedure are accepted as proposed.
2. One answer differs from its record, because it was carried out first: README, open question 2 (the ignore rule that hid `docs/architecture/` from git). The record recommends removing the rule. It was narrowed instead (commit `aff06b95`), because it also keeps the local diagram tool's output out of git: everything in the folder stays ignored except the records, which are `README.md`, `rejected-explanations.md`, `adr/` and `rfc/`.
3. Where an answer gives an action to the owner, the action stays the owner's when its step runs, as its record says:
   - edits to operator data: removing the app configuration for qayaba itself ([ADR-0007](0007-code-target-removal.md), point B), after a copy of the file, which git does not hold; the retired keys in the app configurations ([ADR-0006](0006-bundle-mutation-switch.md), RFC-0001 OD-6 and OD-14); the reference set (OD-2); `.env.example` (OD-15);
   - the repository's auto-merge setting and closing the open maintainer pull requests ([ADR-0010](0010-maintainer-removal.md), points B and C);
   - the live service-triggered run, on the owner's authorization of the repository, sha and credential (OD-11);
   - the D2 statement ([ADR-0012](0012-owner-decisions-rfc-0002-0010.md)).

## Consequences

- Every question of these records has an answer. Some answers name the later RFC or the event that settles the details: the replacement of the tier thresholds (ADR-0001, open question 3), the learning slice's definitions (ADR-0003), the publication adapter (OD-20).
- RFC-0001 OD-14 (warn per unknown app-config key) is the first commit of step 1, before G1 and ahead of C1 and L2, where [RFC-0002](../rfc/0002-platform-steps-0-1.md) places it once accepted. The other RFC-0001 removals follow Z, each in its own commit (RFC-0002, Q12).
- The bundle-mutation key of ADR-0006 lands in step 1 with the removal of the response value oracle (ADR-0004), whose switch bundle mutation runs under today.
- The replicate after step 1 is the new "before" for the slices, one replicate per version ([ADR-0011](0011-root-cause-fix-policy.md)).
- The feature document `odd/tasks/root-cause-2026-10-28.md` carries the work these answers add.

## Enforcement

The tests and gate changes each record names, added with the commit that lands it.

## Alternatives considered

Leaving these questions open until each step reaches them: set aside by the owner, to start implementing with nothing pending.

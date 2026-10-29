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

- Every question of these records has an answer, except three open points that had none (Correction 2026-10-29: see "Correction 2026-10-29" below). Some answers name the later RFC or the event that settles the details: the replacement of the tier thresholds (ADR-0001, open question 3), the learning slice's definitions (ADR-0003), the publication adapter (OD-20).
- RFC-0001 OD-14 (warn per unknown app-config key) is the first commit of step 1, before G1 and ahead of C1 and L2, where [RFC-0002](../rfc/0002-platform-steps-0-1.md) places it once accepted. The other RFC-0001 removals follow Z, each in its own commit (RFC-0002, Q12).
- The bundle-mutation key of ADR-0006 lands in step 1 with the removal of the response value oracle (ADR-0004), whose switch bundle mutation runs under today.
- The replicate after step 1 is the new "before" for the slices, one replicate per version ([ADR-0011](0011-root-cause-fix-policy.md)).
- The feature document `odd/tasks/root-cause-2026-10-28.md` carries the work these answers add.

## Correction 2026-10-29

The first checkpoint found that "every question has an answer" did not hold for three open points. Each now carries a recommendation, grounded in the records. These are recommended answers, not decisions: the owner has not ruled on them, and each is decided when the change that owns it lands.

| Open point | Recommendation | Grounded in | Status |
|---|---|---|---|
| ADR-0008: the declaration's config format and which version readers ship first (circular: [RFC-0001](../rfc/0001-dormant-features.md) OD-10 leaves both to ADR-0008, and ADR-0008 leaves both to the standalone change) | Extend, do not replace: `dev.versionUrl` and `services[].versionUrl` stay the declaration and keep answering `{ sha, healthy }` through the one reader that exists today. A second reader kind (a version stamped into a build) adds one optional key beside `versionUrl` naming the kind, defaulting to the current shape, in the change that ships that reader. No app configuration needs an edit. | ADR-0008 consequence 4 (the declaration "replaces or extends" `versionUrl`, `schemas.ts:111`, `:125`); [ADR-0001](0001-design-pillars.md) P7 (no structure before a failure shows the need); [ADR-0013](0013-owner-decisions-remaining-questions.md) point 3 (the app configurations are the owner's data) | recommended; decided when T19 lands |
| ADR-0009: whether a declared learning arm lifts the whole freeze or only the lesson state | Only the lesson state. Replicate isolation (suite store read-only, no context-map heal inside the run, no login bootstrap and no map rebuild ahead of the run) stays on for every campaign-tagged run, because it is what makes two replicates comparable. After the rule loop, the reflector and the curriculum left (`b0d5721a`, `72d206a9`, `0989507c`), the only learning state to lift is the lesson store of [ADR-0003](0003-learning-layer-rebuild.md) D14. The per-request decision has to reach the two pre-run steps, which are wired at boot today. | ADR-0009 Context ("so that replicate 2 does not start from what replicate 1 taught"); [ADR-0011](0011-root-cause-fix-policy.md) conditions (the suite is held constant); [RFC-0005](../rfc/0005-suite-store-single-writer.md) Risk note | recommended; decided when T20 lands |
| ADR-0009: whether `QA_CAMPAIGN_FREEZE` stays | It goes with the server-side freeze. The decision is per request from the `campaign` tag, which a process switch read at boot cannot express and cannot hand to the pre-run steps. A webhook-triggered run carries no campaign field (`docs/observability-design.md:1041`), so it is not campaign-tagged and not frozen, like any run without a campaign; if an experiment needs a frozen service-triggered run, the webhook payload gets a campaign field rather than the switch staying. Until T20 lands the switch stays as it is. | ADR-0009 decisions 1 to 3; the same Context | recommended; decided when T20 lands |

## Enforcement

The tests and gate changes each record names, added with the commit that lands it.

## Alternatives considered

Leaving these questions open until each step reaches them: set aside by the owner, to start implementing with nothing pending.

# ADR-0014: Owner decisions on RFC-0011

- **Status:** Accepted, 2026-10-30, owner
- **Decision source:** the owner's answer of 2026-10-30 to the question that listed RFC-0011's open questions Q1 to Q8 with their recommendations: "Aceptar todas (Recomendado)" (translated, Correction 2026-10-30: "Accept all (Recommended)").
- **Code references at:** e844d7f9
- **Related:** [RFC-0011](../rfc/0011-multi-hop-cross-repo-impact.md), [ADR-0001](0001-design-pillars.md), [ADR-0011](0011-root-cause-fix-policy.md), [ADR-0013](0013-owner-decisions-remaining-questions.md)

## Context

[RFC-0011](../rfc/0011-multi-hop-cross-repo-impact.md) proposes that a change's cross-repository impact follow the declared service links over more than one hop, in both directions, after the owner observed that a change in one service must reach the pages that depend on it through another (feature document `odd/tasks/root-cause-2026-10-28.md`, S7 and L21). It closed with eight open questions, each with a recommended answer and an alternative.

## Decision

Every recommended answer of RFC-0011 is accepted as written: Q1 (the index of an unchanged service is built on demand), Q2 (a service is read at its mirror's head), Q3 (both directions, in separate commits), Q4 (`crossRepoImpactedCount` keeps its name and counts every hop, marked as an epoch break), Q5 (no hop cap: the visited set and the walk policy bound the walk), Q6 (downstream links are grounding only and add no page, candidate or operation), Q7 (a stop is stated in the prompt as one line) and Q8 (the owner declares the backend-to-backend or event boundary of an app when the change lands; an app that declares none keeps one hop). RFC-0011's status becomes Accepted.

## Enforcement

RFC-0011's RED test and the differential test that pins one hop for an app with no backend boundary, each added with the commit that lands its unit (feature document, T29).

## Alternatives considered

Each question's alternative, as RFC-0011 states it, set aside by the owner's answer.

# ADR-0026: The branch gap's arm decline, chosen under the owner's mandate to fix the mechanisms at root

- **Status:** Accepted, 2026-11-01, by the parent orchestrator under the owner's mandate below; open to the owner's revision
- **Decision source:** the owner asked for the mechanisms of the branch gap to be fixed at root. His words on 2026-11-01 (translated from Spanish): "I want the mechanisms that cause this error, in any app or group of commits, identified and fixed; if they now cause X% and in another case Y%, I don't care. The mechanisms that cause the error must be treated across the board and fixed at the root, always respecting the project's rules and the cleanliness of the hexagonal architecture and DDD, respecting the domains, the sources of truth and the distribution of responsibilities." (original: "quiero que se identifiquen los mecanismos que dan este error en cualquier app o grupo de commits y corregir esos, si ahora causan el X% y en otro caso el Y% me da igual, se deben tratar los mecanismos que causan el error de forma transversal y corregirlo de raiz, siempre respetando las reglas del proyecto y la limpieza de la arquitectura hexagonal y DDD, respetando los dominios, las fuentes de verdad y la reparticion de responsabilidades"), and, for the same step, "it must look for the safe solution that causes no regression and removes no functionality" (original: "debe buscar la solución segura que no causa regresión y que no quite funcionalidades"). The owner did not ask for a decline channel in those words: the parent orchestrator chose RFC-0019's recommendation under that mandate.
- **Code references at:** cb72b618
- **Related:** [RFC-0019](../rfc/0019-arm-decline-by-basis.md), [ADR-0001](0001-design-pillars.md) (P2), `odd/tasks/branch-gap-mechanisms.md` (S1, S2, S7)

## Context

RFC-0019 moves one decision across the engine/AI boundary: whether an untaken arm of the changed code needs no test. Until now nothing in the engine or in the lead's answer could say it; the gap sent every arm to a flow. The boundary table in `AGENTS.md` is the owner's. The owner's request is to fix the mechanisms at root; it does not name this channel. The parent orchestrator took the RFC's recommendation under that mandate, unless the code showed it unsafe, and the work says so here.

## Decision

1. **Option B of RFC-0019 is taken by the parent orchestrator under the owner's mandate**: a typed decline in the lead's correction answer, with the plan's basis vocabulary, checked by the engine against the facts a drop is checked against, asked once when contradicted, then honoured and recorded.
2. **The code did not show it unsafe.** The check is in the RFC ("Safety check"): a decline changes no verdict, gate or grader input; the arm stays in the measurement, the PR, the Issue and every grader; the reader and the check are the correction reader's and the plan's, with no copy.
3. **A new row of the Engine/AI boundary table** in `AGENTS.md`: "Whether an arm no test took needs no test", decided by the agent with facts, the engine verifies; status in force from the commit that lands the contract.

## Assumptions taken (not the owner's words)

1. **The mandate is "fix the mechanisms at root", not "add a decline".** The decline is the parent orchestrator's reading of that mandate for the mechanism "no typed way to leave an arm no test can take"; the owner may revise it. If the owner prefers option C (the engine decides alone) or a different vocabulary, this ADR is superseded.
2. **Every basis of `DROP_BASIS` applies to an arm**, with the plan's refusal rule over the use cases the arm's file seeds. The meaning of `already-covered` for an arm that the measurement found untaken is the lead's to argue; the engine refuses it only when no spec of the suite is linked to any use case the file seeds.
3. **The decline is recorded, never rewarded:** no grader or gate reads it; campaigns read its rate.

## Consequences

- A coverage turn can end with no flow ordered and no sidekick turn, recorded as declined with the basis.
- The lead's role prompt, the coverage origin's rule text and the generated submit-tool schema change; the image smoke for the submit tools is run.

## Enforcement

`engine/test/contexts/coordination/application/lead-correction.test.ts` (admission), `lead-answer-contracts.test.ts` (the wire), `lead-sidekicks.test.ts` (the pass: no revision turn, asked once, honoured), `engine/test/shared-kernel/drop-basis.test.ts` (the check), `branch-cases-record.test.ts` and the coverage step tests (the record keeps the arm), and `npm run submit-contracts:check`.

## Alternatives considered

See RFC-0019, "Options": prose channel (A), engine decides alone (C), a new vocabulary (D).

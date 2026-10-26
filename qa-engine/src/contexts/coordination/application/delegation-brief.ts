import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { AcceptanceCriterion } from "./coordination-context.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { SIDEKICK_AUTHORITY, type SidekickAuthority } from "./authority.ts";

export interface DelegationScope {
  readonly readablePaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly allowedCommands: readonly string[];
}

export interface ArtifactReference {
  readonly id: string;
  readonly path: string;
}

export interface ValidationStep {
  readonly id: string;
  readonly description: string;
}

export interface DelegationBrief {
  readonly delegationId: string;
  readonly runId: string;
  readonly objective: string;
  readonly task: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly scope: DelegationScope;
  readonly knownFacts: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactReference[];
  readonly validationPlan: readonly ValidationStep[];
  readonly authority: SidekickAuthority;
  /* The Live DOM of the flow's pages, cut from the run's Context Pack. */
  readonly pages?: string;
  /* How the change reaches the flow's pages, as the call graph proved it (`route: step > step`). */
  readonly proofs?: readonly string[];
}

export function createDelegationBrief(input: {
  /* Where every free-form field is redacted before it enters the brief. */
  redaction: RedactionPort;
  delegationId: string;
  runId: string;
  objective: string;
  task: string;
  acceptanceCriteria?: readonly AcceptanceCriterion[];
  scope: DelegationScope;
  knownFacts?: readonly EvidenceRef[];
  artifactRefs?: readonly ArtifactReference[];
  validationPlan?: readonly ValidationStep[];
  pages?: string;
  proofs?: readonly string[];
}): DelegationBrief {
  const scrub = (text: string): string => input.redaction.redact(text);
  if (!input.delegationId) throw new Error("DelegationBrief requires delegationId");
  if (!input.runId) throw new Error("DelegationBrief requires runId");
  return {
    delegationId: input.delegationId,
    runId: input.runId,
    objective: scrub(input.objective),
    task: scrub(input.task),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map(scrub),
    scope: input.scope,
    knownFacts: (input.knownFacts ?? []).map((fact) => ({ ...fact, summary: scrub(fact.summary) })),
    artifactRefs: input.artifactRefs ?? [],
    validationPlan: (input.validationPlan ?? []).map((step) => ({ ...step, description: scrub(step.description) })),
    authority: SIDEKICK_AUTHORITY,
    ...(input.pages ? { pages: scrub(input.pages) } : {}),
    ...(input.proofs?.length ? { proofs: input.proofs.map(scrub) } : {}),
  };
}

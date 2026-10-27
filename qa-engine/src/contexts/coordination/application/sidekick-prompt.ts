/* Sidekick prompt assembly lives here so generation does not import DelegationBrief. Injected into SidekickExecutor.
The brief is assembled from the registered section definitions (`coordination-sections/brief-sections.ts`); free-form brief fields are redacted through the RedactionPort at this egress, so secrets never reach the provider. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { assembleDefs, type AssembledPrompt, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { AUTHOR_BRIEF_SECTIONS } from "./coordination-sections/brief-sections.ts";

/* The brief with everything the assembler reports (sizes, hashes, claims). `fit` is the author's window fit rule: over it the suite listing and the flow's pages give way as references; absent, nothing is degraded. */
export function assembleSidekickBrief(redaction: RedactionPort, brief: DelegationBrief, fit?: (bytes: number) => WindowFitOutcome): AssembledPrompt {
  return assembleDefs(AUTHOR_BRIEF_SECTIONS, { brief, scrub: (value) => redaction.redact(value) }, { separator: "\n\n", ...(fit ? { fit } : {}) });
}

export function renderSidekickBrief(redaction: RedactionPort, brief: DelegationBrief, fit?: (bytes: number) => WindowFitOutcome): {
  text: string;
  sectionSizes: Record<string, number>;
  sectionHashes: Record<string, string>;
  stablePrefixBytes: number;
} {
  const { text, sectionSizes, sectionHashes, stablePrefixBytes } = assembleSidekickBrief(redaction, brief, fit);
  return { text, sectionSizes, sectionHashes: sectionHashes ?? {}, stablePrefixBytes };
}

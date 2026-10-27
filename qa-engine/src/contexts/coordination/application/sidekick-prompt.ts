/* Sidekick prompt assembly lives here so generation does not import DelegationBrief. Injected into SidekickExecutor.
The brief is assembled from the registered section definitions (`coordination-sections/brief-sections.ts`); free-form brief fields are redacted through the RedactionPort at this egress, so secrets never reach the provider. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { AUTHOR_BRIEF_SECTIONS, BRIEF_MAX_SUITE_LINES, BRIEF_MAX_SUITE_LINE_CHARS } from "./coordination-sections/brief-sections.ts";

export { BRIEF_MAX_SUITE_LINES, BRIEF_MAX_SUITE_LINE_CHARS };

/* The brief with everything the assembler reports (sizes, hashes, claims). */
export function assembleSidekickBrief(redaction: RedactionPort, brief: DelegationBrief): AssembledPrompt {
  return assembleDefs(AUTHOR_BRIEF_SECTIONS, { brief, scrub: (value) => redaction.redact(value) }, { separator: "\n\n" });
}

export function renderSidekickBrief(redaction: RedactionPort, brief: DelegationBrief): {
  text: string;
  sectionSizes: Record<string, number>;
  sectionHashes: Record<string, string>;
  stablePrefixBytes: number;
} {
  const { text, sectionSizes, sectionHashes, stablePrefixBytes } = assembleSidekickBrief(redaction, brief);
  return { text, sectionSizes, sectionHashes: sectionHashes ?? {}, stablePrefixBytes };
}

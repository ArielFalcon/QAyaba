/*
 * What a rendered prompt knows about itself that a trace records: the hash of each of its sections, how many
 * sections the budget omitted, and the budget. Only hashes, counts and sizes: no text. Handed to the prompt as options so the
 * turn that sends the prompt can say which prompt it was.
 */
import type { AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { SectionMeta } from "@kernel/telemetry/section-meta.ts";

export interface RenderedPromptFacts {
  sectionHashes?: Record<string, string>;
  droppedSections?: readonly string[];
  budgetBytes?: number;
  /* What each grounding section supplied and lost, from the kept assembly. */
  sectionItems?: Record<string, SectionMeta>;
}

export function promptFactsOpts(rendered: RenderedPromptFacts): Pick<AgentPromptOpts, "sectionHashes" | "sectionsDropped" | "promptBudgetBytes" | "sectionItems"> {
  return {
    ...(rendered.sectionHashes ? { sectionHashes: rendered.sectionHashes } : {}),
    ...(rendered.droppedSections ? { sectionsDropped: rendered.droppedSections.length } : {}),
    ...(rendered.budgetBytes !== undefined ? { promptBudgetBytes: rendered.budgetBytes } : {}),
    ...(rendered.sectionItems ? { sectionItems: rendered.sectionItems } : {}),
  };
}

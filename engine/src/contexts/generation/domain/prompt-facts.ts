/*
 * What a rendered prompt knows about itself that a trace records: the hash of each of its sections, how many
 * sections the budget omitted, the budget and the size of its stable prefix. Only hashes, counts and sizes: no text. Handed to the prompt as options so the
 * turn that sends the prompt can say which prompt it was.
 */
import type { AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { ContextFit } from "@kernel/context-budget.ts";
import type { SectionMeta } from "@kernel/telemetry/section-meta.ts";

export interface RenderedPromptFacts {
  sectionHashes?: Record<string, string>;
  /* What the window fit rule did, when the prompt was assembled with one: the sections it gave a smaller render. */
  windowFit?: { degraded: readonly unknown[] };
  /* Bytes of the stable prefix the prompt opens with. */
  stablePrefixBytes?: number;
  /* What each grounding section supplied and lost, from the kept assembly. */
  sectionItems?: Record<string, SectionMeta>;
  /* Whether the prompt fits its role's context window with the working room its turn needs; absent when the run has no context budget. */
  contextFit?: ContextFit;
}

export function promptFactsOpts(rendered: RenderedPromptFacts): Pick<AgentPromptOpts, "sectionHashes" | "sectionsDegraded" | "promptStablePrefixBytes" | "sectionItems" | "contextFit"> {
  return {
    ...(rendered.sectionHashes ? { sectionHashes: rendered.sectionHashes } : {}),
    ...(rendered.windowFit ? { sectionsDegraded: rendered.windowFit.degraded.length } : {}),
    ...(rendered.stablePrefixBytes !== undefined ? { promptStablePrefixBytes: rendered.stablePrefixBytes } : {}),
    ...(rendered.sectionItems ? { sectionItems: rendered.sectionItems } : {}),
    ...(rendered.contextFit ? { contextFit: rendered.contextFit } : {}),
  };
}

/* Every role prompt the coordination context assembles, by name, with the registry its sections come from. A prompt of a role is built from one of these registries through the shared assembler and from nowhere else; the registry-rule test holds the source to that. */
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";
import { AUTHOR_BRIEF_SECTIONS } from "./brief-sections.ts";
import { FEEDBACK_SECTIONS } from "./feedback-sections.ts";
import { REPLAN_SECTIONS } from "./replan-sections.ts";
import { LEAD_CORRECTION_SECTIONS, LEAD_REVIEW_SECTIONS, REFUSED_CORRECTION_SECTIONS } from "./lead-turn-sections.ts";

export const COORDINATION_PROMPTS = {
  /* The brief a flow's author sidekick is handed. */
  "flow-author-brief": AUTHOR_BRIEF_SECTIONS,
  /* The lead's review of the flows its sidekicks authored. */
  "lead-review": LEAD_REVIEW_SECTIONS,
  /* The lead's routing of corrections to the flows that own them. */
  "lead-correction": LEAD_CORRECTION_SECTIONS,
  /* The one request that sends a refused plan back to the lead. */
  /* The one request that sends a refused correction answer back to the lead. */
  "lead-correction-refused": REFUSED_CORRECTION_SECTIONS,
  /* The one request that sends an answer the reader could not read in full back to the lead. */
  /* The one request that sends a plan that left use cases unresolved back to the lead. */
  "lead-replan": REPLAN_SECTIONS,
  /* What the lead sends a sidekick after its brief: feedback and the contract reminder. */
  "lead-feedback": FEEDBACK_SECTIONS,
} as const satisfies Record<string, readonly PromptSectionDef<never>[]>;

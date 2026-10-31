/*
 * The section registry of what the lead sends a sidekick after its brief: the lead's feedback (an instruction to revise, or the
 * orchestrator's facts beside it) and the reminder of the contract the answer is held to. Sections are joined by a blank line.
 */
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";

export interface FeedbackPromptContext {
  feedback: string;
  /* The one line that restates which result the answer is, by delegation and run. */
  contract: string;
  scrub(text: string): string;
}

export const FEEDBACK_SECTIONS: readonly PromptSectionDef<FeedbackPromptContext>[] = [
  { id: "lead-feedback", tier: "task", priority: 10, stability: "run", reason: "The lead's revise instruction, with the orchestrator's facts beside it (9adce82f)", applies: () => true, render: ({ feedback, scrub }) => ({ content: ["## Feedback from lead", scrub(feedback)].join("\n") }) },
  { id: "feedback-contract", tier: "task", priority: 20, stability: "run", reason: "Restates which result the answer is, by delegation and run (9adce82f)", applies: () => true, render: ({ contract }) => ({ content: contract }) },
];

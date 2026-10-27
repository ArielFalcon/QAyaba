/*
 * The section registry of the one request that sends a plan which left use cases unresolved back to the lead: the facts about those
 * use cases and what a plan must do with each. The shape of the answer is the lead's role prompt.
 */
import { candidateLine, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";

export interface ReplanPromptContext {
  unresolved: readonly UseCaseCandidate[];
  /* The drops the run's facts refused, by candidate id: the basis the lead gave and why it was refused. */
  refusals: ReadonlyMap<string, { basis: string; why: string }>;
  scrub(text: string): string;
}

export const REPLAN_SECTIONS: readonly PromptSectionDef<ReplanPromptContext>[] = [
  {
    id: "unresolved",
    tier: "task",
    priority: 10,
    applies: () => true,
    render: ({ unresolved, refusals, scrub }) => ({
      content: [
        "## Use cases your plan leaves unresolved",
        "The change makes these use cases testable. No flow of your plan cites their id or visits their pages, and none is listed as dropped with a basis and a reason the run's facts allow:",
        ...unresolved.map((candidate) => {
          const refusal = refusals.get(candidate.id);
          return `- ${scrub(candidateLine(candidate))}${refusal ? ` | your drop (${refusal.basis}) is refused: ${scrub(refusal.why)}` : ""}`;
        }),
      ].join("\n"),
    }),
  },
  {
    id: "answer",
    tier: "task",
    priority: 20,
    applies: () => true,
    render: () => ({
      content: 'Answer with your whole plan again: give a flow to each one (its id in the flow\'s "candidates"), or list it in "dropped" with a "basis" of the plan contract and the reason it needs no test. This is the only other plan turn of this run; answer with a plan of flows.',
    }),
  },
];

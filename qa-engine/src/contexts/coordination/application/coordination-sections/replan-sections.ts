/*
 * The section registry of the one amendment request that sends a plan back to the lead: the use cases it left unresolved (a drop
 * the run's facts refused among them), the flows past the run's capacity that were not admitted, and the admitted flows whose
 * owned change alone does not fit an author's window. Each is a fact with what a plan must do about it, all in one turn. The shape
 * of the answer is the lead's role prompt.
 */
import { candidateLine, ownedSliceText, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { OwnedSliceSize } from "@kernel/coordination.ts";
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";

export interface ReplanPromptContext {
  unresolved: readonly UseCaseCandidate[];
  /* The drops the run's facts refused, by candidate id: the basis the lead gave and why it was refused. */
  refusals: ReadonlyMap<string, { basis: string; why: string }>;
  /* The change each candidate's flow would own, by candidate id; absent: the run read no diff. */
  slices?: Readonly<Record<string, OwnedSliceSize>>;
  /* The flows the run can author this pass; absent: nothing bounds them. */
  capacity?: number;
  /* The flows of the plan past that capacity, in plan order. */
  notAdmitted: ReadonlyArray<{ id: string; objective: string; candidates: readonly string[] }>;
  /* The admitted flows whose owned change alone does not fit an author's window, with its size. */
  oversize: ReadonlyArray<{ id: string; size: OwnedSliceSize }>;
  scrub(text: string): string;
}

export const REPLAN_SECTIONS: readonly PromptSectionDef<ReplanPromptContext>[] = [
  {
    id: "unresolved",
    tier: "task",
    priority: 10,
    applies: ({ unresolved }) => unresolved.length > 0,
    render: ({ unresolved, refusals, slices, scrub }) => ({
      content: [
        "## Use cases your plan leaves unresolved",
        "The change makes these use cases testable. No flow of your plan cites their id or visits their pages, and none is listed as dropped with a basis and a reason the run's facts allow:",
        ...unresolved.map((candidate) => {
          const refusal = refusals.get(candidate.id);
          return `- ${scrub(candidateLine(candidate, slices?.[candidate.id]))}${refusal ? ` | your drop (${refusal.basis}) is refused: ${scrub(refusal.why)}` : ""}`;
        }),
      ].join("\n"),
    }),
  },
  {
    id: "not-admitted",
    tier: "task",
    priority: 12,
    applies: ({ notAdmitted }) => notAdmitted.length > 0,
    render: ({ capacity, notAdmitted, scrub }) => ({
      content: [
        "## Flows past the run's capacity",
        `The run can author ${capacity ?? 0} flow(s) this pass, from the flows written at once and the time left. These flows of your plan are past it and were not admitted:`,
        ...notAdmitted.map((flow) => `- ${scrub(flow.id)}: ${scrub(flow.objective)}${flow.candidates.length > 0 ? ` (use cases: ${flow.candidates.map(scrub).join(", ")})` : ""}`),
        "Fold what each must check into an admitted flow, or drop its use cases with a basis and a reason; a flow still past the capacity is not authored.",
      ].join("\n"),
    }),
  },
  {
    id: "oversize",
    tier: "task",
    priority: 14,
    applies: ({ oversize }) => oversize.length > 0,
    render: ({ oversize, scrub }) => ({
      content: [
        "## Flows too large for one author",
        "The change these flows own is more than an author's context window holds with room left to work:",
        ...oversize.map((flow) => `- ${scrub(flow.id)}: ${ownedSliceText(flow.size)}`),
        "Split each into flows that each own part of its use cases; a flow kept whole is authored with the rest of its change as references.",
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

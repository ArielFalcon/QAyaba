/*
 * The section registries of the lead's turns after its plan: the review of the flows its sidekicks authored, the routing of corrections,
 * and the findings of the exploration it asked for. Each is the turn's prompt as data; how to judge it and the answer's shape are the
 * lead's role prompt. Sections are ordered by priority alone (one tier) and joined by a blank line.
 */
import { candidateLine, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { PromptSectionDef } from "@kernel/prompt-sections.ts";
import { FINDING_VERIFICATION } from "../explore-verification.ts";
import type { VerifiedExploration } from "../explore-verification.ts";
import type { FlowOutcome } from "../flow-outcomes.ts";

/* The longest spec a review or correction turn shows the lead. */
export const MAX_SPEC_CHARS = 8_000;

export interface FlowUnderReview {
  id: string;
  objective: string;
  acceptance: readonly string[];
  outcome: FlowOutcome;
  /* What the sidekick said of its last answer. */
  summary?: string;
  concerns: readonly string[];
  /* What the orchestrator saw of the flow's run_spec calls; absent when the flow has no loop. */
  runSpec?: { calls: number; maxCalls: number; lastStatus?: string; lastFailure?: string };
  /* Whether the spec the flow holds now is the one its last run_spec call passed on. */
  verified: boolean;
  /* The app defect the flow's run showed, when one did. */
  appDefect?: string;
  /* Whether the sidekick's session is still open for a follow-up. */
  sessionOpen: boolean;
  /* The spec the flow delivered, as it is in the working copy. */
  spec?: string;
}

/* The use cases a review names: those no flow answers for, and those whose answering flows all ran run_spec and none holds a spec that passed it. A use case a flow without run_spec answers for is not called unproven: nothing says so. A use case the lead dropped with a reason is not named. */
export interface CandidateGaps {
  /* The use cases the plan had to answer for. */
  required: readonly UseCaseCandidate[];
  unvisited: UseCaseCandidate[];
  unproven: UseCaseCandidate[];
  /* How many less direct use cases the plan did not have to answer for. */
  others: number;
}

/* One finding a correction turn routes: a verified blocking finding of the reviewer, or a fact one of the run's checks observed, with the spec it names when it names one. */
export interface CorrectionFinding {
  text: string;
  spec?: string;
  /* The changed source file the finding is about (a coverage gap names code, not a spec), and the line when it names one. */
  file?: string;
  line?: number;
}

export interface FlowUnderCorrection {
  id: string;
  objective: string;
  /* The flow's spec, relative to the spec directory. */
  specFile: string;
  sessionOpen: boolean;
  /* The spec as the working copy holds it now. */
  spec?: string;
  /* The ids of the use cases the flow covers and the changed files that seed them: a finding about one of those files is the flow's. */
  candidates?: readonly string[];
  seedFiles?: readonly string[];
}

const section = <C>(def: Omit<PromptSectionDef<C>, "tier">): PromptSectionDef<C> => ({ tier: "task", ...def });

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

/* ── review ── */

export interface ReviewPromptContext {
  flows: readonly FlowUnderReview[];
  turn: { turn: number; maxTurns: number };
  gaps?: CandidateGaps;
  scrub(text: string): string;
}

const isLastReview = ({ turn }: ReviewPromptContext): boolean => turn.turn >= turn.maxTurns;

function runSpecLine(scrub: (text: string) => string, flow: FlowUnderReview): string {
  if (!flow.runSpec) return "run_spec: not available to this flow.";
  const { calls, maxCalls, lastStatus, lastFailure } = flow.runSpec;
  const verified = flow.verified ? "the spec it holds now is the one that passed" : "the spec it holds now has NOT passed run_spec";
  return [
    `run_spec: ${calls} of ${maxCalls} calls used${lastStatus ? `; last call ${lastStatus}` : ""}; ${verified}.`,
    lastFailure ? `Last failure: ${scrub(lastFailure)}` : "",
  ].filter(Boolean).join("\n");
}

function flowBlock(scrub: (text: string) => string, flow: FlowUnderReview): string {
  return [
    `### Flow \`${flow.id}\``,
    `Objective: ${scrub(flow.objective)}`,
    flow.acceptance.length > 0 ? ["Acceptance:", ...flow.acceptance.map((a, i) => `${i + 1}. ${scrub(a)}`)].join("\n") : "",
    `Outcome: ${flow.outcome.kind}${flow.outcome.reason ? ` (${scrub(flow.outcome.reason)})` : ""}`,
    flow.summary ? `Sidekick says: ${scrub(flow.summary)}` : "",
    flow.concerns.length > 0 ? `Sidekick concerns: ${flow.concerns.map((concern) => scrub(concern)).join("; ")}` : "",
    runSpecLine(scrub, flow),
    flow.appDefect ? `App defect shown by its run: ${scrub(flow.appDefect)}. It is reported as it ran and is never sent back to be made green.` : "",
    flow.spec !== undefined ? ["Spec:", "```ts", cut(scrub(flow.spec), MAX_SPEC_CHARS), "```"].join("\n") : "Spec: none delivered.",
  ].filter(Boolean).join("\n");
}

function candidatesBlock(scrub: (text: string) => string, gaps: CandidateGaps, last: boolean): string {
  const lines = (candidates: readonly UseCaseCandidate[]): string[] => candidates.map((candidate) => `- ${scrub(candidateLine(candidate))}`);
  return [
    "## Change candidates",
    `The change makes ${gaps.required.length} use case(s) testable that your plan had to answer for${gaps.others > 0 ? `, and ${gaps.others} less direct one(s) it did not` : ""}.`,
    gaps.unvisited.length > 0 ? ["No flow of your plan covers:", ...lines(gaps.unvisited)].join("\n") : "",
    gaps.unproven.length > 0 ? ["No flow that covers it holds a spec that passed run_spec:", ...lines(gaps.unproven)].join("\n") : "",
    last
      ? "A use case named here whose behaviour the change alters stays untested by this run."
      : `A use case named here whose behaviour the change alters is untested: "revise" the flow that should cover it, naming the page and what to assert there.`,
  ].filter(Boolean).join("\n");
}

/* The review turn: the flows as the orchestrator knows them and the use cases no passing flow covers. */
export const LEAD_REVIEW_SECTIONS: readonly PromptSectionDef<ReviewPromptContext>[] = [
  section({
    id: "review",
    priority: 10,
    applies: () => true,
    render: (ctx) => ({
      content: [`## Review of the flows (turn ${ctx.turn.turn} of ${ctx.turn.maxTurns})`, isLastReview(ctx) ? "This is the last review: each flow can only be accepted or dropped." : ""].filter(Boolean).join("\n\n"),
    }),
  }),
  section({
    id: "flows",
    priority: 20,
    applies: ({ flows }) => flows.length > 0,
    render: (ctx) => ({ content: ctx.flows.map((flow) => flowBlock(ctx.scrub, flow)).join("\n\n") }),
  }),
  section({
    id: "candidates",
    priority: 30,
    applies: ({ gaps }) => gaps !== undefined,
    render: (ctx) => ({ content: candidatesBlock(ctx.scrub, ctx.gaps!, isLastReview(ctx)) }),
  }),
];

/* ── correction ── */

export interface CorrectionPromptContext {
  flows: readonly FlowUnderCorrection[];
  findings: readonly CorrectionFinding[];
  /* The flow each finding belongs to, by position; undefined where it cites none. */
  owner: readonly (string | undefined)[];
  /* The origin's heading and lead, and whether its findings are a judgment the lead may rebut. */
  origin: { heading: string; lead: string; rebuttable: boolean };
  /* How many further units of the gap this turn does not list. */
  omitted: number;
  scrub(text: string): string;
}

const looseFindings = (ctx: CorrectionPromptContext): number[] => ctx.findings.flatMap((_, i) => (ctx.owner[i] === undefined ? [i] : []));

const findingLine = (ctx: CorrectionPromptContext, index: number): string => `${index + 1}. ${ctx.scrub(ctx.findings[index]!.text)}`;

function correctionFlowBlocks(ctx: CorrectionPromptContext): string[] {
  return ctx.flows.flatMap((flow) => {
    const own = ctx.findings.flatMap((_, i) => (ctx.owner[i] === flow.id ? [i] : []));
    if (own.length === 0) return [];
    return [[
      `### Flow \`${flow.id}\` (${flow.specFile})`,
      `Objective: ${ctx.scrub(flow.objective)}`,
      ...(flow.candidates?.length ? [`Use cases it covers: ${flow.candidates.join(", ")}`] : []),
      ["Findings on its spec:", ...own.map((i) => findingLine(ctx, i))].join("\n"),
      flow.spec !== undefined ? ["Spec:", "```ts", cut(ctx.scrub(flow.spec), MAX_SPEC_CHARS), "```"].join("\n") : "Spec: not readable.",
    ].join("\n")];
  });
}

/* The correction turn: the flows with the findings that cite them, numbered, and the findings that cite no flow. */
export const LEAD_CORRECTION_SECTIONS: readonly PromptSectionDef<CorrectionPromptContext>[] = [
  section({
    id: "correction",
    priority: 10,
    applies: () => true,
    render: ({ origin, omitted }) => ({
      content: [
        `## ${origin.heading}`,
        origin.lead,
        origin.rebuttable ? "" : "These are facts the run observed: each one is corrected, none is rebutted.",
        omitted > 0 ? `${omitted} further unit(s) of the gap are not listed in this turn: the run records the count as left out and no one corrects them now.` : "",
      ].filter(Boolean).join("\n\n"),
    }),
  }),
  section({
    id: "flows",
    priority: 20,
    applies: (ctx) => correctionFlowBlocks(ctx).length > 0,
    render: (ctx) => ({ content: correctionFlowBlocks(ctx).join("\n\n") }),
  }),
  /* Where a finding about a source file goes is decided by the use cases a flow covers, so with findings to place every flow is listed with them. */
  section({
    id: "catalogue",
    priority: 25,
    applies: (ctx) => looseFindings(ctx).length > 0,
    render: (ctx) => ({
      content: ["### The flows and the use cases they cover", ...ctx.flows.map((flow) => `- \`${flow.id}\` (${flow.specFile}): ${flow.candidates?.length ? flow.candidates.join(", ") : "no use case cited"}`)].join("\n"),
    }),
  }),
  section({
    id: "unrouted",
    priority: 30,
    applies: (ctx) => looseFindings(ctx).length > 0,
    render: (ctx) => {
      const instruction = ctx.origin.rebuttable
        ? "Name the flow each one belongs to, or rebut it."
        : "Name the flow each one belongs to: an order lists the numbers of the findings the flow is to take. One no flow takes is recorded unrouted and no one corrects it.";
      return { content: ["### Findings that cite no flow", instruction, ...looseFindings(ctx).map((i) => findingLine(ctx, i))].join("\n") };
    },
  }),
];

/* ── rejected plan ── */

export interface RejectedPlanPromptContext {
  /* The refusal's code and what it says the plan got wrong, in words. */
  downgrade: string;
  fact: string;
}

/* The one request that sends a refused plan back to the lead: why it was refused (by its code and in words), and what to answer. */
export const REJECTED_PLAN_SECTIONS: readonly PromptSectionDef<RejectedPlanPromptContext>[] = [
  section({
    id: "rejected-plan",
    priority: 10,
    applies: () => true,
    render: ({ downgrade, fact }) => ({
      content: [
        "## Your plan was not admitted",
        `The orchestrator refused the plan (${downgrade}): ${fact}.`,
        "Answer with ONLY the corrected plan JSON object, in one of the shapes of the plan contract. This is the only other plan turn of this run.",
      ].join("\n"),
    }),
  }),
];

/* ── refused correction ── */

export interface RefusedCorrectionPromptContext {
  refused: readonly { flowId?: string; finding?: number; reason: string }[];
  findingCount: number;
}

/* The one request that sends a refused answer back to the lead: why each part of it was not admitted, the numbers that are findings, and what to answer. */
export const REFUSED_CORRECTION_SECTIONS: readonly PromptSectionDef<RefusedCorrectionPromptContext>[] = [
  section({
    id: "refused",
    priority: 10,
    applies: () => true,
    render: ({ refused, findingCount }) => ({
      content: [
        "## Your correction was not admitted",
        "The orchestrator did not admit these parts of your answer:",
        ...refused.map((r) => `- ${r.flowId ? `flow ${r.flowId}` : "the answer"}${r.finding ? `, finding ${r.finding}` : ""}: ${r.reason}`),
        `The findings are numbered 1..${findingCount}, each number is one finding, and an order names the findings its flow is to take by those numbers.`,
        "Answer with ONLY the corrected JSON object of the correction contract, complete (repeat every order and rebuttal you still hold). This is the only other correction turn for these findings.",
      ].join("\n"),
    }),
  }),
];

/* ── exploration outcome ── */

export interface ExploreOutcomePromptContext {
  skipped?: string;
  questions: readonly VerifiedExploration[];
  scrub(text: string): string;
}

const LABEL: Record<(typeof FINDING_VERIFICATION)[keyof typeof FINDING_VERIFICATION], string> = {
  [FINDING_VERIFICATION.VERIFIED]: "verified by the orchestrator",
  [FINDING_VERIFICATION.UNVERIFIED]: "CLAIM, not verified",
  [FINDING_VERIFICATION.CONTRADICTED]: "CONTRADICTED by the orchestrator's own read",
};

function findingsText({ skipped, questions, scrub }: ExploreOutcomePromptContext): string {
  const lines: string[] = ["## Exploration findings", "The orchestrator ran the exploration you asked for. Verified findings are facts; a claim that is not verified is only the explore sidekick's word; where a finding is contradicted, the orchestrator's read stands."];
  if (skipped) lines.push(`No exploration ran: ${scrub(skipped)}. Plan from what you have.`);
  for (const question of questions) {
    lines.push("", `### ${question.id}: ${scrub(question.question)}`, `status: ${question.status}`);
    if (question.findings.length === 0) lines.push("(no findings)");
    for (const finding of question.findings) {
      lines.push(`- [${LABEL[finding.verification]}] (${finding.kind}) ${scrub(finding.claim)} | ref: ${scrub(finding.ref)} | evidence: ${scrub(finding.evidence)}${finding.contradictedBy ? ` | the orchestrator: ${scrub(finding.contradictedBy)}` : ""}`);
    }
  }
  return lines.join("\n");
}

/* The lead's turn after its exploration: the findings labelled by what the orchestrator checked, and the one answer that is left to give. */
export const EXPLORE_OUTCOME_SECTIONS: readonly PromptSectionDef<ExploreOutcomePromptContext>[] = [
  section({ id: "exploration", priority: 10, applies: () => true, render: (ctx) => ({ content: findingsText(ctx) }) }),
  section({
    id: "answer",
    priority: 20,
    applies: () => true,
    render: () => ({ content: 'Now answer with your plan: ONLY the JSON object `{"plan":...}` (or the declared no-op). You cannot explore again.' }),
  }),
];

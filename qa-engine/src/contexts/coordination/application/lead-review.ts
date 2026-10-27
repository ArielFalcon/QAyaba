/*
 * The lead's review of what the sidekicks authored. The lead is shown, per flow, what it asked for, what came of it, what the
 * orchestrator saw of the flow's run_spec calls and the spec the sidekick wrote, and answers per flow: accept it, send an
 * instruction to the same sidekick (revise), start a fresh sidekick on it (replace), or drop it. The answer is the lead's word and
 * is admitted here against the orchestrator's facts, which decide over it: a spec that has not passed run_spec on its current
 * bytes is not accepted while a review turn is left (when its last call failed, even with no call left to run it again); an app defect is never sent back to be made green;
 * a delivered spec is not dropped (it is already in the working copy, and the run's execution and the reviewer judge it).
 * Pure: no clock, no file, no model.
 */

import { candidateLine, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { flowCovers, type AdmissionSet } from "./plan-coverage.ts";
import { FLOW_OUTCOME, type FlowOutcome } from "./flow-outcomes.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";

export const REVIEW_ACTION = {
  ACCEPT: "accept",
  REVISE: "revise",
  REPLACE: "replace",
  DROP: "drop",
} as const;
export type ReviewAction = (typeof REVIEW_ACTION)[keyof typeof REVIEW_ACTION];

/* The most review turns a coordinated pass asks the lead for; revisions are ordered in every turn but the last. */
export const MAX_REVIEW_TURNS = 3;
export const MAX_SPEC_CHARS = 8_000;
export const MAX_INSTRUCTION_CHARS = 1_200;
const MAX_REASON_CHARS = 400;

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

export interface ReviewOrder {
  flowId: string;
  action: typeof REVIEW_ACTION.REVISE | typeof REVIEW_ACTION.REPLACE;
  instruction: string;
  /* Set when the order is not the action the lead gave: why the orchestrator changed it (an `OVERRIDE` code). */
  overrideReason?: string;
}

/* The codes of why the orchestrator did not take a lead decision as given. */
export const REVIEW_OVERRIDE = {
  NOTHING_DELIVERED: "nothing-delivered",
  UNVERIFIED_SENT_BACK: "unverified-sent-back",
  UNVERIFIED_NO_TURN: "unverified-no-turn-left",
  APP_DEFECT: "app-defect",
  NO_TURN_LEFT: "no-turn-left",
  NEEDS_INSTRUCTION: "needs-instruction",
  DELIVERED_DROP: "delivered-drop",
  SESSION_GONE: "session-gone",
} as const;

export interface ReviewAdmission {
  /* Whether the answer could be read at all. */
  readable: boolean;
  /* The revisions to carry out, in the order the lead gave them. */
  orders: ReviewOrder[];
  accepted: string[];
  dropped: Array<{ flowId: string; reason: string }>;
  /* What the lead asked that the orchestrator did not take, and why. */
  refused: Array<{ flowId: string; action: string; reason: string; code: string }>;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

function runSpecLine(redaction: RedactionPort, flow: FlowUnderReview): string {
  if (!flow.runSpec) return "run_spec: not available to this flow.";
  const { calls, maxCalls, lastStatus, lastFailure } = flow.runSpec;
  const verified = flow.verified ? "the spec it holds now is the one that passed" : "the spec it holds now has NOT passed run_spec";
  return [
    `run_spec: ${calls} of ${maxCalls} calls used${lastStatus ? `; last call ${lastStatus}` : ""}; ${verified}.`,
    lastFailure ? `Last failure: ${redaction.redact(lastFailure)}` : "",
  ].filter(Boolean).join("\n");
}

function flowBlock(redaction: RedactionPort, flow: FlowUnderReview): string {
  return [
    `### Flow \`${flow.id}\``,
    `Objective: ${redaction.redact(flow.objective)}`,
    flow.acceptance.length > 0 ? ["Acceptance:", ...flow.acceptance.map((a, i) => `${i + 1}. ${redaction.redact(a)}`)].join("\n") : "",
    `Outcome: ${flow.outcome.kind}${flow.outcome.reason ? ` (${redaction.redact(flow.outcome.reason)})` : ""}`,
    flow.summary ? `Sidekick says: ${redaction.redact(flow.summary)}` : "",
    flow.concerns.length > 0 ? `Sidekick concerns: ${flow.concerns.map((concern) => redaction.redact(concern)).join("; ")}` : "",
    runSpecLine(redaction, flow),
    flow.appDefect ? `App defect shown by its run: ${redaction.redact(flow.appDefect)}. It is reported as it ran and is never sent back to be made green.` : "",
    flow.spec !== undefined ? ["Spec:", "```ts", cut(redaction.redact(flow.spec), MAX_SPEC_CHARS), "```"].join("\n") : "Spec: none delivered.",
  ].filter(Boolean).join("\n");
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

export function candidateGapsOf(
  admission: AdmissionSet,
  dropped: ReadonlySet<string>,
  flows: ReadonlyArray<{ routes: readonly string[]; candidates: readonly string[]; review: FlowUnderReview }>,
): CandidateGaps | undefined {
  const open = admission.required.filter((candidate) => !dropped.has(candidate.id));
  const unvisited = open.filter((candidate) => !flows.some((flow) => flowCovers(flow, candidate)));
  const unproven = open.filter((candidate) => {
    const visiting = flows.filter((flow) => flowCovers(flow, candidate));
    if (visiting.length === 0) return false;
    return visiting.every(({ review }) => review.runSpec !== undefined && !(review.verified && review.outcome.kind === FLOW_OUTCOME.DELIVERED));
  });
  return unvisited.length > 0 || unproven.length > 0 ? { required: admission.required, unvisited, unproven, others: admission.others } : undefined;
}

function candidatesBlock(redaction: RedactionPort, gaps: CandidateGaps, last: boolean): string {
  const lines = (candidates: readonly UseCaseCandidate[]): string[] => candidates.map((candidate) => `- ${redaction.redact(candidateLine(candidate))}`);
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

/* The review turn's prompt, as data: the flows as the orchestrator knows them and the use cases no passing flow covers. How to judge them and the answer's shape are the lead's role prompt. */
export function renderLeadReview(redaction: RedactionPort, flows: readonly FlowUnderReview[], turn: { turn: number; maxTurns: number }, gaps?: CandidateGaps): string {
  const last = turn.turn >= turn.maxTurns;
  return [
    `## Review of the flows (turn ${turn.turn} of ${turn.maxTurns})`,
    last ? "This is the last review: each flow can only be accepted or dropped." : "",
    ...flows.map((flow) => flowBlock(redaction, flow)),
    ...(gaps ? [candidatesBlock(redaction, gaps, last)] : []),
  ].filter(Boolean).join("\n\n");
}

function textOf(redaction: RedactionPort, value: unknown, max: number): string {
  return typeof value === "string" ? redaction.redact(value).trim().slice(0, max) : "";
}

const ACTIONS = new Set<string>(Object.values(REVIEW_ACTION));

/* What the orchestrator tells a sidekick whose spec was accepted before it passed. */
function verifyInstruction(redaction: RedactionPort, flow: FlowUnderReview): string {
  const failure = flow.runSpec?.lastFailure ? ` Its last failure: ${redaction.redact(flow.runSpec.lastFailure)}` : "";
  return `Your spec has not passed run_spec on its current bytes.${failure} Run it, make it pass without weakening an assertion, and report again.`;
}

export function admitLeadReview(redaction: RedactionPort, output: string, flows: readonly FlowUnderReview[], opts: { revisionsAllowed: boolean }): ReviewAdmission {
  const admission: ReviewAdmission = { readable: false, orders: [], accepted: [], dropped: [], refused: [] };
  const raw = lastJsonObjectWhere(output, (o) => Array.isArray(o.review)) as { review: unknown[] } | undefined;
  if (!raw) return admission;
  admission.readable = true;
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const seen = new Set<string>();
  const refuse = (flowId: string, action: string, code: string, reason: string): void => void admission.refused.push({ flowId, action, reason, code });
  const order = (flow: FlowUnderReview, action: ReviewOrder["action"], instruction: string, overrideReason?: string): void => {
    /* A sidekick whose session is gone cannot be asked again: a fresh one takes the flow. */
    const effective = action === REVIEW_ACTION.REVISE && !flow.sessionOpen ? REVIEW_ACTION.REPLACE : action;
    admission.orders.push({ flowId: flow.id, action: effective, instruction, ...(overrideReason !== undefined ? { overrideReason } : effective !== action ? { overrideReason: REVIEW_OVERRIDE.SESSION_GONE } : {}) });
  };

  for (const entry of raw.review) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const flow = typeof e.flow === "string" ? byId.get(e.flow) : undefined;
    const action = typeof e.action === "string" && ACTIONS.has(e.action) ? (e.action as ReviewAction) : undefined;
    if (!flow || !action || seen.has(flow.id)) continue;
    seen.add(flow.id);
    const instruction = textOf(redaction, e.instruction, MAX_INSTRUCTION_CHARS);
    const reason = textOf(redaction, e.reason, MAX_REASON_CHARS);
    const delivered = flow.outcome.kind === FLOW_OUTCOME.DELIVERED;

    switch (action) {
      case REVIEW_ACTION.ACCEPT: {
        if (!delivered) {
          refuse(flow.id, action, REVIEW_OVERRIDE.NOTHING_DELIVERED, "nothing was delivered to accept");
          break;
        }
        /* Sent back: a spec whose last call failed, or one the flow can still run that has not passed on its current bytes. */
        const lastFailed = flow.runSpec?.lastStatus === "failed";
        const canRun = flow.runSpec !== undefined && flow.runSpec.calls < flow.runSpec.maxCalls;
        if (flow.verified || flow.appDefect !== undefined || !(lastFailed || canRun)) {
          admission.accepted.push(flow.id);
          break;
        }
        if (opts.revisionsAllowed) {
          refuse(flow.id, action, REVIEW_OVERRIDE.UNVERIFIED_SENT_BACK, "the spec has not passed run_spec on its current bytes; it is sent back with the orchestrator's facts");
          order(flow, REVIEW_ACTION.REVISE, verifyInstruction(redaction, flow), REVIEW_OVERRIDE.UNVERIFIED_SENT_BACK);
        } else {
          refuse(flow.id, action, REVIEW_OVERRIDE.UNVERIFIED_NO_TURN, "the spec has not passed run_spec on its current bytes and no review turn is left; the run's execution judges it");
          admission.accepted.push(flow.id);
        }
        break;
      }
      case REVIEW_ACTION.REVISE:
      case REVIEW_ACTION.REPLACE: {
        if (flow.appDefect !== undefined) {
          refuse(flow.id, action, REVIEW_OVERRIDE.APP_DEFECT, `the flow showed an app defect (${redaction.redact(flow.appDefect)}), which is never sent back to be made green`);
          break;
        }
        if (!opts.revisionsAllowed) {
          refuse(flow.id, action, REVIEW_OVERRIDE.NO_TURN_LEFT, "no review turn is left to judge a revision");
          break;
        }
        if (action === REVIEW_ACTION.REVISE && instruction === "") {
          refuse(flow.id, action, REVIEW_OVERRIDE.NEEDS_INSTRUCTION, "a revision needs an instruction");
          break;
        }
        order(flow, action, instruction || "Author this flow again from the brief.");
        break;
      }
      case REVIEW_ACTION.DROP: {
        if (delivered) {
          refuse(flow.id, action, REVIEW_OVERRIDE.DELIVERED_DROP, "a delivered spec is already in the working copy; the run's execution and the reviewer judge it");
          break;
        }
        admission.dropped.push({ flowId: flow.id, reason: reason || "dropped by the lead" });
        break;
      }
    }
  }
  return admission;
}

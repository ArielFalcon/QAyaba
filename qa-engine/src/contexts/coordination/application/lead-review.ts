/*
 * The lead's review of what the sidekicks authored. The lead is shown, per flow, what it asked for, what came of it, what the
 * orchestrator saw of the flow's run_spec calls and the spec the sidekick wrote, and answers per flow: accept it, send an
 * instruction to the same sidekick (revise), start a fresh sidekick on it (replace), or drop it. The answer is the lead's word and
 * is admitted here against the orchestrator's facts, which decide over it: a spec that has not passed run_spec on its current
 * bytes is not accepted while a review turn is left (when its last call failed, even with no call left to run it again); an app defect is never sent back to be made green;
 * a delivered spec is not dropped (it is already in the working copy, and the run's execution and the reviewer judge it).
 * Pure: no clock, no file, no model.
 */

import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import { flowCovers, type AdmissionSet } from "./plan-coverage.ts";
import { FLOW_OUTCOME } from "./flow-outcomes.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { LEAD_REVIEW_SECTIONS, MAX_SPEC_CHARS, type CandidateGaps, type FailureBytes, type FlowUnderReview, type SidekickAnswer } from "./coordination-sections/lead-turn-sections.ts";

/* How the instruction that sends a spec back qualifies its last failure. */
const FAILURE_INSTRUCTION_NOTE: Record<FailureBytes, string> = { current: "", earlier: ", seen on earlier bytes", "no-spec": ", while the flow held no spec" };
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";
import { sha256Hex } from "@kernel/content-hash.ts";

export { MAX_SPEC_CHARS, type CandidateGaps, type FailureBytes, type FlowUnderReview, type SidekickAnswer };

export const REVIEW_ACTION = {
  ACCEPT: "accept",
  REVISE: "revise",
  REPLACE: "replace",
  DROP: "drop",
} as const;
export type ReviewAction = (typeof REVIEW_ACTION)[keyof typeof REVIEW_ACTION];

/* The most review turns a coordinated pass asks the lead for; revisions are ordered in every turn but the last. */
export const MAX_REVIEW_TURNS = 3;
export const MAX_INSTRUCTION_CHARS = 1_200;
const MAX_REASON_CHARS = 400;

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

/* The review turn's prompt, as data: the flows as the orchestrator knows them and the use cases no passing flow covers, assembled from the registered sections. How to judge them and the answer's shape are the lead's role prompt. */
export function assembleLeadReview(redaction: RedactionPort, flows: readonly FlowUnderReview[], turn: { turn: number; maxTurns: number }, gaps?: CandidateGaps): AssembledPrompt {
  return assembleDefs(LEAD_REVIEW_SECTIONS, { flows, turn, ...(gaps ? { gaps } : {}), scrub: (text) => redaction.redact(text) }, { separator: "\n\n" });
}

/* What the lead was shown of each flow's spec in a session: the review turn and the bytes' sha256. */
export type SeenSpecs = Map<string, { turn: number; sha256: string }>;

const SHA_SHOWN = 12;

/*
 * The flows as one review turn shows them: a flow whose spec bytes are those the lead was last shown in this session carries a digest
 * (since which turn, sha256, line count) instead of the spec. `seen` is the session's memory and is updated with what this turn shows.
 */
export function withSpecDigests(flows: readonly FlowUnderReview[], seen: SeenSpecs, turn: number): FlowUnderReview[] {
  return flows.map((flow) => {
    if (flow.spec === undefined) return flow;
    const sha256 = sha256Hex(flow.spec);
    const before = seen.get(flow.id);
    if (before?.sha256 === sha256) {
      const { spec, ...rest } = flow;
      return { ...rest, specUnchanged: { sinceTurn: before.turn, sha256: sha256.slice(0, SHA_SHOWN), lines: spec.split("\n").length } };
    }
    seen.set(flow.id, { turn, sha256 });
    return flow;
  });
}

export function renderLeadReview(redaction: RedactionPort, flows: readonly FlowUnderReview[], turn: { turn: number; maxTurns: number }, gaps?: CandidateGaps): string {
  return assembleLeadReview(redaction, flows, turn, gaps).text;
}

function textOf(redaction: RedactionPort, value: unknown, max: number): string {
  return typeof value === "string" ? redaction.redact(value).trim().slice(0, max) : "";
}

const ACTIONS = new Set<string>(Object.values(REVIEW_ACTION));

/* What the orchestrator tells a sidekick whose spec was accepted before it passed. */
function verifyInstruction(redaction: RedactionPort, flow: FlowUnderReview): string {
  const failure = flow.runSpec?.lastFailure ? ` Its last failure${FAILURE_INSTRUCTION_NOTE[flow.runSpec.lastFailureOn ?? "earlier"]}: ${redaction.redact(flow.runSpec.lastFailure)}` : "";
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

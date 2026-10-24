/*
 * The reviewer's verified corrections, routed by the lead to the flows that own them. After the run's execution and the
 * independent review, the lead is shown, per flow, the spec its sidekick delivered and the findings that cite it, plus the findings
 * that cite no flow, numbered; it answers per flow (revise in the same sidekick session, or replace with a fresh one) and per
 * finding (a rebuttal, with the basis the run checks). The answer is the lead's word and the orchestrator's facts decide over it: a
 * finding that cites a flow's spec goes to that flow whatever the lead routes, a finding that cites one flow is never moved to
 * another, and a flow with findings the lead neither ordered nor rebutted is sent them with the orchestrator's own instruction.
 * Pure: no clock, no file, no model.
 */

import { REVIEW_ACTION, MAX_INSTRUCTION_CHARS, MAX_SPEC_CHARS, firstJsonObject } from "./lead-review.ts";
import { scrub } from "./scrub.ts";

const MAX_REF_CHARS = 400;
const MAX_REASON_CHARS = 400;

/* One verified blocking finding of the reviewer, with the spec its citation names when it names one. */
export interface ReviewerFinding {
  text: string;
  spec?: string;
}

export interface FlowUnderCorrection {
  id: string;
  objective: string;
  /* The flow's spec, relative to the spec directory. */
  specFile: string;
  sessionOpen: boolean;
  /* The spec as the working copy holds it now. */
  spec?: string;
}

export interface CorrectionOrder {
  flowId: string;
  action: typeof REVIEW_ACTION.REVISE | typeof REVIEW_ACTION.REPLACE;
  /* The lead's instruction, or the orchestrator's when the lead gave none. */
  instruction: string;
  /* The findings the flow is sent, verbatim. */
  findings: string[];
}

export interface CorrectionRebuttal {
  finding: string;
  basis: "execution" | "contract";
  ref: string;
  reason: string;
}

export interface CorrectionAdmission {
  readable: boolean;
  orders: CorrectionOrder[];
  rebuttals: CorrectionRebuttal[];
  /* Findings no flow was sent and the lead did not rebut. */
  unrouted: string[];
  refused: Array<{ flowId?: string; finding?: number; reason: string }>;
}

export const DEFAULT_CORRECTION_INSTRUCTION = "Apply the reviewer's findings below to your spec.";

/* The flow a finding belongs to: the one whose spec its citation, or failing that its text, names. */
export function flowOfFinding(finding: ReviewerFinding, flows: readonly FlowUnderCorrection[]): string | undefined {
  const names = (path: string, spec: string): boolean => path === spec || path.endsWith(`/${spec}`);
  const cited = finding.spec?.replaceAll("\\", "/");
  if (cited) return flows.find((flow) => names(cited, flow.specFile))?.id;
  return flows.find((flow) => finding.text.includes(flow.specFile))?.id;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

/* The correction turn's prompt: the flows, the findings numbered, and the answer it reads. */
export function renderLeadCorrection(flows: readonly FlowUnderCorrection[], findings: readonly ReviewerFinding[]): string {
  const owner = findings.map((finding) => flowOfFinding(finding, flows));
  const line = (index: number): string => `${index + 1}. ${scrub(findings[index]!.text)}`;
  const blocks = flows.flatMap((flow) => {
    const own = findings.flatMap((_, i) => (owner[i] === flow.id ? [i] : []));
    if (own.length === 0) return [];
    return [[
      `### Flow \`${flow.id}\` (${flow.specFile})`,
      `Objective: ${scrub(flow.objective)}`,
      ["Findings on its spec:", ...own.map(line)].join("\n"),
      flow.spec !== undefined ? ["Spec:", "```ts", cut(scrub(flow.spec), MAX_SPEC_CHARS), "```"].join("\n") : "Spec: not readable.",
    ].join("\n")];
  });
  const loose = findings.flatMap((_, i) => (owner[i] === undefined ? [i] : []));
  return [
    "## The reviewer's corrections",
    "The run executed the specs your sidekicks delivered and an independent reviewer judged them. These findings are verified: each one cites a contract clause or an execution of this run.",
    `Route each finding to the sidekick of its flow: "${REVIEW_ACTION.REVISE}" sends your instruction and the flow's findings to the same sidekick, which keeps what it learned; "${REVIEW_ACTION.REPLACE}" starts a fresh sidekick on the flow. A finding you hold to be wrong can be rebutted instead, with the evidence the run can check: "execution" and a test of this run that passed on the current bytes, or "contract" and the clause that still holds.`,
    ...blocks,
    loose.length > 0 ? ["### Findings that cite no flow", "Name the flow each one belongs to, or rebut it.", ...loose.map(line)].join("\n") : "",
    "## Answer",
    "Answer with this JSON object and nothing else. A flow's own findings are always sent to it; `findings` adds the numbers of findings that cite no flow.",
    `{"corrections":[{"flow":"<flow id>","action":"${REVIEW_ACTION.REVISE}|${REVIEW_ACTION.REPLACE}","findings":[<number>],"instruction":"<what to change>"}],"rebuttals":[{"finding":<number>,"basis":"execution|contract","ref":"<test or clause>","reason":"<why the finding is wrong>"}]}`,
  ].filter(Boolean).join("\n\n");
}

function textOf(value: unknown, max: number): string {
  return typeof value === "string" ? scrub(value).trim().slice(0, max) : "";
}

export function admitLeadCorrection(output: string, flows: readonly FlowUnderCorrection[], findings: readonly ReviewerFinding[]): CorrectionAdmission {
  const admission: CorrectionAdmission = { readable: false, orders: [], rebuttals: [], unrouted: [], refused: [] };
  const owner = findings.map((finding) => flowOfFinding(finding, flows));
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const raw = firstJsonObject(output) as { corrections?: unknown; rebuttals?: unknown } | undefined;
  const readable = raw !== undefined && typeof raw === "object" && (Array.isArray(raw.corrections) || Array.isArray(raw.rebuttals));
  admission.readable = readable;
  const routed = new Map<string, { action: CorrectionOrder["action"]; instruction: string; extra: Set<number> }>();
  const rebutted = new Set<number>();
  const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= findings.length ? value - 1 : undefined);

  if (readable) {
    for (const entry of Array.isArray(raw!.corrections) ? raw!.corrections : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const flow = typeof e.flow === "string" ? byId.get(e.flow) : undefined;
      if (!flow || routed.has(flow.id)) continue;
      const action = e.action === REVIEW_ACTION.REPLACE ? REVIEW_ACTION.REPLACE : REVIEW_ACTION.REVISE;
      const extra = new Set<number>();
      for (const n of Array.isArray(e.findings) ? e.findings : []) {
        const index = numberOf(n);
        if (index === undefined) continue;
        if (owner[index] !== undefined && owner[index] !== flow.id) {
          admission.refused.push({ flowId: flow.id, finding: index + 1, reason: `the finding cites flow ${owner[index]}'s spec and stays with it` });
          continue;
        }
        if (owner[index] === undefined) extra.add(index);
      }
      routed.set(flow.id, { action, instruction: textOf(e.instruction, MAX_INSTRUCTION_CHARS), extra });
    }
    for (const entry of Array.isArray(raw!.rebuttals) ? raw!.rebuttals : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const index = numberOf(e.finding);
      const basis = e.basis === "execution" || e.basis === "contract" ? e.basis : undefined;
      const ref = textOf(e.ref, MAX_REF_CHARS);
      if (index === undefined || !basis || ref === "" || rebutted.has(index)) continue;
      rebutted.add(index);
      admission.rebuttals.push({ finding: findings[index]!.text, basis, ref, reason: textOf(e.reason, MAX_REASON_CHARS) });
    }
  }

  const sent = new Set<number>();
  for (const flow of flows) {
    const own = findings.flatMap((_, i) => (owner[i] === flow.id && !rebutted.has(i) ? [i] : []));
    const order = routed.get(flow.id);
    const indices = [...own, ...[...(order?.extra ?? [])].filter((i) => !rebutted.has(i))];
    if (indices.length === 0) {
      if (order) admission.refused.push({ flowId: flow.id, reason: "the order names no finding the flow is to correct" });
      continue;
    }
    for (const i of indices) sent.add(i);
    const action = order?.action === REVIEW_ACTION.REPLACE || !flow.sessionOpen ? REVIEW_ACTION.REPLACE : REVIEW_ACTION.REVISE;
    admission.orders.push({ flowId: flow.id, action, instruction: order?.instruction || DEFAULT_CORRECTION_INSTRUCTION, findings: indices.map((i) => findings[i]!.text) });
  }
  admission.unrouted = findings.flatMap((finding, i) => (sent.has(i) || rebutted.has(i) ? [] : [finding.text]));
  return admission;
}

/*
 * Corrections routed by the lead to the flows that own them: the reviewer's verified findings, or what the run's own checks
 * observed of the flows' specs (the static gate, the execution, the change-coverage, the pre-execution selector check). The lead
 * is shown, per flow, the spec its sidekick delivered and the findings that cite it, plus the findings that cite no flow,
 * numbered; it answers per flow (revise in the same sidekick session, or replace with a fresh one) and, for the reviewer's
 * findings only, per finding (a rebuttal, with the basis the run checks). The answer is the lead's word and the orchestrator's facts decide over it: a
 * finding that cites a flow's spec goes to that flow whatever the lead routes, a finding that cites one flow is never moved to
 * another, and a flow with findings the lead neither ordered nor rebutted is sent them with the orchestrator's own instruction.
 * Pure: no clock, no file, no model.
 */

import { REVIEW_ACTION, MAX_INSTRUCTION_CHARS } from "./lead-review.ts";
import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import { LEAD_CORRECTION_SECTIONS, REFUSED_CORRECTION_SECTIONS, type CorrectionFinding, type FlowUnderCorrection } from "./coordination-sections/lead-turn-sections.ts";

export type { CorrectionFinding, FlowUnderCorrection };
import { lastJsonObjectWhere } from "@kernel/last-json-object.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";

const MAX_REF_CHARS = 400;
const MAX_REASON_CHARS = 400;

/*
 * Where a correction turn's findings come from: the independent reviewer, or the orchestrator's own checks after the flows were
 * authored (the static gate, the execution against DEV, the change-coverage measurement, the pre-execution selector check). Only a
 * reviewer's finding is a judgment the lead may rebut; the others are facts the run observed, and every one of them is corrected.
 */
export const CORRECTION_ORIGIN = {
  REVIEW: "review",
  STATIC_GATE: "static-gate",
  EXECUTION: "execution",
  FLAKY: "flaky",
  COVERAGE: "coverage",
  PRE_EXEC: "pre-exec",
} as const;
export type CorrectionOrigin = (typeof CORRECTION_ORIGIN)[keyof typeof CORRECTION_ORIGIN];

const ORIGIN_TEXT: Record<CorrectionOrigin, { heading: string; lead: string; sidekick: string }> = {
  review: {
    heading: "The reviewer's corrections",
    lead: "The run executed the specs your sidekicks delivered and an independent reviewer judged them. These findings are verified: each one cites a contract clause or an execution of this run.",
    sidekick: "The independent reviewer judged your spec after the run executed it. These findings are verified by the orchestrator:",
  },
  "static-gate": {
    heading: "The static gate's errors",
    lead: "The orchestrator's static gate (type check, lint, test listing) refused the specs your sidekicks delivered. Each finding is an error it reported.",
    sidekick: "The orchestrator's static gate refused your spec. What it reported:",
  },
  execution: {
    heading: "The run's failing tests",
    lead: "The run executed the specs your sidekicks delivered against DEV and these failed. Each finding is what the execution reported, or a fact the orchestrator found in the failure.",
    sidekick: "The run executed your spec against DEV and it failed. What the orchestrator observed:",
  },
  flaky: {
    heading: "Tests that passed only on retry",
    lead: "The run executed the specs your sidekicks delivered against DEV and these failed their first attempt and passed on retry. Each finding is what the first attempt showed.",
    sidekick: "The run executed your spec against DEV: it failed its first attempt and passed on retry. What the orchestrator observed:",
  },
  coverage: {
    heading: "Changed lines no test exercised",
    lead: "The run passed, but the change-coverage measurement found changed lines that none of the delivered specs exercised.",
    sidekick: "The run passed, but changed lines no test exercised remain. Extend your spec to exercise those of your flow:",
  },
  "pre-exec": {
    heading: "Selectors the page does not have",
    lead: "Before the specs ran, the orchestrator checked their selectors against the pages it captured from DEV. These selectors are not on the page.",
    sidekick: "Before your spec ran, the orchestrator checked its selectors against the page it captured from DEV. These are not on the page:",
  },
};

/* What the sidekick is told the findings it is sent are. */
export function correctionPreamble(origin: CorrectionOrigin): string {
  return ORIGIN_TEXT[origin].sidekick;
}

/* Whether the findings of this origin are a judgment the lead may rebut. */
const rebuttable = (origin: CorrectionOrigin): boolean => origin === CORRECTION_ORIGIN.REVIEW;

export interface CorrectionOrder {
  flowId: string;
  action: typeof REVIEW_ACTION.REVISE | typeof REVIEW_ACTION.REPLACE;
  /* The lead's instruction, or the orchestrator's when the lead gave none. */
  instruction: string;
  /* The findings the flow is sent, verbatim. */
  findings: string[];
  /* Their positions among the turn's findings, in the same order. */
  indices: number[];
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
  /* The positions of the findings no flow was sent and the lead did not rebut. */
  unrouted: number[];
  refused: Array<{ flowId?: string; finding?: number; reason: string }>;
}

export const DEFAULT_CORRECTION_INSTRUCTION = "Correct your spec for the findings above.";

/* The characters a path is made of: a spec named in a text ends where they do. */
const PATH_CHAR = /[A-Za-z0-9._\/-]/;
const isPathChar = (c: string | undefined): boolean => c !== undefined && PATH_CHAR.test(c);

/*
 * Whether the text names this spec as a whole path, on its own or as the tail of a longer one (`e2e/flows/a.spec.ts`), and not
 * as part of another name (`flows/a.spec.tsx`, `old-flows/a.spec.ts`). A full stop that ends a sentence ends the path too.
 */
function namesSpecIn(text: string, spec: string): boolean {
  for (let at = text.indexOf(spec); at !== -1; at = text.indexOf(spec, at + 1)) {
    const before = text[at - 1];
    const end = at + spec.length;
    const startsClean = before === undefined || before === "/" || !isPathChar(before);
    const endsClean = !isPathChar(text[end]) || (text[end] === "." && !isPathChar(text[end + 1]));
    if (startsClean && endsClean) return true;
  }
  return false;
}

/*
 * Whether two repository-relative paths name one file: equality of the one canonical form (`normalizeSpecPath`), never a suffix. The diff,
 * the seeds and the coverage gap all spell a changed file from the repository root, so a file and a same-named file under another
 * package of a monorepo are two files.
 */
export function sameFile(a: string, b: string): boolean {
  return normalizeSpecPath(a) === normalizeSpecPath(b);
}

/*
 * The flow a finding belongs to: the one whose spec its citation names, or failing that the one spec its text names as a whole
 * path, or failing that, for a finding about a changed source file, the one flow that covers a use case that file seeds. A text
 * that names the specs of several flows, or a file that seeds use cases of several flows, belongs to none of them: the lead is
 * asked where it goes.
 */
export function flowOfFinding(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): string | undefined {
  return routeOfFinding(finding, flows)?.flowId;
}

/* The flow a finding belongs to and what decided it: the spec it cites or names, or the changed file that seeds a use case the flow covers. */
export function routeOfFinding(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): { flowId: string; by: "spec" | "candidate" } | undefined {
  const names = (path: string, spec: string): boolean => path === spec || path.endsWith(`/${spec}`);
  const cited = finding.spec?.replaceAll("\\", "/");
  const bySpec = (id: string | undefined): { flowId: string; by: "spec" } | undefined => (id === undefined ? undefined : { flowId: id, by: "spec" });
  if (cited) return bySpec(flows.find((flow) => names(cited, flow.specFile))?.id);
  const named = flows.filter((flow) => namesSpecIn(finding.text, flow.specFile));
  if (named.length > 0) return named.length === 1 ? bySpec(named[0]!.id) : undefined;
  if (finding.file === undefined) return undefined;
  const seeded = flows.filter((flow) => flow.seedFiles?.some((file) => sameFile(file, finding.file!)));
  return seeded.length === 1 ? { flowId: seeded[0]!.id, by: "candidate" } : undefined;
}

/* The correction turn's prompt, as data: the flows and the findings numbered, assembled from the registered sections. How to route them and the answer's shape are the lead's role prompt. */
export function assembleLeadCorrection(redaction: RedactionPort, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW, omitted = 0): AssembledPrompt {
  const text = ORIGIN_TEXT[origin];
  return assembleDefs(
    LEAD_CORRECTION_SECTIONS,
    { flows, findings, owner: findings.map((finding) => flowOfFinding(finding, flows)), origin: { heading: text.heading, lead: text.lead, rebuttable: rebuttable(origin) }, omitted, scrub: (value) => redaction.redact(value) },
    { separator: "\n\n" },
  );
}

export function renderLeadCorrection(redaction: RedactionPort, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW, omitted = 0): string {
  return assembleLeadCorrection(redaction, flows, findings, origin, omitted).text;
}

/*
 * The one request that sends a refused answer back to the lead: why each part of it was not admitted, the numbers that are findings, and
 * what to answer. The lead's answer is untrusted text and a number outside the list is a correctable slip, not a decision.
 */
export function assembleRefusedCorrection(refused: CorrectionAdmission["refused"], findingCount: number): AssembledPrompt {
  return assembleDefs(REFUSED_CORRECTION_SECTIONS, { refused, findingCount }, { separator: "\n\n" });
}

export function renderRefusedCorrection(refused: CorrectionAdmission["refused"], findingCount: number): string {
  return assembleRefusedCorrection(refused, findingCount).text;
}

function textOf(redaction: RedactionPort, value: unknown, max: number): string {
  return typeof value === "string" ? redaction.redact(value).trim().slice(0, max) : "";
}

export function admitLeadCorrection(redaction: RedactionPort, output: string, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW): CorrectionAdmission {
  const admission: CorrectionAdmission = { readable: false, orders: [], rebuttals: [], unrouted: [], refused: [] };
  const owner = findings.map((finding) => flowOfFinding(finding, flows));
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const raw = lastJsonObjectWhere(output, (o) => Array.isArray(o.corrections) || Array.isArray(o.rebuttals)) as { corrections?: unknown; rebuttals?: unknown } | undefined;
  const readable = raw !== undefined;
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
      routed.set(flow.id, { action, instruction: textOf(redaction, e.instruction, MAX_INSTRUCTION_CHARS), extra });
    }
    /* A fact the run observed is not the lead's to withdraw: rebuttals are read only for the reviewer's findings. */
    for (const entry of rebuttable(origin) && Array.isArray(raw!.rebuttals) ? raw!.rebuttals : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const index = numberOf(e.finding);
      const basis = e.basis === "execution" || e.basis === "contract" ? e.basis : undefined;
      const ref = textOf(redaction, e.ref, MAX_REF_CHARS);
      if (index === undefined || !basis || ref === "" || rebutted.has(index)) continue;
      rebutted.add(index);
      admission.rebuttals.push({ finding: findings[index]!.text, basis, ref, reason: textOf(redaction, e.reason, MAX_REASON_CHARS) });
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
    admission.orders.push({ flowId: flow.id, action, instruction: order?.instruction || DEFAULT_CORRECTION_INSTRUCTION, findings: indices.map((i) => findings[i]!.text), indices });
  }
  admission.unrouted = findings.flatMap((_, i) => (sent.has(i) || rebutted.has(i) ? [] : [i]));
  return admission;
}

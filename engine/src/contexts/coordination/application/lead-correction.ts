/*
 * Corrections routed by the lead to the flows that own them: the reviewer's verified findings, or what the run's own checks
 * observed of the flows' specs (the static gate, the execution, the change-coverage, the pre-execution selector check). The lead
 * is shown, per flow, the spec its sidekick delivered and the findings that cite it, plus the findings that cite no flow,
 * numbered; it answers per flow (revise in the same sidekick session, or replace with a fresh one) and, for the reviewer's
 * findings only, per finding (a rebuttal, with the basis the run checks). The answer is the lead's word and the orchestrator's facts decide over it: a
 * finding that cites a flow's spec goes to that flow whatever the lead routes, a finding about a changed file goes to a flow that
 * holds the file (the lead's choice among several, else the default `routeOfFinding` settles) and to no other, and a flow with
 * findings the lead neither ordered nor rebutted is sent them with the orchestrator's own instruction.
 * Pure: no clock, no file, no model.
 */

import { REVIEW_ACTION, MAX_INSTRUCTION_CHARS } from "./lead-review.ts";
import { assembleDefs, type AssembledPrompt, type WindowFitOutcome } from "@kernel/prompt-sections.ts";
import { LEAD_CORRECTION_SECTIONS, REFUSED_CORRECTION_SECTIONS, type CorrectionFinding, type FlowUnderCorrection } from "./coordination-sections/lead-turn-sections.ts";

export type { CorrectionFinding, FlowUnderCorrection };
import { entryRead, entryUnreadable, readEntries, readOneOf, type UnreadableEntry } from "./answer-reading.ts";
import { endsWithSpecPath, sameSpecPath } from "@kernel/spec-path.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { DROP_BASIS, armDeclineRefusal, type DropBasis } from "@kernel/drop-basis.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";

const MAX_REF_CHARS = 400;
const MAX_REASON_CHARS = 400;

/*
 * Where a correction turn's findings come from: the independent reviewer, or the orchestrator's own checks after the flows were
 * authored (the static gate, the execution against DEV, the change-coverage measurement, the pre-execution selector check). Only a
 * reviewer's finding is a judgment the lead may rebut; the others are facts the run observed. A fact is corrected, except the
 * coverage measurement's, which is taken when the page can reach it and is otherwise reported. `ORIGIN_TEXT` states each origin's rule once.
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

const OBSERVED_FACTS_RULE = "These are facts the run observed: each one is corrected, none is rebutted.";
const CORRECT_EACH_FINDING = "Correct your spec for each finding without weakening an assertion.";
const COVERAGE_RULE = "These are measurements, not demands: take the arm when the page can be brought to that state through the UI against DEV; otherwise change nothing for it and say so in `concerns`. Never force or weaken an assertion; the recount is the disposition of each finding.";
const DECLINE_BASES = Object.values(DROP_BASIS).map((basis) => `\`${basis}\``).join(", ");
const COVERAGE_LEAD_RULE = [
  "These are measurements, not demands: a decision's arms are taken when the page can be brought to that state through the UI against DEV.",
  `An arm no test can take is declined in \`declines\` instead of being sent to a flow: its finding number, a basis of the plan's drops (${DECLINE_BASES}) and a reason.`,
  "The orchestrator holds the basis to its facts once; what you keep stands, recorded as contradicted. A declined arm stays in the measurement and the report.",
  "Never force or weaken an assertion; the recount is the disposition of each finding.",
].join(" ");

const ORIGIN_TEXT: Record<CorrectionOrigin, { heading: string; lead: string; sidekick: string; leadRule: string; closing: string }> = {
  review: {
    heading: "The reviewer's corrections",
    lead: "The run executed the specs your sidekicks delivered and an independent reviewer judged them. These findings are verified: each one cites a contract clause or an execution of this run.",
    sidekick: "The independent reviewer judged your spec after the run executed it. These findings are verified by the orchestrator:",
    leadRule: "",
    closing: "Correct each finding in your spec without weakening an assertion; a finding you hold to be wrong goes in concerns, with the evidence.",
  },
  "static-gate": {
    heading: "The static gate's errors",
    lead: "The orchestrator's static gate (type check, lint, test listing) refused the specs your sidekicks delivered. Each finding is an error it reported.",
    sidekick: "The orchestrator's static gate refused your spec. What it reported:",
    leadRule: OBSERVED_FACTS_RULE,
    closing: CORRECT_EACH_FINDING,
  },
  execution: {
    heading: "The run's failing tests",
    lead: "The run executed the specs your sidekicks delivered against DEV and these failed. Each finding is what the execution reported, or a fact the orchestrator found in the failure.",
    sidekick: "The run executed your spec against DEV and it failed. What the orchestrator observed:",
    leadRule: OBSERVED_FACTS_RULE,
    closing: CORRECT_EACH_FINDING,
  },
  flaky: {
    heading: "Tests that passed only on retry",
    lead: "The run executed the specs your sidekicks delivered against DEV and these failed their first attempt and passed on retry. Each finding is what the first attempt showed.",
    sidekick: "The run executed your spec against DEV: it failed its first attempt and passed on retry. What the orchestrator observed:",
    leadRule: OBSERVED_FACTS_RULE,
    closing: CORRECT_EACH_FINDING,
  },
  coverage: {
    heading: "Changed lines no test exercised",
    lead: "The run passed, but the change-coverage measurement found changed lines that none of the delivered specs exercised.",
    sidekick: "The run passed, but changed lines no test exercised remain. Extend your spec to exercise those of your flow:",
    leadRule: COVERAGE_LEAD_RULE,
    closing: COVERAGE_RULE,
  },
  "pre-exec": {
    heading: "Selectors the page does not have",
    lead: "Before the specs ran, the orchestrator checked their selectors against the pages it captured from DEV. These selectors are not on the page.",
    sidekick: "Before your spec ran, the orchestrator checked its selectors against the page it captured from DEV. These are not on the page:",
    leadRule: OBSERVED_FACTS_RULE,
    closing: CORRECT_EACH_FINDING,
  },
};

/* What the sidekick is told the findings it is sent are. */
export function correctionPreamble(origin: CorrectionOrigin): string {
  return ORIGIN_TEXT[origin].sidekick;
}

/* The sentence that ends the sidekick's correction: what the findings of this origin ask of it. */
export function correctionClosing(origin: CorrectionOrigin): string {
  return ORIGIN_TEXT[origin].closing;
}

/* Whether the findings of this origin are a judgment the lead may rebut. */
const rebuttable = (origin: CorrectionOrigin): boolean => origin === CORRECTION_ORIGIN.REVIEW;

/* Whether the findings of this origin may be declined: the change-coverage measurement's arms are taken when a test can take them. */
const declinable = (origin: CorrectionOrigin): boolean => origin === CORRECTION_ORIGIN.COVERAGE;

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
  /* The id of the finding the lead rebutted, read from the number it was shown: the run checks the rebuttal against that finding alone. */
  findingId: string;
  /* The finding's text, for the record. */
  finding: string;
  basis: "execution" | "contract";
  ref: string;
  reason: string;
}

/* A decision's arms the lead holds no test can take: the basis it gave from the plan's closed set, and why the run's facts contradict it when they do (it stands all the same). */
export interface CorrectionDecline {
  /* The position of the finding among the turn's findings. */
  index: number;
  basis: DropBasis;
  reason: string;
  contradicted?: string;
}

/* What the orchestrator knows of the run that a decline is held to. */
export interface DeclineFacts {
  candidates: readonly UseCaseCandidate[];
}

export interface CorrectionAdmission {
  readable: boolean;
  /* The entries of the answer (or the answer itself) the engine could not read: not acted on, recorded, asked about once. */
  unreadable: UnreadableEntry[];
  orders: CorrectionOrder[];
  rebuttals: CorrectionRebuttal[];
  /* The findings the lead declined: sent to no flow and not unrouted. */
  declines: CorrectionDecline[];
  /* The positions of the findings no flow was sent and the lead neither rebutted nor declined. */
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
 * The flow a finding belongs to, from the facts in the order of their strength: the one whose spec its citation names, or failing that
 * the one spec its text names as a whole path; else the flows whose spec's tests evaluated what the finding is about (`ranBy`: the
 * decision of an arm, the file of a line), which several flows share by the fewest findings the turn already gave them and then by spec
 * path, never by plan order; else, for a finding about a changed file no flow's spec evaluated, a flow that holds the file (covers a
 * use case that file seeds), the one whose use case holds it as one of its own seeds over one that holds it only as a hub's code, the
 * first in the pass's order among equals. The lead may give a finding about a file to another flow that holds it or evaluated it
 * (`admitLeadCorrection`). A text that names the specs of several flows belongs to none of them: the lead is asked where it goes.
 */
export function flowOfFinding(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): string | undefined {
  return routeOfFinding(finding, flows)?.flowId;
}

/* The flows that hold a finding about a changed file, in the pass's order: those covering a use case the file seeds. Empty when the finding names no file. */
export function flowsHoldingFile(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): FlowUnderCorrection[] {
  if (finding.file === undefined) return [];
  return flows.filter((flow) => flow.seedFiles?.some((file) => sameSpecPath(file, finding.file!)) ?? false);
}

/* The flow a finding belongs to and what decided it: the spec it cites or names, the spec that evaluated what it is about, or the changed file that seeds a use case the flow covers. */
export type FindingRoute = { flowId: string; by: "spec" | "evaluator" | "candidate" };

/* The flows of the pass whose spec's tests evaluated what the finding is about, in the pass's order. */
function evaluatorsOf(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): FlowUnderCorrection[] {
  return flows.filter((flow) => finding.ranBy?.some((spec) => endsWithSpecPath(spec, flow.specFile)) ?? false);
}

/* What the facts of one finding settle without the turn's other findings: its route, none, or the flows that share it. */
type Placement = { route: FindingRoute | undefined } | { evaluators: FlowUnderCorrection[] };

function placementOf(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): Placement {
  const cited = finding.spec;
  const bySpec = (id: string | undefined): Placement => ({ route: id === undefined ? undefined : { flowId: id, by: "spec" } });
  if (cited) return bySpec(flows.find((flow) => endsWithSpecPath(cited, flow.specFile))?.id);
  const named = flows.filter((flow) => namesSpecIn(finding.text, flow.specFile));
  if (named.length > 0) return named.length === 1 ? bySpec(named[0]!.id) : { route: undefined };
  const evaluators = evaluatorsOf(finding, flows);
  if (evaluators.length > 0) return { evaluators };
  const direct = (flow: FlowUnderCorrection): boolean => flow.directSeedFiles?.some((file) => sameSpecPath(file, finding.file!)) ?? false;
  const owner = flowsHoldingFile(finding, flows).reduce<FlowUnderCorrection | undefined>((best, flow) => (best === undefined || (direct(flow) && !direct(best)) ? flow : best), undefined);
  return { route: owner === undefined ? undefined : { flowId: owner.id, by: "candidate" } };
}

const bySpecPath = (a: FlowUnderCorrection, b: FlowUnderCorrection): number => (a.specFile < b.specFile ? -1 : a.specFile > b.specFile ? 1 : 0);

/*
 * The route of each finding of a turn. A finding several flows evaluated goes to the one holding the fewest findings of the turn
 * (those the other facts placed, then those already shared out, in the order of the findings), then to the first by spec path, so the
 * same findings reach the same flows whatever order the flows are listed in.
 */
export function routesOfFindings(findings: readonly CorrectionFinding[], flows: readonly FlowUnderCorrection[]): Array<FindingRoute | undefined> {
  const placed = findings.map((finding) => placementOf(finding, flows));
  const load = new Map<string, number>();
  const take = (flowId: string): void => void load.set(flowId, (load.get(flowId) ?? 0) + 1);
  for (const placement of placed) if ("route" in placement && placement.route) take(placement.route.flowId);
  return placed.map((placement): FindingRoute | undefined => {
    if ("route" in placement) return placement.route;
    const [owner] = [...placement.evaluators].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || bySpecPath(a, b));
    take(owner!.id);
    return { flowId: owner!.id, by: "evaluator" };
  });
}

/* The route of one finding as if it were the turn's only one. */
export function routeOfFinding(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[]): FindingRoute | undefined {
  return routesOfFindings([finding], flows)[0];
}

/* The ids of the flows the lead may give a finding to, when its owner is settled by the file it names and several flows hold that file or evaluated what it is about; empty otherwise. */
function movableAmong(finding: CorrectionFinding, flows: readonly FlowUnderCorrection[], route: FindingRoute | undefined): string[] {
  if (route?.by !== "candidate" && route?.by !== "evaluator") return [];
  const evaluators = evaluatorsOf(finding, flows);
  const holders = flowsHoldingFile(finding, flows);
  const among = flows.filter((flow) => evaluators.includes(flow) || holders.includes(flow));
  return among.length > 1 ? among.map((flow) => flow.id) : [];
}

/* Why a finding stays with the flow its facts gave it. */
function staysWith(route: FindingRoute): string {
  if (route.by === "spec") return `the finding cites flow ${route.flowId}'s spec and stays with it`;
  return `the flow covers no use case the finding's file seeds and its spec did not run what the finding is about; it stays with flow ${route.flowId}`;
}

/* The correction turn's prompt, as data: the flows and the findings numbered, assembled from the registered sections. How to route them and the answer's shape are the lead's role prompt. */
export function assembleLeadCorrection(redaction: RedactionPort, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW, fit?: (bytes: number) => WindowFitOutcome): AssembledPrompt {
  const text = ORIGIN_TEXT[origin];
  const routes = routesOfFindings(findings, flows);
  return assembleDefs(
    LEAD_CORRECTION_SECTIONS,
    { flows, findings, owner: routes.map((route) => route?.flowId), holders: findings.map((finding, i) => movableAmong(finding, flows, routes[i])), origin: { heading: text.heading, lead: text.lead, rule: text.leadRule, rebuttable: rebuttable(origin) }, scrub: (value) => redaction.redact(value) },
    { separator: "\n\n", ...(fit ? { fit } : {}) },
  );
}

export function renderLeadCorrection(redaction: RedactionPort, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW): string {
  return assembleLeadCorrection(redaction, flows, findings, origin).text;
}

/*
 * The one request that sends an answer back to the lead: why each part of it was not admitted, the findings (by position) it neither
 * sent to a flow nor rebutted, the numbers that are findings, and what to answer. What the reader cannot read is returned inside the
 * turn that submitted it (`leadCorrectionContract`); this request is about the orchestrator's facts: a finding left out is a decision
 * the lead has not made yet.
 */
export function assembleRefusedCorrection(refused: CorrectionAdmission["refused"], findingCount: number, omitted: readonly number[] = [], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW, declines: readonly CorrectionDecline[] = []): AssembledPrompt {
  const contradictedDeclines = declines.flatMap((d) => (d.contradicted === undefined ? [] : [{ finding: d.index + 1, basis: d.basis, why: d.contradicted }]));
  return assembleDefs(REFUSED_CORRECTION_SECTIONS, { refused, findingCount, omitted: omitted.map((i) => i + 1), rebuttable: rebuttable(origin), contradictedDeclines }, { separator: "\n" });
}

function textOf(redaction: RedactionPort, value: unknown, max: number): string {
  return typeof value === "string" ? redaction.redact(value).trim().slice(0, max) : "";
}

/* Reads the lead's submitted routing: the object the correction contract accepted. No answer at all (`undefined`) is the lead's absence and unreadable is empty; any other answer is unreadable unless it is an object with a `corrections`, `rebuttals` or `declines` list. */
export function admitLeadCorrection(redaction: RedactionPort, answer: unknown, flows: readonly FlowUnderCorrection[], findings: readonly CorrectionFinding[], origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW, facts: DeclineFacts = { candidates: [] }): CorrectionAdmission {
  const admission: CorrectionAdmission = { readable: false, unreadable: [], orders: [], rebuttals: [], declines: [], unrouted: [], refused: [] };
  const route = routesOfFindings(findings, flows);
  const owner = route.map((r) => r?.flowId);
  const movable = findings.map((finding, i) => movableAmong(finding, flows, route[i]));
  /* The flow the lead gave a finding several flows hold: the first order that names it, which replaces the default owner. */
  const given = new Map<number, string>();
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const listed = typeof answer === "object" && answer !== null ? (answer as { corrections?: unknown; rebuttals?: unknown; declines?: unknown }) : undefined;
  const raw = listed !== undefined && (Array.isArray(listed.corrections) || Array.isArray(listed.rebuttals) || Array.isArray(listed.declines)) ? listed : undefined;
  const readable = raw !== undefined;
  admission.readable = readable;
  const routed = new Map<string, { action: CorrectionOrder["action"]; instruction: string; extra: Set<number> }>();
  const rebutted = new Set<number>();
  const declined = new Set<number>();
  const scrub = (text: string): string => redaction.redact(text);
  const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= findings.length ? value - 1 : undefined);

  if (!raw) {
    if (answer !== undefined) admission.unreadable.push({ where: "answer", reason: "it is not an object with a `corrections`, `rebuttals` or `declines` list" });
  } else {
    /* Each order is read once: a flow of this pass, a revise or a replace, and finding numbers that are findings of the turn. An entry that is not that is unacted on and recorded, never read as a revise. */
    const orders = readEntries(raw.corrections, "corrections", (entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entryUnreadable("it is not an object");
      const e = entry as Record<string, unknown>;
      const flow = typeof e.flow === "string" ? byId.get(e.flow) : undefined;
      if (!flow) return entryUnreadable(`flow ${JSON.stringify(e.flow)} is not a flow of this pass`);
      const action = readOneOf(e.action, [REVIEW_ACTION.REVISE, REVIEW_ACTION.REPLACE] as const, `flow ${flow.id}: action`);
      if (!action.ok) return action;
      if (e.findings !== undefined && !Array.isArray(e.findings)) return entryUnreadable(`flow ${flow.id}: findings is not a list of numbers`);
      return entryRead({ e, flow, action: action.value, index });
    }, scrub, { optional: true });
    admission.unreadable.push(...orders.unreadable);
    for (const { e, flow, action, index } of orders.entries) {
      if (routed.has(flow.id)) {
        admission.unreadable.push({ where: `corrections[${index}]`, reason: `flow ${flow.id} is ordered twice; the first order stands` });
        continue;
      }
      const extra = new Set<number>();
      const numbers = readEntries(e.findings, `corrections[${index}].findings`, (n) => {
        const found = numberOf(n);
        return found === undefined ? entryUnreadable(`${JSON.stringify(n)} is not a finding of this turn (1..${findings.length})`) : entryRead(found);
      }, scrub, { optional: true });
      admission.unreadable.push(...numbers.unreadable);
      for (const index of numbers.entries) {
        if (movable[index]!.length > 0) {
          if (!movable[index]!.includes(flow.id)) admission.refused.push({ flowId: flow.id, finding: index + 1, reason: staysWith({ flowId: given.get(index) ?? owner[index]!, by: "candidate" }) });
          else if (given.has(index) && given.get(index) !== flow.id) admission.refused.push({ flowId: flow.id, finding: index + 1, reason: `the finding was already given to flow ${given.get(index)}` });
          else given.set(index, flow.id);
          continue;
        }
        if (owner[index] !== undefined && owner[index] !== flow.id) {
          admission.refused.push({ flowId: flow.id, finding: index + 1, reason: staysWith(route[index]!) });
          continue;
        }
        if (owner[index] === undefined) extra.add(index);
      }
      routed.set(flow.id, { action, instruction: textOf(redaction, e.instruction, MAX_INSTRUCTION_CHARS), extra });
    }
    /* A fact the run observed is not the lead's to withdraw: rebuttals are read only for the reviewer's findings. */
    if (!rebuttable(origin)) {
      if (Array.isArray(raw.rebuttals) && raw.rebuttals.length > 0) admission.refused.push({ reason: "rebuttals are not read for findings the run observed: they are facts, not judgments" });
    } else {
      const rebuttals = readEntries(raw.rebuttals, "rebuttals", (entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entryUnreadable("it is not an object");
        const e = entry as Record<string, unknown>;
        const index = numberOf(e.finding);
        if (index === undefined) return entryUnreadable(`finding ${JSON.stringify(e.finding)} is not a finding of this turn (1..${findings.length})`);
        const basis = readOneOf(e.basis, ["execution", "contract"] as const, `finding ${index + 1}: basis`);
        if (!basis.ok) return basis;
        const ref = textOf(redaction, e.ref, MAX_REF_CHARS);
        if (ref === "") return entryUnreadable(`finding ${index + 1}: ref is missing`);
        const findingId = findings[index]!.id;
        if (findingId === undefined) return entryUnreadable(`finding ${index + 1} carries no id a rebuttal can name`);
        if (rebutted.has(index)) return entryUnreadable(`finding ${index + 1} is rebutted twice; the first rebuttal stands`);
        rebutted.add(index);
        return entryRead({ findingId, finding: findings[index]!.text, basis: basis.value, ref, reason: textOf(redaction, e.reason, MAX_REASON_CHARS) });
      }, scrub, { optional: true });
      admission.unreadable.push(...rebuttals.unreadable);
      admission.rebuttals.push(...rebuttals.entries);
    }
    if (!declinable(origin)) {
      if (Array.isArray(raw.declines) && raw.declines.length > 0) admission.refused.push({ reason: "declines are not read for findings of this origin: only the change-coverage measurement's arms are declined" });
    } else {
      /* A finding the lead sends to a flow itself is corrected: one answer per finding. */
      const ordered = new Set([...given.keys(), ...[...routed.values()].flatMap((order) => [...order.extra])]);
      const seen = new Set<number>();
      const declines = readEntries(raw.declines, "declines", (entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entryUnreadable("it is not an object");
        const e = entry as Record<string, unknown>;
        const index = numberOf(e.finding);
        if (index === undefined) return entryUnreadable(`finding ${JSON.stringify(e.finding)} is not a finding of this turn (1..${findings.length})`);
        if (findings[index]!.declinable !== true) return entryUnreadable(`finding ${index + 1} is not about a decision's arms: only those can be declined`);
        const basis = readOneOf(e.basis, Object.values(DROP_BASIS), `finding ${index + 1}: basis`);
        if (!basis.ok) return basis;
        const reason = textOf(redaction, e.reason, MAX_REASON_CHARS);
        if (reason === "") return entryUnreadable(`finding ${index + 1}: reason is missing`);
        if (seen.has(index)) return entryUnreadable(`finding ${index + 1} is declined twice; the first decline stands`);
        seen.add(index);
        return entryRead({ index, basis: basis.value, reason });
      }, scrub, { optional: true });
      admission.unreadable.push(...declines.unreadable);
      for (const decline of declines.entries) {
        if (ordered.has(decline.index)) {
          admission.refused.push({ finding: decline.index + 1, reason: "the finding is also ordered to a flow: one answer per finding, and the order stands" });
          continue;
        }
        const file = findings[decline.index]!.file;
        const contradicted = file === undefined ? undefined : armDeclineRefusal(candidatesSeededBy(file, facts.candidates), decline.basis);
        declined.add(decline.index);
        admission.declines.push({ ...decline, ...(contradicted !== undefined ? { contradicted } : {}) });
      }
    }
  }

  const decidedByLead = (i: number): boolean => rebutted.has(i) || declined.has(i);
  const sent = new Set<number>();
  const settled = owner.map((id, i) => given.get(i) ?? id);
  for (const flow of flows) {
    const own = findings.flatMap((_, i) => (settled[i] === flow.id && !decidedByLead(i) ? [i] : []));
    const order = routed.get(flow.id);
    const indices = [...own, ...[...(order?.extra ?? [])].filter((i) => !decidedByLead(i))];
    if (indices.length === 0) {
      if (order) admission.refused.push({ flowId: flow.id, reason: "the order names no finding the flow is to correct" });
      continue;
    }
    for (const i of indices) sent.add(i);
    const action = order?.action === REVIEW_ACTION.REPLACE || !flow.sessionOpen ? REVIEW_ACTION.REPLACE : REVIEW_ACTION.REVISE;
    admission.orders.push({ flowId: flow.id, action, instruction: order?.instruction || DEFAULT_CORRECTION_INSTRUCTION, findings: indices.map((i) => findings[i]!.text), indices });
  }
  admission.unrouted = findings.flatMap((_, i) => (sent.has(i) || decidedByLead(i) ? [] : [i]));
  return admission;
}

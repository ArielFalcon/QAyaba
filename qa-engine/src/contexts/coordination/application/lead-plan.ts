/*
 * What the orchestrator makes of the plan the lead emitted. The plan is the lead's word: it names flows and says what each
 * must check, and that is all of it that is kept. Where a sidekick may write, what each flow may take of the run's time and tool
 * calls, and how many flows run at once are decided here from the plan's shape and the run's limits, never from anything the
 * plan says about them (a "readOnly" or "mutates" tag, a path list, a scope). A plan that cannot be admitted as it stands is not
 * guessed at: the plan is rejected and the reason is returned for the run to record.
 * Pure: no clock, no file, no model.
 */

import { LEAD_PLAN_KIND, type LeadPlanKind } from "@kernel/coordination.ts";
import { normalizeGeoLocation, resolvePlace, type GeoLocation } from "@kernel/geolocation.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { SIDEKICK_KIND, type SidekickKind } from "./sidekick-kinds.ts";

export { LEAD_PLAN_KIND, type LeadPlanKind };

/* Why a plan could not be admitted. */
export const PLAN_DOWNGRADE = {
  NO_PLAN: "no-plan",
  MALFORMED: "malformed",
  EMPTY: "empty",
  OVER_LIMIT: "over-limit",
  DUPLICATE: "duplicate-flow",
  NO_TIME: "no-time",
  NO_CALLS: "no-calls",
} as const;
export type PlanDowngrade = (typeof PLAN_DOWNGRADE)[keyof typeof PLAN_DOWNGRADE];

/* What each refusal tells the lead it got wrong, as facts; the plan contract it already holds says the shapes. */
const DOWNGRADE_FACTS: Readonly<Record<PlanDowngrade, (maxFlows: number) => string>> = {
  [PLAN_DOWNGRADE.NO_PLAN]: () => "the answer held no plan JSON object",
  [PLAN_DOWNGRADE.MALFORMED]: () => "it is not one of the plan shapes: a kind, a field or a field's type is not the contract's",
  [PLAN_DOWNGRADE.EMPTY]: () => "it is a fan-out with no flow and no use case dropped with a reason; a change that needs no test is a noop with its reason",
  [PLAN_DOWNGRADE.OVER_LIMIT]: (maxFlows) => `it names more than ${maxFlows} flows`,
  [PLAN_DOWNGRADE.DUPLICATE]: () => "two of its flows have the same id",
  [PLAN_DOWNGRADE.NO_TIME]: () => "the run has too little time left for that many flows",
  [PLAN_DOWNGRADE.NO_CALLS]: () => "the run has too few run_spec calls left for that many flows",
};

/* The one request that sends a refused plan back to the lead: why it was refused (by its code and in words), and what to answer. */
export function renderRejectedPlanRequest(downgrade: string, maxFlows: number): string {
  const fact = (DOWNGRADE_FACTS as Record<string, ((n: number) => string) | undefined>)[downgrade]?.(maxFlows) ?? "it could not be admitted";
  return [
    "## Your plan was not admitted",
    `The orchestrator refused the plan (${downgrade}): ${fact}.`,
    "Answer with ONLY the corrected plan JSON object, in one of the shapes of the plan contract. This is the only other plan turn of this run.",
  ].join("\n");
}

export const MAX_FLOW_ID_CHARS = 48;
export const MAX_OBJECTIVE_CHARS = 400;
export const MAX_ACCEPTANCE_ITEMS = 12;
export const MAX_ACCEPTANCE_CHARS = 240;
export const MAX_ROUTES = 12;
export const MAX_ROUTE_CHARS = 200;
export const MAX_NOOP_REASON_CHARS = 400;
export const MAX_FLOW_CANDIDATES = 24;
export const MAX_DROPPED = 24;
export const MAX_CANDIDATE_ID_CHARS = 64;

/* A site-relative path, as the app's own links are: no scheme, no host, no whitespace. */
export const ROUTE = /^\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;

export interface PlanLimits {
  /* The most flows a plan may name. */
  maxFlows: number;
  /* The most flows that run at once. */
  maxParallel: number;
  /* The most time one flow may take. */
  flowBudgetMs: number;
  /* What is left of the run's time; absent when the run has no deadline. */
  remainingMs?: number;
  /* What the run keeps for what follows the flows (validation, execution, the reviewer). */
  reserveMs: number;
  /* Less than this and a flow cannot read the brief, write a spec and try it once. */
  minFlowMs: number;
  /* The run's totals for the tools a flow may be given; absent when the run was not granted the tool. */
  runSpecCalls?: number;
  runSpecDevWrites?: number;
  browserCalls?: number;
}

export interface PlanDeps {
  /* Where every free-form string the plan carries is redacted before it is kept. */
  redaction: RedactionPort;
  /* The spec directory as the repository sees it (`e2e`). */
  specRelDir: string;
  /* The spec file, relative to the spec directory, that a flow's id names. */
  specFileFor(flowId: string): string;
  /* The places the app declares, when it declares a location: a flow may name one instead of carrying coordinates. */
  places?: Readonly<Record<string, GeoLocation>>;
}

export interface AdmittedFlow {
  id: string;
  /* The kind of sidekick that authors the flow. */
  kind: SidekickKind;
  objective: string;
  acceptance: string[];
  routes: string[];
  /* The ids of the use cases the flow says it covers; an id no candidate has is ignored by whoever reads them. */
  candidates: string[];
  /* The spec file relative to the spec directory, and the one path, relative to the repository, the flow may write. */
  specFile: string;
  writablePaths: string[];
  budgetMs: number;
  runSpecCalls: number;
  runSpecDevWrites: number;
  browserCalls: number;
  /* Where the flow authors, when the plan named a declared place or a valid point; absent: the flow inherits the lead's. */
  location?: GeoLocation;
  /* Set on a maintenance flow only (`maintenance-flow.ts`): an existing spec the plan did not name, corrected for these findings. */
  maintenance?: { findings: string[]; preamble: string };
}

/* An admitted plan that names the flows to author, or declares that nothing is worth a test, or is rejected with the reason. */
export const PLAN_REJECTED = "rejected" as const;

export type AdmittedPlan =
  | { kind: typeof LEAD_PLAN_KIND.NOOP; reason: string }
  | { kind: typeof PLAN_REJECTED; downgrade: PlanDowngrade }
  | { kind: typeof LEAD_PLAN_KIND.FANOUT; flows: AdmittedFlow[]; parallel: number; dropped: PlanDrop[] };

/* A use case the lead says needs no test, with the reason it gave. */
export interface PlanDrop {
  candidate: string;
  reason: string;
}

function reject(downgrade: PlanDowngrade): AdmittedPlan {
  return { kind: PLAN_REJECTED, downgrade };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(redaction: RedactionPort, value: unknown, max: number): string {
  return typeof value === "string" ? redaction.redact(value).replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/* The id as a file-safe slug. An id that is nothing once cleaned is still a name, so two such flows are a duplicate and not a blank. */
export function slugOf(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_FLOW_ID_CHARS).replace(/-+$/g, "") || "flow";
}

function strings(redaction: RedactionPort, value: unknown, max: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(redaction, item, max)).filter((item) => item !== "").slice(0, maxItems);
}

/* A segment that holds a stand-in for a value (`qa-bot-<run>-missing`, `{city}`) names a page of no fixed address: it is kept as a parameter. */
const PLACEHOLDER = /<[^<>/]*>|\{[^{}/]*\}/;
const STAND_IN = ":value";

function routesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const routes = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().split("/").map((segment) => (PLACEHOLDER.test(segment) ? STAND_IN : segment)).join("/"))
    .filter((item) => item.length <= MAX_ROUTE_CHARS && ROUTE.test(item));
  return [...new Set(routes)].slice(0, MAX_ROUTES);
}

/* A site-relative path the text names: it starts a word or follows an opening quote or bracket, and runs to a space, a quote, a bracket, a comma or a semicolon; a full stop, colon or mark that ends a sentence is not part of it. */
const PATH_IN_TEXT = /(?:^|[\s(["'`\u201c\u00ab])(\/[^\s"'`()[\],;\u201d\u00bb]+)/g;

/* The paths a flow's own words name, for a flow whose plan named no route: the pages it says it opens are the pages it visits. */
function pathsIn(texts: readonly string[]): string[] {
  return texts.flatMap((text) => [...text.matchAll(PATH_IN_TEXT)].map((match) => match[1]!.replace(/[.:!?]+$/, ""))).filter((path) => path !== "/" && !path.startsWith("//"));
}

interface RawFlow {
  id: string;
  objective: string;
  acceptance: string[];
  routes: string[];
  candidates: string[];
  location?: GeoLocation;
}

function candidateIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "" && item.length <= MAX_CANDIDATE_ID_CHARS && !/\s/.test(item));
  return [...new Set(ids)].slice(0, MAX_FLOW_CANDIDATES);
}

function dropsOf(value: unknown, redaction: RedactionPort): PlanDrop[] {
  if (!Array.isArray(value)) return [];
  const drops: PlanDrop[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const [candidate] = candidateIdsOf([entry.candidate]);
    const reason = text(redaction, entry.reason, MAX_ACCEPTANCE_CHARS);
    if (candidate !== undefined && reason !== "" && !drops.some((d) => d.candidate === candidate)) drops.push({ candidate, reason });
  }
  return drops.slice(0, MAX_DROPPED);
}

/* The flow's location as the plan gave it: a declared place's name, or a point; anything else is dropped and the flow inherits the lead's. */
function locationOf(value: unknown, places: Readonly<Record<string, GeoLocation>>): GeoLocation | undefined {
  if (typeof value === "string") return resolvePlace(places, value)?.location;
  return normalizeGeoLocation(value);
}

function rawFlowOf(value: unknown, places: Readonly<Record<string, GeoLocation>>, redaction: RedactionPort): RawFlow | undefined {
  if (!isRecord(value)) return undefined;
  const objective = text(redaction, value.objective, MAX_OBJECTIVE_CHARS);
  if (objective === "") return undefined;
  const location = locationOf(value.location, places);
  const acceptance = strings(redaction, value.acceptance, MAX_ACCEPTANCE_CHARS, MAX_ACCEPTANCE_ITEMS);
  const named = routesOf(value.routes);
  return {
    id: slugOf(redaction.redact(typeof value.id === "string" ? value.id : "")),
    objective,
    acceptance,
    routes: named.length > 0 ? named : routesOf(pathsIn([objective, ...acceptance])),
    candidates: candidateIdsOf(value.candidates),
    ...(location !== undefined ? { location } : {}),
  };
}

/* The share of a run total each of `count` flows may use. Undefined when the run has no such tool. */
function shareOf(total: number | undefined, count: number): number | undefined {
  return total === undefined ? undefined : Math.floor(total / count);
}

export function admitLeadPlan(raw: unknown, limits: PlanLimits, deps: PlanDeps): AdmittedPlan {
  if (raw === undefined) return reject(PLAN_DOWNGRADE.NO_PLAN);
  if (!isRecord(raw)) return reject(PLAN_DOWNGRADE.MALFORMED);

  if (raw.kind === LEAD_PLAN_KIND.NOOP) {
    const reason = text(deps.redaction, raw.reason, MAX_NOOP_REASON_CHARS);
    return reason === "" ? reject(PLAN_DOWNGRADE.MALFORMED) : { kind: LEAD_PLAN_KIND.NOOP, reason };
  }
  if (raw.kind !== LEAD_PLAN_KIND.FANOUT || !Array.isArray(raw.flows)) return reject(PLAN_DOWNGRADE.MALFORMED);

  if (raw.flows.length === 0) {
    /* No flow and every use case it names dropped with a reason: the lead decided nothing is worth a test, as a no-op says. */
    const drops = dropsOf(raw.dropped, deps.redaction);
    if (drops.length === 0) return reject(PLAN_DOWNGRADE.EMPTY);
    return { kind: LEAD_PLAN_KIND.NOOP, reason: drops.map((drop) => `${drop.candidate}: ${drop.reason}`).join("; ").slice(0, MAX_NOOP_REASON_CHARS) };
  }
  if (raw.flows.length > limits.maxFlows) return reject(PLAN_DOWNGRADE.OVER_LIMIT);
  const flows: RawFlow[] = [];
  for (const entry of raw.flows) {
    const flow = rawFlowOf(entry, deps.places ?? {}, deps.redaction);
    if (!flow) return reject(PLAN_DOWNGRADE.MALFORMED);
    flows.push(flow);
  }
  if (new Set(flows.map((flow) => flow.id)).size !== flows.length) return reject(PLAN_DOWNGRADE.DUPLICATE);

  const count = flows.length;
  const parallel = Math.min(limits.maxParallel, count);
  const waves = Math.ceil(count / parallel);
  const budgetMs =
    limits.remainingMs === undefined
      ? limits.flowBudgetMs
      : Math.min(limits.flowBudgetMs, Math.floor((limits.remainingMs - limits.reserveMs) / waves));
  if (budgetMs < limits.minFlowMs) return reject(PLAN_DOWNGRADE.NO_TIME);

  const runSpecCalls = shareOf(limits.runSpecCalls, count);
  if (runSpecCalls !== undefined && runSpecCalls < 1) return reject(PLAN_DOWNGRADE.NO_CALLS);
  const runSpecDevWrites = shareOf(limits.runSpecDevWrites, count) ?? 0;
  const browserCalls = shareOf(limits.browserCalls, count) ?? 0;

  return {
    kind: LEAD_PLAN_KIND.FANOUT,
    parallel,
    dropped: dropsOf(raw.dropped, deps.redaction),
    flows: flows.map((flow) => {
      const specFile = deps.specFileFor(flow.id);
      return {
        id: flow.id,
        kind: SIDEKICK_KIND.AUTHOR,
        objective: flow.objective,
        acceptance: flow.acceptance,
        routes: flow.routes,
        candidates: flow.candidates,
        specFile,
        writablePaths: [`${deps.specRelDir.replace(/\/+$/, "")}/${specFile}`],
        budgetMs,
        runSpecCalls: runSpecCalls ?? 0,
        runSpecDevWrites,
        browserCalls,
        ...(flow.location !== undefined ? { location: flow.location } : {}),
      };
    }),
  };
}

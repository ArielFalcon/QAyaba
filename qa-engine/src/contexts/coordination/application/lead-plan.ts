/*
 * What the orchestrator makes of the plan the lead emitted. The plan is the lead's word: it names flows and says what each
 * must check, and that is all of it that is kept. Where a sidekick may write, what each flow may take of the run's time and tool
 * calls, and how many flows run at once are decided here from the plan's shape and the run's limits, never from anything the
 * plan says about them (a "readOnly" or "mutates" tag, a path list, a scope). A plan that cannot be read as it stands is not
 * guessed at: the plan is rejected and the reason is returned for the run to record. A plan of more flows than the run's capacity
 * is not rejected: its first flows are admitted in plan order and the rest are named, for the lead to be asked about.
 * Pure: no clock, no file, no model.
 */

import { LEAD_PLAN_KIND, type LeadPlanKind } from "@kernel/coordination.ts";
import { normalizeGeoLocation, resolvePlace, type GeoLocation } from "@kernel/geolocation.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import { REJECTED_PLAN_SECTIONS } from "./coordination-sections/lead-turn-sections.ts";
import { SIDEKICK_KIND, type SidekickKind } from "./sidekick-kinds.ts";
import { flowCapacity, MIN_BROWSER_CALLS_PER_FLOW, MIN_RUN_SPEC_CALLS_PER_FLOW, MIN_RUN_SPEC_DEV_WRITES_PER_FLOW, perFlowGrant } from "./flow-capacity.ts";

export { MIN_BROWSER_CALLS_PER_FLOW, MIN_RUN_SPEC_CALLS_PER_FLOW, MIN_RUN_SPEC_DEV_WRITES_PER_FLOW };

export { LEAD_PLAN_KIND, type LeadPlanKind };

/* Why a plan could not be admitted. */
export const PLAN_DOWNGRADE = {
  NO_PLAN: "no-plan",
  MALFORMED: "malformed",
  EMPTY: "empty",
  DUPLICATE: "duplicate-flow",
  NO_TIME: "no-time",
} as const;
export type PlanDowngrade = (typeof PLAN_DOWNGRADE)[keyof typeof PLAN_DOWNGRADE];

/* What each refusal tells the lead it got wrong, as facts; the plan contract it already holds says the shapes. */
const DOWNGRADE_FACTS: Readonly<Record<PlanDowngrade, () => string>> = {
  [PLAN_DOWNGRADE.NO_PLAN]: () => "the answer held no plan JSON object",
  [PLAN_DOWNGRADE.MALFORMED]: () => "it is not one of the plan shapes: a kind, a field or a field's type is not the contract's",
  [PLAN_DOWNGRADE.EMPTY]: () => "it is a fan-out with no flow and no use case dropped with a basis and a reason; a change that needs no test is a noop with its reason",
  [PLAN_DOWNGRADE.DUPLICATE]: () => "two of its flows have the same id",
  [PLAN_DOWNGRADE.NO_TIME]: () => "the run has too little time left for any flow",
};

/* The one request that sends a refused plan back to the lead: why it was refused (by its code and in words), and what to answer. */
export function assembleRejectedPlanRequest(downgrade: string): AssembledPrompt {
  const fact = (DOWNGRADE_FACTS as Record<string, (() => string) | undefined>)[downgrade]?.() ?? "it could not be admitted";
  return assembleDefs(REJECTED_PLAN_SECTIONS, { downgrade, fact }, { separator: "\n\n" });
}

export function renderRejectedPlanRequest(downgrade: string): string {
  return assembleRejectedPlanRequest(downgrade).text;
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
  /* The app's ceiling on flows, for cost; absent: only the run's time bounds them (`flowCapacity`). */
  ceiling?: number;
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
  /* The longest one call of each tool may take: a flow is granted no more calls than its time can run. */
  runSpecPerCallMs?: number;
  browserPerCallMs?: number;
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
  /* Set on a flow the orchestrator opened for findings (`maintenance-flow.ts`): an existing spec the plan did not name, corrected for these findings, or, with `newSpec`, a spec written for a use case the plan did not cover. */
  maintenance?: { findings: string[]; preamble: string; newSpec?: true };
}

/* An admitted plan that names the flows to author, or declares that nothing is worth a test, or is rejected with the reason. */
export const PLAN_REJECTED = "rejected" as const;

export type AdmittedPlan =
  /* `dropped` is set when the no-op is a plan of no flows whose every use case is dropped: the drops are checked against the run's facts like any plan's. */
  | { kind: typeof LEAD_PLAN_KIND.NOOP; reason: string; dropped?: PlanDrop[] }
  | { kind: typeof PLAN_REJECTED; downgrade: PlanDowngrade }
  /* `capacity` is the flows the run could author (absent: nothing bounds them); `notAdmitted` the flows past it, in plan order. */
  | { kind: typeof LEAD_PLAN_KIND.FANOUT; flows: AdmittedFlow[]; parallel: number; dropped: PlanDrop[]; capacity?: number; notAdmitted: NotAdmittedFlow[] };

/* A flow of the plan past the run's capacity: what the lead is shown of it when it is asked about it, and what the run records. */
export interface NotAdmittedFlow {
  id: string;
  objective: string;
  candidates: string[];
}

/*
 * Why a use case needs no test, from a closed set the orchestrator can hold to its facts (`plan-coverage.ts`): the change leaves
 * nothing a browser can observe, a spec of the suite already proves it, or it needs a state or a capability the run cannot reach.
 */
export const DROP_BASIS = {
  NO_OBSERVABLE_CHANGE: "no-observable-change",
  ALREADY_COVERED: "already-covered",
  NEEDS_UNAVAILABLE_STATE: "needs-unavailable-state",
} as const;
export type DropBasis = (typeof DROP_BASIS)[keyof typeof DROP_BASIS];
const DROP_BASES: ReadonlySet<string> = new Set(Object.values(DROP_BASIS));

/* A use case the lead says needs no test: the basis it gave from the closed set, and its reason in words. */
export interface PlanDrop {
  candidate: string;
  basis: DropBasis;
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
    const basis = typeof entry.basis === "string" && DROP_BASES.has(entry.basis) ? (entry.basis as DropBasis) : undefined;
    if (candidate !== undefined && basis !== undefined && reason !== "" && !drops.some((d) => d.candidate === candidate)) drops.push({ candidate, basis, reason });
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
    return { kind: LEAD_PLAN_KIND.NOOP, reason: drops.map((drop) => `${drop.candidate}: ${drop.reason}`).join("; ").slice(0, MAX_NOOP_REASON_CHARS), dropped: drops };
  }
  const flows: RawFlow[] = [];
  for (const entry of raw.flows) {
    const flow = rawFlowOf(entry, deps.places ?? {}, deps.redaction);
    if (!flow) return reject(PLAN_DOWNGRADE.MALFORMED);
    flows.push(flow);
  }
  if (new Set(flows.map((flow) => flow.id)).size !== flows.length) return reject(PLAN_DOWNGRADE.DUPLICATE);

  const capacity = flowCapacity({
    maxParallel: limits.maxParallel,
    flowBudgetMs: limits.flowBudgetMs,
    ...(limits.remainingMs !== undefined ? { remainingMs: limits.remainingMs } : {}),
    reserveMs: limits.reserveMs,
    minFlowMs: limits.minFlowMs,
    ...(limits.ceiling !== undefined ? { ceiling: limits.ceiling } : {}),
  });
  if (capacity === 0) return reject(PLAN_DOWNGRADE.NO_TIME);
  const taken = capacity === undefined ? flows : flows.slice(0, capacity);
  const notAdmitted = flows.slice(taken.length).map((flow) => ({ id: flow.id, objective: flow.objective, candidates: flow.candidates }));

  const count = taken.length;
  const parallel = Math.min(limits.maxParallel, count);
  const waves = Math.ceil(count / parallel);
  const budgetMs =
    limits.remainingMs === undefined
      ? limits.flowBudgetMs
      : Math.min(limits.flowBudgetMs, Math.floor((limits.remainingMs - limits.reserveMs) / waves));
  if (budgetMs < limits.minFlowMs) return reject(PLAN_DOWNGRADE.NO_TIME);

  const runSpecCalls = perFlowGrant({ total: limits.runSpecCalls, flows: count, minimum: MIN_RUN_SPEC_CALLS_PER_FLOW, flowBudgetMs: budgetMs, ...(limits.runSpecPerCallMs !== undefined ? { perCallMs: limits.runSpecPerCallMs } : {}) });
  const runSpecDevWrites = perFlowGrant({ total: limits.runSpecDevWrites, flows: count, minimum: MIN_RUN_SPEC_DEV_WRITES_PER_FLOW });
  const browserCalls = perFlowGrant({ total: limits.browserCalls, flows: count, minimum: MIN_BROWSER_CALLS_PER_FLOW, flowBudgetMs: budgetMs, ...(limits.browserPerCallMs !== undefined ? { perCallMs: limits.browserPerCallMs } : {}) });

  return {
    kind: LEAD_PLAN_KIND.FANOUT,
    parallel,
    dropped: dropsOf(raw.dropped, deps.redaction),
    ...(capacity !== undefined ? { capacity } : {}),
    notAdmitted,
    flows: taken.map((flow) => {
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
        runSpecCalls,
        runSpecDevWrites,
        browserCalls,
        ...(flow.location !== undefined ? { location: flow.location } : {}),
      };
    }),
  };
}

/*
 * What the orchestrator makes of the plan the lead emitted. The plan is the lead's word: it names flows and says what each
 * must check, and that is all of it that is kept. Where a sidekick may write, what each flow may take of the run's time and tool
 * calls, and how many flows run at once are decided here from the plan's shape and the run's limits, never from anything the
 * plan says about them (a "readOnly" or "mutates" tag, a path list, a scope). A plan that cannot be admitted as it stands is not
 * guessed at: the work goes back to the lead as one piece, and the reason is returned for the run to record.
 * Pure: no clock, no file, no model.
 */

import { LEAD_PLAN_KIND, type LeadPlanKind } from "@kernel/coordination.ts";
import { normalizeGeoLocation, resolvePlace, type GeoLocation } from "@kernel/geolocation.ts";
import { scrub } from "./scrub.ts";

export { LEAD_PLAN_KIND, type LeadPlanKind };

/* Why a plan that asked for a fan-out became one piece of work for the lead. */
export const PLAN_DOWNGRADE = {
  NO_PLAN: "no-plan",
  MALFORMED: "malformed",
  EMPTY: "empty",
  ONE_FLOW: "one-flow",
  OVER_LIMIT: "over-limit",
  DUPLICATE: "duplicate-flow",
  NO_TIME: "no-time",
  NO_CALLS: "no-calls",
} as const;
export type PlanDowngrade = (typeof PLAN_DOWNGRADE)[keyof typeof PLAN_DOWNGRADE];

export const MAX_FLOW_ID_CHARS = 48;
export const MAX_OBJECTIVE_CHARS = 400;
export const MAX_ACCEPTANCE_ITEMS = 12;
export const MAX_ACCEPTANCE_CHARS = 240;
export const MAX_ROUTES = 12;
export const MAX_ROUTE_CHARS = 200;
export const MAX_NOOP_REASON_CHARS = 400;

/* A site-relative path, as the app's own links are: no scheme, no host, no whitespace. */
const ROUTE = /^\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;

export interface PlanLimits {
  /* The most flows a plan may name. */
  maxFlows: number;
  /* The most flows that run at once. */
  maxParallel: number;
  /* The most time one flow may take. */
  flowBudgetMs: number;
  /* What is left of the run's time; absent when the run has no deadline. */
  remainingMs?: number;
  /* What the run keeps for what follows the flows (validation, execution, the reviewer, the takeover). */
  reserveMs: number;
  /* Less than this and a flow cannot read the brief, write a spec and try it once. */
  minFlowMs: number;
  /* The run's totals for the tools a flow may be given; absent when the run was not granted the tool. */
  runSpecCalls?: number;
  runSpecDevWrites?: number;
  browserCalls?: number;
}

export interface PlanDeps {
  /* The spec directory as the repository sees it (`e2e`). */
  specRelDir: string;
  /* The spec file, relative to the spec directory, that a flow's id names. */
  specFileFor(flowId: string): string;
  /* The places the app declares, when it declares a location: a flow may name one instead of carrying coordinates. */
  places?: Readonly<Record<string, GeoLocation>>;
}

export interface AdmittedFlow {
  id: string;
  objective: string;
  acceptance: string[];
  routes: string[];
  /* The spec file relative to the spec directory, and the one path, relative to the repository, the flow may write. */
  specFile: string;
  writablePaths: string[];
  budgetMs: number;
  runSpecCalls: number;
  runSpecDevWrites: number;
  browserCalls: number;
  /* Where the flow authors, when the plan named a declared place or a valid point; absent: the flow inherits the lead's. */
  location?: GeoLocation;
}

export type AdmittedPlan =
  | { kind: typeof LEAD_PLAN_KIND.NOOP; reason: string }
  | { kind: typeof LEAD_PLAN_KIND.SINGLE; downgrade?: PlanDowngrade }
  | { kind: typeof LEAD_PLAN_KIND.FANOUT; flows: AdmittedFlow[]; parallel: number };

function single(downgrade?: PlanDowngrade): AdmittedPlan {
  return downgrade === undefined ? { kind: LEAD_PLAN_KIND.SINGLE } : { kind: LEAD_PLAN_KIND.SINGLE, downgrade };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? scrub(value).replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/* The id as a file-safe slug. An id that is nothing once cleaned is still a name, so two such flows are a duplicate and not a blank. */
function slugOf(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_FLOW_ID_CHARS).replace(/-+$/g, "") || "flow";
}

function strings(value: unknown, max: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, max)).filter((item) => item !== "").slice(0, maxItems);
}

function routesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length <= MAX_ROUTE_CHARS && ROUTE.test(item))
    .slice(0, MAX_ROUTES);
}

interface RawFlow {
  id: string;
  objective: string;
  acceptance: string[];
  routes: string[];
  location?: GeoLocation;
}

/* The flow's location as the plan gave it: a declared place's name, or a point; anything else is dropped and the flow inherits the lead's. */
function locationOf(value: unknown, places: Readonly<Record<string, GeoLocation>>): GeoLocation | undefined {
  if (typeof value === "string") return resolvePlace(places, value)?.location;
  return normalizeGeoLocation(value);
}

function rawFlowOf(value: unknown, places: Readonly<Record<string, GeoLocation>>): RawFlow | undefined {
  if (!isRecord(value)) return undefined;
  const objective = text(value.objective, MAX_OBJECTIVE_CHARS);
  if (objective === "") return undefined;
  const location = locationOf(value.location, places);
  return {
    id: slugOf(scrub(typeof value.id === "string" ? value.id : "")),
    objective,
    acceptance: strings(value.acceptance, MAX_ACCEPTANCE_CHARS, MAX_ACCEPTANCE_ITEMS),
    routes: routesOf(value.routes),
    ...(location !== undefined ? { location } : {}),
  };
}

/* The share of a run total each of `count` flows may use. Undefined when the run has no such tool. */
function shareOf(total: number | undefined, count: number): number | undefined {
  return total === undefined ? undefined : Math.floor(total / count);
}

export function admitLeadPlan(raw: unknown, limits: PlanLimits, deps: PlanDeps): AdmittedPlan {
  if (raw === undefined) return single(PLAN_DOWNGRADE.NO_PLAN);
  if (!isRecord(raw)) return single(PLAN_DOWNGRADE.MALFORMED);

  if (raw.kind === LEAD_PLAN_KIND.NOOP) {
    const reason = text(raw.reason, MAX_NOOP_REASON_CHARS);
    return reason === "" ? single(PLAN_DOWNGRADE.MALFORMED) : { kind: LEAD_PLAN_KIND.NOOP, reason };
  }
  if (raw.kind === LEAD_PLAN_KIND.SINGLE) return single();
  if (raw.kind !== LEAD_PLAN_KIND.FANOUT || !Array.isArray(raw.flows)) return single(PLAN_DOWNGRADE.MALFORMED);

  if (raw.flows.length === 0) return single(PLAN_DOWNGRADE.EMPTY);
  if (raw.flows.length > limits.maxFlows) return single(PLAN_DOWNGRADE.OVER_LIMIT);
  const flows: RawFlow[] = [];
  for (const entry of raw.flows) {
    const flow = rawFlowOf(entry, deps.places ?? {});
    if (!flow) return single(PLAN_DOWNGRADE.MALFORMED);
    flows.push(flow);
  }
  if (new Set(flows.map((flow) => flow.id)).size !== flows.length) return single(PLAN_DOWNGRADE.DUPLICATE);
  if (flows.length < 2) return single(PLAN_DOWNGRADE.ONE_FLOW);

  const count = flows.length;
  const parallel = Math.min(limits.maxParallel, count);
  const waves = Math.ceil(count / parallel);
  const budgetMs =
    limits.remainingMs === undefined
      ? limits.flowBudgetMs
      : Math.min(limits.flowBudgetMs, Math.floor((limits.remainingMs - limits.reserveMs) / waves));
  if (budgetMs < limits.minFlowMs) return single(PLAN_DOWNGRADE.NO_TIME);

  const runSpecCalls = shareOf(limits.runSpecCalls, count);
  if (runSpecCalls !== undefined && runSpecCalls < 1) return single(PLAN_DOWNGRADE.NO_CALLS);
  const runSpecDevWrites = shareOf(limits.runSpecDevWrites, count) ?? 0;
  const browserCalls = shareOf(limits.browserCalls, count) ?? 0;

  return {
    kind: LEAD_PLAN_KIND.FANOUT,
    parallel,
    flows: flows.map((flow) => {
      const specFile = deps.specFileFor(flow.id);
      return {
        id: flow.id,
        objective: flow.objective,
        acceptance: flow.acceptance,
        routes: flow.routes,
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

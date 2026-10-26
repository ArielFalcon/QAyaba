/*
 * Whether a failure is in the change's reach, as a label that names its evidence. Each failed case is matched, most specific first,
 * on the request that failed (an operation the change reaches), the page it ended on (a page the change reaches) and the flow whose
 * spec it is (written for the use cases the change makes testable); the first match wins. The run's label is read from its cases.
 * A label records and decides nothing. Absence is not independence: "out of reach" needs a scope that did not degrade or truncate.
 * Pure: the route and operation matching is handed in by the caller, so the rules of other contexts are not imported.
 */
import type { EntryPoint } from "@kernel/change-reach.ts";
import { entryKey } from "@kernel/change-reach.ts";
import { sameSpecFile } from "./spec-match.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export type CausalReach = "in-reach" | "out-of-reach" | "unknown";
export type CausalBasis = "request" | "page" | "flow" | "none";

export interface CausalCaseLabel {
  name: string;
  reach: CausalReach;
  basis: CausalBasis;
}

export interface CausalLabel {
  reach: CausalReach;
  basis: CausalBasis;
  /* The reach entries or use case ids the label rests on, once each, bounded. */
  via: string[];
  reason: string;
  /* Bounded: the failed cases, in order, each with its own label. */
  cases: CausalCaseLabel[];
}

/* The part of a change scope the label reads; `ChangeScope` satisfies it. */
export interface CausalScope {
  repos: ReadonlyArray<{ repo: string; entryPoints: readonly EntryPoint[]; entryPointsTruncated: boolean }>;
  reach: ReadonlyArray<{ entry: EntryPoint }>;
  hubs: ReadonlyArray<{ truncated?: boolean }>;
  omitted: number;
  degraded: ReadonlyArray<{ repo: string }>;
}

/* The rules of other contexts the label needs, handed in by the composition that owns them. */
export interface CausalMatchers {
  /* Whether a request path is served by the operation (a gateway prefix tolerated, a parameter matching any value). */
  servesOperation(requestPath: string, operation: { verb: string; path: string }): boolean;
  /* Whether a route template names the page at `pathname`. */
  namesPage(route: string, pathname: string): boolean;
}

/* A flow of the run and the use cases it cites. */
export interface CausalFlow {
  specFile: string;
  candidates: readonly string[];
}

export interface CausalInput {
  cases: ReadonlyArray<Pick<QaCase, "name" | "status" | "file" | "finalUrl" | "networkErrors">>;
  scope: CausalScope | undefined;
  flows: readonly CausalFlow[];
  matchers: CausalMatchers;
}

export const MAX_CAUSAL_CASES = 20;
export const MAX_CAUSAL_VIA = 12;
const MAX_NAME_CHARS = 160;

interface Found {
  reach: CausalReach;
  basis: CausalBasis;
  via: string[];
}

const NONE: Found = { reach: "unknown", basis: "none", via: [] };

function pathnameOf(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  if (url.startsWith("/")) return url.split(/[?#]/)[0];
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/* Absence from the reach proves nothing when a repo's index did not answer or a walk or list was cut. */
function absenceProves(scope: CausalScope): boolean {
  return scope.degraded.length === 0 && scope.omitted === 0 && !scope.hubs.some((hub) => hub.truncated === true) && !scope.repos.some((repo) => repo.entryPointsTruncated);
}

function byRequest(c: CausalInput["cases"][number], input: CausalInput): Found {
  const { scope, matchers } = input;
  if (scope === undefined) return NONE;
  const paths = (c.networkErrors ?? []).map((e) => pathnameOf(e.url)).filter((p): p is string => p !== undefined);
  const operations = (entries: ReadonlyArray<EntryPoint>) => entries.filter((e): e is Extract<EntryPoint, { kind: "operation" }> => e.kind === "operation");
  const reached = operations(scope.reach.map((r) => r.entry));
  const hit = reached.filter((op) => paths.some((p) => matchers.servesOperation(p, op)));
  if (hit.length > 0) return { reach: "in-reach", basis: "request", via: hit.map(entryKey) };
  if (!absenceProves(scope)) return NONE;
  const known = operations(scope.repos.flatMap((repo) => repo.entryPoints));
  const outside = known.filter((op) => paths.some((p) => matchers.servesOperation(p, op)));
  return outside.length > 0 ? { reach: "out-of-reach", basis: "request", via: outside.map(entryKey) } : NONE;
}

function byPage(c: CausalInput["cases"][number], input: CausalInput): Found {
  const { scope, matchers } = input;
  const pathname = pathnameOf(c.finalUrl);
  if (scope === undefined || pathname === undefined) return NONE;
  const pages = (entries: ReadonlyArray<EntryPoint>) => entries.filter((e): e is Extract<EntryPoint, { kind: "page" }> => e.kind === "page");
  const hit = pages(scope.reach.map((r) => r.entry)).filter((page) => matchers.namesPage(page.route, pathname));
  if (hit.length > 0) return { reach: "in-reach", basis: "page", via: hit.map(entryKey) };
  if (!absenceProves(scope)) return NONE;
  const outside = pages(scope.repos.flatMap((repo) => repo.entryPoints)).filter((page) => matchers.namesPage(page.route, pathname));
  return outside.length > 0 ? { reach: "out-of-reach", basis: "page", via: outside.map(entryKey) } : NONE;
}

function byFlow(c: CausalInput["cases"][number], input: CausalInput): Found {
  if (c.file === undefined) return NONE;
  const flow = input.flows.find((f) => f.candidates.length > 0 && sameSpecFile(f.specFile, c.file!));
  return flow ? { reach: "in-reach", basis: "flow", via: [...flow.candidates] } : NONE;
}

function labelCase(c: CausalInput["cases"][number], input: CausalInput): Found {
  for (const find of [byRequest, byPage, byFlow]) {
    const found = find(c, input);
    if (found.basis !== "none") return found;
  }
  return NONE;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/* The label of a run's failure, or undefined when no case failed (reach is not applicable). */
export function labelFailure(input: CausalInput): CausalLabel | undefined {
  const failed = input.cases.filter((c) => c.status === "fail");
  if (failed.length === 0) return undefined;
  const found = failed.map((c) => ({ c, found: labelCase(c, input) }));
  const cases = found.slice(0, MAX_CAUSAL_CASES).map(({ c, found: f }) => ({ name: c.name.slice(0, MAX_NAME_CHARS), reach: f.reach, basis: f.basis }));
  const inReach = found.filter((f) => f.found.reach === "in-reach");
  if (inReach.length > 0) {
    const basis = inReach[0]!.found.basis;
    return {
      reach: "in-reach",
      basis,
      via: unique(inReach.flatMap((f) => f.found.via)).slice(0, MAX_CAUSAL_VIA),
      reason: `${inReach.length} of ${failed.length} failing case(s) are in the change's reach (${basis})`,
      cases,
    };
  }
  if (found.every((f) => f.found.reach === "out-of-reach")) {
    return {
      reach: "out-of-reach",
      basis: found[0]!.found.basis,
      via: unique(found.flatMap((f) => f.found.via)).slice(0, MAX_CAUSAL_VIA),
      reason: "every failing case touches an entry point the change does not reach",
      cases,
    };
  }
  return { reach: "unknown", basis: "none", via: [], reason: input.scope === undefined ? "the run has no change scope to compare the failure with" : "the failure carries no evidence the scope can place", cases };
}

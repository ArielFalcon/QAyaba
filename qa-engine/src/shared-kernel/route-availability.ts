/*
 * Why a route the live-DOM capture asked for was not available at its own address: the change made it so, it may be a
 * regression, the environment kept it away, it was so before the change, or nothing says. One class per route, from facts the
 * orchestrator holds (the capture's navigation, the diff, the code graph, the app's declared login page); no model decides it.
 * Shared by the grounding that classifies (generation), the plan check and the briefs (coordination), the fix loop, the gate
 * signal and the publication (run-orchestration, workspace-and-publication) and the graders (evaluation). Values only.
 */

export const AVAILABILITY_CLASS = {
  CHANGE_INTRODUCED: "change-introduced",
  REGRESSION_CANDIDATE: "regression-candidate",
  ENVIRONMENT: "environment",
  PRE_EXISTING: "pre-existing",
  UNEXPLAINED: "unexplained",
} as const;

export type AvailabilityClass = (typeof AVAILABILITY_CLASS)[keyof typeof AVAILABILITY_CLASS];

/* `server`: the document itself answered with a redirect; `client`: the page loaded and then moved the browser; `unknown`: the capture could not tell. */
export type RedirectMechanism = "server" | "client" | "unknown";

/* Where an unavailable route ended: on another pathname, or on an error status at its own address. */
export type UnavailableOutcome =
  | { kind: "redirected"; to: string; mechanism: RedirectMechanism }
  | { kind: "http-error"; status: number };

/* The evidence a class rests on, by id: the route table at the base and at head (E1), a changed symbol reaching a guard it lists (E2), whether the capture carried a session, and whether the change lives in this repository. */
export type AvailabilityEvidenceId = "declaration" | "guard-reach" | "session" | "change-repo";

export type AvailabilityBasis =
  /* The change edits the route's declaration (`at` is file:line of a changed line in it) or a changed symbol reaches its guard (`at` is file::symbol). */
  | { class: "change-introduced"; via: "route-declaration" | "route-guard"; at: string }
  /* The change reaches the route (its declaration or guards, or only its page) and the page logged a runtime error: a crash sending the browser away is not a contract. */
  | { class: "regression-candidate"; reach: "governs" | "implements"; runtimeError: true }
  | { class: "environment"; why: "login-without-session" | "session-rejected" | "dev-gate" | "data-missing" }
  /* `session-consistent`: the app's declared login page sends a signed-in session away. `unchanged`: the route table entries that decide the route (`at`) and its guards are the same at the base and at head, and no changed symbol reaches them; that proves the redirect is not caused by this change, not that it is intended. */
  | { class: "pre-existing"; why: "session-consistent" | "unchanged"; at?: string }
  /* `missing` names the evidence that was absent or partial. */
  | { class: "unexplained"; missing: readonly AvailabilityEvidenceId[] };

export interface RouteAvailabilityFact {
  /* The address the capture opened (a page of a template when `template` is set). */
  route: string;
  template?: string;
  outcome: UnavailableOutcome;
  /* Whether the capture opened the route with the run's saved session. Absent when the capture did not say. */
  sessionAttached?: boolean;
  basis: AvailabilityBasis;
}

/* The most facts the gate signal lists; the rest are counted. */
export const MAX_AVAILABILITY_FACTS_RECORDED = 16;

/* What a run recorded of route availability. A signal, never a gate: it reads nothing back into a verdict. */
export interface RouteAvailabilityGateSignal {
  /* Routes the capture read with an outcome the classification trusts. */
  read: number;
  unavailable: number;
  byClass: Partial<Record<AvailabilityClass, number>>;
  facts: Array<{ route: string; class: AvailabilityClass; why: string; to?: string }>;
  omitted: number;
}

/* The one word that says why a fact has its class: the declaration or guard, the reach, the environment's reason, the pre-existing basis, or the missing evidence. */
export function availabilityWhy(basis: AvailabilityBasis): string {
  switch (basis.class) {
    case "change-introduced":
      return basis.via;
    case "regression-candidate":
      return basis.reach;
    case "environment":
    case "pre-existing":
      return basis.why;
    case "unexplained":
      return basis.missing.length > 0 ? `missing ${basis.missing.join("+")}` : "no evidence";
  }
}

/* Where the browser ended, in words: `/home (client-side)`, or `HTTP 404`. */
export function outcomeText(outcome: UnavailableOutcome): string {
  if (outcome.kind === "http-error") return `HTTP ${outcome.status}`;
  return outcome.mechanism === "unknown" ? outcome.to : `${outcome.to} (${outcome.mechanism === "server" ? "server redirect" : "client-side"})`;
}

/* The gate signal of a run's facts, given how many routes were read. */
export function routeAvailabilitySignal(read: number, facts: readonly RouteAvailabilityFact[]): RouteAvailabilityGateSignal {
  const byClass: Partial<Record<AvailabilityClass, number>> = {};
  for (const fact of facts) byClass[fact.basis.class] = (byClass[fact.basis.class] ?? 0) + 1;
  const listed = facts.slice(0, MAX_AVAILABILITY_FACTS_RECORDED).map((fact) => ({
    route: fact.route,
    class: fact.basis.class,
    why: availabilityWhy(fact.basis),
    ...(fact.outcome.kind === "redirected" ? { to: fact.outcome.to } : {}),
  }));
  return { read, unavailable: facts.length, byClass, facts: listed, omitted: Math.max(0, facts.length - listed.length) };
}

/* The facts of one class, in the order given. */
export function factsOfClass(facts: readonly RouteAvailabilityFact[], cls: AvailabilityClass): RouteAvailabilityFact[] {
  return facts.filter((fact) => fact.basis.class === cls);
}

/* The fact of a route: by its address, else by its template. */
export function factForRoute(facts: readonly RouteAvailabilityFact[], route: string): RouteAvailabilityFact | undefined {
  const path = pathOnly(route);
  return facts.find((fact) => pathOnly(fact.route) === path) ?? facts.find((fact) => fact.template !== undefined && pathOnly(fact.template) === path);
}

/* A route's pathname with no query or hash and no trailing slash (the root stays `/`). */
export function pathOnly(route: string): string {
  const cut = route.split(/[?#]/)[0] ?? "";
  const trimmed = cut.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

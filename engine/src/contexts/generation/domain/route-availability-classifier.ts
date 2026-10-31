/*
 * The class of a route the capture could not show at its own address. Ordered rules, first match wins; every input is a fact
 * the orchestrator produced (the capture's navigation, the diff against the route's declaration, the code graph's reach to its
 * guards, the app's declared login page). A class needs positive evidence: missing or partial evidence falls to the next rule
 * and finally to `unexplained`, never to `pre-existing`. A read the capture does not trust gets no class. Pure.
 */
import { pathOnly, type AvailabilityBasis, type AvailabilityEvidenceId, type RouteAvailabilityFact, type UnavailableOutcome } from "@kernel/route-availability.ts";

/* What the capture saw of one route (O1, O2). */
export interface RouteNavigation {
  route: string;
  template?: string;
  captureFailed: boolean;
  settled: boolean;
  /* How many nodes the tree it read held. */
  nodes: number;
  /* The pathname the browser ended on. Absent when the capture did not report one. */
  finalPath?: string;
  /* The HTTP status of the document the browser kept. */
  documentStatus?: number;
  /* Whether the document itself answered with a redirect (true), the document stayed at the address and the page moved the browser (false), or the capture could not tell (absent). */
  serverRedirect?: boolean;
  sessionAttached?: boolean;
  runtimeError: boolean;
  /* The page it ended on showed a password field. */
  passwordField: boolean;
}

/* E1: the route table entries that decide the route (its own entry and its parents', the entries that can match before them, the fallbacks) at the base and at head. `changed`: one of them differs, or the route was deleted; `at` is file:line. `unknown`: no extractor read the route's table, or a difference could not be placed. */
export type DeclarationEvidence = { status: "changed"; at: string } | { status: "unchanged"; at: string } | { status: "unknown" };

/* E2: whether a changed symbol reaches a guard the route table lists for the route (its own and its parents'), through the code graph's closure from the changed symbols. `unreached` only when every listed guard was placed and the closure was complete; `partial` otherwise. `at` is file::symbol. */
export type GuardEvidence = { status: "reached"; at: string } | { status: "unreached" } | { status: "partial" };

export interface RouteChangeEvidence {
  declaration: DeclarationEvidence;
  /* Absent when the run's walk gave no route facts: rules that need it fall to `unexplained`. */
  guards?: GuardEvidence;
  /* The links of the route table that could not be followed (where and what), or why there is no table; recorded on an unexplained route so that the missing evidence names its cause. */
  unresolved?: readonly string[];
  /* E3: the change reaches the page's own implementation (not its declaration). */
  implements: boolean;
}

export interface AvailabilityContext {
  /* The app's declared login page (auth.loginPath). */
  loginPath?: string;
  /* Another route of the same capture rendered at its own address: the session the capture holds works. */
  controlRendered: boolean;
  /* The change lives in another repository (a service of a cross-repo run): code unchanged here does not clear it, since the service change may be what sends the route away. */
  changeElsewhere?: boolean;
}

export interface ClassifyInput {
  navigation: RouteNavigation;
  evidence: RouteChangeEvidence;
  context: AvailabilityContext;
  /* For a page of a template: what its sibling that cannot exist showed. Absent when it was not read. */
  sibling?: UnavailableOutcome | "rendered";
}

/* Where the route ended, or undefined when it rendered at its own address. */
export function outcomeOf(nav: RouteNavigation): UnavailableOutcome | undefined {
  if (nav.finalPath !== undefined && pathOnly(nav.finalPath) !== pathOnly(nav.route)) {
    const mechanism = nav.serverRedirect === true ? "server" : nav.serverRedirect === false ? "client" : "unknown";
    return { kind: "redirected", to: pathOnly(nav.finalPath), mechanism };
  }
  if (nav.documentStatus !== undefined && nav.documentStatus >= 400) return { kind: "http-error", status: nav.documentStatus };
  return undefined;
}

const SERVER_ERROR = 500;
const GATE_STATUSES: ReadonlySet<number> = new Set([401, 407]);

/* Whether a pathname is the declared page or below it. */
function isUnder(path: string, declared: string | undefined): boolean {
  if (declared === undefined || !declared.startsWith("/")) return false;
  const base = pathOnly(declared);
  const own = pathOnly(path);
  return own === base || (base !== "/" && own.startsWith(`${base}/`));
}

/* Whether a route is the declared login page itself (not a page below it). */
const isLoginPage = (route: string, declared: string | undefined): boolean => declared !== undefined && declared.startsWith("/") && pathOnly(route) === pathOnly(declared);

function sameOutcome(a: UnavailableOutcome, b: UnavailableOutcome | "rendered"): boolean {
  if (b === "rendered" || a.kind !== b.kind) return false;
  return a.kind === "redirected" ? a.to === (b as { to: string }).to : a.status === (b as { status: number }).status;
}

/* The class of one route, or undefined when it rendered at its own address or its read is not trustworthy. */
export function classifyRouteAvailability(input: ClassifyInput): RouteAvailabilityFact | undefined {
  const { navigation: nav, evidence, context, sibling } = input;
  /* Rule 1: a failed or unsettled read is not evidence; a redirect that may still be in flight is not one either. */
  if (nav.captureFailed || !nav.settled) return undefined;
  const outcome = outcomeOf(nav);
  /* Rule 0 (and an empty render at the route's own address, rule 1). */
  if (outcome === undefined) return undefined;
  const basis = basisOf(nav, outcome, evidence, context, sibling);
  return {
    route: nav.route,
    ...(nav.template !== undefined ? { template: nav.template } : {}),
    outcome,
    ...(nav.sessionAttached !== undefined ? { sessionAttached: nav.sessionAttached } : {}),
    basis,
  };
}

function basisOf(nav: RouteNavigation, outcome: UnavailableOutcome, evidence: RouteChangeEvidence, context: AvailabilityContext, sibling: ClassifyInput["sibling"]): AvailabilityBasis {
  const { declaration, guards } = evidence;
  const governs = declaration.status === "changed" || guards?.status === "reached";
  const runtimeError = nav.runtimeError || (nav.documentStatus !== undefined && nav.documentStatus >= SERVER_ERROR);
  const toLogin = outcome.kind === "redirected" && (isUnder(outcome.to, context.loginPath) || nav.passwordField);
  /* Rule 2: sent to a login page, unless the change governs the route and the capture's session demonstrably works (or there is none to blame). */
  if (toLogin && !(governs && (nav.sessionAttached !== true || context.controlRendered))) {
    return { class: "environment", why: nav.sessionAttached === true ? "session-rejected" : "login-without-session" };
  }
  /* Rule 3: the DEV gate refused the document. */
  if (outcome.kind === "http-error" && GATE_STATUSES.has(outcome.status)) return { class: "environment", why: "dev-gate" };
  /* Rule 4: a page of a template whose sibling that cannot exist ends the same way: DEV lacks the data, not the route. */
  if (nav.template !== undefined && sibling !== undefined && sameOutcome(outcome, sibling)) return { class: "environment", why: "data-missing" };
  /* Rules 5 and 6: the change governs the route. A crash is never its contract. */
  if (governs) {
    if (runtimeError) return { class: "regression-candidate", reach: "governs", runtimeError: true };
    return declaration.status === "changed"
      ? { class: "change-introduced", via: "route-declaration", at: declaration.at }
      : { class: "change-introduced", via: "route-guard", at: (guards as { at: string }).at };
  }
  /* Rule 8: the declared login page sends a signed-in session to a page of the app. */
  if (isLoginPage(nav.route, context.loginPath) && nav.sessionAttached === true && outcome.kind === "redirected" && !toLogin) {
    return { class: "pre-existing", why: "session-consistent" };
  }
  /* Rule 9: the change reaches only the page itself, and the page crashed. */
  if (evidence.implements && runtimeError) return { class: "regression-candidate", reach: "implements", runtimeError: true };
  /* Rule 10: the route table entries that decide the route and its guards are the same at the base and at head, and no changed symbol reaches them: the redirect is not caused by this change. Never on a change that lives in another repository. */
  if (declaration.status === "unchanged" && guards?.status === "unreached" && !evidence.implements && context.changeElsewhere !== true) {
    return { class: "pre-existing", why: "unchanged", at: declaration.at };
  }
  /* Rule 11. */
  const missing: AvailabilityEvidenceId[] = [];
  if (declaration.status === "unknown") missing.push("declaration");
  if (guards === undefined || guards.status === "partial") missing.push("guard-reach");
  if (isLoginPage(nav.route, context.loginPath) && nav.sessionAttached === undefined) missing.push("session");
  if (context.changeElsewhere === true) missing.push("change-repo");
  /* The cause of a declaration or guard evidence that is missing: the specific link the route table could not follow. */
  const links = missing.includes("declaration") || missing.includes("guard-reach") ? evidence.unresolved ?? [] : [];
  return { class: "unexplained", missing, ...(links.length > 0 ? { links } : {}) };
}

/* The classes of one capture's routes, in the order given: the control of rule 2 is any route of the capture that rendered at its own address with content. */
export function classifyCapture(
  routes: readonly { navigation: RouteNavigation; sibling?: ClassifyInput["sibling"] }[],
  evidenceOf: (navigation: RouteNavigation) => RouteChangeEvidence,
  context: Omit<AvailabilityContext, "controlRendered">,
): RouteAvailabilityFact[] {
  const rendered = routes.filter(({ navigation: nav }) => !nav.captureFailed && nav.settled && nav.nodes > 0 && outcomeOf(nav) === undefined);
  const facts: RouteAvailabilityFact[] = [];
  for (const { navigation, sibling } of routes) {
    const controlRendered = rendered.some((other) => other.navigation.route !== navigation.route);
    const fact = classifyRouteAvailability({ navigation, evidence: evidenceOf(navigation), context: { ...context, controlRendered }, ...(sibling !== undefined ? { sibling } : {}) });
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

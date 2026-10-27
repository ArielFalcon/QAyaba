import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCapture,
  classifyRouteAvailability,
  type ClassifyInput,
  type RouteChangeEvidence,
  type RouteNavigation,
} from "@contexts/generation/domain/route-availability-classifier.ts";
import { routeAvailabilitySignal } from "@kernel/route-availability.ts";

/* A settled read of `/upload-menu/preview` that ended on `/home`, client-side, with the run's session. */
const redirected = (over: Partial<RouteNavigation> = {}): RouteNavigation => ({
  route: "/upload-menu/preview",
  captureFailed: false,
  settled: true,
  nodes: 12,
  finalPath: "/home",
  documentStatus: 200,
  serverRedirect: false,
  sessionAttached: true,
  runtimeError: false,
  passwordField: false,
  ...over,
});

const unknownEvidence: RouteChangeEvidence = { declaration: { status: "unknown" }, implements: false };
const declarationChanged: RouteChangeEvidence = { declaration: { status: "changed", at: "src/app.routes.ts:102" }, implements: false };
const provenUnchanged: RouteChangeEvidence = { declaration: { status: "unchanged", at: "src/app.routes.ts:53" }, guards: { status: "unreached" }, implements: false };

const classify = (input: Partial<ClassifyInput> & { navigation: RouteNavigation }) =>
  classifyRouteAvailability({ evidence: unknownEvidence, context: { loginPath: "/login", controlRendered: true }, ...input });

test("rule 0: a route that rendered at its own address gets no availability fact", () => {
  assert.equal(classify({ navigation: redirected({ finalPath: "/upload-menu/preview" }), evidence: declarationChanged }), undefined);
});

test("rule 1: a read that never settled, or failed, is not evidence of anything", () => {
  assert.equal(classify({ navigation: redirected({ settled: false }), evidence: declarationChanged }), undefined);
  assert.equal(classify({ navigation: redirected({ captureFailed: true }), evidence: declarationChanged }), undefined);
  assert.equal(classify({ navigation: redirected({ finalPath: undefined, nodes: 0 }), evidence: declarationChanged }), undefined);
});

test("rule 2: a route sent to the login page without a session is the environment's, whatever the change", () => {
  const fact = classify({ navigation: redirected({ finalPath: "/login", sessionAttached: false }), evidence: provenUnchanged });
  assert.deepEqual(fact?.basis, { class: "environment", why: "login-without-session" });
  const rejected = classify({ navigation: redirected({ finalPath: "/login", sessionAttached: true }), evidence: provenUnchanged, context: { loginPath: "/login", controlRendered: false } });
  assert.deepEqual(rejected?.basis, { class: "environment", why: "session-rejected" });
});

test("rule 2: a page showing a password field counts as a login page even with no declared login path", () => {
  const fact = classify({ navigation: redirected({ finalPath: "/signin", passwordField: true, sessionAttached: true }), context: { controlRendered: false } });
  assert.deepEqual(fact?.basis, { class: "environment", why: "session-rejected" });
});

test("rule 3: a document the DEV gate refused is the environment's", () => {
  const fact = classify({ navigation: redirected({ finalPath: "/upload-menu/preview", documentStatus: 401 }), evidence: declarationChanged });
  assert.deepEqual(fact?.outcome, { kind: "http-error", status: 401 });
  assert.deepEqual(fact?.basis, { class: "environment", why: "dev-gate" });
});

test("rule 4: a template page whose impossible sibling ends the same way lacks data on DEV", () => {
  const fact = classify({ navigation: redirected({ route: "/shops/x/y", template: "/shops/:province/:city" }), sibling: { kind: "redirected", to: "/home", mechanism: "client" } });
  assert.deepEqual(fact?.basis, { class: "environment", why: "data-missing" });
  const differs = classify({ navigation: redirected({ route: "/shops/x/y", template: "/shops/:province/:city" }), sibling: "rendered" });
  assert.equal(differs?.basis.class, "unexplained");
});

test("rule 5: a changed line in the route's declaration makes the redirect the change's behaviour", () => {
  const fact = classify({ navigation: redirected(), evidence: declarationChanged });
  assert.deepEqual(fact?.basis, { class: "change-introduced", via: "route-declaration", at: "src/app.routes.ts:102" });
  assert.deepEqual(fact?.outcome, { kind: "redirected", to: "/home", mechanism: "client" });
  assert.equal(fact?.sessionAttached, true);
});

test("rule 5: a changed symbol reaching the route's guard makes the redirect the change's behaviour", () => {
  const evidence: RouteChangeEvidence = { declaration: { status: "unchanged", at: "src/app.routes.ts:101" }, guards: { status: "reached", at: "src/guards/native-only.guard.ts::nativeOnlyGuard" }, implements: false };
  assert.deepEqual(classify({ navigation: redirected(), evidence })?.basis, { class: "change-introduced", via: "route-guard", at: "src/guards/native-only.guard.ts::nativeOnlyGuard" });
});

test("rule 5: the change governing a route sent to login with a working session is the change's", () => {
  const fact = classify({ navigation: redirected({ finalPath: "/login" }), evidence: declarationChanged, context: { loginPath: "/login", controlRendered: true } });
  assert.equal(fact?.basis.class, "change-introduced");
});

test("rule 6: a governed route whose page logged a runtime error is a regression candidate, not a contract", () => {
  const fact = classify({ navigation: redirected({ runtimeError: true }), evidence: declarationChanged });
  assert.deepEqual(fact?.basis, { class: "regression-candidate", reach: "governs", runtimeError: true });
  const serverError = classify({ navigation: redirected({ finalPath: "/upload-menu/preview", documentStatus: 502 }), evidence: declarationChanged });
  assert.deepEqual(serverError?.basis, { class: "regression-candidate", reach: "governs", runtimeError: true });
});

test("rule 8: the declared login page sending a captured session away is pre-existing", () => {
  const fact = classify({ navigation: redirected({ route: "/login", finalPath: "/home" }) });
  assert.deepEqual(fact?.basis, { class: "pre-existing", why: "session-consistent" });
});

test("rule 8 needs a declared login page and an attached session", () => {
  assert.equal(classify({ navigation: redirected({ route: "/login" }), context: { controlRendered: true } })?.basis.class, "unexplained");
  const noSessionFact = classify({ navigation: redirected({ route: "/login", sessionAttached: undefined }) });
  assert.deepEqual(noSessionFact?.basis, { class: "unexplained", missing: ["declaration", "guard-reach", "session"] });
});

test("rule 9: a page the change reaches only through its implementation that crashed away is a regression candidate", () => {
  const fact = classify({ navigation: redirected({ runtimeError: true }), evidence: { ...provenUnchanged, implements: true } });
  assert.deepEqual(fact?.basis, { class: "regression-candidate", reach: "implements", runtimeError: true });
});

test("rule 10: an unchanged declaration whose guards no changed symbol reaches is pre-existing", () => {
  const fact = classify({ navigation: redirected({ route: "/" }), evidence: provenUnchanged });
  assert.deepEqual(fact?.basis, { class: "pre-existing", why: "unchanged", at: "src/app.routes.ts:53" });
});

test("rule 10 never holds on partial evidence: no walk, a partial walk, or an unknown declaration is unexplained", () => {
  const noWalk = classify({ navigation: redirected({ route: "/" }), evidence: { declaration: { status: "unchanged", at: "src/app.routes.ts:1" }, implements: false } });
  assert.deepEqual(noWalk?.basis, { class: "unexplained", missing: ["guard-reach"] });
  const partial = classify({ navigation: redirected({ route: "/" }), evidence: { declaration: { status: "unchanged", at: "src/app.routes.ts:1" }, guards: { status: "partial" }, implements: false } });
  assert.deepEqual(partial?.basis, { class: "unexplained", missing: ["guard-reach"] });
  const noDeclaration = classify({ navigation: redirected({ route: "/" }), evidence: { declaration: { status: "unknown" }, guards: { status: "unreached" }, implements: false } });
  assert.deepEqual(noDeclaration?.basis, { class: "unexplained", missing: ["declaration"] });
});

test("rule 10 does not clear a route when the change lives in another repository", () => {
  const fact = classify({ navigation: redirected({ route: "/" }), evidence: provenUnchanged, context: { loginPath: "/login", controlRendered: true, changeElsewhere: true } });
  assert.deepEqual(fact?.basis, { class: "unexplained", missing: ["change-repo"] });
});

test("rule 10 does not hold for a page whose implementation the change reaches", () => {
  const fact = classify({ navigation: redirected({ route: "/" }), evidence: { ...provenUnchanged, implements: true } });
  assert.deepEqual(fact?.basis, { class: "unexplained", missing: [] });
});

test("rule 11: with no evidence at all the route is unexplained and says what was missing", () => {
  const fact = classify({ navigation: redirected({ route: "/login/callback" }) });
  assert.deepEqual(fact?.basis, { class: "unexplained", missing: ["declaration", "guard-reach"] });
});

test("rule 11: an unexplained route carries the links its evidence could not follow, only while declaration or guard reach is what is missing", () => {
  const links = ["src/app.routes.ts:12 guard authGuard is unplaced: `@core/guards` matches no `paths` entry"];
  const fact = classify({ navigation: redirected({ route: "/login/callback" }), evidence: { ...unknownEvidence, unresolved: links } });
  assert.deepEqual(fact?.basis, { class: "unexplained", missing: ["declaration", "guard-reach"], links });
  assert.deepEqual(routeAvailabilitySignal(1, [fact!]).facts[0]?.links, links);
  /* Proven evidence leaves nothing to name: the unresolved links of an entry the route does not depend on are not attached. */
  const elsewhere = classify({ navigation: redirected({ route: "/" }), evidence: { ...provenUnchanged, unresolved: links }, context: { loginPath: "/login", controlRendered: true, changeElsewhere: true } });
  assert.deepEqual(elsewhere?.basis, { class: "unexplained", missing: ["change-repo"] });
});

test("a server redirect and an undetermined one are told apart from a client-side one", () => {
  assert.deepEqual(classify({ navigation: redirected({ serverRedirect: true }), evidence: declarationChanged })?.outcome, { kind: "redirected", to: "/home", mechanism: "server" });
  assert.deepEqual(classify({ navigation: redirected({ serverRedirect: undefined }), evidence: declarationChanged })?.outcome, { kind: "redirected", to: "/home", mechanism: "unknown" });
});

test("a capture classifies only its unavailable routes, and the control of rule 2 is another route that rendered", () => {
  const facts = classifyCapture(
    [
      { navigation: redirected({ route: "/orders", finalPath: "/orders" }) },
      { navigation: redirected({ route: "/upload-menu/confirm", finalPath: "/login" }) },
    ],
    () => declarationChanged,
    { loginPath: "/login" },
  );
  assert.deepEqual(facts.map((fact) => [fact.route, fact.basis.class]), [["/upload-menu/confirm", "change-introduced"]]);
  const alone = classifyCapture([{ navigation: redirected({ route: "/upload-menu/confirm", finalPath: "/login" }) }], () => declarationChanged, { loginPath: "/login" });
  assert.deepEqual(alone.map((fact) => fact.basis), [{ class: "environment", why: "session-rejected" }]);
});

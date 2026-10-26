/* buildChangeScope over the three proof strategies: page-kind reach equals the change pages the map-and-graph join proves on the same fixtures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeScope, CHANGE_SCOPE_LIMITS, crossRepoCallSite, fileImplementsPage, handlerServesOperation, tierOf, type ProofWalk, type ReachHit, type ReachProof, type ScopeInput } from "@contexts/change-analysis/application/index.ts";
import { routeServesOperation } from "@contexts/service-topology/domain/cross-repo-impact.ts";
import type { GraphRoute, ImpactedSymbol } from "@kernel/code/index.ts";

const FORMAT = "web/src/app/shared/format.ts";
const ORDERS = "web/src/app/orders/orders.page.ts";
const PROFILE = "web/src/app/profile/profile.page.ts";
const API = "api/src/OrdersController.java";

const sym = (file: string, symbol: string, depth: number, via?: { file: string; symbol: string }, confidence = 1): ImpactedSymbol => ({ file, symbol, kind: "function", depth, confidence, ...(depth === 0 ? { range: { start: 1, end: 5 } } : {}), ...(via ? { via } : {}) });
const FORMAT_SEED = { file: FORMAT, symbol: "formatMoney" };
const MAP = {
  routes: [{ path: "/orders", implementationFiles: [ORDERS] }, { path: "/profile", implementationFiles: [PROFILE] }, { path: "/home" }],
  api: [{ operationId: "listOrders", method: "GET", path: "/api/orders" }, { operationId: "ping", method: "GET", path: "/api/ping" }],
  feBe: [{ route: "/orders", operationId: "listOrders" }],
};
const PROOFS = [fileImplementsPage, handlerServesOperation(routeServesOperation), crossRepoCallSite];

const walkOf = (reached: ImpactedSymbol[], extra: Partial<ProofWalk> = {}): ProofWalk => ({ repo: "org/web", reached, handlers: false, ...extra });
const scope = (walks: ProofWalk[], over: Partial<ScopeInput> = {}, extra: { pageRoutes?: GraphRoute[]; handlerRoutes?: GraphRoute[]; map?: typeof MAP } = {}, proofs: readonly ReachProof[] = PROOFS) =>
  buildChangeScope({ proofs: { map: extra.map ?? MAP, walks, pageRoutes: extra.pageRoutes ?? [], handlerRoutes: extra.handlerRoutes ?? [] }, repos: [], degraded: [], linked: new Set(), ...over }, proofs);
const pagesOf = (s: ReturnType<typeof scope>) => s.reach.filter((r) => r.entry.kind === "page").map((r) => ({ route: (r.entry as { route: string }).route, proof: r.evidence })).sort((a, b) => a.route.localeCompare(b.route));

test("page reach, its evidence, hubs and disagreements over the characterised fixtures", () => {
  type Expected = { pages: Array<{ route: string; proof: string[] }>; hubs: unknown[]; disagreements: unknown[] };
  const cases: Array<{ walks: ProofWalk[]; pageRoutes?: GraphRoute[]; linked?: Set<string>; expected: Expected }> = [
    { walks: [walkOf([sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, FORMAT_SEED)])], expected: { pages: [{ route: "/orders", proof: [`${FORMAT}::formatMoney`, `${ORDERS}::total`, "page /orders"] }], hubs: [], disagreements: [] } },
    { walks: [walkOf([sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, FORMAT_SEED), sym(PROFILE, "balance", 1, FORMAT_SEED)])], linked: new Set(["/orders"]), expected: { pages: [{ route: "/profile", proof: [`${FORMAT}::formatMoney`, `${PROFILE}::balance`, "page /profile"] }], hubs: [], disagreements: [] } },
    { walks: [walkOf([sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, FORMAT_SEED), sym(PROFILE, "balance", 1, FORMAT_SEED)], { truncated: true })], expected: { pages: [], hubs: [[`${FORMAT}::formatMoney`, 2, true]], disagreements: [] } },
    { walks: [walkOf([sym(FORMAT, "formatMoney", 0), sym("web/src/app/orders/classic.page.ts", "Classic", 1, FORMAT_SEED)])], pageRoutes: [{ file: "web/src/app/app.routes.ts", line: 3, path: "/orders", target: { file: "web/src/app/orders/classic.page.ts", symbol: "Classic", kind: "class" } }], expected: { pages: [], hubs: [], disagreements: [{ route: "/orders", mapFiles: [ORDERS], engineFile: "web/src/app/orders/classic.page.ts" }] } },
  ];
  for (const c of cases) {

    const built = scope(c.walks, { linked: c.linked ?? new Set() }, { ...(c.pageRoutes ? { pageRoutes: c.pageRoutes } : {}) });

    assert.deepEqual(pagesOf(built), c.expected.pages);
    assert.deepEqual(built.hubs.map((h) => [h.symbol, h.entries, h.truncated]), c.expected.hubs);
    assert.deepEqual(built.disagreements, c.expected.disagreements);
  }
});

test("an operation a handler serves is an entry point even when no page is joined to it", () => {
  const handler: GraphRoute = { file: API, line: 9, method: "GET", path: "/api/ping", target: { file: API, symbol: "ping", kind: "method" } };
  const walk = walkOf([sym(API, "ping", 0)], { repo: "org/api", handlers: true });

  const built = scope([walk], {}, { handlerRoutes: [handler] });

  assert.deepEqual(built.reach.map((r) => r.entry), [{ kind: "operation", repo: "org/api", verb: "GET", path: "/api/ping", operationId: "ping" }]);
  assert.deepEqual(built.reach[0]!.seeds, [{ file: API, symbol: "ping", range: { start: 1, end: 5 } }]);
});

test("a changed symbol reaching more entries than the hub limit adds none and is reported, as is a truncated seed", () => {
  const map = { routes: ["/a", "/b", "/c", "/d", "/e"].map((path, i) => ({ path, implementationFiles: [`web/p${i}.ts`] })) };
  const reached = [sym(FORMAT, "formatMoney", 0), ...map.routes.map((r, i) => sym(`web/p${i}.ts`, `p${i}`, 1, FORMAT_SEED))];

  const hub = scope([walkOf(reached)], {}, { map: map as never });
  const cut = scope([walkOf(reached.slice(0, 2), { truncated: true })], {}, { map: map as never });

  assert.deepEqual([hub.reach.length, hub.hubs.map((h) => [h.symbol, h.entries])], [0, [[`${FORMAT}::formatMoney`, 5]]]);
  assert.deepEqual([cut.reach.length, cut.hubs[0]?.truncated], [0, true]);
});

test("a walk the budget cut marks the scope even when it proved no entry, and an uncut one does not", () => {
  const cut = scope([walkOf([sym(FORMAT, "formatMoney", 0)], { truncated: true })]);
  const whole = scope([walkOf([sym(FORMAT, "formatMoney", 0)])]);

  assert.deepEqual([cut.reach.length, cut.hubs.length, cut.walksTruncated], [0, 0, true]);
  assert.equal("walksTruncated" in whole, false);
});

test("a map-linked changed file is direct, a depth-2 graph hit is indirect and a call-site hit is cross-repo", () => {
  const direct = scope([walkOf([sym(ORDERS, "total", 0)])]);
  const indirect = scope([walkOf([sym(FORMAT, "formatMoney", 0), sym("web/mid.ts", "mid", 1, FORMAT_SEED), sym(PROFILE, "balance", 2, { file: "web/mid.ts", symbol: "mid" })])]);
  const site = scope([walkOf([sym("web/api.ts", "fetchOrders", 0), sym(ORDERS, "total", 1, { file: "web/api.ts", symbol: "fetchOrders" })], { prefixOf: new Map([["web/api.ts::fetchOrders", ["org/api: GET /api/orders"]]]) })]);

  assert.deepEqual([direct, indirect, site].map((s) => [s.reach[0]!.tier, s.reach[0]!.basis]), [["direct", "implementation"], ["indirect", "graph"], ["cross-repo", "call-site"]]);
  assert.deepEqual(site.reach[0]!.evidence, ["org/api: GET /api/orders", "web/api.ts::fetchOrders", `${ORDERS}::total`, "page /orders"]);
  assert.equal(tierOf({ basis: "handler", hops: 1 }), "direct");
});

test("reach is ordered by tier, then confidence, and capped with the rest counted", () => {
  const reached = [sym(FORMAT, "formatMoney", 0), sym(ORDERS, "total", 1, FORMAT_SEED, 0.4), sym(PROFILE, "balance", 1, FORMAT_SEED, 0.9)];

  const built = scope([walkOf(reached)], { limits: { maxReach: 1, hubEntries: CHANGE_SCOPE_LIMITS.hubEntries } });

  assert.deepEqual([built.reach.map((r) => (r.entry as { route: string }).route), built.omitted], [["/profile"], 1]);
});

test("pages and operations are capped each on their own, so operations never crowd a page out of the reach", () => {
  const hit = (entry: ReachHit["entry"], hops: number): ReachHit => ({ entry, basis: "contract", seed: { file: "x.ts", symbol: `x${hops}` }, hops, evidence: ["x.ts::x"], confidence: 1, seedCut: false });
  const fake: ReachProof = {
    id: "fake",
    prove: (): readonly ReachHit[] => [
      ...["/a", "/b", "/c"].map((path) => hit({ kind: "operation", repo: "org/api", verb: "GET", path: `/api${path}` }, 0)),
      ...["/x", "/y", "/z"].map((route) => hit({ kind: "page", repo: "org/web", route }, 2)),
    ],
  };

  const built = scope([], { limits: { maxReach: 2, hubEntries: CHANGE_SCOPE_LIMITS.hubEntries } }, {}, [fake]);

  assert.deepEqual(built.reach.filter((r) => r.entry.kind === "page").map((r) => (r.entry as { route: string }).route), ["/x", "/y"]);
  assert.deepEqual(built.reach.filter((r) => r.entry.kind === "operation").map((r) => (r.entry as { path: string }).path), ["/api/a", "/api/b"]);
  assert.equal(built.omitted, 2);
});

test("a new proof contributes entries without any change to buildChangeScope", () => {
  const fake: ReachProof = { id: "fake", prove: (): readonly ReachHit[] => [{ entry: { kind: "page", repo: "org/web", route: "/home" }, basis: "contract", seed: { file: "x.ts", symbol: "x" }, hops: 0, evidence: ["x.ts::x", "page /home"], confidence: 1, seedCut: false }] };

  const built = scope([], {}, {}, [...PROOFS, fake]);

  assert.deepEqual(built.reach.map((r) => [r.entry, r.tier]), [[{ kind: "page", repo: "org/web", route: "/home" }, "cross-repo"]]);
});

test("the repos and the degraded repos of the input are carried unchanged", () => {
  const built = scope([], { degraded: [{ repo: "org/api", reason: "the index did not answer" }] });

  assert.deepEqual(built.degraded, [{ repo: "org/api", reason: "the index did not answer" }]);
  assert.deepEqual(built.reach, []);
});

test("a reached symbol named for an operationId proves the pages feBe joins to it with no route node, and a generated contract interface yields none", () => {
  const impl = "api/src/main/java/demo/web/OrdersApiImpl.java";

  const built = scope([walkOf([sym(impl, "listOrders", 0)], { repo: "org/api", handlers: true })]);

  assert.deepEqual(pagesOf(built), [{ route: "/orders", proof: [`${impl}::listOrders`, "GET /api/orders (listOrders)", "page /orders"] }]);
});

test("a map that is not what its type says is read field by field and never thrown on", () => {
  const map = { routes: [{ path: 3, implementationFiles: "x" }, null as never, { path: "/ok", implementationFiles: [7 as never, ORDERS] }], api: [{ operationId: 1 as never }], feBe: [{}] };

  const built = scope([walkOf([sym(ORDERS, "total", 0)], { handlers: true })], {}, { map: map as never });

  assert.deepEqual(pagesOf(built).map((p) => p.route), ["/ok"]);
});

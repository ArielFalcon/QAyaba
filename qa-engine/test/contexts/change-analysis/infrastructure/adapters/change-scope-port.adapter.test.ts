/* The change scope over the run's index: every repo of the change is walked in itself, a service's change reaches the app's pages through the call sites of its links, and an index that cannot answer is a degraded entry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeScopePortAdapter, entryPointsOf } from "@contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts";
import { MAX_KNOWN_ENTRY_POINTS, crossRepoCallSite, fileImplementsPage, handlerServesOperation, openapiOperationDiff } from "@contexts/change-analysis/application/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { DEFAULT_WALK_POLICY, type GraphRoute, type ImpactedSymbol, type LocalSymbolRef } from "@kernel/code/index.ts";
import type { PageMap } from "@contexts/change-analysis/domain/page-files.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import { err, ok } from "@kernel/result.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "abc1234";
const BUDGET = DEFAULT_WALK_POLICY;
const ORDERS = "web/src/app/orders/orders.page.ts";
const FORMAT = "web/src/app/shared/format.ts";
const MAP = { routes: [{ path: "/orders", implementationFiles: [ORDERS] }], api: [], feBe: [] };
const PROOFS = [fileImplementsPage, handlerServesOperation(() => false), crossRepoCallSite];

const report = (symbols: ImpactedSymbol[], seedBasis: "lines" | "whole-file" | "none" = "lines") => ok({ indexedSha: SHA, symbols, truncated: false, seedBasis });
const sym = (file: string, symbol: string, depth: number, via?: LocalSymbolRef): ImpactedSymbol => ({ file, symbol, kind: "function", depth, confidence: 1, ...(via ? { via } : {}) });

function graph(over: Partial<CodeGraphPort> = {}): CodeGraphPort {
  return {
    syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }),
    impactedSymbols: over.impactedSymbols ?? (async () => report([])),
    callersOf: over.callersOf ?? (async () => report([])),
    routes: over.routes ?? (async () => ok([])),
  };
}

const front = { repo: "org/web", role: "primary" as const, repoDir: "/m/web", headSha: SHA, changedFiles: [FORMAT] };
const adapter = (g: CodeGraphPort, loadMap?: () => PageMap | undefined) => new ChangeScopePortAdapter({ codeGraph: g, budget: BUDGET, proofs: PROOFS, ...(loadMap ? { loadMap } : {}) });

const link = (from: Partial<LocalSymbolRef>): ServiceLink => ({
  from: { repo: "org/web", file: from.file ?? "", symbol: from.symbol ?? "" },
  to: { repo: "org/orders-api", file: "api/OrderController.java", symbol: "listAll" },
  transport: "http",
  operation: { verb: "GET", path: "/api/orders" },
  confidence: 0.9,
  source: "openapi",
});

test("a primary repo is walked in itself: its seeds, their basis and the pages they reach, direct and indirect", async () => {
  const g = graph({
    impactedSymbols: async () => report([sym(FORMAT, "formatMoney", 0), { ...sym(ORDERS, "total", 1, { file: FORMAT, symbol: "formatMoney" }) }]),
    routes: async () => ok([{ file: ORDERS, line: 1, path: "/orders" }, { file: "api/O.java", line: 3, method: "get", path: "/api/orders" }]),
  });
  const scope = await adapter(g, () => MAP).resolve({ specDir: "/s", repos: [front] });
  assert.deepEqual(scope.degraded, []);
  assert.equal(scope.repos[0]!.seedBasis, "lines");
  assert.equal(scope.repos[0]!.indexedSha, SHA);
  assert.deepEqual(scope.repos[0]!.seeds.map((s) => s.symbol), ["formatMoney"]);
  assert.deepEqual(scope.repos[0]!.entryPoints.map((e) => e.kind), ["operation", "page"]);
  assert.deepEqual(scope.reach.map((r) => [r.entry.kind === "page" ? r.entry.route : "", r.tier]), [["/orders", "direct"]]);
});

test("without a map the scope still lists the repo's entry points and stays empty of map-declared pages", async () => {
  const g = graph({ impactedSymbols: async () => report([sym(ORDERS, "total", 0)]), routes: async () => ok([{ file: ORDERS, line: 1, path: "/orders" }]) });
  const scope = await adapter(g).resolve({ specDir: "/s", repos: [front] });
  assert.equal(scope.repos[0]!.entryPoints.length, 1);
  assert.deepEqual(scope.degraded, []);
});

test("a repo whose walk the index cannot answer is a degraded entry that still lists its routes", async () => {
  const g = graph({ impactedSymbols: async () => err({ reason: "not indexed" }), routes: async () => ok([{ file: ORDERS, line: 1, path: "/orders" }]) });
  const scope = await adapter(g).resolve({ specDir: "/s", repos: [front] });
  assert.deepEqual(scope.degraded, [{ repo: "org/web", reason: "walk: not indexed" }]);
  assert.equal(scope.repos[0]!.seedBasis, "none");
  assert.equal(scope.repos[0]!.indexedSha, null);
  assert.equal(scope.repos[0]!.entryPoints.length, 1);
  assert.deepEqual(scope.reach, []);
});

test("routes the index cannot list are a degraded entry; the walk still decides by the map's files", async () => {
  const g = graph({ impactedSymbols: async () => report([sym(ORDERS, "total", 0)]), routes: async () => err({ reason: "no routes" }) });
  const scope = await adapter(g, () => MAP).resolve({ specDir: "/s", repos: [front] });
  assert.deepEqual(scope.degraded, [{ repo: "org/web", reason: "routes: no routes" }]);
  assert.deepEqual(scope.reach.map((r) => r.entry.kind === "page" && r.entry.route), ["/orders"]);
});

test("an index that throws never throws out of the scope", async () => {
  const g = graph({ impactedSymbols: async () => { throw new Error("boom"); } });
  const scope = await adapter(g).resolve({ specDir: "/s", repos: [front] });
  assert.deepEqual(scope.degraded, [{ repo: "org/web", reason: "boom" }]);
  assert.equal(scope.repos.length, 1);
});

test("a map that cannot be read leaves the scope to the graph alone", async () => {
  const g = graph({ impactedSymbols: async () => report([sym(ORDERS, "total", 0)]) });
  const scope = await adapter(g, () => { throw new Error("bad map"); }).resolve({ specDir: "/s", repos: [front] });
  assert.deepEqual(scope.reach, []);
  assert.deepEqual(scope.degraded, []);
});

test("a service's change reaches the app's pages through the call sites of its links, each proof opened by the link", async () => {
  const seeds: LocalSymbolRef[][] = [];
  const g = graph({
    impactedSymbols: async (repo) => (repo === "/m/api" ? report([sym("api/OrderController.java", "listAll", 0)]) : report([])),
    callersOf: async (repo, symbols) => {
      assert.equal(repo, "/m/web");
      seeds.push([...symbols]);
      return report([sym(ORDERS, "load", 1, { file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" }), sym("web/src/app/orders/orders.api.ts", "listOrders", 0)]);
    },
  });
  const scope = await adapter(g, () => MAP).resolve({
    specDir: "/s",
    repos: [{ repo: "org/orders-api", role: "service", repoDir: "/m/api", headSha: SHA, changedFiles: ["api/OrderController.java"] }],
    pages: { repo: "org/web", repoDir: "/m/web" },
    crossRepoImpact: { impactedLinks: [{ link: link({ file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" }), tier: "impacted-symbol" }] } as never,
  });
  assert.deepEqual(seeds[0], [{ file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" }]);
  assert.deepEqual(scope.reach.map((r) => [r.entry.kind === "page" && r.entry.route, r.tier, r.basis]), [["/orders", "cross-repo", "call-site"]]);
  assert.match(scope.reach[0]!.evidence[0]!, /^org\/orders-api: GET \/api\/orders/);
  assert.deepEqual(scope.repos.map((r) => r.role), ["service"]);
});

test("a service change with links but no indexed app repo says so instead of reaching nothing silently", async () => {
  const scope = await adapter(graph()).resolve({
    specDir: "/s",
    repos: [{ repo: "org/orders-api", role: "service", repoDir: "/m/api", headSha: SHA, changedFiles: ["a.java"] }],
    crossRepoImpact: { impactedLinks: [{ link: link({ file: "w.ts", symbol: "f" }), tier: "impacted-symbol" }] } as never,
  });
  assert.equal(scope.degraded.length, 1);
  assert.match(scope.degraded[0]!.reason, /not indexed/);
});

test("entry points are every route the engine knows: handlers as operations, the rest as pages, sorted, de-duplicated and capped", () => {
  const routes: GraphRoute[] = [
    { file: "a", line: 1, path: "/b" },
    { file: "a", line: 2, path: "/b" },
    { file: "c", line: 3, method: "post", path: "/api/x" },
  ];
  const { entryPoints, truncated } = entryPointsOf("org/r", routes);
  assert.deepEqual(entryPoints.map((e) => (e.kind === "page" ? e.route : `${e.verb} ${e.path}`)), ["/b", "POST /api/x"]);
  assert.equal(truncated, false);
  const many = Array.from({ length: MAX_KNOWN_ENTRY_POINTS + 5 }, (_, i): GraphRoute => ({ file: "f", line: i, path: `/p${i}` }));
  const capped = entryPointsOf("org/r", many);
  assert.equal(capped.entryPoints.length, MAX_KNOWN_ENTRY_POINTS);
  assert.equal(capped.truncated, true);
});

const apiRepo = { repo: "org/orders-api", role: "service" as const, repoDir: "/m/api", headSha: SHA, changedFiles: ["api/openapi.yaml"] };
const withProofs = (g: CodeGraphPort) => new ChangeScopePortAdapter({ codeGraph: g, budget: BUDGET, proofs: [...PROOFS, openapiOperationDiff], loadMap: () => MAP });
const impacted = (operationChange?: "added" | "removed" | "changed") => ({ impactedLinks: [{ link: link({ file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" }), tier: "contract-file", ...(operationChange ? { operationChange } : {}) }] }) as never;

test("an impacted contract operation is an operation entry of its service, reached across repos with the link as evidence", async () => {
  const scope = await withProofs(graph()).resolve({ specDir: "/s", repos: [apiRepo], pages: { repo: "org/web", repoDir: "/m/web" }, crossRepoImpact: impacted("changed") });
  const operation = scope.reach.find((r) => r.entry.kind === "operation");
  assert.deepEqual(operation?.entry, { kind: "operation", repo: "org/orders-api", verb: "GET", path: "/api/orders" });
  assert.equal(operation?.tier, "cross-repo");
  assert.equal(operation?.basis, "contract");
  assert.deepEqual(operation?.evidence, ["org/orders-api: GET /api/orders"]);
});

test("an operation the change removed reaches its callers with evidence saying so; one it added reaches no caller", async () => {
  const callers = graph({ callersOf: async () => report([sym(ORDERS, "load", 1, { file: "web/src/app/orders/orders.api.ts", symbol: "listOrders" }), sym("web/src/app/orders/orders.api.ts", "listOrders", 0)]) });
  const removed = await withProofs(callers).resolve({ specDir: "/s", repos: [apiRepo], pages: { repo: "org/web", repoDir: "/m/web" }, crossRepoImpact: impacted("removed") });
  const page = removed.reach.find((r) => r.entry.kind === "page");
  assert.match(page?.evidence[0] ?? "", /^org\/orders-api: GET \/api\/orders \(removed\)$/);

  let asked = false;
  const spy = graph({ callersOf: async () => { asked = true; return report([]); } });
  const added = await withProofs(spy).resolve({ specDir: "/s", repos: [apiRepo], pages: { repo: "org/web", repoDir: "/m/web" }, crossRepoImpact: impacted("added") });
  assert.equal(asked, false, "an added operation has no caller to walk from");
  assert.deepEqual(added.reach.map((r) => r.entry.kind), ["operation"]);
});

test("candidates carry the map's page links of the changed files, the suite's manifest targets and objectives and the specs that open the route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candidates-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "manifest.json"), JSON.stringify([{ id: "a", objective: "o", flow: "f", file: "orders.spec.ts", targets: ["/orders"], changeRef: { sha: "x", type: "feat" } }]));
    writeFileSync(join(dir, "opens-profile.spec.ts"), "await page.goto('/profile');");
    const map = { routes: [{ path: "/orders", name: "Orders", implementationFiles: [ORDERS] }, { path: "/profile", source: "web/src/app/profile/routes.ts" }], api: [], feBe: [] };
    const g = graph({ impactedSymbols: async () => report([sym(FORMAT, "formatMoney", 0)]) });
    const subject = adapter(g, () => map);
    const scope = await subject.resolve({ specDir: dir, repos: [{ ...front, changedFiles: [ORDERS, "web/src/app/profile/routes.ts"] }] });

    const candidates = await subject.candidates({ specDir: dir, scope });

    assert.deepEqual(candidates.map((c) => [c.entry.kind === "page" ? c.entry.route : "", c.basis, c.label ?? null, c.existingSpecs]), [
      ["/orders", "implementation", "Orders", ["orders.spec.ts"]],
      ["/profile", "source", null, ["opens-profile.spec.ts"]],
    ]);
    assert.deepEqual(candidates.map((c) => c.specObjectives ?? null), [{ "orders.spec.ts": ["o"] }, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidates exist from the graph's routes alone when no map and no suite can be read", async () => {
  const g = graph({ impactedSymbols: async () => report([sym(ORDERS, "total", 0)]), routes: async () => ok([{ file: ORDERS, line: 1, path: "/orders", target: { file: ORDERS, symbol: "total", kind: "function" } }]) });
  const subject = adapter(g);
  const scope = await subject.resolve({ specDir: "/does/not/exist", repos: [front] });

  const candidates = await subject.candidates({ specDir: "/does/not/exist", scope });

  assert.deepEqual(candidates.map((c) => [c.entry.kind, c.reachability, c.existingSpecs]), [["page", "page", []]]);
});

test("a page only the map links to the changed files is seeded by those files and counts the lines the diff added to them", async () => {
  const STYLE = "web/src/app/orders/orders.page.scss";
  const g = graph({ impactedSymbols: async () => report([]) });
  const subject = adapter(g, () => ({ routes: [{ path: "/orders", implementationFiles: [ORDERS, STYLE] }], api: [], feBe: [] }));
  const touched = new Map([[STYLE, new Set([3, 4, 9])]]);
  const scope = await subject.resolve({ specDir: "/s", repos: [{ ...front, changedFiles: [STYLE], touchedLines: touched }] });

  const [candidate] = await subject.candidates({ specDir: "/does/not/exist", scope });

  assert.deepEqual(candidate!.seeds.map((s) => [s.file, s.range]), [[STYLE, undefined]]);
  assert.deepEqual(candidate!.changedFiles, [{ file: STYLE, addedLines: 3 }]);
});

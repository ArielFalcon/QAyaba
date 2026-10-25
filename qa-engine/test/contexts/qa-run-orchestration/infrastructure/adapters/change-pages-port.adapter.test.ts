/* The walks behind the change-page join: in one repo the change and what reaches it, across repos the frontend call sites of the links the stitcher found reached. An index that cannot answer adds nothing; a link without a call-site symbol claims nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangePagesPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/adapters/change-pages-port.adapter.ts";
import type { ChangePagesRequest, ServiceLink } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { ImpactedSymbol, LocalSymbolRef } from "@kernel/code/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import { err, ok } from "@kernel/result.ts";

const SHA = "abc1234";
const BUDGET = { depth: 3, maxSymbols: 300 };
const ORDERS = "web/src/app/orders/orders.page.ts";
const API = "web/src/app/orders/orders.api.ts";
const MAP = { builtAtSha: SHA, routes: [{ path: "/orders", implementationFiles: [ORDERS] }], api: [], feBe: [] };

const report = (symbols: ImpactedSymbol[]) => ok({ indexedSha: SHA, symbols, truncated: false });

function fakeGraph(over: Partial<CodeGraphPort> = {}): CodeGraphPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }),
    impactedSymbols: over.impactedSymbols ?? (async (repo) => { asked.push(`impacted ${repo}`); return report([]); }),
    callersOf: over.callersOf ?? (async (repo) => { asked.push(`callers ${repo}`); return report([]); }),
    routes: over.routes ?? (async (repo) => { asked.push(`routes ${repo}`); return ok([]); }),
  };
}

const request = (over: Partial<ChangePagesRequest> = {}): ChangePagesRequest => ({ map: MAP, sha: SHA, changedFiles: ["web/src/app/shared/format.ts"], linked: new Set(), ...over });

const link = (from: Partial<LocalSymbolRef>): ServiceLink => ({
  from: { repo: "org/web", file: from.file ?? "", symbol: from.symbol ?? "" },
  to: { repo: "org/orders-api", file: "api/OrderController.java", symbol: "listAll" },
  transport: "http",
  operation: { verb: "GET", path: "/api/orders" },
  confidence: 0.9,
  source: "openapi",
});

test("in one repo the change is walked with its touched lines and the routes of the same index", async () => {
  let walked: BlastRadius | undefined;
  const graph = fakeGraph({
    impactedSymbols: async (_repo, changed) => {
      walked = changed;
      return report([{ file: "web/src/app/shared/format.ts", symbol: "formatMoney", kind: "function", depth: 0 }, { file: ORDERS, symbol: "total", kind: "method", depth: 1, via: { file: "web/src/app/shared/format.ts", symbol: "formatMoney" } }]);
    },
  });
  const adapter = new ChangePagesPortAdapter({ codeGraph: graph, repoDir: "/m/web", budget: BUDGET });
  const touched = new Map([["web/src/app/shared/format.ts", new Set([2])]]);

  const join = await adapter.resolve(request({ touchedLines: touched }));

  assert.deepEqual(join?.pages.map((p) => p.route), ["/orders"]);
  assert.deepEqual(walked?.touchedLines, touched);
  assert.equal(walked?.sha.toString(), SHA);
});

test("an index that cannot answer the walk adds nothing; routes it cannot list leave the map's files to decide", async () => {
  const unavailable = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => err({ reason: "not indexed" }) }), repoDir: "/m/web", budget: BUDGET });
  assert.equal(await unavailable.resolve(request()), undefined);

  const noRoutes = new ChangePagesPortAdapter({
    codeGraph: fakeGraph({ impactedSymbols: async () => report([{ file: ORDERS, symbol: "total", kind: "method", depth: 0 }]), routes: async () => err({ reason: "x" }) }),
    repoDir: "/m/web",
    budget: BUDGET,
  });
  assert.deepEqual((await noRoutes.resolve(request()))?.pages.map((p) => p.route), ["/orders"]);
});

test("a walk that throws is logged and adds nothing", async () => {
  const adapter = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => { throw new Error("boom"); } }), repoDir: "/m/web", budget: BUDGET });
  assert.equal(await adapter.resolve(request()), undefined);
});

test("across repos the walk starts at the call sites of the reached links in the app's index, each proof opened by its link", async () => {
  const seedsAsked: LocalSymbolRef[][] = [];
  const graph = fakeGraph({
    callersOf: async (repo, symbols) => {
      graph.asked.push(`callers ${repo}`);
      seedsAsked.push([...symbols]);
      return report([{ file: API, symbol: "fetchOrders", kind: "function", depth: 0 }, { file: ORDERS, symbol: "load", kind: "method", depth: 1, via: { file: API, symbol: "fetchOrders" } }]);
    },
  });
  const adapter = new ChangePagesPortAdapter({ codeGraph: graph, repoDir: "/m/orders-api", pagesRepoDir: "/m/web", budget: BUDGET });
  const impactedLinks = [{ link: link({ file: API, symbol: "fetchOrders" }), tier: "impacted-symbol" as const }, { link: link({ file: API, symbol: "fetchOrders" }), tier: "contract-file" as const }];

  const join = await adapter.resolve(request({ crossRepoImpact: { impactedLinks } }));

  assert.deepEqual(seedsAsked, [[{ file: API, symbol: "fetchOrders" }]], "one seed per call site");
  assert.deepEqual(join?.pages, [{ route: "/orders", proof: ["org/orders-api: GET /api/orders", `${API}::fetchOrders`, `${ORDERS}::load`, "page /orders"] }]);
  assert.equal(graph.asked.includes("impacted /m/orders-api"), false, "the service's own change is the stitcher's to match, not re-walked here");
  assert.ok(graph.asked.includes("routes /m/web"));
});

test("across repos a link without a call-site symbol claims no page, and no reached link asks nothing", async () => {
  const graph = fakeGraph();
  const adapter = new ChangePagesPortAdapter({ codeGraph: graph, repoDir: "/m/orders-api", pagesRepoDir: "/m/web", budget: BUDGET });

  const join = await adapter.resolve(request({ crossRepoImpact: { impactedLinks: [{ link: link({ file: API }), tier: "contract-file" }] } }));
  assert.deepEqual(join, { pages: [], hubs: [], disagreements: [], omitted: 0 });
  assert.deepEqual(await adapter.resolve(request({ crossRepoImpact: null })), { pages: [], hubs: [], disagreements: [], omitted: 0 });
  assert.deepEqual(graph.asked, []);
});

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  return { warnings, restore: () => { console.warn = original; } };
}

test("an index that cannot answer a walk or list routes says so in the log, with the engine's reason", async () => {
  const log = captureWarnings();
  try {
    const walkFails = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => err({ reason: "query timed out" }) }), repoDir: "/m/web", budget: BUDGET });
    assert.equal(await walkFails.resolve(request()), undefined);
    const routesFail = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => report([]), routes: async () => err({ reason: "reader rejected the index version" }) }), repoDir: "/m/web", budget: BUDGET });
    await routesFail.resolve(request());
  } finally { log.restore(); }
  assert.equal(log.warnings.some((w) => w.includes("query timed out")), true);
  assert.equal(log.warnings.some((w) => w.includes("reader rejected the index version")), true);
});

test("a walk the budget cut is logged and its seeds are no proven non-hubs; a complete walk logs nothing", async () => {
  const reached = [{ file: ORDERS, symbol: "total", kind: "method", depth: 0 }];
  const log = captureWarnings();
  let join;
  try {
    const cut = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => ok({ indexedSha: SHA, symbols: reached, truncated: true }) }), repoDir: "/m/web", budget: BUDGET });
    join = await cut.resolve(request());
  } finally { log.restore(); }
  assert.deepEqual(join?.pages, []);
  assert.equal(join?.hubs[0]?.truncated, true);
  assert.equal(log.warnings.length, 1);

  const quiet = captureWarnings();
  try {
    const whole = new ChangePagesPortAdapter({ codeGraph: fakeGraph({ impactedSymbols: async () => report(reached) }), repoDir: "/m/web", budget: BUDGET });
    assert.deepEqual((await whole.resolve(request()))?.pages.map((p) => p.route), ["/orders"]);
  } finally { quiet.restore(); }
  assert.deepEqual(quiet.warnings, []);
});

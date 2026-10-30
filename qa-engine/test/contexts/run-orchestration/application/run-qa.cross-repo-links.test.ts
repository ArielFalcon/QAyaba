/* What the run's impact step records over several links of one call site, links reached both ways and walks it could not finish (RFC-0011): the real impact use case and the real change scope over a fake code graph keyed by repo, through the run's two steps. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { ok } from "@kernel/result.ts";
import { DEFAULT_WALK_POLICY, type GraphRoute, type ImpactedSymbol, type LocalSymbolRef } from "@kernel/code/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CrossRepoImpact, ServiceLink } from "@kernel/service-links.ts";
import { ChangeSet, crossRepoCallSite, fileImplementsPage, handlerServesOperation, openapiOperationDiff, type ChangeScope, type ChangeScopePort } from "@contexts/change-analysis/application/index.ts";
import { ChangeScopePortAdapter } from "@contexts/change-analysis/infrastructure/adapters/change-scope-port.adapter.ts";
import { CrossRepoImpactPortAdapter } from "@contexts/service-topology/infrastructure/adapters/cross-repo-impact-port.adapter.ts";
import type { GenerationEnrichment } from "@contexts/generation/domain/generation-enrichment.ts";
import type { SandboxedBinaryRunner } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { RIG_SPEC, dispose, newRig, observe, scratchDir, type Rig } from "./run-flow/run-end-rig.ts";

const APP = "org/app";
const PAGE = "web/src/app/orders/orders.page.ts";
const MAP = { routes: [{ path: "/orders", implementationFiles: [PAGE] }], api: [], feBe: [] };
const sym = (ref: LocalSymbolRef, depth: number, extra: Partial<ImpactedSymbol> = {}): ImpactedSymbol => ({ ...ref, kind: "method", depth, confidence: 1, ...extra });
const key = (r: LocalSymbolRef) => `${r.file}::${r.symbol}`;
const route = (target: LocalSymbolRef, method: string, path: string): GraphRoute => ({ file: target.file, line: 1, method, path, target: { ...target, kind: "method" } });

/* A repo's index: for each seed it holds, what a callers walk from it reaches; what its changed files reach; its routes. */
interface RepoIndex {
  callers?: Record<string, LocalSymbolRef[]>;
  changed?: LocalSymbolRef[];
  routes?: GraphRoute[];
  /* How many seeds the walk of the repo's change leaves open at the expansion budget (it reaches nothing of them). */
  partial?: number;
}

interface World {
  rig: Rig;
  scopes: ChangeScope[];
  impacts: Array<CrossRepoImpact | null | undefined>;
  enrichments: Array<GenerationEnrichment | undefined>;
  dirOf: (repo: string) => string;
}

function world(opts: {
  repos: string[];
  links: ServiceLink[];
  indexes: Record<string, RepoIndex>;
  changed: Array<{ repo: string; role: "primary" | "service"; file: string }>;
  mirrors?: string[];
  onSync?: (repo: string) => { outcome: "failed"; reason: string } | undefined;
}): World {
  const rig = newRig();
  const root = scratchDir(rig, "qa-links-");
  const dirs = new Map(opts.repos.map((r) => [r, join(root, r.replaceAll("/", "__"))]));
  for (const d of dirs.values()) mkdirSync(d, { recursive: true });
  const dirOf = (repo: string) => dirs.get(repo)!;
  const repoOf = (dir: string) => [...dirs].find(([, d]) => d === dir)?.[0] ?? "?";
  let calls = 0;
  const graph: CodeGraphPort = {
    syncTo: async (repoDir, sha) => {
      const forced = opts.onSync?.(repoOf(repoDir));
      return { repo: repoDir, engine: "fake", engineVersion: "1", sha, outcome: forced?.outcome ?? "built", durationMs: 0, nodeCount: 1, edgeCount: 0, ...(forced ? { reason: forced.reason } : {}) };
    },
    impactedSymbols: async (repoDir) => {
      const idx = opts.indexes[repoOf(repoDir)] ?? {};
      const symbols = (idx.changed ?? []).map((s) => sym(s, 0));
      return ok({ indexedSha: "x", symbols, truncated: (idx.partial ?? 0) > 0, ...(idx.partial ? { partialSeeds: Array.from({ length: idx.partial }, (_, i) => ({ file: "web/other.ts", symbol: `open${i}` })) } : {}), seedBasis: "lines" as const });
    },
    callersOf: async (repoDir, seeds) => {
      calls += 1;
      if (calls > 200) throw new Error("runaway walk");
      const idx = opts.indexes[repoOf(repoDir)] ?? {};
      const out = new Map<string, ImpactedSymbol>();
      for (const seed of seeds) {
        const reached = idx.callers?.[key(seed)];
        if (!reached) continue;
        if (!out.has(key(seed))) out.set(key(seed), sym(seed, 0, { seeds: [{ ...seed, hops: 0 }] }));
        for (const r of reached) {
          const held = out.get(key(r));
          if (held) held.seeds = [...(held.seeds ?? []), { ...seed, hops: 1 }];
          else out.set(key(r), sym(r, 1, { via: seed, seeds: [{ ...seed, hops: 1 }] }));
        }
      }
      return ok({ indexedSha: "x", symbols: [...out.values()], truncated: false, seedBasis: "lines" as const });
    },
    routes: async (repoDir) => ok(opts.indexes[repoOf(repoDir)]?.routes ?? []),
  };
  const runner: SandboxedBinaryRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) };
  const shaOf = (repo: string) => Sha.of(`${(opts.repos.indexOf(repo) + 1).toString().repeat(7)}`);
  const changedFileOf = (repo: string) => opts.changed.find((c) => c.repo === repo)?.file ?? "none.txt";
  const makeVcs = (dir: string) => ({ blastRadius: async () => BlastRadius.of(shaOf(repoOf(dir)), [changedFileOf(repoOf(dir))]) });
  const real = new ChangeScopePortAdapter({ codeGraph: graph, budget: DEFAULT_WALK_POLICY, proofs: [fileImplementsPage, handlerServesOperation(() => false), crossRepoCallSite, openapiOperationDiff], loadMap: () => MAP });
  const scopes: ChangeScope[] = [];
  const impacts: Array<CrossRepoImpact | null | undefined> = [];
  const changeScope: ChangeScopePort = { resolve: async (request) => { impacts.push(request.crossRepoImpact); const s = await real.resolve(request); scopes.push(s); return s; }, candidates: (request) => real.candidates(request) };
  const entries = opts.changed.map((c) => ({ repo: c.repo, role: c.role, headSha: shaOf(c.repo) }));
  const set = ChangeSet.of("demo", entries);
  const anchor = set.anchor;
  rig.input = { changeSet: set, sha: anchor.headSha, ...(anchor.role === "service" ? { triggerRepo: anchor.repo } : {}) };
  const anchorFile = changedFileOf(anchor.repo);
  rig.classify = async () => ({ action: "generate", reason: "x", diff: `diff --git a/${anchorFile} b/${anchorFile}\n--- a/${anchorFile}\n+++ b/${anchorFile}\n@@ -1,1 +1,2 @@\n a\n+b\n`, intent: { type: "feat", breaking: false, message: "m", changedFiles: [anchorFile] } });
  const enrichments: Array<GenerationEnrichment | undefined> = [];
  rig.author = async (_specDir, _signal, _diff, enrichment) => { enrichments.push(enrichment); return scriptedGeneration({ specs: [RIG_SPEC] }); };
  const others = entries.filter((e) => e.repo !== anchor.repo);
  const services = opts.mirrors ?? opts.repos.filter((r) => r !== APP);
  rig.extra = {
    serviceLinks: { resolve: async () => ({ links: [...opts.links], drift: [] }) },
    crossRepoImpact: new CrossRepoImpactPortAdapter({ mirrors: { mirrorDir: async (repo: string) => dirOf(repo) }, makeVcs, codeGraph: graph, runner }),
    changeScope,
    codeGraph: graph,
    codeGraphRepoDir: dirOf(anchor.repo),
    ...(anchor.role === "service" ? { codeGraphPrimary: { repo: APP, repoDir: dirOf(APP), headSha: async () => "a111111" } } : {}),
    ...(others.length > 0 ? { codeGraphRepoDirs: new Map(others.map((e) => [e.repo, dirOf(e.repo)] as const)) } : {}),
    codeGraphMirrors: new Map(services.map((r) => [r, { repoDir: dirOf(r), headSha: async () => "f00f00f" }] as const)),
  };
  return { rig, scopes, impacts, enrichments, dirOf };
}

const link = (from: { repo: string; file: string; symbol: string }, to: { repo: string; symbol: string }, verb: string, path: string): ServiceLink => ({ from, to: { repo: to.repo, file: "api.yaml", symbol: to.symbol }, transport: "http", contractRef: to.symbol, operation: { verb, path }, confidence: 1, source: "openapi-http-resolver" });
const opsOf = (impact: CrossRepoImpact | null | undefined): string[] => (impact?.impactedLinks ?? []).map((l) => `${l.link.to.repo} ${l.link.operation?.path}`).sort();

/* The call site of the app that calls two operations of one backend, and the backend's own call site to a third service. */
const X = { file: "web/orders.api.ts", symbol: "load" };
const B_CALL = { file: "b/Client.java", symbol: "fetch" };
const B_LIST = { file: "b/Ctl.java", symbol: "listOrders" };
const B_GET = { file: "b/Ctl.java", symbol: "getOrder" };
const C_ITEMS = { file: "c/Ctl.java", symbol: "items" };
const appToList = link({ repo: APP, ...X }, { repo: "org/b", symbol: "listOrders" }, "GET", "/orders");
const appToGet = link({ repo: APP, ...X }, { repo: "org/b", symbol: "getOrder" }, "GET", "/orders/{id}");
const bToC = link({ repo: "org/b", ...B_CALL }, { repo: "org/c", symbol: "items" }, "GET", "/items");
const APP_INDEX: RepoIndex = { callers: { [key(X)]: [{ file: PAGE, symbol: "init" }] }, routes: [{ file: PAGE, line: 1, path: "/orders" }] };

test("two changed services whose operations one call site calls keep both links of that call site", async () => {
  const Y = { file: "web/stock.api.ts", symbol: "loadStock" };
  const C_LIST = { file: "c/Ctl.java", symbol: "list" };
  const C_GET = { file: "c/Ctl.java", symbol: "get" };
  const D_STOCK = { file: "d/Ctl.java", symbol: "stock" };
  const links = [
    link({ repo: APP, ...X }, { repo: "org/c", symbol: "list" }, "GET", "/items"),
    link({ repo: APP, ...X }, { repo: "org/c", symbol: "get" }, "GET", "/items/{id}"),
    link({ repo: APP, ...Y }, { repo: "org/d", symbol: "stock" }, "GET", "/stock"),
  ];
  const w = world({
    repos: [APP, "org/b", "org/c", "org/d"], links, changed: [{ repo: "org/c", role: "service", file: C_LIST.file }, { repo: "org/d", role: "service", file: D_STOCK.file }],
    indexes: {
      "org/c": { changed: [C_LIST, C_GET], routes: [route(C_LIST, "GET", "/items"), route(C_GET, "GET", "/items/{id}")] },
      "org/d": { changed: [D_STOCK], routes: [route(D_STOCK, "GET", "/stock")] },
      [APP]: { callers: { [key(X)]: [{ file: PAGE, symbol: "init" }], [key(Y)]: [{ file: PAGE, symbol: "init" }] }, routes: [{ file: PAGE, line: 1, path: "/orders" }] },
    },
  });
  try {
    const observed = await observe(w.rig, "links-two-services");
    assert.deepEqual(opsOf(w.impacts[0]), ["org/c /items", "org/c /items/{id}", "org/d /stock"]);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 3);
  } finally {
    dispose(w.rig);
  }
});

test("a later hop that reaches two operations of one call site lists both links", async () => {
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, appToGet, bToC], changed: [{ repo: "org/c", role: "service", file: C_ITEMS.file }],
    indexes: {
      "org/c": { changed: [C_ITEMS], routes: [route(C_ITEMS, "GET", "/items")] },
      "org/b": { callers: { [key(B_CALL)]: [B_LIST, B_GET] }, routes: [route(B_LIST, "GET", "/orders"), route(B_GET, "GET", "/orders/{id}")] },
      [APP]: APP_INDEX,
    },
  });
  try {
    const observed = await observe(w.rig, "links-later-hop");
    assert.deepEqual(opsOf(w.impacts[0]), ["org/b /orders", "org/b /orders/{id}", "org/c /items"]);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 3);
  } finally {
    dispose(w.rig);
  }
});

test("downstream, the second operation a changed call site calls leads on to the links out of its handler", async () => {
  const B_CLIENT = { file: "b/Client.java", symbol: "fetchItems" };
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, appToGet, link({ repo: "org/b", ...B_CLIENT }, { repo: "org/c", symbol: "items" }, "GET", "/items")], changed: [{ repo: APP, role: "primary", file: X.file }],
    indexes: {
      [APP]: { changed: [X], ...APP_INDEX },
      "org/b": { callers: { [key(B_CLIENT)]: [B_GET] }, routes: [route(B_LIST, "GET", "/orders"), route(B_GET, "GET", "/orders/{id}")] },
    },
  });
  try {
    const observed = await observe(w.rig, "links-downstream");
    assert.deepEqual(opsOf(w.impacts[0]), ["org/b /orders", "org/b /orders/{id}", "org/c /items"]);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 3);
  } finally {
    dispose(w.rig);
  }
});

test("a link reached from both ends of a change in the app and in C is counted once", async () => {
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, bToC], changed: [{ repo: APP, role: "primary", file: X.file }, { repo: "org/c", role: "service", file: C_ITEMS.file }],
    indexes: {
      "org/c": { changed: [C_ITEMS], routes: [route(C_ITEMS, "GET", "/items")] },
      "org/b": { callers: { [key(B_CALL)]: [B_LIST] }, routes: [route(B_LIST, "GET", "/orders")] },
      [APP]: { changed: [X], ...APP_INDEX },
    },
  });
  try {
    const observed = await observe(w.rig, "links-both-ways");
    assert.equal(w.impacts[0]?.impactedLinks.length, 4, "each link is listed in each direction it was reached");
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 2, "the count is of distinct links");
  } finally {
    dispose(w.rig);
  }
});

test("a walk the budget left partial that found no link records the count as a lower bound, not as none found", async () => {
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, bToC], changed: [{ repo: APP, role: "primary", file: X.file }],
    indexes: { [APP]: { partial: 1, ...APP_INDEX } },
  });
  try {
    const observed = await observe(w.rig, "links-lower-bound");
    assert.deepEqual(w.impacts[0]?.impactedLinks, []);
    assert.equal(w.impacts[0]?.stops?.length, 1);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 0);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactLowerBound, true);
  } finally {
    dispose(w.rig);
  }
});

test("a run whose walks all finished does not mark its count as a lower bound", async () => {
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, bToC], changed: [{ repo: "org/c", role: "service", file: C_ITEMS.file }],
    indexes: { "org/c": { changed: [C_ITEMS], routes: [route(C_ITEMS, "GET", "/items")] }, "org/b": { callers: { [key(B_CALL)]: [B_LIST] }, routes: [route(B_LIST, "GET", "/orders")] }, [APP]: APP_INDEX },
  });
  try {
    const observed = await observe(w.rig, "links-complete");
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactedCount, 2);
    assert.equal(observed.saved[0]?.gateSignals?.crossRepoImpactLowerBound, undefined);
  } finally {
    dispose(w.rig);
  }
});

test("a downstream walk left partial is told to the agent and recorded, and is no gap of the change scope", async () => {
  const w = world({
    repos: [APP, "org/b", "org/c"], links: [appToList, bToC], changed: [{ repo: APP, role: "primary", file: X.file }],
    indexes: { [APP]: { partial: 1, ...APP_INDEX } },
  });
  try {
    await observe(w.rig, "links-downstream-partial");
    assert.deepEqual(w.enrichments[0]?.crossRepoImpact?.stops, [{ repo: APP, direction: "downstream", reason: "partial: 1 seed(s) left open at the expansion budget", partial: true }]);
    assert.deepEqual(w.scopes[0]!.degraded, [], "a downstream link is grounding only: no page is missed because of it");
  } finally {
    dispose(w.rig);
  }
});

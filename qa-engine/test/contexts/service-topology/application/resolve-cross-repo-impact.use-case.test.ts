/* Tier 2 of the cross-repo impact: a handler that takes any verb serves a link's operation, and an index that cannot answer (or a walk the budget cut) is said in the log instead of reading as "no impact". */
import type { ServiceLink } from "@kernel/service-links";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolveCrossRepoImpactUseCase } from "@contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { GraphRoute } from "@kernel/code/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { err, ok } from "@kernel/result.ts";

const REPO = "org/orders-api";
const SHA = "abc1234abc1234abc1234abc1234abc1234abcd";
const CONTROLLER = "src/main/java/demo/OrderController.java";
let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "cross-impact-uc-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const link: ServiceLink = {
  from: { repo: "org/web", file: "src/orders.api.ts", symbol: "remove" },
  to: { repo: REPO, file: "src/main/resources/api.yaml", symbol: "deleteOrder" },
  transport: "http",
  operation: { verb: "DELETE", path: "/api/orders/{id}" },
  confidence: 1,
  source: "openapi",
};
const runner = { refresh: async () => {} };

function graph(over: { impacted?: ReturnType<CodeGraphPort["impactedSymbols"]>; routes?: GraphRoute[] | { reason: string } }): CodeGraphPort {
  const reached = ok({ indexedSha: SHA, symbols: [{ file: CONTROLLER, symbol: "handle", kind: "method", depth: 0, confidence: 1 }], truncated: false, seedBasis: "lines" as const });
  return {
    syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }),
    impactedSymbols: async () => (over.impacted ? over.impacted : reached),
    callersOf: async () => ok({ indexedSha: SHA, symbols: [], truncated: false, seedBasis: "lines" as const }),
    routes: async () => (Array.isArray(over.routes) ? ok(over.routes) : over.routes ? err(over.routes) : ok([])),
  };
}

async function resolve(codeGraph: CodeGraphPort) {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const useCase = new ResolveCrossRepoImpactUseCase({ mirrorDir: async () => dir }, () => ({ blastRadius: async () => BlastRadius.of(Sha.of(SHA), [CONTROLLER]) }), codeGraph, runner);
    return { impact: await useCase.resolve(REPO, SHA, [link]), warnings };
  } finally { console.warn = original; }
}

const handler = (method: string): GraphRoute => ({ file: CONTROLLER, line: 9, method, path: "/orders/{orderId}", target: { file: CONTROLLER, symbol: "handle", kind: "method" } });

test("a reached handler that takes any verb impacts the link whatever its verb", async () => {
  const { impact } = await resolve(graph({ routes: [handler("ANY")] }));
  assert.equal(impact?.impactedLinks.length, 1);
});

test("a reached handler of another specific verb still impacts nothing", async () => {
  const { impact } = await resolve(graph({ routes: [handler("GET")] }));
  assert.equal(impact, null);
});

test("an index that cannot answer the walk or list routes is logged with its reason", async () => {
  const walkFails = await resolve(graph({ impacted: Promise.resolve(err({ reason: "query timed out" })) }));
  assert.equal(walkFails.impact, null);
  assert.equal(walkFails.warnings.some((w) => w.includes("query timed out")), true);

  const routesFail = await resolve(graph({ routes: { reason: "reader rejected the index version" } }));
  assert.equal(routesFail.warnings.some((w) => w.includes("reader rejected the index version")), true);
});

test("a walk the budget cut is logged; a complete one logs nothing", async () => {
  const cut = await resolve(graph({ impacted: Promise.resolve(ok({ indexedSha: SHA, symbols: [], truncated: true, seedBasis: "lines" as const })) }));
  assert.equal(cut.warnings.length, 1);
  const whole = await resolve(graph({ routes: [handler("ANY")] }));
  assert.deepEqual(whole.warnings, []);
});

const TWO_OPS = (extra: string): string => `
paths:
  /api/orders:
    get:
      operationId: listOrders
      responses:
        "200": { description: ok }
  /api/orders/{id}:
    delete:
      operationId: deleteOrder
      responses:
        "204": { description: gone }${extra}
`;
const listLink: ServiceLink = { ...link, to: { ...link.to, symbol: "listOrders" }, operation: { verb: "GET", path: "/api/orders" }, from: { ...link.from, symbol: "list" } };

async function resolveContract(files: { base?: string; head?: string }, fileAt: boolean = true) {
  const asked: string[] = [];
  const useCase = new ResolveCrossRepoImpactUseCase(
    { mirrorDir: async () => dir },
    () => ({
      blastRadius: async () => BlastRadius.of(Sha.of(SHA), [link.to.file]),
      ...(fileAt ? { fileAt: async (ref: string) => { asked.push(ref); return ref === SHA ? files.head : files.base; } } : {}),
    }),
    undefined,
    runner,
  );
  return { impact: await useCase.resolve(REPO, SHA, [link, listLink], "b".repeat(40)), asked };
}

test("a changed contract file impacts only the links whose operation changed in it", async () => {
  const { impact, asked } = await resolveContract({ base: TWO_OPS(""), head: TWO_OPS("\n        \"404\": { description: missing }") });
  assert.deepEqual(impact?.impactedLinks.map((l) => [l.link.operation?.verb, l.operationChange, l.basis]), [["DELETE", "changed", undefined]]);
  assert.deepEqual(asked.sort(), ["b".repeat(40), SHA].sort(), "the contract is read at the change's base and head");
});

test("a contract file whose two versions cannot be compared impacts every link on it and says so", async () => {
  const unparsable = await resolveContract({ base: TWO_OPS(""), head: ": : not yaml [" });
  assert.deepEqual(unparsable.impact?.impactedLinks.map((l) => l.basis), ["contract-file", "contract-file"]);
  const absent = await resolveContract({ base: undefined, head: TWO_OPS("") });
  assert.equal(absent.impact?.impactedLinks.length, 2);
  const noReader = await resolveContract({}, false);
  assert.deepEqual(noReader.impact?.impactedLinks.map((l) => [l.tier, l.basis, l.operationChange]), [["contract-file", "contract-file", undefined], ["contract-file", "contract-file", undefined]]);
});

test("a contract file changed only in prose impacts no link by its file", async () => {
  const { impact } = await resolveContract({ base: TWO_OPS(""), head: TWO_OPS("").replace("operationId: listOrders", "operationId: listOrders\n      description: all orders") });
  assert.equal(impact, null);
});

test("a base ref defaults to the commit before the head", async () => {
  const asked: string[] = [];
  const useCase = new ResolveCrossRepoImpactUseCase({ mirrorDir: async () => dir }, () => ({ blastRadius: async () => BlastRadius.of(Sha.of(SHA), [link.to.file]), fileAt: async (ref: string) => { asked.push(ref); return TWO_OPS(""); } }), undefined, runner);
  await useCase.resolve(REPO, SHA, [link]);
  assert.ok(asked.includes(`${SHA}^`));
});

/* A later hop upstream: the callers of the call sites of the links already impacted, walked in the repo those call sites are in. */
const BACKEND = "org/b";
const CALL = { file: "b/OrderClient.java", symbol: "fetch" };
const OTHER_CALL = { file: "b/StockClient.java", symbol: "stock" };
const HANDLER = { file: "b/OrderController.java", symbol: "listOrders" };
const into: ServiceLink = { from: { repo: "org/web", file: "web/orders.api.ts", symbol: "listOrders" }, to: { repo: BACKEND, file: HANDLER.file, symbol: HANDLER.symbol }, transport: "http", operation: { verb: "GET", path: "/orders" }, confidence: 1, source: "openapi" };
const fedBy = (call: { file: string; symbol: string }, over: Partial<ServiceLink> = {}) => ({
  link: { from: { repo: BACKEND, ...call }, to: { repo: "org/c", file: "c/api.yaml", symbol: "list" }, transport: "http", confidence: 1, source: "http-backend-resolver", ...over } as ServiceLink,
  tier: "impacted-symbol" as const,
});
const reachedHandler = (seeds?: Array<{ file: string; symbol: string; hops: number }>) => ({ ...HANDLER, kind: "method", depth: 1, confidence: 1, ...(seeds ? { seeds } : {}) });

function hopGraph(over: { callers?: Awaited<ReturnType<CodeGraphPort["callersOf"]>>; routes?: GraphRoute[] }): { codeGraph: CodeGraphPort; asked: Array<{ dir: string; seeds: unknown[] }> } {
  const asked: Array<{ dir: string; seeds: unknown[] }> = [];
  const base = graph({ routes: over.routes ?? [] });
  return {
    asked,
    codeGraph: {
      ...base,
      callersOf: async (dir, seeds) => {
        asked.push({ dir, seeds: [...seeds] });
        return over.callers ?? ok({ indexedSha: SHA, symbols: [], truncated: false, seedBasis: "lines" as const });
      },
    },
  };
}

const hopUseCase = (codeGraph: CodeGraphPort | undefined) => new ResolveCrossRepoImpactUseCase({ mirrorDir: async () => dir }, () => ({ blastRadius: async () => BlastRadius.of(Sha.of(SHA), []) }), codeGraph, runner);
const reachedAs = (symbols: unknown[], truncated = false, partialSeeds?: unknown[]) => ok({ indexedSha: SHA, symbols: symbols as never, truncated, seedBasis: "lines" as const, ...(partialSeeds ? { partialSeeds: partialSeeds as never } : {}) });

test("a later hop impacts the link into the repo whose handler the call sites' callers reach, and records the links crossed to it", async () => {
  const fed = fedBy(CALL);
  const { codeGraph, asked } = hopGraph({ callers: reachedAs([{ ...CALL, kind: "method", depth: 0, confidence: 1 }, reachedHandler([{ ...CALL, hops: 1 }])]) });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(asked, [{ dir: "/m/b", seeds: [CALL] }]);
  assert.deepEqual(hop.stops, []);
  assert.deepEqual(hop.links.map((l) => [l.link, l.tier, l.reach]), [[into, "impacted-symbol", { direction: "upstream", via: [fed.link] }]]);
});

test("a handler found by its route, not its name, impacts the link into the repo", async () => {
  const fed = fedBy(CALL);
  const renamed = { ...into, to: { ...into.to, symbol: "someOtherName" } };
  const route: GraphRoute = { file: HANDLER.file, line: 3, method: "GET", path: "/orders", target: { ...HANDLER, kind: "method" } };
  const { codeGraph } = hopGraph({ callers: reachedAs([reachedHandler([{ ...CALL, hops: 1 }])]), routes: [route] });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [renamed, fed.link], fed: [fed] });
  assert.deepEqual(hop.links.map((l) => l.link), [renamed]);
});

test("with two links feeding the hop, the chain is that of the call site whose callers reached the handler", async () => {
  const first = fedBy(CALL);
  const second = fedBy(OTHER_CALL);
  const { codeGraph, asked } = hopGraph({ callers: reachedAs([reachedHandler([{ ...OTHER_CALL, hops: 2 }])]) });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, first.link, second.link], fed: [first, second] });
  assert.equal(asked.length, 1, "one walk with every seed together");
  assert.deepEqual(hop.links.map((l) => l.reach?.via), [[second.link]]);
});

test("a chain keeps the links crossed before this hop in front", async () => {
  const earlier = fedBy({ file: "c/Deep.java", symbol: "deep" }, { from: { repo: "org/c", file: "c/Deep.java", symbol: "deep" }, to: { repo: "org/d", file: "d/api.yaml", symbol: "x" } });
  const fed = { ...fedBy(CALL), reach: { direction: "upstream" as const, via: [earlier.link] } };
  const { codeGraph } = hopGraph({ callers: reachedAs([reachedHandler([{ ...CALL, hops: 1 }])]) });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(hop.links[0]!.reach?.via, [earlier.link, fed.link]);
});

test("a repo whose index cannot answer is a stop with the reason, and no link is claimed beyond it", async () => {
  const fed = fedBy(CALL);
  const { codeGraph } = hopGraph({ callers: err({ reason: "not indexed" }) });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(hop.links, []);
  assert.deepEqual(hop.stops, [{ repo: BACKEND, direction: "upstream", reason: "walk: not indexed" }]);
});

test("a walk that threw is a stop, not a failure of the run", async () => {
  const fed = fedBy(CALL);
  const throwing: CodeGraphPort = { ...graph({}), callersOf: async () => { throw new Error("engine crashed"); } };
  const hop = await hopUseCase(throwing).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(hop.links, []);
  assert.equal(hop.stops[0]?.reason, "walk: engine crashed");
});

test("a walk the budget left partial returns the links it reached and says how many seeds stayed open", async () => {
  const fed = fedBy(CALL);
  const { codeGraph } = hopGraph({ callers: reachedAs([reachedHandler([{ ...CALL, hops: 1 }])], true, [OTHER_CALL]) });
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.equal(hop.links.length, 1);
  assert.deepEqual(hop.stops, [{ repo: BACKEND, direction: "upstream", reason: "partial: 1 of 1 seed(s) left open at the expansion budget" }]);
});

test("without a code graph a later hop is a stop", async () => {
  const fed = fedBy(CALL);
  const hop = await hopUseCase(undefined).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(hop.stops.map((s) => s.reason), ["the run has no code graph"]);
});

test("a fed link without a call-site symbol claims nothing and asks nothing", async () => {
  const fed = fedBy({ file: "", symbol: "" });
  const { codeGraph, asked } = hopGraph({});
  const hop = await hopUseCase(codeGraph).resolveUpstreamHop({ repo: BACKEND, repoDir: "/m/b", links: [into, fed.link], fed: [fed] });
  assert.deepEqual(asked, []);
  assert.deepEqual(hop, { links: [], stops: [] });
});

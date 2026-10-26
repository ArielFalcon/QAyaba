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

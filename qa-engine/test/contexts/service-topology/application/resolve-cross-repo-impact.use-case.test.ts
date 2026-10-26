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
  const reached = ok({ indexedSha: SHA, symbols: [{ file: CONTROLLER, symbol: "handle", kind: "method", depth: 0 }], truncated: false });
  return {
    syncTo: async (repo, sha) => ({ repo, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 }),
    impactedSymbols: async () => (over.impacted ? over.impacted : reached),
    callersOf: async () => ok({ indexedSha: SHA, symbols: [], truncated: false }),
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
  const cut = await resolve(graph({ impacted: Promise.resolve(ok({ indexedSha: SHA, symbols: [], truncated: true })) }));
  assert.equal(cut.warnings.length, 1);
  const whole = await resolve(graph({ routes: [handler("ANY")] }));
  assert.deepEqual(whole.warnings, []);
});

/* buildCoordination: the ledger is always served; the lead and sidekicks only for an e2e run that was given a place for their workspaces. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { resetSharedCoordinationTelemetryForTests } from "@contexts/coordination/infrastructure/adapters/coordination-telemetry-port.adapter.ts";
import { ok, err } from "@kernel/result.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { buildCoordination, graphHoldsSymbol, type CoordinationDeps } from "@contexts/coordination/composition/build-coordination.ts";

afterEach(() => resetSharedCoordinationTelemetryForTests());

function deps(over: Partial<CoordinationDeps> = {}): CoordinationDeps {
  return {
    isCode: false,
    runtime: { openSession: async () => { throw new Error("unused"); } },
    redaction: new PatternRedactionAdapter(),
    specFileFor: (flowId) => `e2e/flows/${flowId}.spec.ts`,
    ...over,
  };
}

const delegation = { workspaceRoot: "/mirrors/.qa-delegations" };

test("a run with no delegation is served the ledger and authored by its lead alone", () => {
  const api = buildCoordination(deps());

  assert.ok(api.coordinationTelemetry);
  assert.equal(api.leadSidekicks, undefined);
});

test("an e2e run with a place for the workspaces gets the lead", () => {
  const api = buildCoordination(deps({ delegation }));

  assert.ok(api.leadSidekicks);
});

test("a code run never coordinates, whatever the shell offers", () => {
  const api = buildCoordination(deps({ isCode: true, delegation }));

  assert.ok(api.coordinationTelemetry);
  assert.equal(api.leadSidekicks, undefined);
});

test("the ledger is one per process, so decisions outlive a run", () => {
  assert.equal(buildCoordination(deps()).coordinationTelemetry, buildCoordination(deps()).coordinationTelemetry);
});

function graph(over: Partial<CodeGraphPort>): CodeGraphPort {
  return { syncTo: async () => { throw new Error("unused"); }, impactedSymbols: async () => { throw new Error("unused"); }, callersOf: async () => ok({ indexedSha: "s", symbols: [], truncated: false, seedBasis: "lines" as const }), routes: async () => ok([]), ...over };
}

test("a symbol ref names a file and a symbol, and the graph holds it only when it finds exactly that symbol in that file", async () => {
  const seen: unknown[] = [];
  const held = graph({ callersOf: async (_dir, symbols) => { seen.push(symbols); return ok({ indexedSha: "s", symbols: [{ file: "src/cart.ts", symbol: "totalOf", kind: "function", depth: 0, confidence: 1 }], truncated: false, seedBasis: "lines" as const }); } });
  assert.equal(await graphHoldsSymbol(held, "/m", "src/cart.ts#totalOf"), true);
  assert.deepEqual(seen, [[{ file: "src/cart.ts", symbol: "totalOf" }]]);
  assert.equal(await graphHoldsSymbol(held, "/m", "src/other.ts#totalOf"), false, "another file's symbol is not the one named");
  assert.equal(await graphHoldsSymbol(graph({}), "/m", "src/cart.ts#ghost"), false);
});

test("a bare name is held when a route points at a symbol of that name, and any answer but a clear yes is no", async () => {
  const routed = graph({ routes: async () => ok([{ file: "src/routes.ts", line: 3, path: "/cart", target: { file: "src/cart.ts", symbol: "CartPage", kind: "class" } }]) });
  assert.equal(await graphHoldsSymbol(routed, "/m", "CartPage"), true);
  assert.equal(await graphHoldsSymbol(routed, "/m", "Missing"), false);
  const down = graph({ callersOf: async () => err({ reason: "not indexed" }), routes: async () => err({ reason: "not indexed" }) });
  assert.equal(await graphHoldsSymbol(down, "/m", "src/cart.ts#totalOf"), false);
  assert.equal(await graphHoldsSymbol(down, "/m", "CartPage"), false);
});

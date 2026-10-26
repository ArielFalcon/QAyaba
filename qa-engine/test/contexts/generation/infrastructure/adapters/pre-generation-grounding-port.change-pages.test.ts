/* The grounding asks the change-page join before the pack, tells it which pages the map already links, hands the pages it proves to the pack's ranking, and keeps why each change page is one. No index, no change: the pages are the map's alone. buildContextPack is a fake here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PreGenerationGroundingPortAdapter, type GroundingTrace } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import type { ChangePagesPort, ChangePagesRequest } from "@contexts/service-topology/application/index.ts";
import type { ContextPackInput } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ChangePagesJoin } from "@kernel/change-pages.ts";

const SHA = "abc1234";
const MAP = {
  builtAtSha: SHA,
  routes: [{ path: "/orders", implementationFiles: ["web/src/app/orders/orders.page.ts"] }, { path: "/profile" }],
  api: [],
  feBe: [],
};
const DIFF = [
  "diff --git a/web/src/app/orders/orders.page.ts b/web/src/app/orders/orders.page.ts",
  "--- a/web/src/app/orders/orders.page.ts",
  "+++ b/web/src/app/orders/orders.page.ts",
  "@@ -3,1 +3,1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");
const JOIN: ChangePagesJoin = { pages: [{ route: "/profile", proof: ["web/src/app/orders/orders.page.ts::a", "page /profile"] }], hubs: [{ symbol: "web/src/http.ts::request", pages: 9 }], disagreements: [], omitted: 0 };

function setup(join: ChangePagesJoin | undefined, packed: { routes: string[]; basis: Array<"implementation" | "source" | "spec" | "graph"> }) {
  const asked: ChangePagesRequest[] = [];
  const inputs: ContextPackInput[] = [];
  const told: ChangePagesJoin[] = [];
  const changePages: ChangePagesPort = { resolve: async (request) => { asked.push(request); return join; } };
  const trace: GroundingTrace = { changePages: (j) => told.push(j) };
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/nonexistent/e2e", baseUrl: "https://dev.example.com", contextMap: MAP },
    {
      changePages,
      trace,
      loadContextMap: () => undefined,
      buildContextPack: async (input) => {
        inputs.push(input);
        return { text: "pack", domBytes: 0, contractBytes: 0, trace: { rankedRoutes: packed.routes, relevantRoutes: packed.routes, relevantBasis: packed.basis, capturablePages: 2, pages: [], pageDeliveries: [], changedTestIds: [], contractIds: [], omittedLines: 0 } };
      },
    },
  );
  return { adapter, asked, inputs, told };
}

test("the pages the join proves reach the pack's ranking, and each change page keeps why it is one", async () => {
  const { adapter, asked, inputs, told } = setup(JOIN, { routes: ["/orders", "/profile"], basis: ["implementation", "graph"] });

  const result = await adapter.ground("/nonexistent/e2e", undefined, DIFF, { sha: SHA });

  assert.equal(asked.length, 1);
  assert.deepEqual([...asked[0]!.linked], ["/orders"], "the map's own link is named so it takes no slot of the join");
  assert.deepEqual(asked[0]!.changedFiles, ["web/src/app/orders/orders.page.ts"]);
  assert.deepEqual([...(asked[0]!.touchedLines?.get("web/src/app/orders/orders.page.ts") ?? [])], [3]);
  assert.equal(asked[0]!.sha, SHA);
  assert.deepEqual(inputs[0]!.graphPages, ["/profile"]);
  assert.deepEqual(result.changeRoutes, ["/orders", "/profile"]);
  assert.deepEqual(result.changeRouteBasis, ["implementation", "graph"]);
  assert.deepEqual(result.changePages, JOIN);
  assert.deepEqual(told, [JOIN], "the join is on the run's record, hubs included");
});

test("no index, or no change handed in, leaves the pack's input and the change pages as the map has them", async () => {
  const unanswered = setup(undefined, { routes: ["/orders"], basis: ["implementation"] });
  const result = await unanswered.adapter.ground("/nonexistent/e2e", undefined, DIFF, { sha: SHA });
  assert.equal("graphPages" in unanswered.inputs[0]!, false);
  assert.deepEqual(result.changeRoutes, ["/orders"]);
  assert.equal(result.changePages, undefined);
  assert.deepEqual(unanswered.told, []);

  const noChange = setup(JOIN, { routes: ["/orders"], basis: ["implementation"] });
  await noChange.adapter.ground("/nonexistent/e2e", undefined, DIFF);
  assert.deepEqual(noChange.asked, []);
  assert.equal("graphPages" in noChange.inputs[0]!, false);
});

test("the pages a hub reaches reach the pack's ranking apart from the proven pages, and never become change pages", async () => {
  const hubOnly: ChangePagesJoin = { pages: [], hubs: [{ symbol: "web/src/limits.ts::CHEAP", pages: 6, routes: ["/profile", "/orders", "/map"] }, { symbol: "web/src/http.ts::request", pages: 9, routes: ["/profile"] }], disagreements: [], omitted: 0 };
  const { adapter, inputs } = setup(hubOnly, { routes: ["/orders"], basis: ["implementation"] });

  const result = await adapter.ground("/nonexistent/e2e", undefined, DIFF, { sha: SHA });

  assert.equal("graphPages" in inputs[0]!, false, "a hub proves no page");
  assert.deepEqual(inputs[0]!.hubPages, ["/profile", "/map"], "each page once, the map's own link left to the map");
  assert.deepEqual(result.changeRoutes, ["/orders"]);
});

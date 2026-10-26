/* The grounding hands the change's use-case candidates and the pages of its hubs to the pack's ranking, and nothing when it has none. buildContextPack is a fake here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PreGenerationGroundingPortAdapter } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import type { ContextPackInput } from "@contexts/generation/infrastructure/context-pack.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const SHA = "abc1234";
const MAP = { builtAtSha: SHA, routes: [{ path: "/orders", implementationFiles: ["web/src/app/orders/orders.page.ts"] }, { path: "/profile" }], api: [], feBe: [] };
const DIFF = [
  "diff --git a/web/src/app/orders/orders.page.ts b/web/src/app/orders/orders.page.ts",
  "--- a/web/src/app/orders/orders.page.ts",
  "+++ b/web/src/app/orders/orders.page.ts",
  "@@ -3,1 +3,1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

function setup() {
  const inputs: ContextPackInput[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/nonexistent/e2e", baseUrl: "https://dev.example.com", contextMap: MAP },
    {
      loadContextMap: () => undefined,
      buildContextPack: async (input) => {
        inputs.push(input);
        return { text: "pack", domBytes: 0, contractBytes: 0, trace: { rankedRoutes: [], relevantRoutes: [], capturablePages: 2, pages: [], pageDeliveries: [], changedTestIds: [], contractIds: [], omittedLines: 0 } };
      },
    },
  );
  return { adapter, inputs };
}

test("the candidates and the hub pages reach the pack's ranking", async () => {
  const { adapter, inputs } = setup();
  const candidates = [pageCandidate("/profile", ["a.ts::x", "page /profile"], { tier: "indirect", basis: "graph" })];

  await adapter.ground("/nonexistent/e2e", undefined, DIFF, { sha: SHA, candidates, hubPages: ["/map"] });

  assert.deepEqual(inputs[0]!.candidates, candidates);
  assert.deepEqual(inputs[0]!.hubPages, ["/map"]);
});

test("no candidate and no hub page, or no change handed in, leave the pack's input as the map has it", async () => {
  const empty = setup();
  await empty.adapter.ground("/nonexistent/e2e", undefined, DIFF, { sha: SHA, candidates: [], hubPages: [] });
  assert.equal("candidates" in empty.inputs[0]!, false);
  assert.equal("hubPages" in empty.inputs[0]!, false);

  const noChange = setup();
  await noChange.adapter.ground("/nonexistent/e2e", undefined, DIFF);
  assert.equal("candidates" in noChange.inputs[0]!, false);
});

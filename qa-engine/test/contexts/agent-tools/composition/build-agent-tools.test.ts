/* buildAgentTools: each tool is built only for an e2e run whose shell supplied its wiring, and a run without it grants nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "@kernel/result.ts";
import { AccountLock } from "@contexts/test-execution/application/index.ts";
import { buildAgentTools, type AgentToolsDeps } from "@contexts/agent-tools/composition/build-agent-tools.ts";
import { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry.ts";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry.ts";
import { CodeGraphToolRegistry } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry.ts";
import { GeolocationRegistry } from "@contexts/agent-tools/infrastructure/geolocation-registry.ts";

function deps(over: Partial<AgentToolsDeps> = {}, run: Partial<AgentToolsDeps["run"]> = {}): AgentToolsDeps {
  return { run: { isCode: false, specRelDir: "e2e", codeGraphRepoDir: "/mirrors/org/app", ...run }, execution: { run: async () => { throw new Error("unused"); } } as never, ...over };
}

const closedLoop = (registry = new ClosedLoopRegistry()) => ({
  registry,
  setting: { enabled: true, limits: { maxCalls: 3, perCallMs: 30_000, maxDevWrites: 5 } },
  generatorRuntimeCanCall: () => true,
  account: "app/user",
  lock: new AccountLock(),
  redact: (text: string) => text,
});

test("a run that supplies no wiring gets no tool", () => {
  assert.deepEqual(buildAgentTools(deps()), {});
});

test("the run_spec loop is built from its wiring and opens a capability in its registry", async () => {
  const registry = new ClosedLoopRegistry();
  const api = buildAgentTools(deps({ closedLoop: closedLoop(registry) }));

  const handle = await api.closedLoop?.open({ runId: "r1", app: "app", mode: "diff", mirrorDir: "/mirrors/org/app", specDir: "/mirrors/org/app/e2e" });

  assert.deepEqual(handle?.limits, { maxCalls: 3, perCallMs: 30_000, maxDevWrites: 5 });
  assert.equal(registry.size, 1);
  await handle?.close();
});

test("a code run is granted no tool whatever the wiring says", () => {
  const explore = { explore: async () => ok({ text: "x", indexedSha: "abc1234" }) };
  const api = buildAgentTools(
    deps(
      {
        closedLoop: closedLoop(),
        agentBrowser: { registry: new AgentBrowserRegistry(), setting: { enabled: true, denyRoutes: [], allowMutating: [] }, generatorRuntimeCanCall: () => true, launcher: {} as never, createHost: () => ({}) as never, account: "a", lock: new AccountLock(), redact: (t) => t },
        codeGraphTools: { registry: new CodeGraphToolRegistry(), generatorRuntimeCanCall: () => true },
        codeExplore: explore,
        geolocation: { registry: new GeolocationRegistry(), setting: { default: { latitude: 1, longitude: 2 }, places: {} } },
      },
      { isCode: true, baseUrl: "https://dev.example.com" },
    ),
  );

  assert.deepEqual(api, {});
});

test("the authenticated browser needs the run's DEV url, and the code-graph tool needs the explore port", () => {
  const browser = { registry: new AgentBrowserRegistry(), setting: { enabled: true, denyRoutes: [], allowMutating: [] }, generatorRuntimeCanCall: () => true, launcher: {} as never, createHost: () => ({}) as never, account: "a", lock: new AccountLock(), redact: (t: string) => t };
  const graph = { registry: new CodeGraphToolRegistry(), generatorRuntimeCanCall: () => true };
  const explore = { explore: async () => ok({ text: "x", indexedSha: "abc1234" }) };

  assert.equal(buildAgentTools(deps({ agentBrowser: browser })).agentBrowser, undefined);
  assert.ok(buildAgentTools(deps({ agentBrowser: browser }, { baseUrl: "https://dev.example.com" })).agentBrowser);
  assert.equal(buildAgentTools(deps({ codeGraphTools: graph })).codeGraphTools, undefined);
  assert.ok(buildAgentTools(deps({ codeGraphTools: graph, codeExplore: explore })).codeGraphTools);
});

test("the authoring location is built from the app's declared position", () => {
  const api = buildAgentTools(deps({ geolocation: { registry: new GeolocationRegistry(), setting: { default: { latitude: 1, longitude: 2 }, places: {} } } }));

  assert.ok(api.geolocation);
});

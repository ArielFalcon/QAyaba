/* The raw agent-list primitive: the agents the OpenCode server resolves for a directory, each with the
   step cap it enforces. Read through the real v2 SDK client with only the network faked, over bodies shaped as
   an OpenCode 1.17.7 server answers GET /agent: `steps` is the only cap field it returns (a configured
   `maxSteps` comes back as `steps`), a configured agent with no cap carries `"steps": null`, and a native
   agent has no `steps` key at all. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Agent as OpenCodeAgent } from "@opencode-ai/sdk/v2";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { listAgentCaps, listModelWindows, turnStepLimit, type AgentListDeps } from "./opencode-client";

/* Fails `npm run typecheck` (not this run) if the SDK's v2 Agent stops declaring its cap as an optional number. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const sdkAgentKeepsItsCapAsAnOptionalNumber: Same<OpenCodeAgent["steps"], number | undefined> = true;
void sdkAgentKeepsItsCapAsAnOptionalNumber;

interface SeenRequest {
  method: string;
  url: URL;
}

/* The real v2 SDK client, its network replaced by `respond`; every request the client makes is recorded. */
async function depsServing(respond: (request: Request) => Response, seen: SeenRequest[] = []): Promise<AgentListDeps> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const network = async (request: Request): Promise<Response> => {
    seen.push({ method: request.method, url: new URL(request.url) });
    return respond(request);
  };
  const client = createOpencodeClient({ baseUrl: "http://agents.invalid:4096", fetch: network as typeof fetch });
  return { getClient: async () => client };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/* A GET /agent body in the server's shape: configured agents carry `steps` (null when uncapped), native ones none. */
function serverAgentList(): Array<Record<string, unknown>> {
  return [
    { name: "qa-author", mode: "primary", permission: [], options: {}, steps: 300 },
    { name: "qa-reviewer", mode: "all", permission: [], options: {}, steps: 25 },
    { name: "probe-steps", mode: "primary", permission: [], options: {}, steps: 40 },
    { name: "probe-both", mode: "primary", permission: [], options: {}, steps: 33 },
    { name: "probe-none", mode: "primary", permission: [], options: {}, steps: null },
    { name: "build", mode: "primary", native: true, permission: [], options: {} },
    { name: "general", mode: "subagent", native: true, permission: [], options: {} },
  ];
}

async function capsOf(wire: unknown): Promise<Map<string, unknown>> {
  const listed = await listAgentCaps("/m/app", await depsServing(() => json(wire)));
  return new Map(listed.map(({ name, cap }) => [name, cap]));
}

test("every agent of a server response is listed with the cap the server enforces for it", async () => {
  const caps = await capsOf(serverAgentList());
  assert.equal(caps.size, serverAgentList().length, "no agent is dropped");
  assert.equal(caps.get("qa-author"), 300);
  assert.equal(caps.get("qa-reviewer"), 25);
  assert.equal(caps.get("probe-steps"), 40);
  assert.equal(caps.get("probe-both"), 33, "steps wins when an agent declares both names");
});

test("an agent the server lists without a cap has none, whether its steps is null or absent", async () => {
  const caps = await capsOf(serverAgentList());
  for (const name of ["probe-none", "build", "general"]) {
    assert.equal(caps.has(name), true, `${name} is listed`);
    assert.equal(caps.get(name), undefined, `${name} has no cap`);
  }
});

test("the deprecated maxSteps is the cap of an agent that carries no steps", async () => {
  const caps = await capsOf([
    { name: "max-steps-only", maxSteps: 30 },
    { name: "steps-and-max-steps", steps: 33, maxSteps: 22 },
    { name: "null-steps", steps: null, maxSteps: 22 },
    { name: "neither" },
  ]);
  assert.equal(caps.get("max-steps-only"), 30);
  assert.equal(caps.get("steps-and-max-steps"), 33);
  assert.equal(caps.get("null-steps"), 22, "a null steps is no steps");
  assert.equal(caps.get("neither"), undefined);
});

test("an agent typed by the SDK's v2 Agent reports its steps as its cap", async () => {
  const agent: OpenCodeAgent = { name: "qa-author", mode: "primary", permission: [], options: {}, steps: 40 };
  const caps = await capsOf([agent]);
  assert.equal(caps.get("qa-author"), 40);
});

test("a cap that is not a number is carried as the server sent it, for the caller to judge", async () => {
  const caps = await capsOf([
    { name: "textual", steps: "40" },
    { name: "zero", steps: 0 },
    { name: "fractional", steps: 2.5 },
  ]);
  assert.equal(caps.get("textual"), "40");
  assert.equal(caps.get("zero"), 0);
  assert.equal(caps.get("fractional"), 2.5);
});

test("the agent list is asked of the directory the caller names, once per call", async () => {
  const seen: SeenRequest[] = [];
  const deps = await depsServing(() => json([]), seen);
  await listAgentCaps("/m/app one", deps);
  await listAgentCaps("/m/app two", deps);
  assert.deepEqual(
    seen.map((r) => [r.method, r.url.pathname, r.url.searchParams.get("directory")]),
    [
      ["GET", "/agent", "/m/app one"],
      ["GET", "/agent", "/m/app two"],
    ],
  );
});

test("an empty agent list is an empty answer", async () => {
  assert.deepEqual(await listAgentCaps("/m/app", await depsServing(() => json([]))), []);
});

test("a server error is thrown with its status and what it said, never read as an empty list", async () => {
  const deps = await depsServing(() => json({ name: "BadRequestError", message: "directory is not a project" }, 400));
  await assert.rejects(() => listAgentCaps("/m/app", deps), /failed \(HTTP 400\): .*directory is not a project/);
});

test("an unreachable server is thrown with the network's own message, never read as an empty list", async () => {
  const deps = await depsServing(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(() => listAgentCaps("/m/app", deps), /app\.agents failed: fetch failed$/, "no status is made up for a reply that never came");
});

test("a reply that is not a list of agents is thrown with what it was", async () => {
  await assert.rejects(
    async () => listAgentCaps("/m/app", await depsServing(() => json({ agents: [] }))),
    /no list of agents.*\{"agents":\[\]\}/,
  );
  await assert.rejects(
    async () => listAgentCaps("/m/app", await depsServing(() => new Response("", { status: 200, headers: { "content-type": "application/json" } }))),
    /no list of agents.*\{\}/,
  );
});

test("the server's providers answer the context window of every model it serves, keyed by the provider/model reference a role is assigned", async () => {
  const seen: SeenRequest[] = [];
  const deps = await depsServing(() => json({
    providers: [
      { id: "deepseek-api", models: { "deepseek-v4.1-flash": { limit: { context: 1_048_576, output: 8_192 } } } },
      { id: "opencode", models: { "a-model": { limit: { context: 200_000, output: 4_096 } }, "no-limit": {}, "zero": { limit: { context: 0 } } } },
    ],
    default: {},
  }), seen);

  assert.deepEqual(await listModelWindows("/m/app", deps), { "deepseek-api/deepseek-v4.1-flash": 1_048_576, "opencode/a-model": 200_000 });
  assert.deepEqual(seen.map((r) => [r.method, r.url.pathname, r.url.searchParams.get("directory")]), [["GET", "/config/providers", "/m/app"]]);
});

test("a providers read the server refuses, or answers without a list, is thrown, never read as no windows", async () => {
  await assert.rejects(async () => listModelWindows("/m/app", await depsServing(() => json({ message: "boom" }, 500))), /config\.providers failed \(HTTP 500\)/);
  await assert.rejects(async () => listModelWindows("/m/app", await depsServing(() => json({ default: {} }))), /no list of providers/);
});

test("a turn's step limit is the one the server last reported for its agent, and the local file only for an agent the server never listed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qa-turn-step-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stale = join(dir, "opencode.json");
  writeFileSync(stale, JSON.stringify({ agent: { "qa-author": { steps: 60 }, "qa-unlisted": { steps: 7 } } }));
  await listAgentCaps("/work", await depsServing(() => json([{ name: "qa-author", steps: 300 }, { name: "qa-uncapped", steps: null }])));
  assert.equal(turnStepLimit("qa-author", stale), 300);
  assert.equal(turnStepLimit("qa-uncapped", stale), undefined, "an agent the server enforces no cap for has none, whatever the file says");
  assert.equal(turnStepLimit("qa-unlisted", stale), 7);
});

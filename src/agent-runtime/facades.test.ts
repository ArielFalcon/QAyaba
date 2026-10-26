import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeFacade } from "./facades";
import { AGENT_ROLES } from "./types";
import type { AgentProvider, AgentRuntimeStrategy, AgentRole, AgentRuntimeConfig, StepLimits } from "./types";

/* A runtime the host does not ship, standing in for the second one a future provider adds: it proves the facade dispatches by assignment. */
const OTHER_NAME = "fixture-runtime";
const OTHER = OTHER_NAME as unknown as AgentProvider;

function strategy(provider: AgentProvider, calls: AgentRole[], models: Array<string | undefined> = []): AgentRuntimeStrategy {
  return {
    provider,
    async health() {
      return { provider, status: "healthy", configured: true };
    },
    async listModels() {
      return [{ id: `${provider}/model`, label: `${provider} model` }];
    },
    async openSession(role, _cwd, opts) {
      calls.push(role);
      models.push(opts?.model);
      return {
        id: `${provider}-${role}`,
        async prompt() {
          return `{"approved":true,"specs":[]}`;
        },
        async dispose() {},
      };
    },
  };
}

const CONFIG: AgentRuntimeConfig = {
  assignments: {
    primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
    reviewer: { provider: "opencode", model: "opencode-go/minimax-m3" },
    chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
  },
};

/* The reviewer and the chat tier (the chat role and the reflector that rides it) run on the other runtime; every other role runs on opencode. */
const SPLIT_CONFIG: AgentRuntimeConfig = {
  assignments: {
    primary: CONFIG.assignments.primary,
    reviewer: { provider: OTHER, model: "fixture-runtime/reviewer" },
    chat: { provider: OTHER, model: "fixture-runtime/chat" },
  },
};
const RUN_BY_OTHER_IN_SPLIT_CONFIG: readonly AgentRole[] = ["reviewer", "chat", "reflector"];

function single(calls: AgentRole[] = [], models: Array<string | undefined> = []): AgentRuntimeFacade {
  return new AgentRuntimeFacade({ opencode: strategy("opencode", calls, models) }, CONFIG);
}

test("the facade routes every agent role through the one runtime", async () => {
  const calls: AgentRole[] = [];
  const deps = single(calls).deps();
  await (await deps.open("qa-reviewer", "/tmp/repo")).dispose();
  assert.deepEqual(calls, ["reviewer"]);
});

test("the facade opens the qa-author agent as the author role", async () => {
  const calls: AgentRole[] = [];
  await (await single(calls).deps().open("qa-author", "/tmp/repo")).dispose();
  assert.deepEqual(calls, ["author"]);
});

test("the facade rejects an unknown agent name without opening any session", async () => {
  const calls: AgentRole[] = [];
  await assert.rejects(() => single(calls).deps().open("qa-unmapped", "/tmp/repo"), /qa-unmapped/);
  assert.deepEqual(calls, []);
});

test("the facade opens a session on the role assignment's model when the caller names none", async () => {
  const models: Array<string | undefined> = [];
  await (await single([], models).deps().open("qa-author", "/tmp/repo")).dispose();
  assert.deepEqual(models, [CONFIG.assignments.primary.model]);
});

test("the facade opens a session on the model the caller asked for, not the role assignment's", async () => {
  const models: Array<string | undefined> = [];
  await (await single([], models).deps().open("qa-author", "/tmp/repo", { model: "opencode-go/escalated" })).dispose();
  assert.deepEqual(models, ["opencode-go/escalated"]);
});

test("the facade opens each role on the strategy its assignment names", async () => {
  const openCalls: AgentRole[] = [];
  const otherCalls: AgentRole[] = [];
  const facade = new AgentRuntimeFacade({ opencode: strategy("opencode", openCalls), [OTHER_NAME]: strategy(OTHER, otherCalls) } as Record<AgentProvider, AgentRuntimeStrategy>, SPLIT_CONFIG);
  const deps = facade.deps();
  await (await deps.open("qa-author", "/tmp/repo")).dispose();
  await (await deps.open("qa-reviewer", "/tmp/repo")).dispose();
  await (await deps.open("qa-assistant", "/tmp/repo")).dispose();
  assert.deepEqual(openCalls, ["author"]);
  assert.deepEqual(otherCalls, ["reviewer", "chat"]);
});

test("the facade opens a session on the model the caller asked for, on the provider the role is assigned to", async () => {
  const openModels: Array<string | undefined> = [];
  const otherModels: Array<string | undefined> = [];
  const facade = new AgentRuntimeFacade({ opencode: strategy("opencode", [], openModels), [OTHER_NAME]: strategy(OTHER, [], otherModels) } as Record<AgentProvider, AgentRuntimeStrategy>, SPLIT_CONFIG);
  await (await facade.deps().open("qa-reviewer", "/tmp/repo", { model: "fixture-runtime/escalated" })).dispose();
  assert.deepEqual(otherModels, ["fixture-runtime/escalated"]);
  assert.deepEqual(openModels, []);
});

test("getStatus reports the providers the facade runs", async () => {
  const status = await single().getStatus();
  assert.deepEqual(status, { providers: [{ provider: "opencode", status: "healthy", configured: true }] });
  assert.equal("mode" in status, false);
});

/* A strategy that enforces `limits`, recording the directory of every read. */
function strategyEnforcing(provider: AgentProvider, limits: StepLimits, reads: string[]): AgentRuntimeStrategy {
  return {
    ...strategy(provider, []),
    async stepLimits(directory) {
      reads.push(directory);
      return limits;
    },
  };
}

test("the facade answers with the limits its strategy enforces for the directory", async () => {
  const reads: string[] = [];
  const facade = new AgentRuntimeFacade({ opencode: strategyEnforcing("opencode", { author: 40, reviewer: 25 }, reads) }, CONFIG);
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.author, 40);
  assert.equal(limits.reviewer, 25);
  assert.equal(limits.chat, undefined, "a role the strategy reports no limit for has none");
  assert.deepEqual(reads, ["/m/app"]);
});

test("the facade answers no limit for any role when its strategy enforces none", async () => {
  assert.deepEqual(await single().stepLimits("/m/app"), {});
});

test("the facade takes each role's limit from the provider the role is assigned to", async () => {
  const opencodeEnforces: StepLimits = Object.fromEntries(AGENT_ROLES.map((role, index) => [role, 10 + index]));
  const reads: string[] = [];
  const facade = new AgentRuntimeFacade({ opencode: strategyEnforcing("opencode", opencodeEnforces, reads), [OTHER_NAME]: strategy(OTHER, []) } as Record<AgentProvider, AgentRuntimeStrategy>, SPLIT_CONFIG);
  const limits = await facade.stepLimits("/m/app");
  AGENT_ROLES.forEach((role, index) => {
    assert.equal(limits[role], RUN_BY_OTHER_IN_SPLIT_CONFIG.includes(role) ? undefined : 10 + index, `${role}`);
  });
  assert.deepEqual(reads, ["/m/app"], "opencode is read once, however many roles run on it");
});

test("the facade reads every provider that runs a role once, and a role takes its own provider's limit", async () => {
  const opencodeReads: string[] = [];
  const otherReads: string[] = [];
  const facade = new AgentRuntimeFacade(
    {
      opencode: strategyEnforcing("opencode", { author: 40, reviewer: 25 }, opencodeReads),
      [OTHER_NAME]: strategyEnforcing(OTHER, { reviewer: 7, author: 99 }, otherReads),
    } as Record<AgentProvider, AgentRuntimeStrategy>,
    SPLIT_CONFIG,
  );
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.author, 40, "the generator runs on opencode, not on the other runtime");
  assert.equal(limits.reviewer, 7, "the reviewer runs on the other runtime, not on opencode");
  assert.deepEqual(opencodeReads, ["/m/app"]);
  assert.deepEqual(otherReads, ["/m/app"]);
});

test("the facade does not read a provider that runs no role", async () => {
  const otherReads: string[] = [];
  const facade = new AgentRuntimeFacade(
    { opencode: strategyEnforcing("opencode", { author: 40, reviewer: 25 }, []), [OTHER_NAME]: strategyEnforcing(OTHER, { reviewer: 7 }, otherReads) } as Record<AgentProvider, AgentRuntimeStrategy>,
    CONFIG,
  );
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.reviewer, 25);
  assert.deepEqual(otherReads, []);
});

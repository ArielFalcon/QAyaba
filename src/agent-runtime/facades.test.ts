import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleAgentFacade, DualAgentFacade } from "./facades";
import { AGENT_ROLES } from "./types";
import type { AgentRuntimeStrategy, AgentRole, AgentRuntimeConfig, StepLimits } from "./types";

function strategy(provider: "opencode" | "codex", calls: AgentRole[], models: Array<string | undefined> = []): AgentRuntimeStrategy {
  return {
    provider,
    async health() {
      return { provider, status: "healthy", configured: true };
    },
    async listModels() {
      return provider === "opencode"
        ? [{ id: "opencode-go/deepseek-v4-pro", label: "OpenCode Pro" }]
        : [{ id: "gpt-5.4", label: "GPT 5.4" }];
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

test("SingleAgentFacade routes every legacy agent role through one strategy", async () => {
  const calls: AgentRole[] = [];
  const facade = new SingleAgentFacade(strategy("opencode", calls), {
    mode: "single",
    singleProvider: "opencode",
    assignments: {
      primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode", model: "opencode-go/minimax-m3" },
      chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
    },
  });
  const deps = facade.deps();
  const session = await deps.open("qa-reviewer", "/tmp/repo");
  await session.dispose();
  assert.deepEqual(calls, ["reviewer"]);
});

const SINGLE_OPENCODE_CONFIG: AgentRuntimeConfig = {
  mode: "single",
  singleProvider: "opencode",
  assignments: {
    primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
    reviewer: { provider: "opencode", model: "opencode-go/minimax-m3" },
    chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
  },
};

const DUAL_CONFIG: AgentRuntimeConfig = {
  mode: "dual",
  singleProvider: "opencode",
  assignments: {
    primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
    reviewer: { provider: "codex", model: "gpt-5.4" },
    chat: { provider: "codex", model: "gpt-5.4-mini" },
  },
};

test("SingleAgentFacade opens the qa-sidekick agent as the sidekick role, not the primary author", async () => {
  const calls: AgentRole[] = [];
  const deps = new SingleAgentFacade(strategy("opencode", calls), SINGLE_OPENCODE_CONFIG).deps();
  await (await deps.open("qa-sidekick", "/tmp/repo")).dispose();
  assert.deepEqual(calls, ["sidekick"]);
});

test("DualAgentFacade opens the qa-sidekick agent as the sidekick role, not the primary author", async () => {
  const openCalls: AgentRole[] = [];
  const codexCalls: AgentRole[] = [];
  const facade = new DualAgentFacade({ opencode: strategy("opencode", openCalls), codex: strategy("codex", codexCalls) }, DUAL_CONFIG);
  await (await facade.deps().open("qa-sidekick", "/tmp/repo")).dispose();
  assert.deepEqual(openCalls, ["sidekick"]);
  assert.deepEqual(codexCalls, []);
});

test("SingleAgentFacade rejects an unknown agent name without opening any session", async () => {
  const calls: AgentRole[] = [];
  const deps = new SingleAgentFacade(strategy("opencode", calls), SINGLE_OPENCODE_CONFIG).deps();
  await assert.rejects(() => deps.open("qa-unmapped", "/tmp/repo"), /qa-unmapped/);
  assert.deepEqual(calls, []);
});

test("DualAgentFacade rejects an unknown agent name without opening any session", async () => {
  const openCalls: AgentRole[] = [];
  const codexCalls: AgentRole[] = [];
  const facade = new DualAgentFacade({ opencode: strategy("opencode", openCalls), codex: strategy("codex", codexCalls) }, DUAL_CONFIG);
  await assert.rejects(() => facade.deps().open("qa-unmapped", "/tmp/repo"), /qa-unmapped/);
  assert.deepEqual([...openCalls, ...codexCalls], []);
});

test("SingleAgentFacade opens a session on the role assignment's model when the caller names none", async () => {
  const models: Array<string | undefined> = [];
  const deps = new SingleAgentFacade(strategy("opencode", [], models), SINGLE_OPENCODE_CONFIG).deps();
  await (await deps.open("qa-sidekick", "/tmp/repo")).dispose();
  assert.deepEqual(models, [SINGLE_OPENCODE_CONFIG.assignments.primary.model]);
});

test("SingleAgentFacade opens a session on the model the caller asked for, not the role assignment's", async () => {
  const models: Array<string | undefined> = [];
  const deps = new SingleAgentFacade(strategy("opencode", [], models), SINGLE_OPENCODE_CONFIG).deps();
  await (await deps.open("qa-sidekick", "/tmp/repo", { model: "opencode-go/escalated" })).dispose();
  assert.deepEqual(models, ["opencode-go/escalated"]);
});

test("DualAgentFacade opens a session on the role assignment's model when the caller names none", async () => {
  const models: Array<string | undefined> = [];
  const facade = new DualAgentFacade({ opencode: strategy("opencode", []), codex: strategy("codex", [], models) }, DUAL_CONFIG);
  await (await facade.deps().open("qa-reviewer", "/tmp/repo")).dispose();
  assert.deepEqual(models, [DUAL_CONFIG.assignments.reviewer.model]);
});

test("DualAgentFacade opens a session on the model the caller asked for, on the provider the role is assigned to", async () => {
  const openModels: Array<string | undefined> = [];
  const codexModels: Array<string | undefined> = [];
  const facade = new DualAgentFacade({ opencode: strategy("opencode", [], openModels), codex: strategy("codex", [], codexModels) }, DUAL_CONFIG);
  await (await facade.deps().open("qa-reviewer", "/tmp/repo", { model: "gpt-5.5" })).dispose();
  assert.deepEqual(codexModels, ["gpt-5.5"]);
  assert.deepEqual(openModels, []);
});

test("DualAgentFacade routes roles to their assigned provider strategies", async () => {
  const openCalls: AgentRole[] = [];
  const codexCalls: AgentRole[] = [];
  const facade = new DualAgentFacade(
    { opencode: strategy("opencode", openCalls), codex: strategy("codex", codexCalls) },
    {
      mode: "dual",
      singleProvider: "opencode",
      assignments: {
        primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
        reviewer: { provider: "codex", model: "gpt-5.4" },
        chat: { provider: "codex", model: "gpt-5.4-mini" },
      },
    },
  );
  const deps = facade.deps();
  await (await deps.open("qa-generator", "/tmp/repo")).dispose();
  await (await deps.open("qa-reviewer", "/tmp/repo")).dispose();
  await (await deps.open("qa-assistant", "/tmp/repo")).dispose();
  assert.deepEqual(openCalls, ["primary"]);
  assert.deepEqual(codexCalls, ["reviewer", "chat"]);
});

/* A strategy that enforces `limits`, recording the directory of every read. */
function strategyEnforcing(provider: "opencode" | "codex", limits: StepLimits, reads: string[]): AgentRuntimeStrategy {
  return {
    ...strategy(provider, []),
    async stepLimits(directory) {
      reads.push(directory);
      return limits;
    },
  };
}

/* In DUAL_CONFIG the reviewer and the chat tier (the chat role and the reflector that rides it) run on codex; every other role runs on opencode. */
const RUN_BY_CODEX_IN_DUAL_CONFIG: readonly AgentRole[] = ["reviewer", "chat", "reflector"];

test("SingleAgentFacade answers with the limits its strategy enforces for the directory", async () => {
  const reads: string[] = [];
  const facade = new SingleAgentFacade(strategyEnforcing("opencode", { primary: 40, reviewer: 25 }, reads), SINGLE_OPENCODE_CONFIG);
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.primary, 40);
  assert.equal(limits.reviewer, 25);
  assert.equal(limits.explorer, undefined, "a role the strategy reports no limit for has none");
  assert.deepEqual(reads, ["/m/app"]);
});

test("SingleAgentFacade answers no limit for any role when its strategy enforces none", async () => {
  const facade = new SingleAgentFacade(strategy("codex", []), { ...SINGLE_OPENCODE_CONFIG, singleProvider: "codex" });
  assert.deepEqual(await facade.stepLimits("/m/app"), {});
});

test("DualAgentFacade takes each role's limit from the provider the role is assigned to", async () => {
  const opencodeEnforces: StepLimits = Object.fromEntries(AGENT_ROLES.map((role, index) => [role, 10 + index]));
  const reads: string[] = [];
  const facade = new DualAgentFacade({ opencode: strategyEnforcing("opencode", opencodeEnforces, reads), codex: strategy("codex", []) }, DUAL_CONFIG);
  const limits = await facade.stepLimits("/m/app");
  AGENT_ROLES.forEach((role, index) => {
    assert.equal(limits[role], RUN_BY_CODEX_IN_DUAL_CONFIG.includes(role) ? undefined : 10 + index, `${role}`);
  });
  assert.deepEqual(reads, ["/m/app"], "opencode is read once, however many roles run on it");
});

test("DualAgentFacade reads every provider that runs a role once, and a role takes its own provider's limit", async () => {
  const opencodeReads: string[] = [];
  const codexReads: string[] = [];
  const facade = new DualAgentFacade(
    {
      opencode: strategyEnforcing("opencode", { primary: 40, reviewer: 25 }, opencodeReads),
      codex: strategyEnforcing("codex", { reviewer: 7, primary: 99 }, codexReads),
    },
    DUAL_CONFIG,
  );
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.primary, 40, "the generator runs on opencode, not on codex");
  assert.equal(limits.reviewer, 7, "the reviewer runs on codex, not on opencode");
  assert.deepEqual(opencodeReads, ["/m/app"]);
  assert.deepEqual(codexReads, ["/m/app"]);
});

test("DualAgentFacade does not read a provider that runs no role", async () => {
  const codexReads: string[] = [];
  const allOnOpencode: AgentRuntimeConfig = {
    ...DUAL_CONFIG,
    assignments: {
      primary: DUAL_CONFIG.assignments.primary,
      reviewer: { provider: "opencode", model: "opencode-go/minimax-m3" },
      chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
    },
  };
  const facade = new DualAgentFacade(
    { opencode: strategyEnforcing("opencode", { primary: 40, reviewer: 25 }, []), codex: strategyEnforcing("codex", { reviewer: 7 }, codexReads) },
    allOnOpencode,
  );
  const limits = await facade.stepLimits("/m/app");
  assert.equal(limits.reviewer, 25);
  assert.deepEqual(codexReads, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleAgentFacade, DualAgentFacade } from "./facades";
import type { AgentRuntimeStrategy, AgentRole, AgentRuntimeConfig } from "./types";

function strategy(provider: "opencode" | "codex", calls: AgentRole[]): AgentRuntimeStrategy {
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
    async openSession(role) {
      calls.push(role);
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

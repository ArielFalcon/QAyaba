import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import type { AgentRole } from "@kernel/agent-role";
import type { AgentDeps } from "../integrations/opencode-client";
import { roleToAgentName } from "../server/rewritten-engine-factory";
import { SingleAgentFacade } from "./facades";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";
import { CodexRuntimeStrategy, type CodexTransportStartInput } from "./codex-strategy";
import { AGENT_NAME_FOR_ROLE, type AgentFacade, type AgentRuntimeConfig } from "./types";

/*
 * The whole path a role travels between the engine and a provider: the engine names the role,
 * the shell turns it into an agent name, the facade turns the name back into a role, and the
 * strategy opens the provider session. Only the raw provider transport is faked, so a
 * disagreement between any two of those steps shows up as the wrong agent (or role) at the end.
 */

const ALL_ROLES = Object.keys(AGENT_NAME_FOR_ROLE) as AgentRole[];

function configFor(provider: "opencode" | "codex"): AgentRuntimeConfig {
  const assignment = { provider, model: "some-model" };
  return { mode: "single", singleProvider: provider, assignments: { primary: assignment, reviewer: assignment, chat: assignment } };
}

/* The narrowing the composition root applies between the engine's runtime adapter and the host deps. */
function engineRuntime(facade: AgentFacade): AgentRuntimeAdapter {
  const deps = facade.deps();
  return new AgentRuntimeAdapter(
    {
      open: (agent, cwd, opts) =>
        deps.open(agent, cwd, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
        }),
    },
    roleToAgentName,
  );
}

test("a session opened for each role reaches the OpenCode transport as that role's own agent", async () => {
  const opened: string[] = [];
  const raw: AgentDeps = {
    open: async (agent) => {
      opened.push(agent);
      return { id: `raw-${agent}`, prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "k" }, depsFactory: async () => raw });
  const runtime = engineRuntime(new SingleAgentFacade(strategy, configFor("opencode")));

  for (const role of ALL_ROLES) {
    opened.length = 0;
    await (await runtime.openSession(role, "/repo")).dispose();
    assert.deepEqual(opened, [AGENT_NAME_FOR_ROLE[role]], `role ${role} must open its own agent`);
  }
});

test("an escalated sidekick session reaches the OpenCode transport as qa-sidekick on the model the engine asked for", async () => {
  const opened: Array<{ agent: string; model?: string }> = [];
  const raw: AgentDeps = {
    open: async (agent, _cwd, opts) => {
      opened.push({ agent, model: opts?.model });
      return { id: "raw-1", prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "k" }, depsFactory: async () => raw });
  const runtime = engineRuntime(new SingleAgentFacade(strategy, configFor("opencode")));

  await (await runtime.openSession("sidekick", "/repo", { model: "opencode-go/escalated" })).dispose();

  assert.deepEqual(opened, [{ agent: AGENT_NAME_FOR_ROLE.sidekick, model: "opencode-go/escalated" }]);
});

test("a session opened for each role reaches the Codex transport as that role", async () => {
  const started: CodexTransportStartInput[] = [];
  const strategy = new CodexRuntimeStrategy({
    env: { CODEX_API_KEY: "codex-key" },
    promptRoot: "/nonexistent-prompt-root",
    transport: {
      start: async (input) => {
        started.push(input);
        return { id: "codex-1", prompt: async () => "ok", dispose: async () => {} };
      },
      health: async () => ({ provider: "codex", status: "healthy", configured: true }),
      listModels: async () => [{ id: "some-model" }],
    },
  });
  const runtime = engineRuntime(new SingleAgentFacade(strategy, configFor("codex")));

  for (const role of ALL_ROLES) {
    started.length = 0;
    await (await runtime.openSession(role, "/repo")).dispose();
    assert.deepEqual(started.map((s) => s.role), [role], `role ${role} must reach Codex as itself`);
  }
});

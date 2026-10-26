import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";
import { AGENT_NAME_FOR_ROLE, capabilitiesForRole, roleForAgentName } from "./types";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port";
import type { AgentDeps } from "../integrations/opencode-client";

/* Capability policy is expressed ONCE, provider-agnostic; each strategy enforces it with its own
   mechanism (OpenCode tools{} map). The judge must not be able to write.
 */
test("capabilitiesForRole: the judge / chat / reflector are read-only; authoring roles can write", () => {
  for (const role of ["reviewer", "chat", "reflector"] as const) {
    assert.equal(capabilitiesForRole(role).canWrite, false, `${role} must be read-only`);
  }
  for (const role of ["primary", "sidekick", "maintainer"] as const) {
    assert.equal(capabilitiesForRole(role).canWrite, true, `${role} must be able to write`);
  }
});

test("roleForAgentName maps qa-reflector to the read-only reflector role", () => {
  assert.equal(roleForAgentName("qa-reflector"), "reflector");
  assert.equal(capabilitiesForRole("reflector").canWrite, false);
});

test("roleForAgentName resolves every role's agent name back to that role", () => {
  for (const [role, agent] of Object.entries(AGENT_NAME_FOR_ROLE)) {
    assert.equal(roleForAgentName(agent), role, `agent ${agent} must resolve back to role ${role}`);
  }
});

test("roleForAgentName rejects an agent name no role maps to instead of falling back to the primary author", () => {
  assert.throws(() => roleForAgentName("qa-unmapped"), /qa-unmapped/);
});

test("the lead role is the read-only qa-lead agent and the agent name resolves back to it", () => {
  assert.equal(AGENT_NAME_FOR_ROLE.lead, "qa-lead");
  assert.equal(roleForAgentName("qa-lead"), "lead");
  assert.equal(capabilitiesForRole("lead").canWrite, false);
});

/* Proposer is read-only: it hypothesizes candidates, never writes. */

test("capabilitiesForRole: the proposer is read-only (it hypothesizes candidates, never writes)", () => {
  assert.equal(capabilitiesForRole("proposer").canWrite, false);
});

test("roleForAgentName maps qa-proposer to the read-only proposer role", () => {
  assert.equal(roleForAgentName("qa-proposer"), "proposer");
});

test("the role-to-agent table maps proposer to the qa-proposer agent", () => {
  assert.equal(AGENT_NAME_FOR_ROLE.proposer, "qa-proposer");
});

test("OpenCodeRuntimeStrategy maps the proposer role to the qa-proposer agent", async () => {
  const calls: string[] = [];
  const deps: AgentDeps = {
    open: async (agent) => {
      calls.push(agent);
      return { id: "s", prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "k" }, depsFactory: async () => deps });
  await strategy.openSession("proposer", "/repo");
  assert.deepEqual(calls, ["qa-proposer"]);
});

test("OpenCodeRuntimeStrategy maps roles to OpenCode agents and forwards model overrides", async () => {
  const calls: Array<{ agent: string; cwd: string; model?: string }> = [];
  const deps: AgentDeps = {
    open: async (agent, cwd, opts) => {
      calls.push({ agent, cwd, model: opts?.model });
      return { id: "s1", prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({
    env: { OPENCODE_API_KEY: "opencode-key" },
    depsFactory: async () => deps,
  });

  const session = await strategy.openSession("reviewer", "/repo", { model: "opencode-go/minimax-m3" });
  assert.equal(await session.prompt("review"), "ok");

  assert.deepEqual(calls, [{ agent: "qa-reviewer", cwd: "/repo", model: "opencode-go/minimax-m3" }]);
});

test("OpenCodeRuntimeStrategy reports needs_config without OPENCODE_API_KEY", async () => {
  const strategy = new OpenCodeRuntimeStrategy({ env: {}, depsFactory: async () => { throw new Error("should not connect"); } });
  assert.deepEqual(await strategy.health(), { provider: "opencode", status: "needs_config", configured: false });
});

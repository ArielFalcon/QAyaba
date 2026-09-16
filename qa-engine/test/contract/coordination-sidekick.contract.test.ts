// Fase 4 — SidekickExecutor over AgentRuntimePort. Fake runtime; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import {
  resolveCapabilityRole,
  SidekickExecutor,
} from "@contexts/qa-run-orchestration/application/coordination/sidekick-executor.ts";
import { renderSidekickBrief } from "@contexts/qa-run-orchestration/application/coordination/sidekick-prompt.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

const scope = {
  readablePaths: ["e2e/"],
  writablePaths: ["e2e/specs/"],
  allowedCommands: ["npm test"],
};

function brief(overrides: { task?: string } = {}) {
  return createDelegationBrief({
    delegationId: "d1",
    runId: "r1",
    objective: "cover checkout",
    task: overrides.task ?? "write smoke spec",
    scope,
    acceptanceCriteria: ["checkout completes"],
  });
}

test("resolveCapabilityRole maps lead→primary and sidekicks→worker without model names", () => {
  assert.equal(resolveCapabilityRole("lead"), "primary");
  assert.equal(resolveCapabilityRole("sidekick-standard"), "worker");
  assert.equal(resolveCapabilityRole("sidekick-escalated"), "worker");
});

test("renderSidekickBrief includes authority, scope, validation and escalation — not a lead transcript", () => {
  const { text, sectionSizes } = renderSidekickBrief(brief());
  assert.match(text, /write smoke spec/);
  assert.match(text, /checkout completes/);
  assert.match(text, /canExpandScope:\s*false/);
  assert.match(text, /e2e\/specs\//);
  assert.match(text, /onNeedsLead/);
  assert.equal(text.includes("LEAD TRANSCRIPT"), false);
  assert.ok(Object.keys(sectionSizes).length > 0);
});

test("SidekickExecutor opens worker session, prompts, disposes, and parses DelegationResult", async () => {
  const prompts: string[] = [];
  let disposed = false;
  const session: AgentSession = {
    async prompt(text) {
      prompts.push(text);
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed",
          summary: "wrote smoke",
          filesChanged: [{ path: "e2e/specs/checkout.spec.ts" }],
          evidence: [],
          validation: [{ id: "v1", ok: true }],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
      };
    },
    async dispose() {
      disposed = true;
    },
  };
  const roles: AgentRole[] = [];
  const runtime: Pick<AgentRuntimePort, "openSession"> = {
    async openSession(role) {
      roles.push(role);
      return session;
    },
  };
  const executor = new SidekickExecutor({ runtime, render: renderSidekickBrief });
  const result = await executor.execute(brief(), {
    cwd: "/tmp/mirror",
    capability: "sidekick-standard",
  });
  assert.deepEqual(roles, ["worker"]);
  assert.equal(prompts.length, 1);
  assert.equal(disposed, true);
  assert.equal(result.status, "completed");
  assert.equal(result.delegationId, "d1");
  assert.equal(result.recommendation, "accept");
});

test("SidekickExecutor can send feedback on the same session before dispose", async () => {
  const prompts: string[] = [];
  const session: AgentSession = {
    async prompt(text) {
      prompts.push(text);
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed-with-concerns",
          summary: "fixed after feedback",
          filesChanged: [{ path: "e2e/specs/checkout.spec.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: ["selector fragile"],
          unresolvedQuestions: [],
          recommendation: "review",
        }),
      };
    },
    async dispose() {},
  };
  const runtime: Pick<AgentRuntimePort, "openSession"> = {
    async openSession() {
      return session;
    },
  };
  const executor = new SidekickExecutor({ runtime, render: renderSidekickBrief });
  const result = await executor.execute(brief(), {
    cwd: "/tmp/mirror",
    capability: "sidekick-standard",
    feedback: "selectors must use getByRole",
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /getByRole/);
  assert.equal(result.status, "completed-with-concerns");
});

test("SidekickExecutor rejects a result for a foreign brief as failed", async () => {
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "OTHER",
          runId: "r1",
          status: "completed",
          summary: "spoof",
          filesChanged: [],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
      };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({
    runtime: { openSession: async () => session },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), { cwd: "/tmp", capability: "sidekick-standard" });
  assert.equal(result.status, "failed");
  assert.equal(result.recommendation, "escalate");
});

test("SidekickExecutor marks write outside writablePaths as blocked", async () => {
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "completed",
          summary: "escaped",
          filesChanged: [{ path: "src/app.ts" }],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: [],
          recommendation: "accept",
        }),
      };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({
    runtime: { openSession: async () => session },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), { cwd: "/tmp", capability: "sidekick-standard" });
  assert.equal(result.status, "blocked");
  assert.equal(result.recommendation, "escalate");
});

test("SidekickExecutor passes escalated model via OpenSessionOpts without naming it in domain", async () => {
  let seenModel: string | undefined;
  const session: AgentSession = {
    async prompt() {
      return {
        output: JSON.stringify({
          delegationId: "d1",
          runId: "r1",
          status: "needs-lead",
          summary: "architecture ambiguous",
          filesChanged: [],
          evidence: [],
          validation: [],
          assumptions: [],
          concerns: [],
          unresolvedQuestions: ["which layout?"],
          recommendation: "escalate",
        }),
      };
    },
    async dispose() {},
  };
  const executor = new SidekickExecutor({
    runtime: {
      openSession: async (_role, _cwd, opts) => {
        seenModel = opts?.model;
        return session;
      },
    },
    render: renderSidekickBrief,
  });
  const result = await executor.execute(brief(), {
    cwd: "/tmp",
    capability: "sidekick-escalated",
    model: "configured-externally",
  });
  assert.equal(seenModel, "configured-externally");
  assert.equal(result.status, "needs-lead");
});

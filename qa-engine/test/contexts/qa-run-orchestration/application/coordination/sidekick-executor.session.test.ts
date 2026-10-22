import { test } from "node:test";
import assert from "node:assert/strict";
import { SidekickExecutor } from "@contexts/qa-run-orchestration/application/coordination/sidekick-executor.ts";
import { createDelegationBrief } from "@contexts/qa-run-orchestration/application/coordination/delegation-brief.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

const brief = createDelegationBrief({
  delegationId: "run-1-flow-cart",
  runId: "run-1",
  objective: "the cart total",
  task: "write the spec",
  scope: { readablePaths: ["."], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] },
});

const RESULT = JSON.stringify({ delegationId: "run-1-flow-cart", runId: "run-1", status: "completed", summary: "done", filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], validation: [], acceptance: [], assumptions: [], concerns: [], unresolvedQuestions: [], recommendation: "accept" });

function executor(opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }>) {
  return new SidekickExecutor({
    runtime: {
      openSession: async (role, cwd, opts) => {
        opened.push({ role, cwd, opts });
        return { prompt: async () => ({ output: RESULT }), dispose: async () => {} };
      },
    },
  });
}

test("the session opens in the directory it is given, as the sidekick role, and says which flow it is for and which tools its run denied it", async () => {
  const opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }> = [];
  await executor(opened).execute(brief, { cwd: "/work/run-1/cart", capability: "sidekick-standard", delegationId: "run-1-flow-cart", denyTools: ["serena*", "playwright*"], timeoutMs: 90_000 });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.role, "sidekick");
  assert.equal(opened[0]!.cwd, "/work/run-1/cart");
  assert.equal(opened[0]!.opts?.timeoutMs, 90_000);
  assert.equal(opened[0]!.opts?.descriptor?.runId, "run-1");
  assert.equal(opened[0]!.opts?.descriptor?.delegationId, "run-1-flow-cart");
  assert.deepEqual(opened[0]!.opts?.descriptor?.denyTools, ["serena*", "playwright*"]);
});

test("a session with no flow and no denied tools says neither", async () => {
  const opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }> = [];
  await executor(opened).execute(brief, { cwd: "/m", capability: "sidekick-standard" });
  assert.equal("delegationId" in (opened[0]!.opts?.descriptor ?? {}), false);
  assert.equal("denyTools" in (opened[0]!.opts?.descriptor ?? {}), false);
});

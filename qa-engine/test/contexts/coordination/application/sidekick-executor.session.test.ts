import { test } from "node:test";
import assert from "node:assert/strict";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const brief = createDelegationBrief({ redaction,
  delegationId: "run-1-flow-cart",
  runId: "run-1",
  objective: "the cart total",
  task: "write the spec",
  scope: { readablePaths: ["."], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] },
});

const RESULT = JSON.stringify({ delegationId: "run-1-flow-cart", runId: "run-1", status: "completed", summary: "done", filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], validation: [], acceptance: [], assumptions: [], concerns: [], unresolvedQuestions: [], recommendation: "accept" });

function executor(opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }>) {
  return new SidekickExecutor({ redaction,
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

test("an open sidekick session answers a follow-up in the same session, read as the first answer is, and is disposed once when its holder lets it go", async () => {
  const prompts: string[] = [];
  let opened = 0;
  let disposed = 0;
  const sidekick = new SidekickExecutor({ redaction,
    runtime: {
      openSession: async () => {
        opened += 1;
        return { prompt: async (text: string) => { prompts.push(text); return { output: RESULT }; }, dispose: async () => { disposed += 1; } };
      },
    },
  });
  const session = await sidekick.open(brief, { cwd: "/w", capability: "sidekick-standard" });
  assert.equal(session.first.status, "completed");
  assert.equal(disposed, 0, "the session outlives its first answer");
  const second = await session.ask("Assert the total, not the count.", { timeoutMs: 30_000 });
  assert.equal(second.status, "completed");
  assert.equal(opened, 1, "the follow-up went to the same session");
  assert.match(prompts[1]!, /Assert the total, not the count\./);
  assert.match(prompts[1]!, /delegationId=run-1-flow-cart/, "the follow-up asks for the same contract");
  await session.dispose();
  await session.dispose();
  assert.equal(disposed, 1);
});

test("a sidekick session whose first answer throws is disposed before the error leaves", async () => {
  let disposed = 0;
  const sidekick = new SidekickExecutor({ redaction,
    runtime: { openSession: async () => ({ prompt: async () => { throw new Error("boom"); }, dispose: async () => { disposed += 1; } }) },
  });
  await assert.rejects(sidekick.open(brief, { cwd: "/w", capability: "sidekick-standard" }), /boom/);
  assert.equal(disposed, 1);
});

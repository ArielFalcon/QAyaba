/* A kind's session is opened for the role and the agent its registry entry names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openKindSession } from "@contexts/coordination/application/kind-session.ts";
import { SIDEKICK_KIND, sidekickKindSpec } from "@contexts/coordination/application/sidekick-kinds.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

test("a session for the review kind is opened with the review entry's role and agent", async () => {
  const opened: Array<{ role: AgentRole; cwd: string; opts?: OpenSessionOpts }> = [];
  const runtime = { openSession: async (role: AgentRole, cwd: string, opts?: OpenSessionOpts) => { opened.push({ role, cwd, opts }); return { prompt: async () => ({ output: "" }), dispose: async () => {} }; } };
  await openKindSession(runtime, SIDEKICK_KIND.REVIEW, "/mirror", { descriptor: { runId: "r1" }, timeoutMs: 5 });
  const spec = sidekickKindSpec(SIDEKICK_KIND.REVIEW);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.role, spec.role);
  assert.equal(opened[0]!.cwd, "/mirror");
  assert.equal(opened[0]!.opts?.descriptor?.role, spec.agent);
  assert.equal(opened[0]!.opts?.descriptor?.runId, "r1");
  assert.equal(opened[0]!.opts?.timeoutMs, 5);
});

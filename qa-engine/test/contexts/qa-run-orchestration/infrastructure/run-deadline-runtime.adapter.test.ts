import { test } from "node:test";
import assert from "node:assert/strict";
import { RunDeadlineRuntime } from "@contexts/qa-run-orchestration/infrastructure/run-deadline-runtime.adapter.ts";
import { RunDeadline } from "@contexts/qa-run-orchestration/domain/run-deadline.ts";
import { RUN_TIME_BUDGET_MS } from "@contexts/qa-run-orchestration/domain/run-time-budget.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { isRunDeadlineError, RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { AgentPromptOpts, AgentRuntimePort, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

const HOST_CAP = 40 * 60_000;

interface Harness {
  runtime: RunDeadlineRuntime;
  clock: { t: number };
  deadline: RunDeadline;
  opened: Array<{ role: AgentRole; opts?: OpenSessionOpts }>;
  prompts: Array<{ text: string; opts?: AgentPromptOpts }>;
  /** What the inner session does with the next prompt. */
  inner: { behave: (opts: AgentPromptOpts | undefined) => Promise<{ output: string }> };
}

function harness(budgetMs: number | "unarmed"): Harness {
  const clock = { t: 0 };
  const deadline = new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, manual: budgetMs === "unarmed" ? 1 : budgetMs } });
  if (budgetMs !== "unarmed") deadline.arm({ mode: "manual" });
  const opened: Harness["opened"] = [];
  const prompts: Harness["prompts"] = [];
  const inner: Harness["inner"] = { behave: async () => ({ output: "ok" }) };
  const base: AgentRuntimePort = {
    openSession: async (role, _cwd, opts) => {
      opened.push({ role, ...(opts ? { opts } : {}) });
      return {
        prompt: async (text, o) => { prompts.push({ text, ...(o ? { opts: o } : {}) }); return inner.behave(o); },
        dispose: async () => {},
      };
    },
  };
  return { runtime: new RunDeadlineRuntime(base, deadline, { hostPromptCapMs: HOST_CAP }), clock, deadline, opened, prompts, inner };
}

test("while no deadline is armed the runtime is a pass-through: nothing is added to a prompt", async () => {
  const h = harness("unarmed");
  const session = await h.runtime.openSession("primary", "/w", { timeoutMs: 5 });
  await session.prompt("hi", { isRepair: true });
  assert.deepEqual(h.prompts[0]!.opts, { isRepair: true });
  assert.equal(h.opened[0]!.opts?.timeoutMs, 5);
});

test("a prompt with no limit of its own is given what is left of the run", async () => {
  const h = harness(60_000);
  h.clock.t = 10_000;
  const session = await h.runtime.openSession("primary", "/w");
  await session.prompt("hi");
  assert.equal(h.prompts[0]!.opts?.timeoutMs, 50_000);
});

test("a prompt is held to the smaller of its own limit and what is left of the run", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("primary", "/w");
  await session.prompt("own limit is smaller", { timeoutMs: 20_000 });
  h.clock.t = 50_000;
  await session.prompt("time left is smaller", { timeoutMs: 20_000 });
  assert.deepEqual(h.prompts.map((p) => p.opts?.timeoutMs), [20_000, 10_000]);
});

test("the session's own limit counts as the prompt's when the prompt states none", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("reviewer", "/w", { timeoutMs: 15_000 });
  await session.prompt("hi");
  assert.equal(h.prompts[0]!.opts?.timeoutMs, 15_000);
});

test("every other option of the prompt reaches the session untouched", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("primary", "/w");
  await session.prompt("hi", { isRepair: true, withoutTools: true, stepLimit: 7, finalStepOnly: true });
  assert.deepEqual({ ...h.prompts[0]!.opts, timeoutMs: undefined }, { isRepair: true, withoutTools: true, stepLimit: 7, finalStepOnly: true, timeoutMs: undefined });
});

test("a prompt that finds no time left is not sent: the run's deadline error names the role and that it never started", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("reviewer", "/w");
  h.clock.t = 60_000;
  await assert.rejects(session.prompt("late"), (err: unknown) => {
    assert.ok(isRunDeadlineError(err));
    const e = err as RunDeadlineExceededError;
    assert.deepEqual([e.role, e.stop, e.budgetMs, e.label], ["reviewer", "before-turn", 60_000, "manual"]);
    return true;
  });
  assert.equal(h.prompts.length, 0, "no turn is spent on a run whose time is gone");
});

test("a session is not opened once the run's time is gone", async () => {
  const h = harness(60_000);
  h.clock.t = 61_000;
  await assert.rejects(h.runtime.openSession("explorer", "/w"), (err: unknown) => isRunDeadlineError(err) && (err as RunDeadlineExceededError).stop === "before-turn");
  assert.equal(h.opened.length, 0);
});

test("a turn that times out because the run's time ran out is the run's deadline, not the turn's own timeout", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("primary", "/w");
  h.clock.t = 30_000;
  h.inner.behave = async () => { h.clock.t = 60_000; throw new AgentTimeoutError("OpenCode prompt: timed out"); };
  await assert.rejects(session.prompt("long"), (err: unknown) => {
    assert.ok(isRunDeadlineError(err));
    assert.equal((err as RunDeadlineExceededError).stop, "mid-turn");
    assert.ok((err as Error).cause instanceof AgentTimeoutError, "the turn's own error stays reachable");
    return true;
  });
});

test("a turn that times out on its own, with run time to spare, stays the turn's own timeout (a tier budget reads it as such)", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("primary", "/w");
  const own = new AgentTimeoutError("OpenCode prompt: timed out");
  h.inner.behave = async () => { h.clock.t = 20_000; throw own; };
  await assert.rejects(session.prompt("short", { timeoutMs: 20_000 }), (err: unknown) => err === own);
});

test("without a limit of its own, the host's prompt deadline decides whether the run's time was what ended the turn", async () => {
  const h = harness(2 * HOST_CAP);
  const session = await h.runtime.openSession("primary", "/w");
  const own = new AgentTimeoutError("OpenCode prompt: timed out");
  h.inner.behave = async () => { h.clock.t = HOST_CAP; throw own; };
  await assert.rejects(session.prompt("host deadline fires first"), (err: unknown) => err === own);
});

test("any other failure of a turn passes through unchanged", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("primary", "/w");
  const boom = new Error("provider rejected the request");
  h.inner.behave = async () => { throw boom; };
  await assert.rejects(session.prompt("x"), (err: unknown) => err === boom);
});

test("dispose reaches the session even after the run's time is gone", async () => {
  let disposed = 0;
  const clock = { t: 0 };
  const deadline = new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 10 } });
  deadline.arm({ mode: "manual" });
  const runtime = new RunDeadlineRuntime({ openSession: async () => ({ prompt: async () => ({ output: "" }), dispose: async () => { disposed++; } }) }, deadline, { hostPromptCapMs: HOST_CAP });
  const session = await runtime.openSession("primary", "/w");
  clock.t = 99;
  await session.dispose();
  assert.equal(disposed, 1);
});

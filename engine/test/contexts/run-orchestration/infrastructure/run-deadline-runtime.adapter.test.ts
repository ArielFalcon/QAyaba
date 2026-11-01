import { test } from "node:test";
import assert from "node:assert/strict";
import { RunDeadlineRuntime } from "@contexts/run-orchestration/infrastructure/run-deadline-runtime.adapter.ts";
import { RunDeadline } from "@contexts/run-orchestration/domain/run-deadline.ts";
import { RUN_TIME_BUDGET_MS } from "@contexts/run-orchestration/domain/run-time-budget.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { isAllotmentSpentError, isRunDeadlineError, RunDeadlineExceededError, type AllotmentSpentError } from "@kernel/run-deadline.ts";
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
  /* The last purpose holds nothing back, so what is left of the run is what the turn may use. */
  deadline.enter("decide");
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
  const session = await h.runtime.openSession("author", "/w", { timeoutMs: 5 });
  await session.prompt("hi", { isRepair: true });
  assert.deepEqual(h.prompts[0]!.opts, { isRepair: true });
  assert.equal(h.opened[0]!.opts?.timeoutMs, 5);
});

test("a prompt with no limit of its own is given what is left of the run", async () => {
  const h = harness(60_000);
  h.clock.t = 10_000;
  const session = await h.runtime.openSession("author", "/w");
  await session.prompt("hi");
  assert.equal(h.prompts[0]!.opts?.timeoutMs, 50_000);
});

test("a prompt is held to the smaller of its own limit and what is left of the run", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("author", "/w");
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
  const session = await h.runtime.openSession("author", "/w");
  await session.prompt("hi", { isRepair: true, withoutWrites: true, stepLimit: 7, textOnly: true });
  assert.deepEqual({ ...h.prompts[0]!.opts, timeoutMs: undefined, timeLimit: undefined }, { isRepair: true, withoutWrites: true, stepLimit: 7, textOnly: true, timeoutMs: undefined, timeLimit: undefined });
});

test("a time the run's deadline sets is named as the run's deadline, and one the turn's own limit sets keeps the caller's name", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("author", "/w");
  await session.prompt("deadline binds");
  assert.equal(h.prompts[0]!.opts?.timeLimit, "run-deadline");
  await session.prompt("own limit binds", { timeoutMs: 5_000, timeLimit: "repair-cap" });
  assert.equal(h.prompts[1]!.opts?.timeoutMs, 5_000);
  assert.equal(h.prompts[1]!.opts?.timeLimit, "repair-cap");
});

test("a prompt that finds no time left is not sent: the run's deadline error names the role and that it never started", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("reviewer", "/w");
  h.clock.t = 60_000;
  await assert.rejects(session.prompt("late"), (err: unknown) => {
    assert.ok(isRunDeadlineError(err));
    const e = err as RunDeadlineExceededError;
    assert.deepEqual([e.role, e.stop, e.budgetMs, e.label, e.purpose], ["reviewer", "before-turn", 60_000, "manual", "decide"]);
    return true;
  });
  assert.equal(h.prompts.length, 0, "no turn is spent on a run whose time is gone");
});

test("a turn that times out at its purpose's share while the run has time is that turn's timeout alone, not the run's deadline", async () => {
  const h = harness(40 * 60_000);
  h.deadline.measure([{ furthestPhase: "learn", phaseTimings: { validate: 60_000, execute: 180_000, coverage: 120_000, review: 240_000, publish: 60_000 } }]);
  h.deadline.enter("generate");
  const session = await h.runtime.openSession("author", "/w");
  h.inner.behave = async () => { h.clock.t += 29 * 60_000; throw new AgentTimeoutError("OpenCode prompt: timed out"); };
  await assert.rejects(session.prompt("long"), (err: unknown) => {
    assert.ok(isAllotmentSpentError(err));
    assert.ok(!isRunDeadlineError(err));
    assert.ok(err instanceof AgentTimeoutError);
    assert.equal((err as AllotmentSpentError).stop, "mid-turn");
    assert.equal((err as AllotmentSpentError).purpose, "generate");
    assert.ok((err as Error).cause instanceof AgentTimeoutError, "the turn's own error stays reachable");
    return true;
  });
  assert.ok(h.deadline.remainingMs()! > 0);
});

test("a session is not opened once the run's time is gone", async () => {
  const h = harness(60_000);
  h.clock.t = 61_000;
  await assert.rejects(h.runtime.openSession("chat", "/w"), (err: unknown) => isRunDeadlineError(err) && (err as RunDeadlineExceededError).stop === "before-turn");
  assert.equal(h.opened.length, 0);
});

test("a turn that times out because the run's time ran out is the run's deadline, not the turn's own timeout", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("author", "/w");
  h.clock.t = 30_000;
  h.inner.behave = async () => { h.clock.t = 60_000; throw new AgentTimeoutError("OpenCode prompt: timed out"); };
  await assert.rejects(session.prompt("long"), (err: unknown) => {
    assert.ok(isRunDeadlineError(err));
    assert.equal((err as RunDeadlineExceededError).stop, "mid-turn");
    assert.equal((err as RunDeadlineExceededError).purpose, "decide", "the end names the purpose whose allotment it was");
    assert.ok((err as Error).cause instanceof AgentTimeoutError, "the turn's own error stays reachable");
    return true;
  });
});

test("a turn that times out on its own, with run time to spare, stays the turn's own timeout (a tier budget reads it as such)", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("author", "/w");
  const own = new AgentTimeoutError("OpenCode prompt: timed out");
  h.inner.behave = async () => { h.clock.t = 20_000; throw own; };
  await assert.rejects(session.prompt("short", { timeoutMs: 20_000 }), (err: unknown) => err === own);
});

test("without a limit of its own, the host's prompt deadline decides whether the run's time was what ended the turn", async () => {
  const h = harness(2 * HOST_CAP);
  const session = await h.runtime.openSession("author", "/w");
  const own = new AgentTimeoutError("OpenCode prompt: timed out");
  h.inner.behave = async () => { h.clock.t = HOST_CAP; throw own; };
  await assert.rejects(session.prompt("host deadline fires first"), (err: unknown) => err === own);
});

test("any other failure of a turn passes through unchanged", async () => {
  const h = harness(60_000);
  const session = await h.runtime.openSession("author", "/w");
  const boom = new Error("provider rejected the request");
  h.inner.behave = async () => { throw boom; };
  await assert.rejects(session.prompt("x"), (err: unknown) => err === boom);
});

test("dispose reaches the session even after the run's time is gone", async () => {
  let disposed = 0;
  const clock = { t: 0 };
  const deadline = new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 10 } });
  deadline.arm({ mode: "manual" });
  deadline.enter("decide");
  const runtime = new RunDeadlineRuntime({ openSession: async () => ({ prompt: async () => ({ output: "" }), dispose: async () => { disposed++; } }) }, deadline, { hostPromptCapMs: HOST_CAP });
  const session = await runtime.openSession("author", "/w");
  clock.t = 99;
  await session.dispose();
  assert.equal(disposed, 1);
});

test("a turn is held to what its purpose is allotted, not to what is left of the run: the phases after it keep their measured time", async () => {
  const h = harness(40 * 60_000);
  h.deadline.measure([{ furthestPhase: "learn", phaseTimings: { validate: 60_000, health: 0, execute: 180_000, fix_loop: 0, coverage: 120_000, review: 240_000, decide: 0, publish: 60_000 } }]);
  h.deadline.enter("generate");
  const session = await h.runtime.openSession("author", "/w");
  await session.prompt("plan");
  assert.equal(h.prompts[0]!.opts?.timeoutMs, 29 * 60_000, "40 min less the 11 min the app's runs spend after generation");
  assert.equal(h.prompts[0]!.opts?.timeLimit, "allotment", "the share is smaller than what is left: the run itself still has time");
});

test("a turn whose purpose has been allotted nothing is refused as the purpose's share spent, not as the run's deadline", async () => {
  const h = harness(40 * 60_000);
  h.deadline.measure([{ furthestPhase: "learn", phaseTimings: { validate: 60_000, execute: 180_000, coverage: 120_000, review: 240_000, publish: 60_000 } }]);
  h.deadline.enter("generate");
  h.clock.t = 35 * 60_000;
  const session = await h.runtime.openSession("author", "/w").catch((err) => err);
  assert.ok(isAllotmentSpentError(session), "no time is left for generation: the review and the rest are owed 11 of the 5 minutes that remain");
  assert.ok(!isRunDeadlineError(session), "the run itself still has time");
  assert.ok(session instanceof AgentTimeoutError, "an owner reads it as the timeout of that turn alone");
  assert.equal((session as AllotmentSpentError).stop, "before-turn");
  assert.equal((session as AllotmentSpentError).purpose, "generate");
  assert.equal(h.deadline.remainingMs(), 5 * 60_000);
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

test("opening a session the runtime never answers ends with the run's deadline error once the run's time passes", async () => {
  const clock = { t: 0 };
  const deadline = new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 150 } });
  deadline.arm({ mode: "manual" });
  deadline.enter("decide");
  const runtime = new RunDeadlineRuntime({ openSession: () => never() }, deadline);
  await assert.rejects(runtime.openSession("author", "/w"), (err: unknown) => {
    assert.ok(isRunDeadlineError(err));
    assert.equal((err as RunDeadlineExceededError).stop, "before-turn");
    return true;
  });
});

test("a dispose the runtime never answers ends within what the run has left, and does not throw", async () => {
  const clock = { t: 0 };
  const deadline = new RunDeadline({ now: () => clock.t, budgets: { ...RUN_TIME_BUDGET_MS, manual: 150 } });
  deadline.arm({ mode: "manual" });
  deadline.enter("decide");
  const runtime = new RunDeadlineRuntime({ openSession: async () => ({ prompt: async () => ({ output: "ok" }), dispose: () => never<void>() }) }, deadline, { disposeGraceMs: 50 });
  const session = await runtime.openSession("author", "/w");
  const started = Date.now();
  await session.dispose();
  assert.ok(Date.now() - started < 1_500, "the dispose must end on the run's time left");
});

test("while no deadline is armed a dispose is passed straight to the runtime", async () => {
  let disposed = 0;
  const runtime = new RunDeadlineRuntime({ openSession: async () => ({ prompt: async () => ({ output: "ok" }), dispose: async () => { disposed += 1; } }) }, new RunDeadline({ now: () => 0, budgets: RUN_TIME_BUDGET_MS }));
  const session = await runtime.openSession("author", "/w");
  await session.dispose();
  assert.equal(disposed, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { SidekickExecutor } from "@contexts/coordination/application/sidekick-executor.ts";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import type { AgentPromptOpts, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import { SessionGoneError } from "@kernel/turn-end.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const brief = createDelegationBrief({ redaction,
  delegationId: "run-1-flow-cart",
  runId: "run-1",
  objective: "the cart total",
  task: "write the spec",
  scope: { readablePaths: ["."], writablePaths: ["e2e/flows/cart.spec.ts"], allowedCommands: [] },
});

const RESULT = JSON.stringify({ delegationId: "run-1-flow-cart", runId: "run-1", status: "completed", summary: "done", filesChanged: [{ path: "e2e/flows/cart.spec.ts" }], evidence: [], acceptance: [], concerns: [], unresolvedQuestions: [] });

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
  await executor(opened).execute(brief, { cwd: "/work/run-1/cart", kind: "author", delegationId: "run-1-flow-cart", denyTools: ["serena*", "playwright*"], timeoutMs: 90_000 });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.role, "author");
  assert.equal(opened[0]!.cwd, "/work/run-1/cart");
  assert.equal(opened[0]!.opts?.timeoutMs, 90_000);
  assert.equal(opened[0]!.opts?.descriptor?.runId, "run-1");
  assert.equal(opened[0]!.opts?.descriptor?.delegationId, "run-1-flow-cart");
  assert.deepEqual(opened[0]!.opts?.descriptor?.denyTools, ["serena*", "playwright*"]);
});

test("a session with no flow and no denied tools says neither", async () => {
  const opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }> = [];
  await executor(opened).execute(brief, { cwd: "/m", kind: "author" });
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
  const session = await sidekick.open(brief, { cwd: "/w", kind: "author" });
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
  await assert.rejects(sidekick.open(brief, { cwd: "/w", kind: "author" }), /boom/);
  assert.equal(disposed, 1);
});

function stoppedFirstTurn(error: unknown, calls: { disposed: number; prompts: number }) {
  return new SidekickExecutor({ redaction,
    runtime: {
      openSession: async () => ({
        prompt: async () => {
          calls.prompts += 1;
          if (calls.prompts === 1) throw error;
          return { output: RESULT };
        },
        dispose: async () => { calls.disposed += 1; },
      }),
    },
  });
}

test("a first turn that ran out of its time leaves the session to a holder that asked to keep it, idle and able to answer the lead's follow-up, with no answer read", async () => {
  const calls = { disposed: 0, prompts: 0 };
  const session = await stoppedFirstTurn(new AgentTimeoutError("OpenCode prompt: timed out after 90000ms"), calls).open(brief, { cwd: "/w", kind: "author", keepUnanswered: true });
  assert.equal(calls.disposed, 0);
  assert.equal(session.first.status, "failed");
  assert.deepEqual(session.first.filesChanged, []);
  assert.match(session.first.summary, /ran out of its time/);
  assert.equal((await session.ask("Try again.")).status, "completed", "the same session answers");
  await session.dispose();
  assert.equal(calls.disposed, 1);
});

test("a first turn that ended because its flow was stopped is kept the same way, and one the caller did not ask to keep is disposed before the error leaves", async () => {
  const stopped = new AbortController();
  stopped.abort();
  const kept = { disposed: 0, prompts: 0 };
  const session = await stoppedFirstTurn(new Error("the agent turn was aborted"), kept).open(brief, { cwd: "/w", kind: "author", keepUnanswered: true, signal: stopped.signal });
  assert.equal(kept.disposed, 0);
  await session.dispose();
  const dropped = { disposed: 0, prompts: 0 };
  await assert.rejects(stoppedFirstTurn(new Error("the agent turn was aborted"), dropped).open(brief, { cwd: "/w", kind: "author", signal: stopped.signal }), /aborted/);
  assert.equal(dropped.disposed, 1);
});

test("a first turn that the run's own deadline ended is never kept, and one that failed for another reason is kept only for a holder that asked to", async () => {
  const deadline = { disposed: 0, prompts: 0 };
  await assert.rejects(stoppedFirstTurn(new RunDeadlineExceededError(1000, "diff-tiny", "author", "mid-turn"), deadline).open(brief, { cwd: "/w", kind: "author", keepUnanswered: true }));
  assert.equal(deadline.disposed, 1);
  const kept = { disposed: 0, prompts: 0 };
  const session = await stoppedFirstTurn(new Error("boom"), kept).open(brief, { cwd: "/w", kind: "author", keepUnanswered: true });
  assert.equal(kept.disposed, 0, "a fault of the runtime does not end the session");
  assert.equal(session.first.turnEnd?.kind, "failed");
  assert.equal((await session.ask("Try again.")).status, "completed", "the same session answers");
  await session.dispose();
  const dropped = { disposed: 0, prompts: 0 };
  await assert.rejects(stoppedFirstTurn(new Error("boom"), dropped).open(brief, { cwd: "/w", kind: "author" }), /boom/);
  assert.equal(dropped.disposed, 1, "a caller that did not ask to keep the session gets the error and no session");
});

function askFaulting(error: unknown, calls: { disposed: number; prompts: number }) {
  return new SidekickExecutor({ redaction,
    runtime: {
      openSession: async () => ({
        prompt: async () => {
          calls.prompts += 1;
          if (calls.prompts === 2) throw error;
          return { output: RESULT };
        },
        dispose: async () => { calls.disposed += 1; },
      }),
    },
  });
}

test("a follow-up that met a fault of the transport is a turn that did not answer, typed, and the session answers the next one", async () => {
  const calls = { disposed: 0, prompts: 0 };
  const fault = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  const session = await askFaulting(fault, calls).open(brief, { cwd: "/w", kind: "author" });
  const faulted = await session.ask("Assert the total.");
  assert.equal(faulted.status, "failed");
  assert.equal(faulted.turnEnd?.kind, "failed");
  assert.equal(faulted.turnEnd?.errorType, "transport");
  assert.deepEqual(faulted.filesChanged, []);
  assert.equal(calls.disposed, 0, "the session outlives the fault");
  assert.equal((await session.ask("Again.")).status, "completed");
  await session.dispose();
  assert.equal(calls.disposed, 1);
});

test("a follow-up that ran out of its time is a typed end of its own and keeps the session", async () => {
  const calls = { disposed: 0, prompts: 0 };
  const session = await askFaulting(new AgentTimeoutError("OpenCode prompt: timed out after 30000ms"), calls).open(brief, { cwd: "/w", kind: "author" });
  const late = await session.ask("Assert the total.", { timeoutMs: 30_000 });
  assert.equal(late.turnEnd?.kind, "timeout");
  assert.equal(calls.disposed, 0);
  await session.dispose();
});

test("only a session the runtime says is gone is ended by the executor, in a first turn and in a follow-up", async () => {
  const followUp = { disposed: 0, prompts: 0 };
  const session = await askFaulting(new SessionGoneError("session ses_1 not found"), followUp).open(brief, { cwd: "/w", kind: "author" });
  assert.equal((await session.ask("Assert the total.")).turnEnd?.kind, "session-gone");
  assert.equal(followUp.disposed, 1, "the session the runtime no longer holds is ended");
  await session.dispose();
  assert.equal(followUp.disposed, 1, "and only once");
  const first = { disposed: 0, prompts: 0 };
  const gone = await stoppedFirstTurn(new SessionGoneError("session ses_1 not found"), first).open(brief, { cwd: "/w", kind: "author", keepUnanswered: true });
  assert.equal(gone.first.turnEnd?.kind, "session-gone");
  assert.equal(first.disposed, 1);
});

test("the run's own deadline in a follow-up ends the run: it is thrown, not typed", async () => {
  const calls = { disposed: 0, prompts: 0 };
  const session = await askFaulting(new RunDeadlineExceededError(1000, "diff-tiny", "author", "mid-turn"), calls).open(brief, { cwd: "/w", kind: "author" });
  await assert.rejects(session.ask("Assert the total."), RunDeadlineExceededError);
});

test("the lead's feedback is a registered section: the follow-up and the first prompt carry its sizes and hashes beside the brief's", async () => {
  const seen: Array<{ text: string; opts: AgentPromptOpts | undefined }> = [];
  const sidekick = new SidekickExecutor({ redaction,
    runtime: { openSession: async () => ({ prompt: async (text: string, opts?: AgentPromptOpts) => { seen.push({ text, opts }); return { output: RESULT }; }, dispose: async () => {} }) },
  });
  const session = await sidekick.open(brief, { cwd: "/m", kind: "author", feedback: "Assert the total row." });
  assert.ok(seen[0]!.text.includes("## Feedback from lead\nAssert the total row."));
  assert.ok("lead-feedback" in (seen[0]!.opts?.sectionSizes ?? {}));
  assert.ok("lead-feedback" in (seen[0]!.opts?.sectionHashes ?? {}));
  await session.ask("Try the other page.");
  assert.ok(seen[1]!.text.startsWith("## Feedback from lead\nTry the other page."));
  assert.deepEqual(Object.keys(seen[1]!.opts?.sectionSizes ?? {}), ["lead-feedback", "feedback-contract"]);
  assert.deepEqual(Object.keys(seen[1]!.opts?.sectionHashes ?? {}), ["lead-feedback", "feedback-contract"]);
  await session.dispose();
});

const FOUND_NOTHING = "I wrote the spec and ran it; it passes. No JSON from me.";

function repairing(outputs: string[], calls: { prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>; opened: number; disposed: number }) {
  return new SidekickExecutor({ redaction,
    runtime: {
      openSession: async () => {
        calls.opened += 1;
        return { prompt: async (text: string, opts?: AgentPromptOpts) => { calls.prompts.push({ text, opts }); return { output: outputs[Math.min(calls.prompts.length - 1, outputs.length - 1)]! }; }, dispose: async () => { calls.disposed += 1; } };
      },
    },
  });
}

test("an answer that holds no result is asked about once, in the same session with the tools off, and the restated result is the sidekick's answer", async () => {
  const calls = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  const session = await repairing([FOUND_NOTHING, RESULT], calls).open(brief, { cwd: "/w", kind: "author" });
  assert.equal(calls.opened, 1, "the same session");
  assert.equal(calls.prompts.length, 2, "the brief and one repair turn");
  assert.equal(calls.prompts[1]!.opts?.withoutTools, true);
  assert.equal(calls.prompts[1]!.opts?.isRepair, true);
  assert.match(calls.prompts[1]!.text, /could not read/i);
  assert.match(calls.prompts[1]!.text, /delegationId=run-1-flow-cart/, "it restates the contract");
  assert.equal(session.first.status, "completed");
  assert.equal(session.first.readMiss, undefined);
  assert.equal(session.first.repaired, true);
  await session.dispose();
});

test("an answer still unreadable after the repair turn is the failed unreadable result it was, asked about once only", async () => {
  const calls = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  const session = await repairing([FOUND_NOTHING], calls).open(brief, { cwd: "/w", kind: "author" });
  assert.equal(calls.prompts.length, 2, "never a second repair");
  assert.equal(session.first.status, "failed");
  assert.equal(session.first.readMiss, "unreadable");
  assert.equal(session.first.repaired, true);
  await session.dispose();
});

test("a result with an entry it cannot read is asked about once, and the repaired result replaces it only when it reads better", async () => {
  const flawed = JSON.stringify({ ...JSON.parse(RESULT), filesChanged: [{ path: "e2e/flows/cart.spec.ts" }, "x"] });
  const calls = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  const better = await repairing([flawed, RESULT], calls).open(brief, { cwd: "/w", kind: "author" });
  assert.match(calls.prompts[1]!.text, /filesChanged\[1\]/, "the repair names where the entry sits");
  assert.equal(better.first.unreadableEntries, undefined);
  const same = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  const stays = await repairing([flawed], same).open(brief, { cwd: "/w", kind: "author" });
  assert.equal(same.prompts.length, 2);
  assert.deepEqual(stays.first.unreadableEntries?.map((u) => u.where), ["filesChanged[1]"], "the entry that stays unreadable is recorded");
});

test("an answer that reads whole is not asked about again, and nor is an answer with nothing in it", async () => {
  const whole = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  await repairing([RESULT], whole).open(brief, { cwd: "/w", kind: "author" });
  assert.equal(whole.prompts.length, 1);
  const empty = { prompts: [] as Array<{ text: string; opts: AgentPromptOpts | undefined }>, opened: 0, disposed: 0 };
  const session = await repairing(["   "], empty).open(brief, { cwd: "/w", kind: "author" });
  assert.equal(empty.prompts.length, 1, "an answer with nothing in it is the sidekick's absence, not a result to repair");
  assert.equal(session.first.readMiss, "unreadable");
});

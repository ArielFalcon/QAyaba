import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTimeoutError } from "@kernel/domain-error.ts";
import type { AgentPromptOpts, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
import { describeNoSubmission, SUBMIT_TOOL, type SubmissionContract, type SubmissionReport } from "@kernel/submission.ts";
import { submitTurn } from "@kernel/submit-turn.ts";

const contract: SubmissionContract<string> = { tool: SUBMIT_TOOL.PLAN, check: (answer) => (typeof answer === "string" ? { ok: true, value: answer } : { ok: false, errors: [{ path: "answer", reason: "not text" }] }) };

type Prompt = Awaited<ReturnType<AgentSession["prompt"]>>;

function scripted(...turns: Array<Prompt | Error>): { session: Pick<AgentSession, "prompt">; prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }> } {
  const prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }> = [];
  const queue = [...turns];
  return {
    prompts,
    session: {
      prompt: async (text, opts) => {
        prompts.push({ text, opts });
        const next = queue.shift();
        if (next === undefined) throw new Error("no more scripted turns");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const accepted = (value: string, calls = 1): SubmissionReport => ({ accepted: true, value, calls });
const open = (end: "stopped" | "output-length", errors: Array<{ path: string; reason: string }> = [], calls = 0): SubmissionReport => ({ accepted: false, calls, errors, end });

test("a turn that submits is the answer and asks nothing more", async () => {
  const { session, prompts } = scripted({ output: "done", submission: accepted("the plan", 2) });
  const turn = await submitTurn(session, "plan it", { timeoutMs: 1_000 }, contract);
  assert.deepEqual(turn, { submitted: true, value: "the plan", output: "done", calls: 2, continued: false });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.opts?.submit, contract);
});

test("a turn that ends without a submission gets one continuation restricted to the submit tool, told the last rejection, within the same bounds", async () => {
  const { session, prompts } = scripted({ output: "{broken", submission: open("output-length", [{ path: "flows[0].objective", reason: "objective is missing" }], 1) }, { output: "", submission: accepted("fixed", 1) });
  const turn = await submitTurn(session, "plan it", { timeoutMs: 90_000, timeLimit: "plan-budget", stepLimit: 12, withoutWrites: true, finalStepOnly: true }, contract);
  assert.deepEqual(turn, { submitted: true, value: "fixed", output: "", calls: 2, continued: true });
  assert.equal(prompts.length, 2);
  const continuation = prompts[1]!;
  assert.equal(continuation.opts?.submitOnly, true);
  assert.equal(continuation.opts?.submit, contract);
  assert.equal(continuation.opts?.timeoutMs, 90_000);
  assert.equal(continuation.opts?.timeLimit, "plan-budget");
  assert.equal(continuation.opts?.stepLimit, 12);
  assert.equal(continuation.opts?.withoutWrites, undefined);
  assert.match(continuation.text, /output-length limit/);
  assert.match(continuation.text, /flows\[0\]\.objective: objective is missing/);
  assert.match(continuation.text, /submit_plan/);
});

test("a turn with no submission after its continuation is a typed end with the last rejection, never a throw", async () => {
  const errors = [{ path: "flows", reason: "it is not a list" }];
  const { session, prompts } = scripted({ output: "a", submission: open("stopped", errors, 1) }, { output: "b", submission: open("stopped", [], 0) });
  const turn = await submitTurn(session, "plan it", {}, contract);
  assert.equal(prompts.length, 2, "exactly one continuation");
  assert.equal(turn.submitted, false);
  if (turn.submitted) return;
  assert.deepEqual({ end: turn.end, errors: turn.errors, calls: turn.calls, continued: turn.continued, continuationTimedOut: turn.continuationTimedOut }, { end: "stopped", errors, calls: 1, continued: true, continuationTimedOut: false });
  assert.match(describeNoSubmission(turn), /flows: it is not a list/);
});

test("a continuation that runs out of the time its purpose is allotted is typed, and the first turn's rejection stands", async () => {
  const errors = [{ path: "answer", reason: "not text" }];
  const { session } = scripted({ output: "a", submission: open("stopped", errors, 3) }, new AgentTimeoutError("allotment spent"));
  const turn = await submitTurn(session, "plan it", {}, contract);
  assert.equal(turn.submitted, false);
  if (turn.submitted) return;
  assert.equal(turn.continuationTimedOut, true);
  assert.deepEqual(turn.errors, errors);
  assert.match(describeNoSubmission(turn), /continuation ran out of its time/);
});

test("a fault of the continuation that is no time limit is not swallowed", async () => {
  const { session } = scripted({ output: "a", submission: open("stopped") }, new Error("transport down"));
  await assert.rejects(submitTurn(session, "plan it", {}, contract), /transport down/);
});

test("a runtime that reports no submission counts as a turn that made no call", async () => {
  const { session, prompts } = scripted({ output: "x" }, { output: "y" });
  const turn = await submitTurn(session, "plan it", {}, contract);
  assert.equal(prompts.length, 2);
  assert.equal(turn.submitted, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentOutputLengthError } from "@kernel/domain-error.ts";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";
import { SubmissionRegistry } from "@contexts/agent-tools/infrastructure/submission-registry.ts";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter.ts";

test("openSession delegates to AgentDeps.open and adapts prompt → { output }, forwarding round/isRepair/sectionSizes", async () => {
  let promptOpts: unknown = null;
  const adapter = new AgentRuntimeAdapter({
    open: async (_agent, _cwd, _opts) => ({
      id: "s1",
      prompt: async (_t: string, o: unknown) => { promptOpts = o; return "RESULT"; },
      dispose: async () => {},
    }) as never,
  }, (role) => role);
  const session = await adapter.openSession("author", "/m", { descriptor: { runId: "r1" } });
  const out = await session.prompt("go", { round: 3, isRepair: true, sectionSizes: { task: 9 } });
  assert.equal(out.output, "RESULT");
  assert.deepEqual(promptOpts, { round: 3, isRepair: true, sectionSizes: { task: 9 } }); /* opts NOT dropped */
});

const planContract: SubmissionContract<string> = { tool: SUBMIT_TOOL.PLAN, check: (answer) => (typeof answer === "string" ? { ok: true, value: answer } : { ok: false, errors: [{ path: "answer", reason: "not text" }] }) };

function submittingAdapter(prompt: (registry: SubmissionRegistry, text: string) => Promise<string>) {
  const registry = new SubmissionRegistry({ redact: (text) => text });
  const adapter = new AgentRuntimeAdapter({ open: async () => ({ id: "ses-7", prompt: (text: string) => prompt(registry, text), dispose: async () => {} }) as never }, () => "qa-lead", registry);
  return { registry, adapter };
}

test("a prompt that asks for a submission arms its session for the role's agent, reports what the tool accepted and closes the slot", async () => {
  const { registry, adapter } = submittingAdapter(async (live) => {
    live.find("ses-7")!.call({ sessionId: "ses-7", agent: "qa-lead", tool: SUBMIT_TOOL.PLAN, answer: 3 });
    live.find("ses-7")!.call({ sessionId: "ses-7", agent: "qa-lead", tool: SUBMIT_TOOL.PLAN, answer: "the plan" });
    return "closing words";
  });
  const session = await adapter.openSession("lead", "/m");
  const out = await session.prompt("plan", { submit: planContract });
  assert.deepEqual(out, { output: "closing words", submission: { accepted: true, value: "the plan", calls: 2 } });
  assert.equal(registry.find("ses-7"), undefined);
});

test("a turn the model's output-length limit cut is a typed end of the submission, not a throw, and keeps what the tool had rejected", async () => {
  const { registry, adapter } = submittingAdapter(async (live) => {
    live.find("ses-7")!.call({ sessionId: "ses-7", agent: "qa-lead", tool: SUBMIT_TOOL.PLAN, answer: 3 });
    throw new AgentOutputLengthError("cut");
  });
  const session = await adapter.openSession("lead", "/m");
  const out = await session.prompt("plan", { submit: planContract });
  assert.deepEqual(out.submission, { accepted: false, calls: 1, errors: [{ path: "answer", reason: "not text" }], end: "output-length" });
  assert.equal(registry.find("ses-7"), undefined);
});

test("any other fault of a submitting prompt propagates and still closes the slot", async () => {
  const { registry, adapter } = submittingAdapter(async () => { throw new Error("transport down"); });
  const session = await adapter.openSession("lead", "/m");
  await assert.rejects(session.prompt("plan", { submit: planContract }), /transport down/);
  assert.equal(registry.find("ses-7"), undefined);
});

test("a prompt that asks for a submission is refused where the runtime holds no submission port, naming the service token", async () => {
  const adapter = new AgentRuntimeAdapter({ open: async () => ({ id: "s", prompt: async () => "x", dispose: async () => {} }) as never }, () => "qa-lead");
  const session = await adapter.openSession("lead", "/m");
  await assert.rejects(session.prompt("plan", { submit: planContract }), /QA_TOOLS_TOKEN/);
});

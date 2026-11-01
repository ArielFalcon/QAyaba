import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AgentPromptOpts, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";
import { SUBMIT_TOOL, type SubmissionContract, type SubmissionReport } from "@kernel/submission.ts";

const contract: SubmissionContract<Record<string, unknown>> = { tool: SUBMIT_TOOL.PLAN, check: (answer) => ({ ok: true, value: answer as Record<string, unknown> }) };
const PLANNING = { capacity: 5, maxParallel: 2, budgetMs: 180_000, submit: contract };

function planInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: "diff", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", runId: "run-1",
    mode: "diff", appName: "a", planning: PLANNING,
    ...over,
  };
}

type Turn = { output?: string; submission?: SubmissionReport } | { throws: Error };

interface Seen {
  opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }>;
  prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>;
  rendered: OpencodeRunInput[];
  disposed: number;
}

const FANOUT = { kind: "fanout", flows: [{ id: "a", objective: "x" }, { id: "b", objective: "y" }] };
const accepted = (value: Record<string, unknown> = FANOUT, calls = 1): Turn => ({ output: "closing words", submission: { accepted: true, value, calls } });
const missed = (end: "stopped" | "output-length" = "stopped", errors: Array<{ path: string; reason: string }> = []): Turn => ({ output: "", submission: { accepted: false, calls: errors.length, errors, end } });

function build(...turns: Turn[]): { ports: AuthoringPorts; seen: Seen } {
  const seen: Seen = { opened: [], prompts: [], rendered: [], disposed: 0 };
  const queue = [...turns];
  const ports: AuthoringPorts = {
    runtime: {
      openSession: async (role, cwd, opts) => {
        seen.opened.push({ role, cwd, opts });
        return {
          prompt: async (text, promptOpts) => {
            seen.prompts.push({ text, opts: promptOpts });
            const next = queue.shift();
            if (next === undefined) throw new Error("no scripted turn left");
            if ("throws" in next) throw next.throws;
            return { output: next.output ?? "", ...(next.submission ? { submission: next.submission } : {}) };
          },
          dispose: () => { seen.disposed += 1; },
        } satisfies AgentSession;
      },
    },
    rendering: {
      render: () => "",
      renderMain: (input) => { seen.rendered.push(input); return { text: "PLAN_PROMPT", sectionSizes: { task: 1 } }; },
      renderReviewer: () => ({ text: "REVIEW_PROMPT", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => { throw new Error("a planning turn reads no free text"); },
      parseReview: () => ({ approved: true, findings: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
  };
  return { ports, seen };
}

test("a planning turn is one prompt in one lead session bounded by the planning budget, in which the agent may not write, answered through the plan contract", async () => {
  const { ports, seen } = build(accepted());
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.opened.length, 1);
  assert.equal(seen.opened[0]!.role, "lead");
  assert.equal(seen.opened[0]!.cwd, "/m");
  assert.equal(seen.opened[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.opened[0]!.opts?.timeLimit, "plan-budget");
  assert.equal(seen.opened[0]!.opts?.descriptor?.runId, "run-1");
  assert.equal(seen.prompts.length, 1);
  assert.equal(seen.prompts[0]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.prompts[0]!.opts?.timeLimit, "plan-budget");
  assert.equal(seen.prompts[0]!.opts?.submit, contract);
  assert.deepEqual(result.plan, FANOUT);
  assert.equal(result.noSubmission, undefined);
  assert.equal(result.timedOut, false);
});

test("the prompt is the generator's own for this input, with its planning limits", async () => {
  const { ports, seen } = build(accepted());
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.rendered[0]!.planning?.capacity, PLANNING.capacity);
  assert.equal(seen.prompts[0]!.text, "PLAN_PROMPT");
  assert.deepEqual(seen.opened.map((o) => o.role), ["lead"]);
});

test("a turn that delivers a plan keeps its session open for the lead's next turn, read-only and bounded, and closes it once", async () => {
  const { ports, seen } = build(accepted(), accepted({ review: [] }));
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.disposed, 0, "the lead's session outlives the plan");
  assert.ok(result.lead, "the session comes back with the plan");
  const reviewContract: SubmissionContract<Record<string, unknown>> = { tool: SUBMIT_TOOL.FLOW_REVIEW, check: (answer) => ({ ok: true, value: answer as Record<string, unknown> }) };
  const answer = await result.lead.askSubmitting("REVIEW", { timeoutMs: 45_000 }, reviewContract);
  assert.deepEqual(answer, { value: { review: [] }, timedOut: false });
  assert.equal(seen.opened.length, 1, "the next turn is asked in the same session");
  assert.equal(seen.prompts[1]!.text, "REVIEW");
  assert.equal(seen.prompts[1]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[1]!.opts?.timeoutMs, 45_000);
  assert.equal(seen.prompts[1]!.opts?.submit, reviewContract, "the turn is answered through the contract it is asked with, not the plan's");
  await result.lead.dispose();
  await result.lead.dispose();
  assert.equal(seen.disposed, 1);
});

test("a lead's next turn that runs out of its time is reported, not thrown", async () => {
  const { ports } = build(accepted(), { throws: new AgentTimeoutError("timed out") });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.deepEqual(await result.lead!.askSubmitting("REVIEW", { timeoutMs: 1 }, contract), { timedOut: true });
  await result.lead!.dispose();
});

test("a plan turn cut by the output-length limit before its plan closed gets one continuation restricted to the submit tool, and its plan comes back", async () => {
  const { ports, seen } = build(missed("output-length", [{ path: "plan", reason: "the lead delivered no accepted plan" }]), accepted(FANOUT, 1));
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.deepEqual(result.plan, FANOUT);
  assert.equal(result.noSubmission, undefined);
  assert.equal(seen.prompts.length, 2);
  assert.equal(seen.prompts[1]!.opts?.submitOnly, true);
  assert.equal(seen.prompts[1]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.match(seen.prompts[1]!.text, /output-length limit/);
  assert.match(seen.prompts[1]!.text, /the lead delivered no accepted plan/);
  assert.equal(seen.disposed, 0);
});

test("a turn with no accepted plan after its continuation says why, keeps its session, and is not a timed-out turn", async () => {
  const { ports, seen } = build(missed("stopped", [{ path: "flows[0].objective", reason: "objective is missing" }]), missed("stopped"));
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal("plan" in result, false);
  assert.equal(result.timedOut, false);
  assert.match(result.noSubmission!, /no accepted submission/);
  assert.match(result.noSubmission!, /flows\[0\]\.objective: objective is missing/);
  assert.equal(seen.prompts.length, 2, "exactly one continuation");
  assert.equal(seen.disposed, 0, "the session outlives a turn with no plan");
  assert.ok(result.lead);
  await result.lead.dispose();
  assert.equal(seen.disposed, 1);
});

test("a continuation that runs out of the time its purpose is allotted leaves a typed miss, not a timed-out plan turn", async () => {
  const { ports } = build(missed("stopped"), { throws: new AgentTimeoutError("allotment spent") });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(result.timedOut, false);
  assert.match(result.noSubmission!, /continuation ran out of its time/);
});

test("the lead is asked for its plan again through the same contract, in the same session, and a miss there is reported with its reason", async () => {
  const amended = { kind: "fanout", flows: [{ id: "c", objective: "z" }] };
  const { ports, seen } = build(accepted(), accepted(amended), missed("stopped"), missed("stopped"));
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  const again = await result.lead!.askForPlan("amend", { timeoutMs: 5_000 });
  assert.deepEqual(again, { plan: amended, timedOut: false });
  assert.equal(seen.opened.length, 1, "asked in the same session");
  assert.equal(seen.prompts[1]!.text, "amend");
  assert.equal(seen.prompts[1]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[1]!.opts?.submit, contract);
  const miss = await result.lead!.askForPlan("amend", { timeoutMs: 5_000 });
  assert.equal(miss.plan, undefined);
  assert.match(miss.noSubmission!, /no accepted submission/);
  await result.lead!.dispose();
  assert.equal(seen.disposed, 1);
});

test("a turn that runs out of its planning time is reported as such, not thrown, and its session is closed", async () => {
  const { ports, seen } = build({ throws: new AgentTimeoutError("OpenCode prompt: timed out") });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(result.timedOut, true);
  assert.equal("plan" in result, false);
  assert.equal(result.lead, undefined);
  assert.equal(seen.disposed, 1);
});

test("any other failure of the turn is thrown, loudly, and the session is still closed", async () => {
  const { ports, seen } = build({ throws: new AgentUnavailableError("provider down") });
  await assert.rejects(new GenerateTestsUseCase(ports).plan(planInput()), /provider down/);
  assert.equal(seen.disposed, 1);
});

test("asking for a plan of an input that carries no planning limits, or no plan contract, is a mistake, not a plan", async () => {
  const { planning: _, ...withoutPlanning } = planInput();
  await assert.rejects(new GenerateTestsUseCase(build(accepted()).ports).plan(withoutPlanning), /planning/);
  const { submit: __, ...limits } = PLANNING;
  await assert.rejects(new GenerateTestsUseCase(build(accepted()).ports).plan(planInput({ planning: limits })), /planning\.submit/);
});

test("the cancellation of the run reaches the planning session", async () => {
  const { ports, seen } = build(accepted());
  const controller = new AbortController();
  await new GenerateTestsUseCase(ports).plan(planInput(), { signal: controller.signal });
  assert.equal(seen.opened[0]!.opts?.signal, controller.signal);
});

test("the planning session is opened for the lead role, which the roster makes read-only, with no per-prompt tool denial", async () => {
  const { ports, seen } = build(accepted());
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.opened[0]!.role, "lead");
  assert.equal(seen.opened[0]!.opts?.descriptor?.role, "qa-lead");
  assert.equal("denyTools" in (seen.opened[0]!.opts?.descriptor ?? {}), false);
});

test("a follow-up turn of the lead hands the transport the sizes and hashes of the sections it was assembled from", async () => {
  const { ports, seen } = build(accepted(), accepted(), accepted());
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  await result.lead!.askSubmitting("REVIEW", { timeoutMs: 1_000, sectionSizes: { flows: 12 }, sectionHashes: { flows: "abc" } }, contract);
  assert.deepEqual(seen.prompts[1]!.opts?.sectionSizes, { flows: 12 });
  assert.deepEqual(seen.prompts[1]!.opts?.sectionHashes, { flows: "abc" });
  await result.lead!.askSubmitting("PLAN AGAIN", { timeoutMs: 1_000 }, contract);
  assert.equal(seen.prompts[2]!.opts?.sectionSizes, undefined);
  await result.lead!.dispose();
});

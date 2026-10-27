import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type AuthoringPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable } from "@contexts/generation/domain/manifest-repository.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AgentPromptOpts, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

const PLANNING = { maxFlows: 5, maxParallel: 2, budgetMs: 180_000 };

function planInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: "diff", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", runId: "run-1",
    target: "e2e", mode: "diff", appName: "a", planning: PLANNING,
    ...over,
  };
}

interface Seen {
  opened: Array<{ role: AgentRole; cwd: string; opts: OpenSessionOpts | undefined }>;
  prompts: Array<{ text: string; opts: AgentPromptOpts | undefined }>;
  rendered: OpencodeRunInput[];
  parsedWith: Array<{ text: string; specDir: string | undefined }>;
  disposed: number;
}

function build(step: { output: string } | { throws: Error }, deliverable: GeneratorDeliverable): { ports: AuthoringPorts; seen: Seen } {
  const seen: Seen = { opened: [], prompts: [], rendered: [], parsedWith: [], disposed: 0 };
  const ports: AuthoringPorts = {
    runtime: {
      openSession: async (role, cwd, opts) => {
        seen.opened.push({ role, cwd, opts });
        return {
          prompt: async (text, promptOpts) => {
            seen.prompts.push({ text, opts: promptOpts });
            if ("throws" in step) throw step.throws;
            return { output: step.output };
          },
          dispose: () => { seen.disposed += 1; },
        };
      },
    },
    rendering: {
      render: () => "",
      renderMain: (input) => { seen.rendered.push(input); return { text: "PLAN_PROMPT", sectionSizes: { task: 1 } }; },
      renderReviewer: () => ({ text: "REVIEW_PROMPT", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text, specDir) => { seen.parsedWith.push({ text, specDir }); return deliverable; },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
  };
  return { ports, seen };
}

const FANOUT = { kind: "fanout", flows: [{ id: "a", objective: "x" }, { id: "b", objective: "y" }] };

test("a planning turn is one prompt in one generator session bounded by the planning budget, in which the agent may not write", async () => {
  const { ports, seen } = build({ output: '{"plan":{}}' }, { specs: [], parsed: true, plan: FANOUT });
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.opened.length, 1);
  assert.equal(seen.opened[0]!.role, "lead");
  assert.equal(seen.opened[0]!.cwd, "/m");
  assert.equal(seen.opened[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.opened[0]!.opts?.descriptor?.runId, "run-1");
  assert.equal(seen.prompts.length, 1);
  assert.equal(seen.prompts[0]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.prompts[0]!.opts?.finalStepOnly, true);
});

test("a turn that comes back with a plan keeps its session open for the lead's next turn, read-only and bounded, and closes it once", async () => {
  const { ports, seen } = build({ output: "the plan" }, { specs: [], parsed: true, plan: FANOUT });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.disposed, 0, "the lead's session outlives the plan");
  assert.ok(result.lead, "the session comes back with the plan");
  const answer = await result.lead.ask("REVIEW", { timeoutMs: 45_000 });
  assert.deepEqual(answer, { output: "the plan", timedOut: false });
  assert.equal(seen.opened.length, 1, "the next turn is asked in the same session");
  assert.equal(seen.prompts[1]!.text, "REVIEW");
  assert.equal(seen.prompts[1]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[1]!.opts?.timeoutMs, 45_000);
  await result.lead.dispose();
  await result.lead.dispose();
  assert.equal(seen.disposed, 1);
});

test("a lead's next turn that runs out of its time is reported, not thrown", async () => {
  let calls = 0;
  const { ports } = build({ output: "the plan" }, { specs: [], parsed: true, plan: FANOUT });
  const open = ports.runtime.openSession;
  ports.runtime = { openSession: async (role, cwd, opts) => {
    const session = await open(role, cwd, opts);
    return { prompt: async (text, o) => { calls += 1; if (calls > 1) throw new AgentTimeoutError("timed out"); return session.prompt(text, o); }, dispose: session.dispose };
  } };
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.deepEqual(await result.lead!.ask("REVIEW", { timeoutMs: 1 }), { output: "", timedOut: true });
  await result.lead!.dispose();
});

test("a turn that comes back without a plan closes its session at once", async () => {
  const { ports, seen } = build({ output: "noop" }, { specs: [], parsed: true, noopReason: "nothing" });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(result.lead, undefined);
  assert.equal(seen.disposed, 1);
});

test("the prompt is the generator's own for this input, with its planning limits", async () => {
  const { ports, seen } = build({ output: "x" }, { specs: [], parsed: true, plan: FANOUT });
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.rendered[0]!.planning?.maxFlows, PLANNING.maxFlows);
  assert.equal(seen.prompts[0]!.text, "PLAN_PROMPT");
});

test("the plan the verdict carried comes back as it was read, for the orchestrator to judge, and the reviewer is never opened", async () => {
  const { ports, seen } = build({ output: "the plan" }, { specs: [], parsed: true, plan: FANOUT });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.deepEqual(result.plan, FANOUT);
  assert.equal(result.parsed, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(seen.opened.map((o) => o.role), ["lead"]);
  assert.deepEqual(seen.parsedWith[0], { text: "the plan", specDir: "/m/e2e" });
});

test("a turn that declares a no-op instead of a plan returns the reason, and no plan", async () => {
  const { ports } = build({ output: "noop" }, { specs: [], parsed: true, noopReason: "nothing here is worth a test" });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(result.noopReason, "nothing here is worth a test");
  assert.equal("plan" in result, false);
});

test("a turn that gives neither a plan nor a reason, or none that can be read, comes back without either", async () => {
  const empty = await new GenerateTestsUseCase(build({ output: "…" }, { specs: [], parsed: true }).ports).plan(planInput());
  assert.equal("plan" in empty, false);
  assert.equal("noopReason" in empty, false);
  assert.equal(empty.parsed, true);
  const unreadable = await new GenerateTestsUseCase(build({ output: "…" }, { specs: [], parsed: false }).ports).plan(planInput());
  assert.equal(unreadable.parsed, false);
});

test("a turn that ran out of its planning time is reported as such, not thrown, and its session is closed", async () => {
  const { ports, seen } = build({ throws: new AgentTimeoutError("OpenCode prompt: timed out") }, { specs: [], parsed: false });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(result.timedOut, true);
  assert.equal("plan" in result, false);
  assert.equal(seen.disposed, 1);
});

test("any other failure of the turn is thrown, loudly, and the session is still closed", async () => {
  const { ports, seen } = build({ throws: new AgentUnavailableError("provider down") }, { specs: [], parsed: false });
  await assert.rejects(new GenerateTestsUseCase(ports).plan(planInput()), /provider down/);
  assert.equal(seen.disposed, 1);
});

test("asking for a plan of an input that carries no planning limits is a mistake, not a plan", async () => {
  const { ports } = build({ output: "x" }, { specs: [], parsed: true });
  const { planning: _, ...withoutPlanning } = planInput();
  await assert.rejects(new GenerateTestsUseCase(ports).plan(withoutPlanning), /planning/);
});

test("the cancellation of the run reaches the planning session", async () => {
  const { ports, seen } = build({ output: "x" }, { specs: [], parsed: true, plan: FANOUT });
  const controller = new AbortController();
  await new GenerateTestsUseCase(ports).plan(planInput(), { signal: controller.signal });
  assert.equal(seen.opened[0]!.opts?.signal, controller.signal);
});

test("the planning session is opened for the lead role, which the roster makes read-only, with no per-prompt tool denial", async () => {
  const { ports, seen } = build({ output: '{"plan":{}}' }, { specs: [], parsed: true, plan: FANOUT });
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.opened[0]!.role, "lead");
  assert.equal(seen.opened[0]!.opts?.descriptor?.role, "qa-lead");
  assert.equal("denyTools" in (seen.opened[0]!.opts?.descriptor ?? {}), false);
});

test("a turn that asks to explore keeps its session open and the lead's answer to the findings is read as a planning turn", async () => {
  const { ports, seen } = build({ output: "the answer" }, { specs: [], parsed: true });
  const deliverables: GeneratorDeliverable[] = [{ specs: [], parsed: true, explore: [{ id: "cart", question: "what shows?" }] }, { specs: [], parsed: true, plan: FANOUT }, { specs: [], parsed: true, explore: [{ id: "again", question: "more?" }] }, { specs: [], parsed: false }];
  let read = 0;
  ports.verdicts.parseGenerator = (text, specDir) => { seen.parsedWith.push({ text, specDir }); return deliverables[read++]!; };
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  assert.deepEqual(result.explore, [{ id: "cart", question: "what shows?" }]);
  assert.equal("plan" in result, false);
  assert.equal(seen.disposed, 0, "the session outlives the request: the lead is asked again in it");
  const second = await result.lead!.askForPlan("findings", { timeoutMs: 5_000 });
  assert.deepEqual(second, { plan: FANOUT, parsed: true, timedOut: false });
  assert.equal(seen.opened.length, 1, "asked in the same session");
  assert.equal(seen.prompts[1]!.text, "findings");
  assert.equal(seen.prompts[1]!.opts?.withoutWrites, true);
  const again = await result.lead!.askForPlan("findings", { timeoutMs: 5_000 });
  assert.equal(again.explore?.length, 1, "a second request is reported as one, for the orchestrator to refuse");
  const unreadable = await result.lead!.askForPlan("findings", { timeoutMs: 5_000 });
  assert.equal(unreadable.parsed, false);
  await result.lead!.dispose();
  assert.equal(seen.disposed, 1);
});

test("a follow-up turn of the lead hands the transport the sizes and hashes of the sections it was assembled from", async () => {
  const { ports, seen } = build({ output: "the plan" }, { specs: [], parsed: true, plan: FANOUT });
  const result = await new GenerateTestsUseCase(ports).plan(planInput());
  await result.lead!.ask("REVIEW", { timeoutMs: 1_000, sectionSizes: { flows: 12 }, sectionHashes: { flows: "abc" } });
  assert.deepEqual(seen.prompts[1]!.opts?.sectionSizes, { flows: 12 });
  assert.deepEqual(seen.prompts[1]!.opts?.sectionHashes, { flows: "abc" });
  await result.lead!.ask("PLAN AGAIN", { timeoutMs: 1_000 });
  assert.equal(seen.prompts[2]!.opts?.sectionSizes, undefined);
  await result.lead!.dispose();
});

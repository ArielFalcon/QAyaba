import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable, ManifestEntry } from "@contexts/generation/application/ports/index.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AgentPromptOpts, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

const PLANNING = { maxFlows: 5, maxParallel: 2, budgetMs: 180_000 };

function planInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: "diff", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", runId: "run-1",
    needsReview: true, target: "e2e", mode: "diff", appName: "a", planning: PLANNING,
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

function build(step: { output: string } | { throws: Error }, deliverable: GeneratorDeliverable): { ports: GenerationPorts; seen: Seen } {
  const seen: Seen = { opened: [], prompts: [], rendered: [], parsedWith: [], disposed: 0 };
  const ports: GenerationPorts = {
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
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text, specDir) => { seen.parsedWith.push({ text, specDir }); return deliverable; },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  };
  return { ports, seen };
}

const FANOUT = { kind: "fanout", flows: [{ id: "a", objective: "x" }, { id: "b", objective: "y" }] };

test("a planning turn is one prompt in one generator session bounded by the planning budget, in which the agent may not write", async () => {
  const { ports, seen } = build({ output: '{"plan":{}}' }, { specs: [], parsed: true, plan: FANOUT });
  await new GenerateTestsUseCase(ports).plan(planInput());
  assert.equal(seen.opened.length, 1);
  assert.equal(seen.opened[0]!.role, "primary");
  assert.equal(seen.opened[0]!.cwd, "/m");
  assert.equal(seen.opened[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.opened[0]!.opts?.descriptor?.runId, "run-1");
  assert.equal(seen.prompts.length, 1);
  assert.equal(seen.prompts[0]!.opts?.withoutWrites, true);
  assert.equal(seen.prompts[0]!.opts?.timeoutMs, PLANNING.budgetMs);
  assert.equal(seen.prompts[0]!.opts?.finalStepOnly, true);
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
  assert.deepEqual(seen.opened.map((o) => o.role), ["primary"]);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { DIFF_TIME_BUDGET_MS } from "@kernel/diff-stat.ts";
import { AgentUnavailableError } from "@kernel/domain-error.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

const TINY_DIFF = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "+line", ""].join("\n");
const PROMPT_CAP_MS = 900_000;

type Step = { output: string } | { throws: Error };

interface Harness {
  opened: Array<{ role: AgentRole; opts: OpenSessionOpts | undefined }>;
  prompts: Array<{ session: number; text: string; timeoutMs: number | undefined }>;
  disposed: number[];
  renders: Array<{ continuation: boolean }>;
}

function baseInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/demo", sha: "abc", diff: TINY_DIFF, mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
    target: "e2e", mode: "diff", appName: "a",
    ...over,
  };
}

const regenInput = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput =>
  baseInput({ fixCases: [{ name: "flows/a.spec.ts › opens", status: "fail", detail: "locator not found" }], ...over });

function build(steps: Step[], opts: { continuesSessions?: boolean; promptCapMs?: number } = {}): { ports: GenerationPorts; seen: Harness } {
  const seen: Harness = { opened: [], prompts: [], disposed: [], renders: [] };
  const queue = [...steps];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role, _cwd, sessionOpts) => {
        seen.opened.push({ role, opts: sessionOpts });
        const id = seen.opened.length;
        return {
          prompt: async (text, promptOpts) => {
            seen.prompts.push({ session: id, text, timeoutMs: promptOpts?.timeoutMs });
            const step = queue.shift() ?? { output: "" };
            if ("throws" in step) throw step.throws;
            return { output: step.output };
          },
          dispose: () => { seen.disposed.push(id); },
        };
      },
    },
    rendering: {
      render: () => "",
      renderMain: (_input, renderOpts) => {
        const continuation = renderOpts?.continuation === true;
        seen.renders.push({ continuation });
        return { text: continuation ? "CONTINUATION" : "FULL", sectionSizes: {} };
      },
      renderReviewer: () => ({ text: "REVIEW_PROMPT", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text) => (text.includes("SPECS") ? { specs: ["flows/a.spec.ts"], parsed: true } : { specs: [], parsed: false }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [], parsed: true }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    ...(opts.continuesSessions !== undefined ? { continuesSessions: () => opts.continuesSessions as boolean } : {}),
    ...(opts.promptCapMs !== undefined ? { promptCapMs: opts.promptCapMs } : {}),
  };
  return { ports, seen };
}

test("a regeneration continues the first pass's generator session with the continuation prompt, and the session lives until the run releases it", async () => {
  const { ports, seen } = build([{ output: "SPECS" }, { output: "SPECS" }, { output: "SPECS" }], { continuesSessions: true, promptCapMs: PROMPT_CAP_MS });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.generate(baseInput());
  await useCase.generate(regenInput());
  await useCase.generate(baseInput({ reviewCorrections: ["the assertion checks the wrong total"] }));

  assert.equal(seen.opened.length, 1, "one generator session for the whole run");
  assert.deepEqual(seen.prompts.map((p) => [p.session, p.text]), [[1, "FULL"], [1, "CONTINUATION"], [1, "CONTINUATION"]]);
  assert.deepEqual(seen.disposed, [], "the session stays open between regenerations");

  await useCase.releaseSession();
  assert.deepEqual(seen.disposed, [1]);
  await useCase.releaseSession();
  assert.deepEqual(seen.disposed, [1], "releasing twice disposes once");
});

test("a runtime that does not keep a conversation gets the full prompt in a fresh session on every regeneration", async () => {
  for (const continuesSessions of [false, undefined]) {
    const { ports, seen } = build([{ output: "SPECS" }, { output: "SPECS" }], continuesSessions === undefined ? {} : { continuesSessions });
    const useCase = new GenerateTestsUseCase(ports);

    await useCase.generate(baseInput());
    await useCase.generate(regenInput());

    assert.equal(seen.opened.length, 2, String(continuesSessions));
    assert.deepEqual(seen.prompts.map((p) => p.text), ["FULL", "FULL"], String(continuesSessions));
    assert.deepEqual(seen.disposed, [1, 2], String(continuesSessions));
  }
});

test("a regeneration with no session to continue opens one with the full prompt, and the next regeneration continues it", async () => {
  const { ports, seen } = build([{ output: "SPECS" }, { output: "SPECS" }], { continuesSessions: true });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.generate(regenInput());
  await useCase.generate(regenInput());

  assert.equal(seen.opened.length, 1);
  assert.deepEqual(seen.prompts.map((p) => p.text), ["FULL", "CONTINUATION"]);
});

test("a regeneration in a session first opened under a tier budget runs under the host's prompt deadline, not what is left of that budget", async () => {
  const { ports, seen } = build([{ output: "SPECS" }, { output: "SPECS" }], { continuesSessions: true, promptCapMs: PROMPT_CAP_MS });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.generate(baseInput());
  await useCase.generate(regenInput());

  assert.equal(seen.opened[0]?.opts?.timeoutMs, DIFF_TIME_BUDGET_MS.tiny, "the first pass is the tier-bound one");
  assert.equal(seen.prompts[1]?.timeoutMs, PROMPT_CAP_MS);
});

test("a tier-bound first pass on a host that states no prompt deadline is not continued: a regeneration could only inherit the tier budget", async () => {
  const { ports, seen } = build([{ output: "SPECS" }, { output: "SPECS" }], { continuesSessions: true });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.generate(baseInput());
  await useCase.generate(regenInput());

  assert.equal(seen.opened.length, 2);
  assert.deepEqual(seen.disposed, [1]);
  assert.deepEqual(seen.prompts.map((p) => p.text), ["FULL", "FULL"]);
});

test("a continued session whose prompt throws is disposed and forgotten: the error propagates and the next regeneration opens a fresh session", async () => {
  const fault = new AgentUnavailableError("the session is gone");
  const { ports, seen } = build([{ output: "SPECS" }, { throws: fault }, { output: "SPECS" }], { continuesSessions: true, promptCapMs: PROMPT_CAP_MS });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.generate(baseInput());
  await assert.rejects(useCase.generate(regenInput()), (err) => err === fault);
  assert.deepEqual(seen.disposed, [1]);

  await useCase.generate(regenInput());
  assert.equal(seen.opened.length, 2);
  assert.deepEqual(seen.prompts.map((p) => [p.session, p.text]), [[1, "FULL"], [1, "CONTINUATION"], [2, "FULL"]]);
});

test("a planning turn never leaves a session for a regeneration to continue", async () => {
  const { ports, seen } = build([{ output: "PLAN" }, { output: "SPECS" }], { continuesSessions: true });
  const useCase = new GenerateTestsUseCase(ports);

  await useCase.plan(baseInput({ planning: { budgetMs: 60_000, maxFlows: 3 } } as Partial<OpencodeRunInput>));
  await useCase.generate(regenInput());

  assert.deepEqual(seen.disposed.includes(1), true);
  assert.equal(seen.opened.length, 2);
  assert.equal(seen.prompts[1]?.text, "FULL");
});

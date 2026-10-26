import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/generation-input.ts";
import { REPAIR_TURN_TIMEOUT_MS } from "@contexts/generation/domain/repair-turn.ts";
import { AgentTimeoutError, AgentUnavailableError } from "@kernel/domain-error.ts";
import type { AgentPromptOpts } from "@kernel/ports/agent-runtime.port.ts";

const INPUT: OpencodeRunInput = {
  repo: "r", sha: "s", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns",
  needsReview: true, target: "e2e", mode: "diff", appName: "a",
};

function build(reviewerRepair: () => Promise<{ output: string }>) {
  const reviewerPrompts: Array<{ text: string; opts?: AgentPromptOpts }> = [];
  let reviewParses = 0;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role) => ({
        prompt: async (text, opts) => {
          if (role !== "reviewer") return { output: "SPECS" };
          reviewerPrompts.push({ text, ...(opts ? { opts } : {}) });
          return reviewerPrompts.length === 1 ? { output: "garbled" } : reviewerRepair();
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "GEN", sectionSizes: {} }),
      renderReviewer: () => ({ text: "REV", sectionSizes: {} }),
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/a.spec.ts"], parsed: true }),
      parseReview: (text) => {
        reviewParses++;
        return text === "garbled"
          ? { approved: false, corrections: [], valid: false, issues: ["not json"], parsed: false }
          : { approved: true, corrections: [], valid: true, issues: [], parsed: true };
      },
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
    repair: { checkGenerator: () => ({ valid: true, issues: [] }), instruction: (kind) => `REPAIR ${kind}` },
  };
  return { ports, reviewerPrompts, parses: () => reviewParses };
}

test("the reviewer's contract-repair prompt runs with no tools and under the repair cap, and the review prompt it repairs does not", async () => {
  const { ports, reviewerPrompts } = build(async () => ({ output: "fixed" }));
  const result = await new GenerateTestsUseCase(ports).generate(INPUT);
  assert.equal(result.approved, true);
  assert.equal(reviewerPrompts[0]?.opts?.withoutTools, undefined);
  assert.equal(reviewerPrompts[1]?.opts?.withoutTools, true);
  assert.equal(reviewerPrompts[1]?.opts?.timeoutMs, REPAIR_TURN_TIMEOUT_MS);
});

test("a reviewer repair that ran past its own cap leaves the review unreadable and fails closed on it, without raising", async () => {
  const { ports } = build(async () => { throw new AgentTimeoutError("timed out"); });
  const result = await new GenerateTestsUseCase(ports).generate(INPUT);
  assert.equal(result.reviewed, true);
  assert.equal(result.approved, false, "an unreadable review is never an approval");
});

test("a reviewer repair that fails for any other reason is still the integration error it is", async () => {
  const { ports } = build(async () => { throw new AgentUnavailableError("provider rejected the request"); });
  await assert.rejects(new GenerateTestsUseCase(ports).generate(INPUT), AgentUnavailableError);
});

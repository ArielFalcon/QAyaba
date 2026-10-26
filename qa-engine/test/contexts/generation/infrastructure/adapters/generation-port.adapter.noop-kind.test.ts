/* The kind of a declared no-op reaches the run through the generation port. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationPortAdapter } from "@contexts/generation/infrastructure/adapters/generation-port.adapter.ts";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GeneratorDeliverable } from "@contexts/generation/domain/manifest-repository.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { NOOP_KIND } from "@kernel/noop-kind.ts";

function portsReturning(deliverable: GeneratorDeliverable): GenerationPorts {
  return {
    runtime: { openSession: async () => ({ prompt: async () => ({ output: "verdict" }), dispose: async () => {} }) } as unknown as GenerationPorts["runtime"],
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "prompt", sectionSizes: {} }),
      renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
      specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => deliverable,
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_dir, entries) => [...entries] },
    budget: { capDiff: (d: string) => d, capText: (t: string) => t, budgetForRole: () => 1000 },
  };
}

const CONTEXT = {
  repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234", target: "e2e" as const, mode: "diff" as const, diff: "", needsReview: false,
};

test("the port reports the kind of a declared no-op", async () => {
  const adapter = new GenerationPortAdapter(
    new GenerateTestsUseCase(portsReturning({ specs: [], parsed: true, noopReason: "no rows on DEV: the end-of-list button never rendered", noopKind: NOOP_KIND.UNOBSERVABLE })),
    CONTEXT,
  );
  const result = await adapter.generate("/mirrors/org/app/e2e");
  assert.equal(result.end, GENERATION_END.DECLARED_NOOP);
  assert.equal(result.noopKind, NOOP_KIND.UNOBSERVABLE);
});

test("the port reports no kind for a generation that delivered specs", async () => {
  const adapter = new GenerationPortAdapter(new GenerateTestsUseCase(portsReturning({ specs: ["flows/list.spec.ts"], parsed: true })), CONTEXT);
  const result = await adapter.generate("/mirrors/org/app/e2e");
  assert.equal("noopKind" in result, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase, type GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import { AUTHOR_SIDEKICK } from "@kernel/sidekick-session.ts";
import type { ManifestEntry } from "@kernel/manifest/manifest-entry.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type { OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts";

interface Opened { role: AgentRole; cwd: string; opts?: OpenSessionOpts }

function author(): { turn(): Promise<unknown>; opened: Opened[]; disposed: () => number } {
  const opened: Opened[] = [];
  let disposed = 0;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role, cwd, opts) => {
        opened.push({ role, cwd, ...(opts ? { opts } : {}) });
        return { prompt: async () => ({ output: '{"specs":["flows/a.spec.ts"]}' }), dispose: () => { disposed++; } };
      },
    },
    rendering: { render: () => "", renderMain: () => ({ text: "MAIN", sectionSizes: {} }), renderReviewer: () => ({ text: "", sectionSizes: {} }), specFileForFlow: (f) => `flows/${f}.spec.ts` },
    verdicts: {
      parseGenerator: (text) => ({ specs: ["flows/a.spec.ts"], parsed: true, outputTail: text }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: { read: async () => [], reconcile: async (_d, e) => [...e] as ManifestEntry[] },
    budget: { capDiff: (d) => d, capText: (t) => t, budgetForRole: () => 0 },
  };
  const useCase = new GenerateTestsUseCase(ports);
  return {
    turn: () => useCase.author({ repo: "org/demo", sha: "abc1234", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", target: "e2e", mode: "diff", appName: "a", runId: "run-1" }),
    opened,
    disposed: () => disposed,
  };
}

test("every authoring turn opens a fresh author sidekick session and disposes it", async () => {
  const a = author();
  await a.turn();
  await a.turn();

  assert.equal(a.opened.length, 2, "no session is carried from one turn to the next");
  for (const o of a.opened) {
    assert.equal(o.role, AUTHOR_SIDEKICK.role);
    assert.equal(o.opts?.descriptor?.role, AUTHOR_SIDEKICK.agent);
  }
  assert.equal(a.disposed(), 2);
});

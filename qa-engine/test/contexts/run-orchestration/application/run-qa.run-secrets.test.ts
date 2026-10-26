/* A run is the unit that owns its test account's secrets: it opens the scope they are registered into, the scope reaches every step the run takes, and it ends with the run. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { activeRunSecretScope, redactByValue, type RunSecretScope } from "../../../../src/shared-infrastructure/run-secret-redaction.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";

const SECRET = "account-secret-7731";

async function runOnce(runId: string, observe: { atGenerate?: RunSecretScope | undefined; atExecute?: string }): Promise<void> {
  const ws = runWorkspace("qa-run-secrets-");
  try {
    const useCase = new RunQaUseCase({
      changeAnalysis: {
        classify: async () => ({
          action: "generate",
          reason: "diff touches many files",
          diff: "x",
          intent: { type: "feat", breaking: false, message: "cover checkout", changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
          contradiction: true,
        }),
      },
      generation: generationOnDisk({
        generate: async () => {
          observe.atGenerate = activeRunSecretScope();
          activeRunSecretScope()?.addAccountSecrets([SECRET]);
          return scriptedGeneration({ specs: ["a.spec.ts"], declaredSpecs: [{ file: "a.spec.ts", flow: "f", objective: "o" }], approved: true });
        },
      }),
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => ({ ok: true, errors: [] }) },
      execution: {
        execute: async () => {
          observe.atExecute = redactByValue(`logged in with ${SECRET}`);
          return { verdict: "pass", cases: [], logs: "" };
        },
      },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: fakeWorkspace(ws),
      suiteStore: ws.suiteStore,
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async () => {} },
      setup: { setup: async () => {} },
      cleanup: { cleanup: async () => {} },
      config: { needsReview: false },
    });
    await useCase.run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId });
  } finally {
    ws.cleanup();
  }
}

test("every step of a run sees the run's scope, a secret registered in one step is redacted in the next, and the scope ends with the run", async () => {
  const observed: { atGenerate?: RunSecretScope | undefined; atExecute?: string } = {};
  await runOnce("secrets-1", observed);
  assert.ok(observed.atGenerate, "the scope is open while the run generates");
  assert.equal(observed.atExecute, `logged in with ${REDACTED}`);
  assert.equal(activeRunSecretScope(), undefined);
});

test("two runs never share a scope: the second does not redact the first's secrets", async () => {
  const first: { atGenerate?: RunSecretScope | undefined; atExecute?: string } = {};
  const second: { atGenerate?: RunSecretScope | undefined; atExecute?: string } = {};
  await runOnce("secrets-a", first);
  await runOnce("secrets-b", second);
  assert.notEqual(first.atGenerate, second.atGenerate);
});

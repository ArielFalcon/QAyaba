/* A run owns the sandbox its agent-influenced code runs in: the scope is open for every step and is gone when the run ends, however it ends. A run in which the launcher refused to start agent code ends as an infra-error of its own class, whichever step met the refusal, and never teaches the engine. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { ERROR_CLASS } from "@contexts/qa-run-orchestration/domain/helpers/error-class.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { createExecSandbox, SandboxUnavailableError } from "../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, type ExecScopePort } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { createExecScopeProvider } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope-provider.ts";

async function runWith(options: { execScope?: ExecScopePort; execute: () => Promise<{ verdict: "pass"; cases: []; logs: string }> }): Promise<{ saved: RunOutcome[]; threw?: unknown }> {
  const mirror = mkdtempSync(join(tmpdir(), "qa-run-exec-scope-"));
  const specDir = join(mirror, "e2e");
  mkdirSync(specDir, { recursive: true });
  const saved: RunOutcome[] = [];
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
      generation: { generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], declaredSpecs: [{ file: "a.spec.ts", flow: "f", objective: "o" }], approved: true }) },
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => ({ ok: true, errors: [] }) },
      execution: { execute: options.execute },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: { prepare: async () => ({ specDir, mirrorDir: mirror }) },
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async (outcome: RunOutcome) => { saved.push(outcome); } },
      setup: { setup: async () => {} },
      cleanup: { cleanup: async () => {} },
      config: { needsReview: false },
      ...(options.execScope ? { execScope: options.execScope } : {}),
    });
    try {
      await useCase.run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "run-exec-scope" });
    } catch (threw) {
      return { saved, threw };
    }
    return { saved };
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

function provider(root: string, sandbox = null): ExecScopePort {
  return createExecScopeProvider({ workRoot: root, sandbox, egress: { dev: [], install: [] } });
}

test("the scope is open while the run executes and its work dir is gone when the run ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  let workDir: string | undefined;
  try {
    await runWith({ execScope: provider(root), execute: async () => { workDir = activeExecScope()?.workDir; return { verdict: "pass", cases: [], logs: "" }; } });
    assert.ok(workDir !== undefined && workDir.startsWith(root), "the run executed inside a scope whose work dir is below the root");
    assert.equal(activeExecScope(), undefined);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(workDir), false, "the work dir was removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the work dir is removed when the run throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  let workDir: string | undefined;
  try {
    const out = await runWith({ execScope: provider(root), execute: async () => { workDir = activeExecScope()?.workDir; throw new Error("boom"); } });
    assert.ok(out.threw !== undefined || out.saved.length > 0);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(workDir!), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run in which the launcher refused to start agent code ends E-SANDBOX, not E-INFRA", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  try {
    const exec = createExecSandbox({ sandbox: null, mode: "required", baseEnv: {}, warn: () => {} });
    const out = await runWith({
      execScope: provider(root),
      execute: async () => {
        try {
          exec.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite" });
        } catch (err) {
          assert.ok(err instanceof SandboxUnavailableError);
          throw err;
        }
        return { verdict: "pass", cases: [], logs: "" };
      },
    });
    const outcome = out.saved.at(-1);
    assert.ok(outcome, "the run persisted an outcome");
    assert.equal(outcome.verdict, "infra-error");
    assert.equal(outcome.errorClass, ERROR_CLASS.SANDBOX);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose sandbox scope cannot be opened because a survivor holds the sandbox uid ends E-SANDBOX without running anything", async () => {
  let executed = false;
  const refusing: ExecScopePort = { open: async () => { throw new SandboxUnavailableError("residue", "the run cannot start: 1 process(es) of the sandbox uid survived SIGKILL"); } };
  const out = await runWith({ execScope: refusing, execute: async () => { executed = true; return { verdict: "pass", cases: [], logs: "" }; } });
  assert.equal(out.threw, undefined);
  assert.equal(executed, false);
  const outcome = out.saved.at(-1);
  assert.ok(outcome, "the run persisted an outcome");
  assert.equal(outcome.verdict, "infra-error");
  assert.equal(outcome.errorClass, ERROR_CLASS.SANDBOX);
});

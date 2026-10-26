/* A run owns the sandbox its agent-influenced code runs in: the scope is open for every step and is gone when the run ends, however it ends. A run in which the launcher refused to start agent code ends as an infra-error of its own class, whichever step met the refusal, and never teaches the engine. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RunQaUseCase } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ObserverPort } from "@contexts/run-orchestration/application/ports/observer.port.ts";
import { ERROR_CLASS } from "@contexts/cross-run-learning/domain/error-class.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { createExecSandbox, SandboxUnavailableError } from "../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, type ExecScopePort } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { createExecScopeProvider } from "../../../../src/shared-infrastructure/process-sandbox/exec-scope-provider.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

async function runWith(options: { execScope?: ExecScopePort; observer?: ObserverPort; execute: () => Promise<{ verdict: "pass"; cases: []; logs: string }> }): Promise<{ saved: RunOutcome[]; threw?: unknown }> {
  const ws = runWorkspace("qa-run-exec-scope-");
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
      generation: generationOnDisk({ generate: async () => scriptedGeneration({ specs: ["a.spec.ts"], declaredSpecs: [{ file: "a.spec.ts", flow: "f", objective: "o" }], approved: true }) }),
      review: { review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }) },
      validation: { validate: async () => ({ ok: true, errors: [] }) },
      execution: { execute: options.execute },
      objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
      publication: { publish: async () => ({ outcome: "pr" }) },
      learning: { fold: async () => {}, retrieve: async () => [] },
      workspace: fakeWorkspace(ws),
      specFiles: confinedSpecFiles,
      suiteStore: ws.suiteStore,
      deployGate: { waitUntilServing: async () => ok(true) },
      runHistory: { save: async (outcome: RunOutcome) => { saved.push(outcome); } },
      setup: { setup: async () => {} },
      cleanup: { cleanup: async () => {} },
      config: { needsReview: false },
      ...(options.execScope ? { execScope: options.execScope } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
    });
    try {
      await useCase.run({ app: "demo", sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "run-exec-scope" });
    } catch (threw) {
      return { saved, threw };
    }
    return { saved };
  } finally {
    ws.cleanup();
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

/* What the egress filter records while a child runs: the scope's report fills in as hosts are refused. */
function refuseHosts(...hosts: string[]): void {
  const report = activeExecScope()!.report;
  report.egress = "enforced";
  report.denied.push(...hosts);
}

test("a run that dies on an agent error after a child was refused hosts still persists which hosts, and the error still reaches the caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  try {
    const failure = new Error("provider error");
    const out = await runWith({
      execScope: provider(root),
      execute: async () => {
        refuseHosts("idp.example.test", "cdn.example.test");
        throw failure;
      },
    });
    assert.equal(out.threw, failure, "the shell still sees the error that ended the run");
    const outcome = out.saved.at(-1);
    assert.ok(outcome, "the run persisted an outcome");
    assert.equal(outcome.verdict, "infra-error");
    assert.deepEqual(outcome.gateSignals.sandbox, { egress: "enforced", denied: ["idp.example.test", "cdn.example.test"] });
    assert.equal(outcome.gateSignals.coverageRatio, null, "no other signal is made up for a run that never reached it");
    assert.equal(outcome.gateSignals.valueScore, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that dies on an error having started no sandboxed child persists nothing of its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  try {
    const out = await runWith({ execScope: provider(root), execute: async () => { throw new Error("provider error"); } });
    assert.ok(out.threw instanceof Error);
    assert.deepEqual(out.saved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that ends E-SANDBOX or on a verdict persists the hosts it was refused too", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  try {
    const exec = createExecSandbox({ sandbox: null, mode: "required", baseEnv: {}, warn: () => {} });
    const out = await runWith({
      execScope: provider(root),
      execute: async () => {
        refuseHosts("idp.example.test");
        exec.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite" });
        return { verdict: "pass", cases: [], logs: "" };
      },
    });
    const outcome = out.saved.at(-1);
    assert.equal(outcome?.errorClass, ERROR_CLASS.SANDBOX);
    assert.deepEqual(outcome?.gateSignals.sandbox?.denied, ["idp.example.test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function loggingObserver(lines: string[]): ObserverPort {
  return { onStep: () => {}, onEvent: (event) => { if (event.type === "log.line") lines.push(event.text); } };
}

test("the end of a run says which hosts the egress filter refused, once, and says nothing when none were", async () => {
  const root = mkdtempSync(join(tmpdir(), "qa-run-exec-root-"));
  try {
    const lines: string[] = [];
    await runWith({
      execScope: provider(root),
      observer: loggingObserver(lines),
      execute: async () => {
        refuseHosts("idp.example.test", "cdn.example.test");
        return { verdict: "pass", cases: [], logs: "" };
      },
    });
    const said = lines.filter((l) => l.includes("sandbox: egress denied"));
    assert.equal(said.length, 1);
    assert.match(said[0]!, /denied 2 host\(s\): idp\.example\.test, cdn\.example\.test/);

    const quiet: string[] = [];
    await runWith({ execScope: provider(root), observer: loggingObserver(quiet), execute: async () => ({ verdict: "pass", cases: [], logs: "" }) });
    assert.deepEqual(quiet.filter((l) => l.includes("sandbox: egress denied")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

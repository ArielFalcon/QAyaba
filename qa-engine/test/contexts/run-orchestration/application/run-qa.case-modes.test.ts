/* A case's declared mode decides what its bytes prove, for every app and on every pass. These cases drive the whole run (RunQaUseCase over fakes and a real working copy) with executions that report a spec file whose tests were skipped or are all marked test.fail(): the file has no real passing case, so its bytes are not proven, are not admitted to the suite store and are not published. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ExecutionPort } from "@contexts/test-execution/application/index.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { generationOnDisk, runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";

const INPUT: RunQaInput = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "modes-run" };

const files = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

const caseOf = (file: string, over: Partial<QaCase> = {}): QaCase => ({ name: `${file} › works`, status: "pass", expectedStatus: "passed", file, ...over });

type Reported = Awaited<ReturnType<ExecutionPort["execute"]>>;

/* A first pass that delivers two specs; `b` is what the execution reports of the second. */
async function firstPass(b: Pick<Reported, "cases"> & Partial<Pick<Reported, "skippedTests">>, baselines: string[][] = []): Promise<{ sideEffect: string | undefined; verdict: string; stored: boolean }> {
  const ws = runWorkspace("qa-modes-");
  const deps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served(generationOnDisk({ author: async () => scriptedGeneration({ specs: ["flows/a.spec.ts", "flows/b.spec.ts"] }) })),
    review: { review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute: async () => ({ verdict: "pass", cases: [caseOf("flows/a.spec.ts"), ...b.cases], ...(b.skippedTests ? { skippedTests: b.skippedTests } : {}), logs: "" }) },
    objectiveSignal: { measure: async (_blast, _dir, _diff, baselineCases) => { baselines.push([...(baselineCases ?? [])]); return { status: "unknown", ratio: null }; }, blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async () => {} },
    confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2 },
  } as RunQaUseCaseDeps;
  const out = await new RunQaUseCase(deps).run(INPUT);
  const manifests = files(join(ws.baseDir, "suite-store")).filter((p) => /manifest/.test(p)).map((p) => readFileSync(p, "utf8"));
  return { verdict: out.decision.verdict, sideEffect: (out.decision as { sideEffect?: string }).sideEffect, stored: manifests.some((m) => m.includes("flows/b.spec.ts")) };
}

test("a delivered spec file whose every test was skipped is not proven: the run opens no pull request and the store does not admit it", async () => {
  const r = await firstPass({ cases: [], skippedTests: [{ name: "flows/b.spec.ts › needs data", file: "flows/b.spec.ts", annotation: "skip" }] });

  assert.notEqual(r.sideEffect, "pr");
  assert.notEqual(r.verdict, "pass");
  assert.equal(r.stored, false);
});

test("a delivered spec file whose only test is marked test.fail() is not proven: the run opens no pull request and the store does not admit it", async () => {
  const r = await firstPass({ cases: [caseOf("flows/b.spec.ts", { expectedStatus: "failed", name: "flows/b.spec.ts › known bug" })] });

  assert.notEqual(r.sideEffect, "pr");
  assert.notEqual(r.verdict, "pass");
  assert.equal(r.stored, false);
});

/* The engine is the one authority on a skipped or expected-to-fail test in the files a run delivers, whatever the app's own lint: such a test is not a pass, so the run does not pass on it. */
test("a delivered spec file that skips a test beside a passing one does not pass: the skip is the engine's to refuse, not the app's lint", async () => {
  const r = await firstPass({ cases: [caseOf("flows/b.spec.ts")], skippedTests: [{ name: "flows/b.spec.ts › needs data", file: "flows/b.spec.ts", annotation: "fixme" }] });

  assert.equal(r.verdict, "fail");
  assert.notEqual(r.sideEffect, "pr");
});

test("a delivered spec file that marks a test test.fail() beside a passing one does not pass", async () => {
  const r = await firstPass({ cases: [caseOf("flows/b.spec.ts"), caseOf("flows/b.spec.ts", { expectedStatus: "failed", name: "flows/b.spec.ts › known bug" })] });

  assert.equal(r.verdict, "fail");
  assert.notEqual(r.sideEffect, "pr");
});

test("a skipped test in a file the run did not deliver (the seed's own cleanup pass) does not touch the verdict", async () => {
  const r = await firstPass({ cases: [caseOf("flows/b.spec.ts")], skippedTests: [{ name: "cleanup.spec.ts › removes orphaned data", file: "cleanup.spec.ts", annotation: "skip" }] });

  assert.equal(r.verdict, "pass");
  assert.equal(r.sideEffect, "pr");
});

/* A test of the existing suite marked test.fail() is not among the delivered files, so the first pass does not refuse it; it still proves nothing, so the mutation baseline (the tests a mutant is judged against) must not hold it. */
test("the measurement's passing baseline holds the tests that really passed, not an existing test marked test.fail()", async () => {
  const baselines: string[][] = [];
  await firstPass({ cases: [caseOf("flows/b.spec.ts"), caseOf("flows/old.spec.ts", { expectedStatus: "failed", name: "flows/old.spec.ts › known bug" })] }, baselines);

  assert.ok(baselines.length > 0, "the run measured");
  for (const baseline of baselines) {
    assert.ok(baseline.includes("flows/b.spec.ts › works"));
    assert.equal(baseline.includes("flows/old.spec.ts › known bug"), false);
  }
});

/* A test that did not run because an earlier one failed is not a skip its author wrote. These cases drive the whole run with the reports Playwright 1.60.0 writes for a serial group whose steps fail one after another (the fixture's shapes, each step's status moved by the step that fails): fixing one step must be a fix even though the next one now fails, and a report that only moves the failure is not a skip for the engine to refuse. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";
import { RunQaUseCase, type RunQaInput, type RunQaUseCaseDeps } from "@contexts/run-orchestration/application/run-qa.use-case.ts";
import type { ExecutionPort } from "@contexts/test-execution/application/index.ts";
import { parsePlaywrightReport } from "@contexts/test-execution/infrastructure/playwright-report.ts";
import { scriptedGeneration } from "../../../support/generation-output.ts";
import { runWorkspace } from "../../../support/run-workspace.ts";
import { fakeWorkspace } from "./run-flow/fake-workspace.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";
import { served } from "../../../support/coordinator-over-author.ts";
import { primaryChangeSet } from "../../../support/change-set.ts";

const INPUT: RunQaInput = { app: "demo", changeSet: primaryChangeSet("demo", Sha.of("abc1234")), sha: Sha.of("abc1234"), source: "manual", mode: "diff", target: "e2e", runId: "serial-run" };
const SPEC = "flows/serial.spec.ts";

type PwTest = { status: string; expectedStatus: string; results: Array<{ status: string }> };
type PwReport = { suites: Array<{ title: string; specs: Array<{ title: string; ok: boolean; tests: PwTest[] }> }>; stats: Record<string, number> } & Record<string, unknown>;

/* Playwright's own serial report, with step `failing` (0-based) failing: the steps before it pass, the ones after it never run (status skipped, expectedStatus passed, no annotation). None: every step passes. */
function serialReport(failing: number | undefined): unknown {
  const real = JSON.parse(readFileSync(new URL("../../test-execution/infrastructure/__fixtures__/playwright-1.60.0/serial-retries-2.json", import.meta.url), "utf8")) as PwReport;
  const suite = real.suites.find((s) => s.title === SPEC)!;
  suite.specs.forEach((spec, i) => {
    const t = spec.tests[0]!;
    const [status, result] = failing === undefined || i < failing ? ["expected", "passed"] : i === failing ? ["unexpected", "failed"] : ["skipped", "skipped"];
    t.status = status!;
    t.results = t.results.map(() => ({ ...t.results[0]!, status: result! }));
    spec.ok = status === "expected";
  });
  const statuses = suite.specs.map((spec) => spec.tests[0]!.status);
  const count = (status: string): number => statuses.filter((s) => s === status).length;
  return { ...real, suites: [suite], stats: { ...real.stats, expected: count("expected"), unexpected: count("unexpected"), skipped: count("skipped"), flaky: 0 } };
}

async function run(failingAfterRound: (round: number) => number | undefined): Promise<{ verdict: string; sideEffect: string | undefined; rounds: number }> {
  const ws = runWorkspace("qa-serial-");
  let turns = 0;
  let rounds = 0;
  const execute: ExecutionPort["execute"] = async (_dir, opts) => {
    const { namespace } = (opts ?? {}) as { namespace?: string };
    const parsed = parsePlaywrightReport(serialReport(failingAfterRound(namespace === undefined ? 0 : ++rounds)));
    return { verdict: parsed.verdict, cases: parsed.cases, skippedTests: parsed.skippedTests, logs: "" };
  };
  const deps = {
    changeAnalysis: { classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" }) },
    ...served({
      author: async (specDir: string) => {
        turns++;
        mkdirSync(join(specDir, "flows"), { recursive: true });
        writeFileSync(join(specDir, SPEC), `// turn ${turns}\n`);
        return scriptedGeneration({ specs: [SPEC] });
      },
    }),
    review: { review: async () => ({ approved: true, findings: [], blockingCount: 0, parsed: true }) },
    validation: { validate: async () => ({ ok: true, errors: [] }) },
    execution: { execute },
    objectiveSignal: { measure: async () => ({ status: "unknown", ratio: null }), blocks: () => false },
    publication: { publish: async () => ({ outcome: "pr" }) },
    workspace: fakeWorkspace(ws),
    specFiles: confinedSpecFiles,
    suiteStore: ws.suiteStore,
    deployGate: { verifyServed: async () => ok({ state: "undeclared" as const }), waitUntilHealthy: async () => ok(true) },
    runHistory: { save: async () => {} },
    confinement: { enforce: async () => ({ strays: 0, dangerous: 0, reverted: [] }) },
    config: { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 4 },
  } as RunQaUseCaseDeps;
  const out = await new RunQaUseCase(deps).run(INPUT);
  return { verdict: out.decision.verdict, sideEffect: (out.decision as { sideEffect?: string }).sideEffect, rounds };
}

test("a serial group whose failing steps are fixed one round at a time ends green: the steps that did not run are not skips", async () => {
  /* The suite fails at step 2 (index 1); each round fixes the failing step and the next one fails, until all pass. */
  const r = await run((round) => (round === 0 ? 1 : round === 1 ? 2 : round === 2 ? 3 : undefined));

  assert.equal(r.verdict, "pass");
  assert.equal(r.sideEffect, "pr");
  assert.equal(r.rounds, 3);
});

test("a serial group whose failing step is not fixed stays failed, and is not published", async () => {
  const r = await run(() => 1);

  assert.equal(r.verdict, "fail");
  assert.notEqual(r.sideEffect, "pr");
});

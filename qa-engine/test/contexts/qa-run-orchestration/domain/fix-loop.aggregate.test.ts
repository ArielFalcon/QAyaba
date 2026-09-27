import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FixLoop,
  type FixLoopExecuteInput,
  type FixLoopExecutionPort,
  type FixLoopGenerateInput,
  type FixLoopGenerateResult,
  type FixLoopGenerationPort,
  type FixLoopInput,
  type FixLoopRun,
} from "@contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts";
import type { SpecSelectorFindings } from "@contexts/qa-run-orchestration/domain/helpers/selector-check.ts";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import type { QaCase } from "@kernel/qa-case.ts";

/* ExecutionPort/GenerationPort/SelectorCheck (this file); each loop decision tested in isolation.
   Characterization against the fail-issue/invalid-issue goldens lives in a separate file.
 */

function makeCase(overrides: Partial<QaCase> = {}): QaCase {
  return { name: "login", status: "fail", detail: "getByRole resolved to 0 elements", ...overrides };
}

function budgets(): { cycleBudget: CycleBudget; wallClockBudget: WallClockBudget } {
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
  return { cycleBudget, wallClockBudget };
}

/* A stub GenerationPort that always regenerates one spec with no selector-contradiction feedback. */
function regenAlwaysSucceeds(): FixLoopGenerationPort {
  return {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
}

test("break-issue with runner_infra evidence -> infra-error, no regen call", async () => {
  let regenCalled = false;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop should break BEFORE any retry-execute");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      regenCalled = true;
      return { specs: [], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ detail: "browserType.launch: Executable doesn't exist" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "infra-error");
  assert.equal(result.realBugDetected, false);
  assert.equal(regenCalled, false, "runner_infra breaks BEFORE any regeneration call");
});

test("break-issue with app_defect (real-bug) evidence -> realBugDetected=true, verdict stays fail", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop should break on the FIRST evaluation");
    },
  };
  const generation = regenAlwaysSucceeds();
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [makeCase({ detail: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'" })],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(result.realBugDetected, true);
});

test("loop condition — maxRetries=0 disables the fix-loop entirely (no regen, no re-execute)", async () => {
  let regenCalled = false;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called when maxRetries=0");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      regenCalled = true;
      return { specs: [], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 0,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(regenCalled, false);
  assert.equal(result.retries, 0);
});

test("loop condition — verdict!=='fail' skips the loop entirely (already pass)", async () => {
  const execution: FixLoopExecutionPort = { execute: async () => { throw new Error("must not execute"); } };
  const generation: FixLoopGenerationPort = { generate: async () => { throw new Error("must not regen"); } };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "pass", cases: [{ name: "login", status: "pass" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: [],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "pass");
  assert.equal(result.retries, 0);
});

test("loop condition — generating=false skips the loop entirely (regression-only run)", async () => {
  const execution: FixLoopExecutionPort = { execute: async () => { throw new Error("must not execute"); } };
  const generation: FixLoopGenerationPort = { generate: async () => { throw new Error("must not regen"); } };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: false,
    mode: "diff",
    objectiveSource: [],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(result.retries, 0);
});

test("Lever-2 absentKeys short-circuit — regenerates WITHOUT re-executing, loops again", async () => {
  let executeCallCount = 0;
  let generateCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      /* Second round: selector now present → allUnique path is irrelevant here; return a clean pass
         so the loop terminates cleanly on round 2's execute (if it ever gets called).
       */
      return { verdict: "pass", cases: [{ name: "login", status: "pass" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      return { specs: ["login.spec.ts"], approved: true };
    },
  };
  /* Round 1: selector absent (absentKeys.size > 0) -> gate spends (prev===null, always allowed) ->
     regen -> short-circuit (skip re-execute) -> loop again. Round 2: the run is UNCHANGED (never
     re-executed), so curRound is IDENTICAL to round 1's prevRound (same failingCount, same
     failingNames, same absentSelectors -> lever2Flips=0) -> decideProgress correctly fail-closes
     (no measurable progress) -> adjudicate's Rule 5 (break-needs-human) fires, NOT another regen.
     This is the CORRECT ported behavior (fail-closed progress gate), not a bug: an agent that never
     changes the failure set only gets ONE regen before the loop stops for human review.
   */
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: {
      check: () => ({
        contradictions: ['button:"Submit" is NOT in the captured failure-point tree. Present roles: (none)'],
        absentKeys: new Set(["role|button|Submit|0|0"]),
        anyVerifiedPresent: false,
        anyNonExtractable: false,
        anyUnverifiable: false,
      }),
    },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ detail: "getByRole resolved to 0 elements" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(executeCallCount, 0, "absentKeys.size>0 must short-circuit re-execute on EVERY round it fires");
  assert.equal(generateCallCount, 1, "round 1 regenerates once, then the fail-closed gate stops round 2 (break-needs-human)");
  assert.equal(result.retries, 1);
  assert.equal(result.run.verdict, "fail", "run is unchanged (never re-executed)");
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human");
});

test("filtered-retry — canFilter true (coverageWillMeasure=false, regen stayed in failed set)", async () => {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async (i) => {
      receivedExecuteInputs.push(i);
      return { verdict: "pass", cases: [{ name: "login", status: "pass", file: "login.spec.ts" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: "login.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: false,
  });

  assert.equal(receivedExecuteInputs.length, 1);
  assert.deepEqual(receivedExecuteInputs[0]!.specFiles, ["login.spec.ts"]);
});

/* The failing set and the regen's specs are compared as whole suite-relative paths: two specs that
   share a file name in different folders are different files. */
async function retryScopeFor(failingFile: string, regenSpecs: string[]): Promise<string[] | undefined> {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const loop = new FixLoop({
    execution: {
      execute: async (i) => {
        receivedExecuteInputs.push(i);
        return { verdict: "pass", cases: [{ name: "login", status: "pass", file: failingFile }] };
      },
    },
    generation: { generate: async () => ({ specs: regenSpecs, approved: true }) },
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });
  const { cycleBudget, wallClockBudget } = budgets();
  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: failingFile })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/login.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: false,
  });
  assert.equal(receivedExecuteInputs.length, 1);
  return receivedExecuteInputs[0]!.specFiles;
}

test("filtered retry: a regen spec with the failing file's name in ANOTHER folder re-runs the whole suite", async () => {
  assert.equal(await retryScopeFor("user/login.spec.ts", ["admin/login.spec.ts"]), undefined);
});

test("filtered retry: a regen of the failing file in the SAME folder re-runs only that file", async () => {
  assert.deepEqual(await retryScopeFor("user/login.spec.ts", ["./user/login.spec.ts"]), ["user/login.spec.ts"]);
});

test("filtered retry: a regen spec named only by the failing file's name re-runs the whole suite", async () => {
  assert.equal(await retryScopeFor("user/login.spec.ts", ["login.spec.ts"]), undefined);
});

test("filtered retry: a regen of the failing file written with backslashes re-runs only that file", async () => {
  assert.deepEqual(await retryScopeFor("user/login.spec.ts", ["user\\login.spec.ts"]), ["user/login.spec.ts"]);
});

test("filtered-retry — regen specs are ALL outside the failing set -> full re-execute (no specFiles)", async () => {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async (i) => {
      receivedExecuteInputs.push(i);
      return { verdict: "pass", cases: [{ name: "checkout", status: "pass", file: "checkout.spec.ts" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    /* Zero overlap with the failing set (["login.spec.ts"]) — the regen wrote an entirely
       different spec file. Filtering execute() to the stale failing set would silently never
       run the file the regen actually produced. */
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: "login.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: false,
  });

  assert.equal(receivedExecuteInputs.length, 1);
  assert.equal(
    receivedExecuteInputs[0]!.specFiles,
    undefined,
    "regen specs entirely outside the failing set must NEVER filter — the regenerated file would never run",
  );
});

test("filtered-retry — canFilter false when coverageWillMeasure=true (never filter, keystone guard)", async () => {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async (i) => {
      receivedExecuteInputs.push(i);
      return { verdict: "pass", cases: [{ name: "login", status: "pass", file: "login.spec.ts" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: "login.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true,
  });

  assert.equal(receivedExecuteInputs.length, 1);
  assert.equal(receivedExecuteInputs[0]!.specFiles, undefined, "coverageWillMeasure=true must NEVER filter");
});

test("bestRunSoFar regression guard — a worse terminal retry is discarded for an earlier better run", async () => {
  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      if (executeCallCount === 1) {
        return {
          verdict: "fail",
          cases: [
            { name: "login", status: "pass", file: "login.spec.ts" },
            { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
          ],
        };
      }
      return {
        verdict: "fail",
        cases: [
          { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
          { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
        ],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts", "checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [
        { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
        { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
      ],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true, /* never-filter, keeps the merge logic out of this test's scope */
  });

  /* Round 1 (1 failure) is strictly better than round 2 (2 failures, a regression) — the guard must
     restore round 1's run, not ship round 2's worse terminal retry.
   */
  assert.equal(result.run.cases.filter((c) => c.status === "fail").length, 1);
  assert.equal(
    result.run.cases.find((c) => c.name === "checkout")?.status,
    "fail",
    "round 1's still-failing checkout case must be the one that survives",
  );
});

test("bestRunSoFar guard is SKIPPED when realBugDetected fired (the current fail run must reach the Issue)", async () => {
  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      return {
        verdict: "fail",
        cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [
        { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
        { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
      ],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true,
  });

  assert.equal(result.realBugDetected, true);
  /* The round-1 retry (1 failure) reduced failures vs the initial (2), so bestRunSoFar tracks it —
     but the real-bug branch fires on round 2's evaluation and must NOT be overridden by the guard.
   */
  assert.equal(result.run.cases.filter((c) => c.status === "fail").length, 1);
  assert.equal(result.run.cases[0]!.detail?.includes("Expected: 'Paid'"), true);
});

/* decideProgress (helpers/progress-gate.ts) downgrades a Signal-B "progress" verdict to spend:false
   when the CURRENT round's reexploreNavigations >= REEXPLORE_FLAIL_THRESHOLD (3). The prior round's
   nav count (result?.reexploreNavigations ?? 0) is read at the next round's gate. Without this
   field populated, the thrash-stop is unreachable and the loop spends an extra retry.
 */
test("reexploreNavigations thrash-stop — a heavy re-exploration round downgrades Signal B to no-progress (break-needs-human)", async () => {
  let executeCallCount = 0;
  let generateCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      /* Round 1's retry-execute: a DIFFERENT failing name each call so Signal B (failing name set
         changed) would normally hold every round — EXCEPT the round-1 regen reports a thrashing
         reexploreNavigations count, which must downgrade round 2's gate evaluation to no-progress.
       */
      return {
        verdict: "fail" as const,
        cases: [{ name: `checkout-retry-${executeCallCount}`, status: "fail" as const, file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      /* Every regen reports heavy re-exploration (>= REEXPLORE_FLAIL_THRESHOLD=3) — mirrors an agent
         that re-navigated instead of fixing from the injected failure-point tree.
       */
      return { specs: ["checkout.spec.ts"], approved: true, reexploreNavigations: 5 };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-f1",
    coverageWillMeasure: true, /* never-filter, keeps merge logic out of this test's scope */
  });

  /* Round 1: prev===null -> always allowed -> regen (reexploreNavigations:5) -> execute (round 2's
     curRound.reexploreNavigations must read THIS 5). Round 2: failing name changed (Signal B would
     normally hold) but reexploreNavigations>=3 downgrades it to no-progress -> adjudicate's
     break-needs-human fires -> loop stops WITHOUT a second regen.
   */
  assert.equal(generateCallCount, 1, "the thrash-stop must prevent a second regen call once round 2's gate reads the prior round's reexploreNavigations>=3");
  assert.equal(executeCallCount, 1, "only round 1's retry-execute runs; round 2 never re-executes because the loop breaks on the gate evaluation first");
  assert.equal(result.retries, 1);
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human", "the fail-closed gate (fed by reexploreNavigations from the prior round) must route to break-needs-human, not another regen");
});

/* A mid-retry infra-error (DEV dies after a filtered retry-execute) is a discarded-run verdict
   and must carry zero cases, matching every other infra-error assignment site in this aggregate.
 */
test("mid-retry infra-error (DEV dies after a filtered retry-execute) discards cases, matching legacy resultOf's cases:[] contract", async () => {
  let executeCallCount = 0;
  let devHealthyCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      return {
        verdict: "fail" as const,
        cases: [{ name: "checkout", status: "fail" as const, file: "checkout.spec.ts", detail: "net::ERR_CONNECTION_REFUSED" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
    /* devHealthy on FixLoopInput is the FIRST check (adjudicator evidence, always healthy here); the
       SECOND, independent devHealthy() call happens right after the retry-execute returns fail — this
       one reports DEV down, forcing the mid-retry infra-error assignment.
     */
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => {
      devHealthyCallCount++;
      /* 1st call: the adjudicator evidence snapshot (must be healthy so the loop proceeds to regen).
         2nd call: the pre-retry-execute guard (must be healthy so retry-execute actually runs).
         3rd call: the POST-retry-execute check — DEV is now down.
       */
      return devHealthyCallCount < 3;
    },
    namespace: "qa-bot-f2",
    coverageWillMeasure: true,
  });

  assert.equal(executeCallCount, 1, "the retry-execute must have run before the mid-retry infra-error fires");
  assert.equal(result.run.verdict, "infra-error");
  assert.deepEqual(result.run.cases, [], "legacy resultOf() ALWAYS returns cases:[] — a discarded infra-error run must carry zero cases, matching every other infra-error assignment in this aggregate");
});

/* cycleBudget/wallClockBudget thread into the FixLoopGenerationPort.generate() call so a composed
   generation adapter can enforce the budget check at the generate() call boundary, rather than the
   fix-loop re-implementing budget logic it structurally does not own.
 */
test("the regen call threads cycleBudget/wallClockBudget to the GenerationPort, matching WHERE the legacy checks (inside generateOnce, not the fix-loop block)", async () => {
  const receivedGenerateInputs: Array<{ cycleBudget?: CycleBudget; wallClockBudget?: WallClockBudget }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }] }),
  };
  const generation: FixLoopGenerationPort = {
    generate: async (input) => {
      receivedGenerateInputs.push(input);
      return { specs: ["checkout.spec.ts"], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-f4",
  });

  assert.equal(receivedGenerateInputs.length, 1);
  assert.strictEqual(receivedGenerateInputs[0]!.cycleBudget, cycleBudget, "the SAME immutable CycleBudget instance passed into FixLoopInput must reach the generation port call — the aggregate forwards the budget unread");
  assert.strictEqual(receivedGenerateInputs[0]!.wallClockBudget, wallClockBudget, "the SAME immutable WallClockBudget instance must reach the generation port call — the aggregate forwards the budget unread");
});

/* FixLoopResult.lastSpecMetas surfaces the LAST regen round's own specMetas — the caller
   (RunQaUseCase) prefers this over the pre-loop generation's own specMetas once the loop has
   engaged, since the loop's own final regen is the freshest "what was tested" evidence.
 */

test("lastSpecMetas reflects the FINAL regen round's own specMetas once the loop fixes the run and exits", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }] }),
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({
      specs: ["checkout.spec.ts"],
      approved: true,
      specMetas: [{ flow: "Checkout", objective: "user can pay with a saved card" }],
    }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-specmetas",
  });

  assert.equal(result.run.verdict, "pass");
  assert.deepEqual(result.lastSpecMetas, [{ flow: "Checkout", objective: "user can pay with a saved card" }]);
});

test("lastSpecMetas is undefined when the loop never regenerated (already passing on entry)", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop condition is false from the start (verdict already pass)");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      throw new Error("generate must not be called — the loop never engages");
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "pass", cases: [{ name: "checkout", status: "pass" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-specmetas-noop",
  });

  assert.equal(result.lastSpecMetas, undefined);
});

/* ── Recording harness: the ports are the aggregate's only outputs besides its result ──────────── */

const VALUE_MISMATCH = "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'";
const LOCATOR_FAULT = "getByRole resolved to 0 elements";

function findings(overrides: Partial<SpecSelectorFindings> = {}): SpecSelectorFindings {
  return { contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false, ...overrides };
}

function recordingLoop(opts: {
  runs?: FixLoopRun[];
  regen?: (round: number) => FixLoopGenerateResult;
  check?: (round: number) => SpecSelectorFindings;
}) {
  const rec = {
    executes: [] as FixLoopExecuteInput[],
    generates: [] as FixLoopGenerateInput[],
    checks: [] as { specSources: string[]; trees: string[][] }[],
  };
  const loop = new FixLoop({
    execution: {
      execute: async (i) => {
        rec.executes.push(i);
        const next = opts.runs?.[Math.min(rec.executes.length, opts.runs.length) - 1];
        if (!next) throw new Error("this scenario does not expect a re-execution");
        return next;
      },
    },
    generation: {
      generate: async (i) => {
        rec.generates.push(i);
        return opts.regen ? opts.regen(rec.generates.length) : { specs: ["checkout.spec.ts"], approved: true };
      },
    },
    selectorCheck: {
      check: (specSources, trees) => {
        rec.checks.push({ specSources, trees });
        return opts.check ? opts.check(rec.checks.length) : findings();
      },
    },
  });
  return { loop, rec };
}

function loopInput(overrides: Partial<FixLoopInput> = {}): FixLoopInput {
  const { cycleBudget, wallClockBudget } = budgets();
  return {
    initialRun: { verdict: "fail", cases: [makeCase({ file: "checkout.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-run",
    coverageWillMeasure: false,
    ...overrides,
  };
}

const noFix = (): FixLoopGenerateResult => ({ specs: [], approved: true });

test("the selector check sees one tree per failing case that captured a failure DOM, without blank lines, beside the latest spec sources", async () => {
  const { loop, rec } = recordingLoop({ regen: noFix });
  await loop.run(
    loopInput({
      initialSpecSources: ["spec-source"],
      initialRun: {
        verdict: "fail",
        cases: [
          makeCase({ name: "pay", file: "checkout.spec.ts", failureDom: "button: Pay\n\n   \nlink: Home" }),
          makeCase({ name: "no-dom", file: "checkout.spec.ts" }),
          { name: "passing", status: "pass", file: "login.spec.ts", failureDom: "heading: Welcome" },
        ],
      },
    }),
  );
  assert.deepEqual(rec.checks[0], { specSources: ["spec-source"], trees: [["button: Pay", "link: Home"]] });
});

test("without a captured failure DOM, or in code mode, the selector check gets no spec sources", async () => {
  const noDom = recordingLoop({ regen: noFix });
  await noDom.loop.run(loopInput({ initialSpecSources: ["spec-source"] }));
  assert.deepEqual(noDom.rec.checks[0], { specSources: [], trees: [] });

  const code = recordingLoop({ regen: noFix });
  await code.loop.run(
    loopInput({ isCode: true, initialSpecSources: ["spec-source"], initialRun: { verdict: "fail", cases: [makeCase({ failureDom: "button: Pay" })] } }),
  );
  assert.deepEqual(code.rec.checks[0]?.specSources, []);
});

test("with a failure DOM but no known spec source, the selector check gets no spec sources", async () => {
  const { loop, rec } = recordingLoop({ regen: noFix });
  await loop.run(loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ failureDom: "button: Pay" })] } }));
  assert.deepEqual(rec.checks[0]?.specSources, []);
});

test("the regeneration is asked to fix only the failing cases", async () => {
  const { loop, rec } = recordingLoop({ regen: noFix });
  await loop.run(
    loopInput({
      initialRun: { verdict: "fail", cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" }), { name: "login", status: "pass", file: "login.spec.ts" }] },
    }),
  );
  assert.deepEqual(rec.generates[0]?.fixCases.map((c) => c.name), ["checkout"]);
});

test("a previously absent selector that turns up counts as progress and earns another regeneration", async () => {
  const { loop, rec } = recordingLoop({
    check: (round) => findings(round === 1 ? { absentKeys: new Set(["button:Pay"]) } : {}),
    runs: [{ verdict: "pass", cases: [{ name: "login", status: "pass", file: "checkout.spec.ts" }] }],
  });
  await loop.run(loopInput({ maxRetries: 2 }));
  assert.equal(rec.generates.length, 2, "round 2 regenerates because the absent selector flipped to present");
});

test("an absent selector keeps a value-mismatch failure from being judged a real app bug", async () => {
  const { loop } = recordingLoop({ regen: noFix, check: () => findings({ anyVerifiedPresent: true, absentKeys: new Set(["button:Pay"]) }) });
  const result = await loop.run(loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ file: "checkout.spec.ts", detail: VALUE_MISMATCH })] } }));
  assert.equal(result.realBugDetected, false);
});

test("a selector that matches several nodes keeps a value-mismatch failure from being judged a real app bug", async () => {
  const { loop } = recordingLoop({
    regen: noFix,
    check: () => findings({ anyVerifiedPresent: true, contradictions: ['button: "Pay" matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)'] }),
  });
  const result = await loop.run(loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ file: "checkout.spec.ts", detail: VALUE_MISMATCH })] } }));
  assert.equal(result.realBugDetected, false);
});

test("the adjudicator sees the failing spec files: a diff-mode failure outside the changed files is labelled an objective gap", async () => {
  const { loop } = recordingLoop({ regen: noFix });
  const result = await loop.run(
    loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ file: "e2e/profile.spec.ts", detail: "Timeout 5000ms exceeded" })] } }),
  );
  assert.equal(result.lastAdjudicatorVerdict?.class, "objective_gap");
});

test("DEV found down at the adjudication snapshot ends the loop as infra-error, never as a real bug", async () => {
  const { loop, rec } = recordingLoop({});
  const result = await loop.run(loopInput({ devHealthy: async () => false }));
  assert.equal(result.run.verdict, "infra-error");
  assert.equal(result.realBugDetected, false);
  assert.equal(rec.generates.length, 0);
});

test("code mode re-runs the repo's own suite under the run's namespace and keeps that namespace for coverage", async () => {
  const { loop, rec } = recordingLoop({ regen: () => ({ specs: ["test/cart.test.ts"], approved: true }), runs: [{ verdict: "pass", cases: [{ name: "cart", status: "pass" }] }] });
  const result = await loop.run(loopInput({ isCode: true, initialRun: { verdict: "fail", cases: [makeCase({ name: "cart", detail: "AssertionError: expected 1 to equal 2" })] } }));
  assert.deepEqual(rec.executes, [{ namespace: "qa-bot-run" }]);
  assert.equal(result.run.verdict, "pass");
  assert.equal(result.coverageNamespace, "qa-bot-run");
});

test("DEV going down before the retry execution stops the loop without executing and keeps the failing run", async () => {
  let calls = 0;
  const { loop, rec } = recordingLoop({ runs: [{ verdict: "pass", cases: [{ name: "login", status: "pass", file: "checkout.spec.ts" }] }] });
  const result = await loop.run(loopInput({ devHealthy: async () => ++calls < 2 }));
  assert.equal(rec.executes.length, 0);
  assert.equal(result.run.verdict, "fail");
});

test("a filtered retry re-runs only the failing spec files and keeps the results of the specs it did not re-run", async () => {
  const { loop, rec } = recordingLoop({ runs: [{ verdict: "pass", cases: [{ name: "checkout", status: "pass", file: "checkout.spec.ts" }] }] });
  const result = await loop.run(
    loopInput({
      initialRun: { verdict: "fail", cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" }), { name: "login", status: "pass", file: "login.spec.ts" }] },
    }),
  );
  assert.deepEqual(rec.executes[0]?.specFiles, ["checkout.spec.ts"]);
  assert.equal(result.run.verdict, "pass");
  assert.deepEqual(result.run.cases.map((c) => c.name).sort(), ["checkout", "login"]);
});

test("a filtered retry that still fails, or only passes on retry, reports fail or flaky over the merged cases", async () => {
  const initialRun: FixLoopRun = {
    verdict: "fail",
    cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" }), { name: "login", status: "pass", file: "login.spec.ts" }],
  };
  const stillFailing = recordingLoop({ runs: [{ verdict: "fail", cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" })] }] });
  assert.equal((await stillFailing.loop.run(loopInput({ initialRun }))).run.verdict, "fail");
  const flaky = recordingLoop({ runs: [{ verdict: "flaky", cases: [{ name: "checkout", status: "flaky", file: "checkout.spec.ts" }] }] });
  assert.equal((await flaky.loop.run(loopInput({ initialRun }))).run.verdict, "flaky");
});

test("a failing case without a spec file disables the filtered retry; a passing one without a file does not", async () => {
  const run: FixLoopRun = { verdict: "pass", cases: [{ name: "checkout", status: "pass", file: "checkout.spec.ts" }] };
  const failingNoFile = recordingLoop({ runs: [run] });
  await failingNoFile.loop.run(
    loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" }), makeCase({ name: "setup" })] } }),
  );
  assert.equal(failingNoFile.rec.executes[0]?.specFiles, undefined);

  const passingNoFile = recordingLoop({ runs: [run] });
  await passingNoFile.loop.run(
    loopInput({ initialRun: { verdict: "fail", cases: [makeCase({ name: "checkout", file: "checkout.spec.ts" }), { name: "setup", status: "pass" }] } }),
  );
  assert.deepEqual(passingNoFile.rec.executes[0]?.specFiles, ["checkout.spec.ts"]);
});

test("filtered retry: a regen that rewrote a failing spec AND added a new one re-runs the whole suite", async () => {
  assert.equal(await retryScopeFor("user/login.spec.ts", ["user/login.spec.ts", "user/new.spec.ts"]), undefined);
});

test("the filtered retry applies when the caller does not say whether coverage will be measured", async () => {
  const { loop, rec } = recordingLoop({ runs: [{ verdict: "pass", cases: [{ name: "checkout", status: "pass", file: "checkout.spec.ts" }] }] });
  const input = loopInput();
  delete input.coverageWillMeasure;
  await loop.run(input);
  assert.deepEqual(rec.executes[0]?.specFiles, ["checkout.spec.ts"]);
});

test("DEV found down after a failed retry ends the run as infra-error even on the last allowed retry", async () => {
  let calls = 0;
  const { loop } = recordingLoop({ runs: [{ verdict: "fail", cases: [makeCase({ file: "checkout.spec.ts" })] }] });
  const result = await loop.run(loopInput({ devHealthy: async () => ++calls < 3 }));
  assert.equal(result.run.verdict, "infra-error");
});

test("a retry that ends in infra-error is reported as infra-error even after an earlier round improved", async () => {
  let calls = 0;
  const { loop } = recordingLoop({
    runs: [
      { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }] },
      { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), makeCase({ name: "b", file: "b.spec.ts" })] },
    ],
  });
  const result = await loop.run(
    loopInput({
      maxRetries: 2,
      coverageWillMeasure: true,
      initialRun: { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), makeCase({ name: "b", file: "b.spec.ts" })] },
      devHealthy: async () => ++calls < 6,
    }),
  );
  assert.equal(result.run.verdict, "infra-error");
});

test("a real bug found after a better earlier round reports the run that proved it, not the earlier one", async () => {
  const { loop } = recordingLoop({
    check: () => findings({ anyVerifiedPresent: true }),
    runs: [
      { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }, { name: "c", status: "pass", file: "c.spec.ts" }] },
      { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts", detail: VALUE_MISMATCH }), makeCase({ name: "b", file: "b.spec.ts", detail: VALUE_MISMATCH }), { name: "c", status: "pass", file: "c.spec.ts" }] },
    ],
  });
  const result = await loop.run(
    loopInput({
      maxRetries: 3,
      coverageWillMeasure: true,
      initialRun: {
        verdict: "fail",
        cases: [makeCase({ name: "a", file: "a.spec.ts", detail: LOCATOR_FAULT }), makeCase({ name: "b", file: "b.spec.ts", detail: LOCATOR_FAULT }), makeCase({ name: "c", file: "c.spec.ts", detail: LOCATOR_FAULT })],
      },
    }),
  );
  assert.equal(result.realBugDetected, true);
  assert.deepEqual(result.run.cases.filter((c) => c.status === "fail").map((c) => c.name), ["a", "b"]);
});

test("a passing retry is kept even if DEV reports unhealthy right after it", async () => {
  let calls = 0;
  const { loop } = recordingLoop({ runs: [{ verdict: "pass", cases: [{ name: "login", status: "pass", file: "checkout.spec.ts" }] }] });
  const result = await loop.run(loopInput({ devHealthy: async () => ++calls < 3 }));
  assert.equal(result.run.verdict, "pass");
});

test("a retry the runner reports as infra-error keeps that verdict, even with more failing cases than an earlier round", async () => {
  const launchError = "browserType.launch: Executable doesn't exist";
  const { loop } = recordingLoop({
    runs: [
      { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }] },
      { verdict: "infra-error", cases: [makeCase({ name: "a", file: "a.spec.ts", detail: launchError }), makeCase({ name: "b", file: "b.spec.ts", detail: launchError })] },
    ],
  });
  const result = await loop.run(
    loopInput({
      maxRetries: 2,
      coverageWillMeasure: true,
      initialRun: { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), makeCase({ name: "b", file: "b.spec.ts" })] },
    }),
  );
  assert.equal(result.run.verdict, "infra-error");
});

test("a filtered retry the runner reports as infra-error ends the run as infra-error, never merged with the specs it did not re-run", async () => {
  const { loop, rec } = recordingLoop({
    regen: () => ({ specs: ["a.spec.ts"], approved: true }),
    runs: [{ verdict: "infra-error", cases: [] }],
  });
  const result = await loop.run(
    loopInput({
      initialRun: { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }] },
    }),
  );
  assert.deepEqual(rec.executes[0]?.specFiles, ["a.spec.ts"], "the retry was scoped to the failing spec");
  assert.equal(result.run.verdict, "infra-error");
});

test("a re-run failing spec the filtered retry reports no result for keeps its last failure", async () => {
  const { loop, rec } = recordingLoop({
    regen: () => ({ specs: ["a.spec.ts", "c.spec.ts"], approved: true }),
    runs: [{ verdict: "pass", cases: [{ name: "c", status: "pass", file: "c.spec.ts" }] }],
  });
  const result = await loop.run(
    loopInput({
      initialRun: {
        verdict: "fail",
        cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }, makeCase({ name: "c", file: "c.spec.ts" })],
      },
    }),
  );
  assert.deepEqual(rec.executes[0]?.specFiles, ["a.spec.ts", "c.spec.ts"], "the retry was scoped to the failing specs");
  assert.equal(result.run.verdict, "fail");
  assert.deepEqual(result.run.cases.filter((c) => c.status === "fail").map((c) => c.name), ["a"]);
  assert.deepEqual(result.run.cases.map((c) => c.name).sort(), ["a", "b", "c"], "b is carried forward and c is replaced by its fresh result");
});

test("a filtered retry is never reported greener than the runner's own verdict for it", async () => {
  const initialRun: FixLoopRun = {
    verdict: "fail",
    cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "pass", file: "b.spec.ts" }],
  };
  const regen = (): FixLoopGenerateResult => ({ specs: ["a.spec.ts"], approved: true });
  const failed = recordingLoop({ regen, runs: [{ verdict: "fail", cases: [{ name: "a", status: "pass", file: "a.spec.ts" }] }] });
  assert.equal((await failed.loop.run(loopInput({ initialRun }))).run.verdict, "fail");
  const flaky = recordingLoop({ regen, runs: [{ verdict: "flaky", cases: [{ name: "a", status: "pass", file: "a.spec.ts" }] }] });
  assert.equal((await flaky.loop.run(loopInput({ initialRun }))).run.verdict, "flaky");
});

test("a flaky spec the filtered retry did not re-run keeps a passing retry flaky", async () => {
  const { loop } = recordingLoop({
    regen: () => ({ specs: ["a.spec.ts"], approved: true }),
    runs: [{ verdict: "pass", cases: [{ name: "a", status: "pass", file: "a.spec.ts" }] }],
  });
  const result = await loop.run(
    loopInput({
      initialRun: { verdict: "fail", cases: [makeCase({ name: "a", file: "a.spec.ts" }), { name: "b", status: "flaky", file: "b.spec.ts" }] },
    }),
  );
  assert.equal(result.run.verdict, "flaky");
});

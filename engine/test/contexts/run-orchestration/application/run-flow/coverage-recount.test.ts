/*
 * A recount describes the bytes under review however many regenerations were accepted before it (RFC-0015): the files an accepted
 * regeneration kept are measured by a measurement execution of their passing tests, and every spec file is read from the measurement
 * execution that ran its current bytes, found by their fingerprint, so a file given its prior bytes back is read from the dumps of
 * those bytes and bytes no measurement ran are never counted from another's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSurvivors, measureCoverage, measureKept, recountAfter, type GapRegeneration } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { initialRunState, type MeasuredDumps, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { CoverageSource } from "@contexts/objective-signal/application/index.ts";
import { testOfCase } from "@contexts/objective-signal/domain/dump-names.ts";
import type { ExecutionOpts } from "@contexts/test-execution/domain/execution.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { sha256Hex } from "@kernel/content-hash.ts";
import { Sha } from "@kernel/sha.ts";

const RECOUNT = { status: "pass" as const, ratio: 1, uncovered: [], untakenArms: [], measurement: { changedLines: 4, coveredChanged: 4, changedFiles: 1, mappedFiles: 1 } };

const pass = (name: string, file: string): QaCase => ({ name, status: "pass", file, durationMs: 1_000 });

/* A run whose spec files hold `disk` and whose measurement executions answer with `measured` (by default every test they are given passes). */
function rig(disk: Record<string, string>, measured?: (opts: ExecutionOpts) => { verdict: "pass" | "fail" | "infra-error"; cases: QaCase[] }) {
  const asked: CoverageSource[][] = [];
  const executed: ExecutionOpts[] = [];
  const ctx = {
    deps: {
      execution: {
        execute: async (_dir: string, opts: ExecutionOpts) => {
          executed.push(opts);
          const answer = measured?.(opts) ?? { verdict: "pass" as const, cases: (opts.specFiles ?? []).map((file) => pass(file.replace(".spec.ts", ""), file)) };
          return { ...answer, logs: "" };
        },
      },
      objectiveSignal: { recount: async (_br: unknown, _dir: string, _diff: unknown, sources: readonly CoverageSource[]) => (asked.push([...sources]), RECOUNT) },
    },
    input: { sha: Sha.of("abc1234"), runId: "r" },
    cfg: { coveragePolicyMode: "signal" },
    workspace: { specDir: "/e2e" },
    services: {
      specRoot: { mirrorDir: "/mirror" },
      specFiles: { readOwned: (_root: unknown, file: string) => (file in disk ? { bytes: Buffer.from(disk[file]!) } : { absent: true }) },
      runDeadlinePort: { peekAllowance: () => null, fired: () => false },
    },
  } as unknown as WorkspaceRunContext;
  return { ctx, asked, executed };
}

const H = (text: string): string => sha256Hex(text);

/* The run's measurement execution, which ran a.spec.ts and b.spec.ts in their first bytes. */
const FIRST: MeasuredDumps = { namespace: "r-measure", files: [{ file: "a.spec.ts", sha: H("a1") }, { file: "b.spec.ts", sha: H("b1") }], exceptTests: [] };

const withDumps = (dumps: MeasuredDumps[]): RunState => {
  const state = initialRunState() as RunState;
  return { ...state, coverage: { ...state.coverage, dumps } };
};

const acceptedKeeping = (namespace: string, kept: string[], cases: QaCase[]): GapRegeneration =>
  ({ outcome: "accepted", run: { verdict: "pass", cases, logs: "" }, acceptanceCalls: 1, leadCorrections: 0, namespace, changedSpecFiles: kept }) as unknown as GapRegeneration;

test("the files an accepted regeneration kept are measured by a measurement execution of their passing tests, and the recount reads them from it and every other file from the run's measurement", async () => {
  const { ctx, asked, executed } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b2" });
  const state = withDumps([FIRST]);
  const regen = acceptedKeeping("r-acc0", ["b.spec.ts"], [pass("a", "a.spec.ts"), pass("b", "b.spec.ts")]);

  const measured = await measureKept(state, ctx, regen);
  const outcome = await recountAfter(state, ctx, regen, measured);

  assert.equal(executed.length, 1);
  assert.equal(executed[0]!.purpose, "measurement");
  assert.equal(executed[0]!.coverage, true);
  assert.equal(executed[0]!.namespace, "r-acc0-measure");
  assert.deepEqual(executed[0]!.specFiles, ["b.spec.ts"]);
  assert.deepEqual(executed[0]!.tests, [testOfCase("b")]);
  assert.deepEqual(asked, [[{ namespace: "r-measure", specFiles: ["a.spec.ts"] }, { namespace: "r-acc0-measure", specFiles: ["b.spec.ts"] }]]);
  assert.equal(outcome.untakenArmsCurrent, true);
  assert.deepEqual(outcome.dumps.map((d) => d.namespace), ["r-measure", "r-acc0-measure"]);
});

test("a spec file whose bytes went back to those a measurement ran is read from that measurement's dumps, whatever ran after it", async () => {
  const { ctx, asked } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b1", "c.spec.ts": "c2" });
  const later: MeasuredDumps = { namespace: "r-acc0-measure", files: [{ file: "b.spec.ts", sha: H("b2") }], exceptTests: [] };
  const state = withDumps([FIRST, later]);
  const regen = acceptedKeeping("r-acc1", ["c.spec.ts"], [pass("a", "a.spec.ts"), pass("b", "b.spec.ts"), pass("c", "c.spec.ts")]);

  await recountAfter(state, ctx, regen, await measureKept(state, ctx, regen));

  assert.deepEqual(asked, [[{ namespace: "r-measure", specFiles: ["a.spec.ts", "b.spec.ts"] }, { namespace: "r-acc1-measure", specFiles: ["c.spec.ts"] }]]);
});

test("bytes no measurement execution ran are never counted from another's dumps: the recount is not made and the arms are not current", async () => {
  const { ctx, asked } = rig({ "a.spec.ts": "a-edited", "b.spec.ts": "b2" });
  const state = withDumps([FIRST]);
  const regen = acceptedKeeping("r-acc0", ["b.spec.ts"], [pass("a", "a.spec.ts"), pass("b", "b.spec.ts")]);

  const outcome = await recountAfter(state, ctx, regen, await measureKept(state, ctx, regen));

  assert.deepEqual(asked, []);
  assert.equal(outcome.untakenArmsCurrent, false);
});

test("a measurement of the kept files that could not run leaves the measurement before the regeneration standing", async () => {
  const { ctx, asked } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b2" }, () => ({ verdict: "infra-error", cases: [] }));
  const state = withDumps([FIRST]);
  const regen = acceptedKeeping("r-acc0", ["b.spec.ts"], [pass("a", "a.spec.ts"), pass("b", "b.spec.ts")]);

  const outcome = await recountAfter(state, ctx, regen, await measureKept(state, ctx, regen));

  assert.deepEqual(asked, []);
  assert.equal(outcome.untakenArmsCurrent, false);
  assert.deepEqual(outcome.dumps, [FIRST]);
});

test("a kept test that fails only under the measurement credits nothing: its dumps are left out of the recount", async () => {
  const { ctx, asked } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b2" }, (opts) => ({ verdict: "fail", cases: (opts.specFiles ?? []).map((file): QaCase => ({ ...pass("b", file), status: "fail" })) }));
  const state = withDumps([FIRST]);
  const regen = acceptedKeeping("r-acc0", ["b.spec.ts"], [pass("a", "a.spec.ts"), pass("b", "b.spec.ts")]);

  await recountAfter(state, ctx, regen, await measureKept(state, ctx, regen));

  assert.deepEqual(asked, [[{ namespace: "r-measure", specFiles: ["a.spec.ts"] }, { namespace: "r-acc0-measure", specFiles: ["b.spec.ts"], exceptTests: [testOfCase("b")] }]]);
});

test("a regeneration that was not accepted runs no measurement and leaves the dumps as they were", async () => {
  const { ctx, asked, executed } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b1" });
  const state = withDumps([FIRST]);
  const rejected = { outcome: "rejected", run: { verdict: "pass", cases: [], logs: "" }, acceptanceCalls: 2, leadCorrections: 0 } as unknown as GapRegeneration;

  const outcome = await recountAfter(state, ctx, rejected, await measureKept(state, ctx, rejected));

  assert.deepEqual(executed, []);
  assert.deepEqual(asked, []);
  assert.deepEqual(outcome.dumps, [FIRST]);
});

test("the survivor closure judges the re-applied mutants against the tests that passed in the kept files' measurement execution, never the acceptance's", async () => {
  const { ctx } = rig({ "a.spec.ts": "a1", "b.spec.ts": "b2" }, (opts) => ({ verdict: "fail", cases: ([pass("b › keeps", "b.spec.ts"), { ...pass("b › totals", "b.spec.ts"), status: "fail" }] as QaCase[]).filter((c) => opts.specFiles?.includes(c.file!)) }));
  const baselines: string[][] = [];
  (ctx.deps.objectiveSignal as { recheckSurvivors: unknown }).recheckSurvivors = async (_runs: unknown, _dir: string, _ns: string, baseline: string[]) => (baselines.push(baseline), { applied: 1, killed: 1, survived: [] });
  const site = { file: "src/x.ts", line: 3, column: 0, operator: "negate condition", script: { url: "https://dev/main.js", sha256: "h" }, edit: { start: 1, end: 2, replacement: "!" }, original: "x", ranIn: [] };
  const state = withDumps([FIRST]);
  const routed = { ...state, coverage: { ...state.coverage, survivorRuns: [{ site, specFiles: ["b.spec.ts"] }], bundleMutation: { applied: 1, killed: 0, survived: [{ file: "src/x.ts", line: 3, operator: "negate condition", specFiles: ["b.spec.ts"] }] } } } as RunState;
  const regen = acceptedKeeping("r-acc0", ["b.spec.ts"], [pass("a", "a.spec.ts"), pass("b › keeps", "b.spec.ts"), pass("b › totals", "b.spec.ts")]);

  const closure = await closeSurvivors(routed, ctx, regen, await measureKept(routed, ctx, regen));

  assert.deepEqual(baselines, [["b › keeps"]]);
  assert.equal(closure?.closed, 1);
});

test("a recount is told the spec files of the regenerated run's passing cases, and the outcome carries which spec ran each file from the dumps it read", async () => {
  const told: unknown[] = [];
  const ranBy = [{ file: "src/store.ts", specFiles: ["flows/login.spec.ts"] }];
  const { ctx } = rig({ "flows/login.spec.ts": "l2", "flows/cart.spec.ts": "c1" }, () => ({ verdict: "pass", cases: [pass("a", "flows/login.spec.ts"), pass("c", "flows/login.spec.ts")] }));
  (ctx.deps.objectiveSignal as { recount: unknown }).recount = async (_br: unknown, _dir: string, _diff: unknown, _sources: unknown, opts: { caseFiles?: string[] }) => (told.push(opts.caseFiles), { ...RECOUNT, ranBy });
  const cases: QaCase[] = [pass("a", "flows/login.spec.ts"), { name: "b", status: "fail", file: "flows/cart.spec.ts" }, pass("c", "flows/login.spec.ts")];
  const regen = acceptedKeeping("r-acc0", ["flows/login.spec.ts"], cases);
  const first: MeasuredDumps = { namespace: "r-measure", files: [{ file: "flows/login.spec.ts", sha: H("l1") }, { file: "flows/cart.spec.ts", sha: H("c1") }], exceptTests: [] };
  const state = withDumps([first]);
  const stale = { ...state, coverage: { ...state.coverage, ranBy: [{ file: "src/store.ts", specFiles: ["flows/cart.spec.ts"] }] } } as RunState;
  const outcome = await recountAfter(stale, ctx, regen, await measureKept(stale, ctx, regen));
  assert.deepEqual(told, [["flows/login.spec.ts"]]);
  assert.deepEqual(outcome.ranBy, ranBy, "the recount's reading replaces the measurement's");
});

test("the measurement is told the spec files of the cases that passed in the measurement execution, and the run keeps which spec ran each file from the dumps it read", async () => {
  const told: unknown[] = [];
  const ranBy = [{ file: "src/store.ts", specFiles: ["flows/login.spec.ts"] }];
  const ctx = {
    deps: { objectiveSignal: { measure: async (...args: unknown[]) => (told.push((args[4] as { caseFiles?: string[] }).caseFiles), { ...RECOUNT, ranBy }), blocks: () => false } },
    input: { sha: Sha.of("abc1234"), mode: "diff" },
    cfg: { coveragePolicyMode: "signal" },
    workspace: { specDir: "/e2e" },
    services: { specRoot: { mirrorDir: "/mirror" } },
  } as unknown as WorkspaceRunContext;
  const state = initialRunState() as RunState;
  state.execution = { ...state.execution, run: { verdict: "pass", cases: [{ name: "a", status: "pass", file: "flows/login.spec.ts" }, { name: "c", status: "pass", file: "flows/cart.spec.ts" }], logs: "" } } as RunState["execution"];
  const measuredCases = [{ name: "a", status: "pass" as const, file: "flows/login.spec.ts" }, { name: "c", status: "fail" as const, file: "flows/cart.spec.ts" }];
  state.coverage = { ...state.coverage, measuredBy: { namespace: "r-measure", tests: 2, passed: ["a"], baseline: ["a"], failedOnlyUnderMeasurement: ["c"], cases: measuredCases, files: [] } };
  const out = await measureCoverage(state, ctx);
  assert.deepEqual(told, [["flows/login.spec.ts"]]);
  assert.deepEqual((out as { update: { coverage: RunState["coverage"] } }).update.coverage.ranBy, ranBy);
});

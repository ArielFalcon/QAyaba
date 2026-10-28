/* A recount describes the bytes under review however many regenerations were accepted before it: every accepted regeneration's re-runs are carried and replace the base namespace's dumps of the specs they rewrote. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureCoverage, recountAfter, type GapRegeneration } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { CoverageRerun } from "@contexts/objective-signal/application/index.ts";
import { Sha } from "@kernel/sha.ts";

const RECOUNT = { status: "pass" as const, ratio: 1, uncovered: [], untakenArms: [], measurement: { changedLines: 4, coveredChanged: 4, changedFiles: 1, mappedFiles: 1 } };

function rig() {
  const asked: CoverageRerun[][] = [];
  const ctx = {
    deps: { objectiveSignal: { recount: async (_br: unknown, _dir: string, _diff: unknown, reruns: readonly CoverageRerun[]) => (asked.push([...reruns]), RECOUNT) } },
    input: { sha: Sha.of("abc1234") },
    cfg: { coveragePolicyMode: "signal" },
    workspace: { specDir: "/e2e" },
  } as unknown as WorkspaceRunContext;
  return { ctx, asked };
}

const accepted = (namespace: string, specFile: string): GapRegeneration =>
  ({ outcome: "accepted", run: { cases: [] }, acceptanceCalls: 1, leadCorrections: 0, reruns: [{ namespace, specFiles: [specFile] }] }) as unknown as GapRegeneration;

test("a second accepted regeneration recounts the first one's spec from its regenerated dumps too", async () => {
  const { ctx, asked } = rig();
  const state = initialRunState() as RunState;
  const first = await recountAfter(state, ctx, accepted("r-acc0", "b.spec.ts"));
  const second = await recountAfter({ ...state, coverage: first }, ctx, accepted("r-acc1", "a.spec.ts"));
  assert.deepEqual(asked[1], [{ namespace: "r-acc0", specFiles: ["b.spec.ts"] }, { namespace: "r-acc1", specFiles: ["a.spec.ts"] }]);
  assert.equal(second.untakenArmsCurrent, true);
});

test("one accepted regeneration recounts from its own re-runs alone", async () => {
  const { ctx, asked } = rig();
  await recountAfter(initialRunState() as RunState, ctx, accepted("r-acc0", "a.spec.ts"));
  assert.deepEqual(asked, [[{ namespace: "r-acc0", specFiles: ["a.spec.ts"] }]]);
});

test("a regeneration that was not accepted leaves the carried re-runs as they were", async () => {
  const { ctx, asked } = rig();
  const state = initialRunState() as RunState;
  const first = await recountAfter(state, ctx, accepted("r-acc0", "b.spec.ts"));
  const rejected = await recountAfter({ ...state, coverage: first }, ctx, { outcome: "rejected", run: {}, acceptanceCalls: 2, leadCorrections: 0 } as unknown as GapRegeneration);
  assert.equal(asked.length, 1);
  assert.deepEqual(rejected.reruns, first.reruns);
});

test("a recount is told the spec files of the regenerated run's passing cases, and the outcome carries which spec ran each file from the dumps it read", async () => {
  const told: unknown[] = [];
  const ranBy = [{ file: "src/store.ts", specFiles: ["flows/login.spec.ts"] }];
  const ctx = {
    deps: { objectiveSignal: { recount: async (_br: unknown, _dir: string, _diff: unknown, _reruns: unknown, opts: { caseFiles?: string[] }) => (told.push(opts.caseFiles), { ...RECOUNT, ranBy }) } },
    input: { sha: Sha.of("abc1234") },
    cfg: { coveragePolicyMode: "signal" },
    workspace: { specDir: "/e2e" },
  } as unknown as WorkspaceRunContext;
  const cases = [{ name: "a", status: "pass", file: "flows/login.spec.ts" }, { name: "b", status: "fail", file: "flows/cart.spec.ts" }, { name: "c", status: "pass", file: "flows/login.spec.ts" }];
  const regen = { outcome: "accepted", run: { cases }, acceptanceCalls: 1, leadCorrections: 0, reruns: [{ namespace: "r-acc0", specFiles: ["flows/login.spec.ts"] }] } as unknown as GapRegeneration;
  const stale = { ...initialRunState(), coverage: { ...initialRunState().coverage, ranBy: [{ file: "src/store.ts", specFiles: ["flows/cart.spec.ts"] }] } } as RunState;
  const outcome = await recountAfter(stale, ctx, regen);
  assert.deepEqual(told, [["flows/login.spec.ts"]]);
  assert.deepEqual(outcome.ranBy, ranBy, "the recount's reading replaces the measurement's");
});

test("the measurement is told the spec files of the passing cases, and the run keeps which spec ran each file from the dumps it read", async () => {
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
  state.execution = { ...state.execution, run: { verdict: "pass", cases: [{ name: "a", status: "pass", file: "flows/login.spec.ts" }, { name: "b", status: "fail", file: "flows/cart.spec.ts" }], logs: "" } } as RunState["execution"];
  const out = await measureCoverage(state, ctx);
  assert.deepEqual(told, [["flows/login.spec.ts"]]);
  assert.deepEqual((out as { update: { coverage: RunState["coverage"] } }).update.coverage.ranBy, ranBy);
});

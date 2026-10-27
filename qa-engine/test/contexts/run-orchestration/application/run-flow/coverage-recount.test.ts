/* A recount describes the bytes under review however many regenerations were accepted before it: every accepted regeneration's re-runs are carried and replace the base namespace's dumps of the specs they rewrote. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recountAfter, type GapRegeneration } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";
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
  ({ outcome: "accepted", run: {}, acceptanceCalls: 1, leadCorrections: 0, reruns: [{ namespace, specFiles: [specFile] }] }) as unknown as GapRegeneration;

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

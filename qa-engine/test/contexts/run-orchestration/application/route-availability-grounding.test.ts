import { test } from "node:test";
import assert from "node:assert/strict";
import { availabilityGroundingOf, CHANGE_CLOSURE_BUDGET, runBaseRef } from "@contexts/run-orchestration/application/run-flow/route-availability-grounding.ts";
import { initialRunState, type RunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import type { WorkspaceRunContext } from "@contexts/run-orchestration/application/run-flow/run-context.ts";
import type { ImpactReport } from "@kernel/code/index.ts";
import { Sha } from "@kernel/sha.ts";

const HEAD = "ed28973ed28973ed28973ed28973ed28973ed289";
const DIFF = "diff --git a/src/app.routes.ts b/src/app.routes.ts\n--- a/src/app.routes.ts\n+++ b/src/app.routes.ts\n@@ -101,0 +102,1 @@\n+    canMatch: [nativeOnlyGuard],\n";

test("the run's base is its range start: the base sha, the head n commits back, else the parent", () => {
  assert.equal(runBaseRef({ headSha: HEAD, baseSha: "abc1234" }), "abc1234");
  assert.equal(runBaseRef({ headSha: HEAD, commits: 3 }), `${HEAD}~3`);
  assert.equal(runBaseRef({ headSha: HEAD }), `${HEAD}^`);
});

function ctxWith(report: ImpactReport | undefined, asked: unknown[]): WorkspaceRunContext {
  const codeGraph = {
    impactedSymbols: async (_dir: string, _changed: unknown, budget: unknown) => {
      asked.push(budget);
      return report === undefined ? { ok: false as const, error: { reason: "unindexed" } } : { ok: true as const, value: report };
    },
  };
  return {
    deps: { codeGraph, codeGraphRepoDir: "/mirror", authContext: { baseUrl: "http://dev.example", auth: { kind: "form", loginPath: "/login" } } },
    input: { sha: Sha.of(HEAD), changeSet: { anchor: { headSha: HEAD, commits: 3 } } },
    services: { specRoot: { mirrorDir: "/mirror" } },
  } as unknown as WorkspaceRunContext;
}

const stateWithDiff = (): RunState => ({ ...initialRunState(), classification: { ...initialRunState().classification, diff: DIFF } });
const symbol = (name: string, depth: number) => ({ file: "src/guards/native.ts", symbol: name, kind: "function", depth, confidence: 1 });

test("the grounding gets the run's base, the declared login page and a closure it asks for only when needed", async () => {
  const asked: unknown[] = [];
  const grounding = availabilityGroundingOf(stateWithDiff(), ctxWith({ indexedSha: HEAD, symbols: [symbol("nativeOnlyGuard", 0), symbol("caller", 2)], truncated: false, seedBasis: "lines" }, asked));
  assert.equal(grounding.baseRef, `${HEAD}~3`);
  assert.equal(grounding.loginPath, "/login");
  assert.deepEqual(asked, []);
  assert.deepEqual(await grounding.changeClosure?.(), { symbols: [{ file: "src/guards/native.ts", symbol: "nativeOnlyGuard" }, { file: "src/guards/native.ts", symbol: "caller" }], complete: true });
  assert.deepEqual(asked, [CHANGE_CLOSURE_BUDGET]);
});

test("a closure cut by its budget, reaching its depth bound or seeded by nothing is not complete", async () => {
  const closure = async (report: ImpactReport) => availabilityGroundingOf(stateWithDiff(), ctxWith(report, [])).changeClosure?.();
  assert.equal((await closure({ indexedSha: HEAD, symbols: [symbol("a", 0)], truncated: true, seedBasis: "lines" }))?.complete, false);
  assert.equal((await closure({ indexedSha: HEAD, symbols: [symbol("a", CHANGE_CLOSURE_BUDGET.depth)], truncated: false, seedBasis: "lines" }))?.complete, false);
  assert.equal((await closure({ indexedSha: HEAD, symbols: [], truncated: false, seedBasis: "none" }))?.complete, false);
  assert.equal(await availabilityGroundingOf(stateWithDiff(), ctxWith(undefined, [])).changeClosure?.(), undefined);
});

test("a run with no diff gets no base and no closure", () => {
  const grounding = availabilityGroundingOf(initialRunState(), ctxWith(undefined, []));
  assert.deepEqual(grounding, { loginPath: "/login" });
});

/* The coverage phase asks about the run's use cases and the per-candidate figures are persisted beside the ratio; they decide nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ChangeSet, deriveCandidates, type ChangeScope, type ChangeScopePort } from "@contexts/change-analysis/application/index.ts";
import type { ObjectiveSignalPort } from "@contexts/objective-signal/application/index.ts";
import { dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const FRONT = "org/front";
const FRONT_SHA = Sha.of("f111111");
const DIFF = "diff --git a/web/a.ts b/web/a.ts\n--- a/web/a.ts\n+++ b/web/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";
const SCOPE: ChangeScope = {
  repos: [{ repo: FRONT, role: "primary", indexedSha: "f111111", changedFiles: ["web/a.ts"], seeds: [], seedBasis: "lines", entryPoints: [], entryPointsTruncated: false }],
  reach: [{ entry: { kind: "page", repo: FRONT, route: "/a" }, tier: "direct", basis: "implementation", evidence: ["page /a"], seeds: [{ file: "web/a.ts", symbol: "a", range: { start: 1, end: 2 } }], confidence: 1 }],
  hubs: [], disagreements: [], omitted: 0, degraded: [],
};
const WITH_OPERATION: ChangeScope = { ...SCOPE, reach: [...SCOPE.reach, { entry: { kind: "operation", repo: FRONT, verb: "GET", path: "/orders/{id}" }, tier: "direct", basis: "handler", evidence: ["GET /orders/{id}"], seeds: [{ file: "web/a.ts", symbol: "h", range: { start: 1, end: 2 } }], confidence: 1 }] };

async function run(over: { triggerRepo?: string; withScope?: boolean; scope?: ChangeScope } = {}) {
  const rig = newRig();
  try {
    const asked: Array<Parameters<ObjectiveSignalPort["measure"]>[4]> = [];
    const changeScope: ChangeScopePort = { resolve: async () => over.scope ?? SCOPE, candidates: async ({ scope }) => deriveCandidates(scope) };
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA, ...(over.triggerRepo ? { triggerRepo: over.triggerRepo } : {}) };
    rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF, intent: { type: "feat", breaking: false, message: "m", changedFiles: ["web/a.ts"] } });
    rig.measure = async (_br, _dir, _diff, _cases, opts) => {
      asked.push(opts);
      const ids = (opts?.candidates ?? []).map((c) => c.id);
      return { status: "pass", ratio: 0.5, ...(opts?.faultAim ? { valueScore: 0.5, valueByCandidate: opts.faultAim.candidates.map((c) => ({ candidateId: c.candidateId, exposed: 2, killed: 1, ratio: 0.5 })) } : {}), measurement: { changedLines: 2, coveredChanged: 1, changedFiles: 1, mappedFiles: 1, ...(ids.length ? { perCandidate: ids.map((candidateId) => ({ candidateId, changedLines: 2, coveredChanged: 1, ratio: 0.5 })) } : {}) } };
    };
    rig.extra = { ...(over.withScope === false ? {} : { changeScope }), codeGraphRepoDir: "/m/front" };
    const observed = await observe(rig, "cov-by-candidate");
    return { observed, asked };
  } finally {
    dispose(rig);
  }
}

test("the run's candidates are asked about and their figures persisted beside the unchanged ratio", async () => {
  const { observed, asked } = await run();
  assert.equal(asked[0]?.candidates?.length, 1);
  const saved = observed.saved[0]!.gateSignals;
  assert.equal(saved.coverageRatio, 0.5);
  assert.deepEqual(saved.coverageByCandidate, [{ candidateId: asked[0]!.candidates![0]!.id, changedLines: 2, coveredChanged: 1, ratio: 0.5 }]);
});

test("a run with no candidates asks the measurement as it always did and persists no per-candidate figure", async () => {
  const { observed, asked } = await run({ withScope: false });
  assert.equal(asked[0], undefined);
  assert.equal(observed.saved[0]!.gateSignals.coverageByCandidate, undefined);
  assert.equal(observed.saved[0]!.gateSignals.coverageRatio, 0.5);
});

test("the oracle is aimed at the operations the scope reaches and its per-candidate score is persisted beside the unchanged value score", async () => {
  const { observed, asked } = await run({ scope: WITH_OPERATION });
  const aim = asked[0]?.faultAim;
  assert.equal(aim?.operations.length, 1);
  assert.equal(aim?.operations[0]?.verb, "GET");
  const saved = observed.saved[0]!.gateSignals;
  assert.equal(saved.valueScore, 0.5);
  assert.deepEqual(saved.valueByCandidate, aim!.candidates.map((c) => ({ candidateId: c.candidateId, exposed: 2, killed: 1, ratio: 0.5 })));
});

test("with no operation in reach the oracle is given no aim and the run persists no per-candidate score", async () => {
  const { observed, asked } = await run();
  assert.equal(asked[0]?.faultAim, undefined);
  assert.equal(observed.saved[0]!.gateSignals.valueByCandidate, undefined);
});

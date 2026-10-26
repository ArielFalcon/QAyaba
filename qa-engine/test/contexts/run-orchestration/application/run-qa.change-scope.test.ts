/* The change scope of a run: asked once after the cross-repo impact for every repo of the change, recorded as a span, and never the end of a run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { ChangeSet, deriveCandidates, type ChangeScope, type ChangeScopePort, type ChangeScopeRequest } from "@contexts/change-analysis/application/index.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { PlanSnapshot } from "@kernel/ports/plan-snapshot.port.ts";
import { LeadSidekicks } from "@contexts/coordination/application/lead-sidekicks.ts";
import { systemTimers } from "@contexts/coordination/application/fan-out-dispatcher.ts";
import type { DelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import type { DelegationResult } from "@contexts/coordination/application/delegation-result.ts";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import { evidence as baseEvidence } from "../../evaluation/evidence-fixtures.ts";
import type { PlanEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const FRONT = "org/front";
const BACK = "org/back";
const FRONT_SHA = Sha.of("f111111");
const BACK_SHA = Sha.of("b222222");
const DIFF = "diff --git a/web/a.ts b/web/a.ts\n--- a/web/a.ts\n+++ b/web/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";

const SCOPE: ChangeScope = {
  repos: [{ repo: FRONT, role: "primary", indexedSha: "f111111", changedFiles: ["web/a.ts"], seeds: [], seedBasis: "lines", entryPoints: [], entryPointsTruncated: false }],
  reach: [
    { entry: { kind: "page", repo: FRONT, route: "/a" }, tier: "direct", basis: "implementation", evidence: ["page /a"], seeds: [], confidence: 1 },
    { entry: { kind: "page", repo: FRONT, route: "/b" }, tier: "indirect", basis: "graph", evidence: ["x", "page /b"], seeds: [], confidence: 1 },
  ],
  hubs: [],
  disagreements: [],
  omitted: 0,
  degraded: [{ repo: BACK, reason: "walk: not indexed" }],
};

class SpanRecorder extends NoopTelemetry {
  readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  readonly candidateSpans: Array<Record<string, unknown>> = [];
  override startSpan(name?: string, opts?: StartSpanOptions): SpanHandle {
    if (name === "qayaba.change_scope") this.spans.push({ name, attrs: { ...(opts?.attrs ?? {}) } });
    if (name === "qayaba.change.candidates") this.candidateSpans.push({ ...(opts?.attrs ?? {}) });
    return super.startSpan(name, opts);
  }
}

const graph = (indexed: string[]): CodeGraphPort => ({
  syncTo: async (repoDir, sha) => {
    indexed.push(`${repoDir}@${sha}`);
    return { repo: repoDir, engine: "fake", engineVersion: "1", sha, outcome: "built", durationMs: 0, nodeCount: 1, edgeCount: 0 };
  },
  impactedSymbols: async () => { throw new Error("unused"); },
  callersOf: async () => { throw new Error("unused"); },
  routes: async () => { throw new Error("unused"); },
});

test("a diff run asks for the scope of every repo of its change, each at its own mirror and head, and records the counts per tier", async () => {
  const rig = newRig();
  try {
    const asked: ChangeScopeRequest[] = [];
    const telemetry = new SpanRecorder();
    const indexed: string[] = [];
    const changeScope: ChangeScopePort = { resolve: async (request) => { asked.push(request); return SCOPE; }, candidates: async ({ scope }) => deriveCandidates(scope) };
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: BACK, role: "service", headSha: BACK_SHA }, { repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF, intent: { type: "feat", breaking: false, message: "m", changedFiles: ["web/a.ts"] } });
    rig.extra = {
      changeScope,
      telemetry,
      codeGraph: graph(indexed),
      codeGraphRepoDir: "/m/front",
      codeGraphRepoDirs: new Map([[BACK, "/m/back"]]),
    };
    const observed = await observe(rig, "scope-asked");
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.repos.map((r) => [r.repo, r.role, r.repoDir, r.headSha]), [[BACK, "service", "/m/back", BACK_SHA.toString()], [FRONT, "primary", "/m/front", FRONT_SHA.toString()]]);
    assert.deepEqual(asked[0]!.repos[1]!.changedFiles, ["web/a.ts"]);
    assert.deepEqual([...(asked[0]!.repos[1]!.touchedLines?.get("web/a.ts") ?? [])], [2]);
    assert.deepEqual(indexed.sort(), [`/m/back@${BACK_SHA.toString()}`, `/m/front@${FRONT_SHA.toString()}`]);
    assert.equal(telemetry.spans.length, 1);
    const attrs = telemetry.spans[0]!.attrs;
    assert.equal(attrs["qayaba.change_scope.direct"], 1);
    assert.equal(attrs["qayaba.change_scope.indirect"], 1);
    assert.equal(attrs["qayaba.change_scope.cross_repo"], 0);
    assert.deepEqual(attrs["qayaba.change_scope.degraded"], [`${BACK}: walk: not indexed`]);
    assert.deepEqual(attrs["qayaba.change_scope.seed_basis"], [`${FRONT}: lines`]);
    assert.equal(telemetry.candidateSpans.length, 1);
    assert.equal(telemetry.candidateSpans[0]!["qayaba.candidates.count"], 2);
    assert.match(String((telemetry.candidateSpans[0]!["qayaba.candidates.entries"] as string[])[0]), /^uc-[0-9a-f]{8}: page \/a \[direct, page, implementation\]$/);
  } finally {
    dispose(rig);
  }
});

test("a repo of the change with no index in the run is a degraded entry of the scope, not a silent absence", async () => {
  const rig = newRig();
  try {
    let asked: ChangeScopeRequest | undefined;
    const telemetry = new SpanRecorder();
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: BACK, role: "service", headSha: BACK_SHA }, { repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.extra = { changeScope: { resolve: async (request) => { asked = request; return { ...SCOPE, degraded: [] }; }, candidates: async () => [] }, telemetry, codeGraphRepoDir: "/m/front" };
    await observe(rig, "scope-unindexed");
    assert.deepEqual(asked?.repos.map((r) => r.repo), [FRONT]);
    assert.deepEqual(telemetry.spans[0]!.attrs["qayaba.change_scope.degraded"], [`${BACK}: the repo has no index in this run`]);
  } finally {
    dispose(rig);
  }
});

test("a scope that cannot be computed never ends the run", async () => {
  const rig = newRig();
  try {
    const telemetry = new SpanRecorder();
    rig.extra = { changeScope: { resolve: async () => { throw new Error("index exploded"); }, candidates: async () => [] }, telemetry };
    const observed = await observe(rig, "scope-throws");
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.match(String(telemetry.spans[0]!.attrs["qayaba.change_scope.degraded"]), /index exploded/);
  } finally {
    dispose(rig);
  }
});

test("a run without a scope port, and a run outside diff mode, ask for no scope", async () => {
  const rig = newRig();
  try {
    let calls = 0;
    const telemetry = new SpanRecorder();
    rig.extra = { telemetry };
    assert.equal((await observe(rig, "scope-unwired")).result?.decision.verdict, "pass");
    rig.input = { mode: "manual", guidance: "check the form" };
    rig.extra = { telemetry, changeScope: { resolve: async () => { calls += 1; return SCOPE; }, candidates: async () => [] } };
    await observe(rig, "scope-manual");
    assert.equal(calls, 0);
    assert.equal(telemetry.spans.length, 0);
  } finally {
    dispose(rig);
  }
});

test("candidates that cannot be derived never end the run and leave the run without them", async () => {
  const rig = newRig();
  try {
    const telemetry = new SpanRecorder();
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.extra = { changeScope: { resolve: async () => SCOPE, candidates: async () => { throw new Error("suite unreadable"); } }, telemetry, codeGraphRepoDir: "/m/front" };
    const observed = await observe(rig, "candidates-throw");
    assert.equal(observed.result?.decision.verdict, "pass");
    assert.equal(telemetry.candidateSpans[0]!["qayaba.candidates.count"], 0);
  } finally {
    dispose(rig);
  }
});

/* The change set -> scope -> candidates -> plan snapshot -> evaluation chain, with the real coordinator and the real grading; only the ports at the process boundary are fakes. */
test("a two-entry change set reaches the evaluation: the coordinator is handed its candidates, the plan snapshot lists their states and the evaluation scores each use case", async () => {
  const rig = newRig();
  try {
    const snapshots: PlanSnapshot[] = [];
    const received: Array<readonly UseCaseCandidate[] | undefined> = [];
    const flowSpec = (id: string): string => `flows/${id}.spec.ts`;
    const coordinator = new LeadSidekicks({
      redaction: new PatternRedactionAdapter(),
      sidekick: { open: async (brief) => ({ first: delegated(brief), ask: async () => delegated(brief), dispose: async () => {} }) },
      workspaces: {
        create: async (request) => ({ dir: `/w/${request.delegationId}`, specDir: `/w/${request.delegationId}/e2e`, specRelDir: "e2e", files: 1, cut: false }),
        stage: async () => true,
        collect: async (_ws, request) => ({ copied: request.delegationId.endsWith("-flow-a") ? [...request.writablePaths] : [], refused: [], proposals: [], proposalsTotal: 0 }),
        refresh: async (_ws, request) => [...request.writablePaths],
        dispose: async () => {},
        sweepAll: async () => 0,
      },
      timers: systemTimers,
      planSnapshots: { record: (snapshot) => void snapshots.push(snapshot) },
      specFileFor: flowSpec,
    });
    const twoDirect: ChangeScope = { ...SCOPE, reach: SCOPE.reach.map((r) => ({ ...r, tier: "direct" as const })), degraded: [] };
    const changeScope: ChangeScopePort = { resolve: async () => twoDirect, candidates: async ({ scope }) => deriveCandidates(scope) };
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF, intent: { type: "feat", breaking: false, message: "m", changedFiles: ["web/a.ts"] } });
    rig.execute = async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass", file: flowSpec("a") }], logs: "" });
    rig.extra = {
      changeScope,
      codeGraphRepoDir: "/m/front",
      leadSidekicks: {
        coordinate: async (input) => {
          received.push(input.candidates);
          const [first, second] = input.candidates ?? [];
          const plan = { kind: "fanout", flows: [{ id: "a", objective: "page a", routes: ["/a"], candidates: [first!.id] }, { id: "b", objective: "page b", routes: ["/b"], candidates: [second!.id] }] };
          const result = await coordinator.coordinate({ ...input, plan: async () => ({ plan, parsed: true, timedOut: false }) });
          if (result.action === "fanout") for (const spec of result.aggregated.specs) if (!rig.ws.has(spec)) rig.ws.write(spec);
          return result;
        },
      },
    };
    const observed = await observe(rig, "scope-to-evaluation");
    assert.equal(observed.result?.decision.verdict, "pass");

    const handed = received[0] ?? [];
    assert.deepEqual(handed.map((c) => (c.entry.kind === "page" ? c.entry.route : "")).sort(), ["/a", "/b"], "the coordinator is handed the candidate of each entry of the change");

    const last = snapshots.at(-1)!;
    assert.equal(last.kind, "fanout");
    assert.deepEqual(last.candidates.map((c) => [c.id, c.state]).sort(), handed.map((c) => [c.id, "planned"]).sort(), "the snapshot lists both candidates, each answered by a flow");

    const evidence = planEvidenceOf(last, observed.result!.cases);
    const scores = new Map(gradeEvidence({ ...baseEvidence(), plan: evidence }, ["plan_candidate_coverage", "delivered_candidate_coverage"]).map((s) => [s.name, s]));
    assert.equal(scores.get("plan_candidate_coverage")?.value, 1, "both use cases were planned");
    assert.equal(scores.get("delivered_candidate_coverage")?.value, 0.5, "only the flow that delivered a passing spec counts");
    for (const c of handed) assert.match(String(scores.get("delivered_candidate_coverage")?.comment), new RegExp(`${c.id}: (delivered|planned)`));
  } finally {
    dispose(rig);
  }
});

/* The plan a run kept, read as the evaluation reads it: a flow passed when it delivered its spec and every case tied to that spec passed. */
function planEvidenceOf(snapshot: PlanSnapshot, cases: readonly QaCase[]): PlanEvidence {
  return {
    kind: snapshot.kind,
    changeRoutes: snapshot.changeRoutes,
    candidates: snapshot.candidates.map((c) => ({ id: c.id, state: c.state, ...(c.reason !== undefined ? { reason: c.reason } : {}), ...(c.pages !== undefined ? { pages: c.pages } : {}) })),
    flows: snapshot.flows.map((f) => {
      const statuses = cases.filter((c) => c.file === f.specFile).map((c) => c.status);
      return { id: f.id, visits: f.visits, candidates: f.candidates, passed: f.outcome?.kind === "delivered" && statuses.length > 0 && statuses.every((s) => s === "pass") };
    }),
  };
}

function delegated(brief: DelegationBrief): DelegationResult {
  return { delegationId: brief.delegationId, runId: brief.runId, status: "completed", summary: "wrote the spec", filesChanged: brief.scope.writablePaths.map((path) => ({ path })), evidence: [], validation: [], assumptions: [], concerns: [], unresolvedQuestions: [], recommendation: "accept", acceptance: [] };
}

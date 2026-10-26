/* The change scope of a run: asked once after the cross-repo impact for every repo of the change, recorded as a span, and never the end of a run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { ChangeSet, deriveCandidates, type ChangeScope, type ChangeScopePort, type ChangeScopeRequest } from "@contexts/change-analysis/application/index.ts";
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

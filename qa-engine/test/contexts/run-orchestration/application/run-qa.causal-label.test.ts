/* A failing diff run states whether its failure is in the change's reach: the label reaches the publication input and the persisted outcome alike, and a passing run carries none. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { ChangeSet, deriveCandidates, type ChangeScope, type ChangeScopePort } from "@contexts/change-analysis/application/index.ts";
import type { PublicationPort } from "@contexts/run-orchestration/application/ports/publication.port.ts";
import { renderIssue } from "@contexts/workspace-and-publication/domain/render-publication.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { CoordinateResult } from "@contexts/coordination/application/index.ts";
import { RIG_SPEC, dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const FRONT = "org/front";
const FRONT_SHA = Sha.of("f111111");
const DIFF = "diff --git a/web/a.ts b/web/a.ts\n--- a/web/a.ts\n+++ b/web/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";

const KNOWN = [
  { kind: "operation", repo: FRONT, verb: "GET", path: "/shops/{id}" },
  { kind: "operation", repo: FRONT, verb: "GET", path: "/orders/{id}" },
] as const;

const SCOPE: ChangeScope = {
  repos: [{ repo: FRONT, role: "primary", indexedSha: "f111111", changedFiles: ["web/a.ts"], seeds: [], seedBasis: "lines", entryPoints: [...KNOWN], entryPointsTruncated: false }],
  reach: [{ entry: KNOWN[0], tier: "direct", basis: "handler", evidence: ["GET /shops/{id}"], seeds: [], confidence: 1 }],
  hubs: [],
  disagreements: [],
  omitted: 0,
  degraded: [],
};

const failing = (path: string): QaCase => ({ name: "shop page loads", status: "fail", detail: "expect(locator).toBeVisible() timeout", networkErrors: [{ url: `https://dev.example${path}`, status: 500 }] });

async function failingRun(cases: QaCase[], flowCandidates?: Array<{ specFile: string; candidates: string[] }>) {
  const rig = newRig();
  try {
    const published: Array<Parameters<PublicationPort["publish"]>[0]> = [];
    const changeScope: ChangeScopePort = { resolve: async () => SCOPE, candidates: async ({ scope }) => deriveCandidates(scope) };
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF, intent: { type: "feat", breaking: false, message: "m", changedFiles: ["web/a.ts"] } });
    rig.execute = async () => ({ verdict: "fail", cases, logs: "" });
    rig.publish = async (input) => { published.push(input); return { outcome: "issue" }; };
    rig.extra = {
      changeScope,
      codeGraphRepoDir: "/m/front",
      ...(flowCandidates
        ? { leadSidekicks: { coordinate: async (): Promise<CoordinateResult> => ({ action: "fanout", aggregated: { end: GENERATION_END.DELIVERED, specs: [RIG_SPEC], incompleteFlows: [] }, proposals: [], signal: { plan: "fanout", flows: 1, delivered: 1, incomplete: 0 }, flowCandidates }) } }
        : {}),
    };
    const observed = await observe(rig, "causal");
    return { observed, published };
  } finally {
    dispose(rig);
  }
}

test("a failure on an operation the change reaches is labelled in reach in the Issue and the persisted outcome", async () => {
  const { observed, published } = await failingRun([failing("/api/shops/9")]);
  assert.equal(published.length, 1);
  const label = published[0]!.causal;
  assert.equal(label?.reach, "in-reach");
  assert.equal(label?.basis, "request");
  assert.deepEqual(observed.saved[0]!.gateSignals.causal, label);
  const body = renderIssue({ verdict: "fail", cases: published[0]!.cases, ...(label ? { causal: label } : {}) });
  assert.match(body, /Change reach\n- Reach: in the change's reach\n- Basis: request\n- Via: `GET \/shops\/\{id\}`/);
});

test("a failure on a known operation outside the reach is labelled out of reach, and the run still opens its Issue", async () => {
  const { observed, published } = await failingRun([failing("/orders/3")]);
  assert.equal(published[0]!.causal?.reach, "out-of-reach");
  assert.equal(observed.saved[0]!.gateSignals.causal?.reach, "out-of-reach");
  assert.equal(observed.result?.decision.verdict, "fail");
});

test("a failure with no evidence the scope can place is labelled unknown", async () => {
  const { published } = await failingRun([{ name: "t", status: "fail" }]);
  assert.equal(published[0]!.causal?.reach, "unknown");
});

test("a failing case with no request or page evidence is in reach by the flow written for the change", async () => {
  const { observed, published } = await failingRun([{ name: "t", status: "fail", file: RIG_SPEC }], [{ specFile: RIG_SPEC, candidates: ["uc-0000aaaa"] }]);
  assert.equal(published[0]!.causal?.reach, "in-reach");
  assert.equal(published[0]!.causal?.basis, "flow");
  assert.deepEqual(published[0]!.causal?.via, ["uc-0000aaaa"]);
  assert.deepEqual(observed.saved[0]!.gateSignals.causal, published[0]!.causal);
});

test("a passing run carries no label", async () => {
  const rig = newRig();
  try {
    const observed = await observe(rig, "no-label");
    assert.equal(observed.saved[0]!.gateSignals.causal, undefined);
  } finally {
    dispose(rig);
  }
});

/* A contradiction the provider's contract does not declare, on a page the change reaches, is a defect of the run: a green suite does not make the run pass, and the Issue says why. Anything weaker stays a possible contradiction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import { ChangeSet, deriveCandidates, type ChangeScope, type ChangeScopePort } from "@contexts/change-analysis/application/index.ts";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import { dispose, newRig, observe } from "./run-flow/run-end-rig.ts";
import { contradictionFact } from "../../../support/data-contradiction.ts";

const FRONT = "org/front";
const FRONT_SHA = Sha.of("f111111");
const DIFF = "diff --git a/web/a.ts b/web/a.ts\n--- a/web/a.ts\n+++ b/web/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";

const BROWSE = { kind: "page", repo: FRONT, route: "/browse" } as const;
const ABOUT = { kind: "page", repo: FRONT, route: "/about" } as const;

const SCOPE: ChangeScope = {
  repos: [{ repo: FRONT, role: "primary", indexedSha: "f111111", changedFiles: ["web/a.ts"], seeds: [], seedBasis: "lines", entryPoints: [BROWSE, ABOUT], entryPointsTruncated: false }],
  reach: [{ entry: BROWSE, tier: "direct", basis: "handler", evidence: ["/browse"], seeds: [], confidence: 1 }],
  hubs: [],
  disagreements: [],
  omitted: 0,
  degraded: [],
};

async function run(facts: DataContradiction[], opts: { scope?: boolean } = {}) {
  const rig = newRig();
  try {
    const published: Array<Parameters<PublicationPort["publish"]>[0]> = [];
    const changeScope: ChangeScopePort = { resolve: async () => SCOPE, candidates: async ({ scope }) => deriveCandidates(scope) };
    rig.input = { changeSet: ChangeSet.of("demo", [{ repo: FRONT, role: "primary", headSha: FRONT_SHA }]), sha: FRONT_SHA };
    rig.classify = async () => ({ action: "generate", reason: "x", diff: DIFF, intent: { type: "feat", breaking: false, message: "m", changedFiles: ["web/a.ts"] } });
    rig.publish = async (input) => { published.push(input); return { outcome: "published" }; };
    rig.extra = {
      ...(opts.scope === false ? {} : { changeScope, codeGraphRepoDir: "/m/front" }),
      preGenerationGrounding: { ground: async () => ({ dataContradictions: { read: 3, facts } }) },
    };
    const observed = await observe(rig, "defects");
    return { observed, published };
  } finally {
    dispose(rig);
  }
}

test("a green run with a contradiction the provider's contract lacks, on a page the change reaches, ends fail and opens an Issue that lists it", async () => {
  const { observed, published } = await run([contradictionFact({ route: "/browse" })]);
  assert.equal(observed.result?.decision.verdict, "fail");
  assert.equal(observed.result?.decision.sideEffect, "issue");
  assert.equal(published[0]!.verdict, "fail");
  assert.deepEqual(published[0]!.defects?.map((d) => [d.fact.key, d.basis, d.via]), [["category", "page", ["page /browse"]]]);
  assert.equal(published[0]!.dataContradictions, undefined, "a defect is listed once, not again among the possible contradictions");
  assert.equal(published[0]!.cases.every((c) => c.status === "pass"), true, "no test failed");
});

test("the persisted outcome records the verdict, the defects found and no error class for them", async () => {
  const { observed } = await run([contradictionFact({ route: "/browse" })]);
  const saved = observed.saved[0]!;
  assert.equal(saved.verdict, "fail");
  assert.equal(saved.errorClass, null, "an engine fault it is not: no class the process audit counts");
  assert.equal(saved.gateSignals.defects?.found, 1);
  assert.deepEqual(saved.gateSignals.defects?.facts.map((f) => [f.route, f.key, f.basis]), [["/browse", "category", "page"]]);
  assert.equal(saved.gateSignals.dataContradictions?.found, 1, "the contradiction is still recorded as read");
});

test("a contradiction the provider's contract declares, or one on a page the change does not reach, leaves the run green", async () => {
  for (const fact of [contradictionFact({ route: "/browse", provider: "provider-declared-absent" }), contradictionFact({ route: "/about" })]) {
    const { observed, published } = await run([fact]);
    assert.equal(observed.result?.decision.verdict, "pass", fact.provider + fact.route);
    assert.equal(published[0]!.defects, undefined);
    assert.equal(observed.saved[0]!.gateSignals.defects, undefined);
  }
});

test("a run with no scope to place the contradiction in finds no defect", async () => {
  const { observed } = await run([contradictionFact({ route: "/browse" })], { scope: false });
  assert.equal(observed.result?.decision.verdict, "pass");
  assert.equal(observed.saved[0]!.gateSignals.defects, undefined);
});

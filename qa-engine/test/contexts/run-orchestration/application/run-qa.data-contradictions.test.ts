/* The data contradictions the grounding recorded reach the reviewer as facts it may cite, verify its citation, are persisted as a gate signal and listed in the PR; none of them decides the verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicationPort } from "@contexts/workspace-and-publication/application/index.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import { dispose, newRig, observe } from "./run-flow/run-end-rig.ts";

const FACT: DataContradiction = {
  route: "/browse",
  key: "category",
  carriedBy: { operation: "GET https://app.example/api/items", items: 40 },
  missingFrom: { operation: "GET https://app.example/api/items/by-region/ES", items: 12 },
  schemaBacked: false,
};

async function run(opts: { facts?: DataContradiction[]; review?: ReviewPort["review"] } = {}) {
  const rig = newRig();
  try {
    let enrichment: Parameters<ReviewPort["review"]>[3];
    let published: Parameters<PublicationPort["publish"]>[0] | undefined;
    rig.config = { reviewLoopIntegrity: true };
    rig.extra = { preGenerationGrounding: { ground: async () => ({ dataContradictions: { read: 3, facts: opts.facts ?? [FACT] } }) } };
    rig.review = async (...args) => {
      enrichment = args[3];
      return opts.review ? opts.review(...args) : { approved: true, corrections: [], blockingCount: 0, parsed: true };
    };
    rig.publish = async (decision) => {
      published = decision;
      return { outcome: "pr" };
    };
    const observed = await observe(rig, "data-contradictions");
    return { observed, enrichment, published };
  } finally {
    dispose(rig);
  }
}

test("the contradictions are persisted as a gate signal beside the pages read, the reviewer is given them, and the PR lists them", async () => {
  const { observed, enrichment, published } = await run();
  const signal = observed.saved[0]!.gateSignals.dataContradictions;
  assert.equal(signal?.pages, 3);
  assert.equal(signal?.found, 1);
  assert.equal(signal?.facts[0]?.key, "category");
  assert.deepEqual(enrichment?.dataContradictions?.map((f) => f.key), ["category"]);
  assert.deepEqual(published?.dataContradictions?.map((f) => f.key), ["category"]);
  assert.equal(observed.result?.decision.verdict, "pass", "a contradiction decides no verdict");
});

test("pages read with no contradiction are recorded as read, and nothing is given to the reviewer or listed", async () => {
  const { observed, enrichment, published } = await run({ facts: [] });
  assert.equal(observed.saved[0]!.gateSignals.dataContradictions?.pages, 3);
  assert.equal(observed.saved[0]!.gateSignals.dataContradictions?.found, 0);
  assert.equal(enrichment?.dataContradictions, undefined);
  assert.equal(published?.dataContradictions, undefined);
});

test("a blocking finding that cites a contradiction the run recorded is verified and rejects the review; one citing an unrecorded key is dropped", async () => {
  const rejection = (ref: string): ReviewPort["review"] => async () => ({
    approved: false,
    corrections: ["[false-positive] the spec guards its ordering check with `if (offered.length > 0)` over a source the run saw contradict itself"],
    severities: ["blocking"],
    citations: [{ kind: "contradiction", ref }],
    blockingCount: 1,
    parsed: true,
  });
  const verified = await run({ review: rejection("/browse#category") });
  assert.equal(verified.published?.reviewerApproved, false, "the verified finding stands");
  const unrecorded = await run({ review: rejection("/browse#zone") });
  assert.equal(unrecorded.published?.reviewerApproved, true, "a citation of a fact the run does not hold blocks nothing");
});

test("a run whose grounding recorded no response shape persists no contradiction signal, as before", async () => {
  const rig = newRig();
  try {
    rig.extra = { preGenerationGrounding: { ground: async () => ({}) } };
    const observed = await observe(rig, "no-shapes");
    assert.equal(observed.saved[0]!.gateSignals.dataContradictions, undefined);
  } finally {
    dispose(rig);
  }
});

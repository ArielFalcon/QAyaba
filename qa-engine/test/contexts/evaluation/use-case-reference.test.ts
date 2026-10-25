/* The reference set of use cases: what a file must hold, how a run's commit finds its change, and which use cases a run could cover. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUseCaseReference, reachableUseCases, referenceFor } from "@contexts/evaluation/domain/use-case-reference.ts";

const SET = {
  app: "shop",
  changes: [
    {
      sha: "ab922ad43b47b0e8b7b7039632406e486469c5ba",
      base: "157337b8",
      summary: "tell a missing product from a failed load",
      useCases: [
        { id: "missing", description: "an unknown product shows the not-found state and a search CTA", reachability: "dev", routes: ["/p/:slug"] },
        { id: "failed", description: "a failed load shows the error and a retry CTA", reachability: "fault-injection", routes: ["/p/:slug"], why: "only when the product request fails" },
      ],
    },
    { sha: "e20a5d0a", summary: "unit tests only", useCases: [] },
  ],
};

test("a reference set is read with its changes and use cases, and a change with none is kept", () => {
  const set = parseUseCaseReference(SET, "shop.json");
  assert.equal(set.app, "shop");
  assert.deepEqual(set.changes.map((c) => [c.sha.slice(0, 8), c.useCases.length]), [["ab922ad4", 2], ["e20a5d0a", 0]]);
  assert.deepEqual(set.changes[0]!.useCases[1], { id: "failed", description: "a failed load shows the error and a retry CTA", reachability: "fault-injection", routes: ["/p/:slug"], why: "only when the product request fails" });
});

test("a file that does not hold a reference set is refused, naming what is wrong", () => {
  const bad = (over: unknown, pattern: RegExp) => assert.throws(() => parseUseCaseReference(over, "x.json"), pattern);
  bad([], /object/);
  bad({ changes: [] }, /app is required/);
  bad({ app: "shop", changes: [{ sha: "xyz", summary: "s", useCases: [] }] }, /sha/);
  bad({ app: "shop", changes: [{ sha: "abcdef12", summary: "s" }] }, /useCases is a list/);
  bad({ app: "shop", changes: [{ sha: "abcdef12", summary: "s", useCases: [{ id: "a", description: "d", reachability: "maybe" }] }] }, /reachability is one of/);
  bad({ app: "shop", changes: [{ sha: "abcdef12", summary: "s", useCases: [{ id: "a", description: "d", reachability: "not-e2e" }] }] }, /says why/);
  bad({ app: "shop", changes: [{ sha: "abcdef12", summary: "s", useCases: [{ id: "a", description: "d", reachability: "dev" }, { id: "a", description: "e", reachability: "dev" }] }] }, /unique/);
});

test("a run finds its change by app and commit, a short sha matching a full one, and never another app's", () => {
  const sets = [parseUseCaseReference(SET, "shop.json"), parseUseCaseReference({ ...SET, app: "other" }, "other.json")];
  assert.equal(referenceFor(sets, "shop", "ab922ad4")?.summary, "tell a missing product from a failed load");
  assert.equal(referenceFor(sets, "shop", "E20A5D0A0000000000000000000000000000000")?.summary, "unit tests only");
  assert.equal(referenceFor(sets, "shop", "ab922a"), undefined, "a sha shorter than seven characters names nothing");
  assert.equal(referenceFor(sets, "nobody", "ab922ad4"), undefined);
});

test("only the use cases reachable on dev are ones a run could cover", () => {
  const change = parseUseCaseReference(SET, "shop.json").changes[0]!;
  assert.deepEqual(reachableUseCases(change).map((u) => u.id), ["missing"]);
});

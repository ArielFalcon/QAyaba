import { test } from "node:test";
import assert from "node:assert/strict";
import { correctionClassOf } from "@contexts/generation/domain/review-output.ts";

test("the correction class is the closed tag the reviewer was told to use", () => {
  assert.equal(correctionClassOf(["[false-positive] the list is never asserted"]), "false-positive");
  assert.equal(correctionClassOf(["[wrong-objective] this spec tests auth, not the label rename"]), "wrong-objective");
  assert.equal(correctionClassOf(["[fragile-selector] scope the locator"]), "fragile-selector");
  assert.equal(correctionClassOf(["[no-cleanup] namespaced data is left behind"]), "no-cleanup");
  assert.equal(correctionClassOf(["[other] it calls a delete endpoint"]), "other");
});

test("the first tagged correction wins, and an untagged correction is other", () => {
  assert.equal(correctionClassOf(["[fragile-selector] first", "[wrong-objective] second"]), "fragile-selector");
  assert.equal(correctionClassOf(["the list is never asserted"]), "other");
});

test("no corrections is none, never a fabricated class", () => {
  assert.equal(correctionClassOf([]), "none");
});

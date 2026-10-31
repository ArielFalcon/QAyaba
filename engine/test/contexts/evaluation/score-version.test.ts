import { test } from "node:test";
import assert from "node:assert/strict";
import { currentScores, type Score } from "@contexts/evaluation/domain/score.ts";

const score = (name: string, graderVersion: string, over: Partial<Score> = {}): Score => ({ name, value: 1, dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", graderVersion, ...over });

test("the newest grader version of each name wins, compared as numbers when they are", () => {
  const scores = [score("a", "9", { value: 0.1 }), score("a", "10", { value: 0.9 }), score("b", "2")];
  assert.deepEqual(currentScores(scores, { allVersions: false }).map((s) => [s.name, s.graderVersion]), [["a", "10"], ["b", "2"]]);
});

test("versions that are not numbers compare as numeric-aware text", () => {
  const scores = [score("a", "v2"), score("a", "v10"), score("a", "v9")];
  assert.deepEqual(currentScores(scores, { allVersions: false }).map((s) => s.graderVersion), ["v10"]);
});

test("a human label shows only with all versions, and all versions come back as stored", () => {
  const scores = [score("a", "1"), score("a", "human", { source: "human" }), score("only-human", "human", { source: "human" })];
  assert.deepEqual(currentScores(scores, { allVersions: false }).map((s) => s.name), ["a"]);
  assert.deepEqual(currentScores(scores, { allVersions: true }), scores);
});

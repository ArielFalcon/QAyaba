import { test } from "node:test";
import assert from "node:assert/strict";
import { GRADER_CATALOG, specOfScore, scoreOf, STEP_INTENTS, CONTEXT_SOURCES, MAX_SCORE_COMMENT_CHARS, isGradedName } from "@contexts/evaluation/domain/grader-catalog.ts";
import { GRADERS, gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import { RUN_PHASES } from "@contexts/run-orchestration/domain/run-phase-cursor.ts";
import { evidence } from "./evidence-fixtures.ts";

test("every name a grader can emit is a catalog base name", () => {
  for (const g of GRADERS) for (const n of g.names) assert.ok(GRADER_CATALOG.some((s) => s.name === n), n);
});

test("every graded catalog entry has a grader, and the pending ones have none", () => {
  const emitted = new Set(GRADERS.flatMap((g) => g.names));
  for (const s of GRADER_CATALOG) assert.equal(emitted.has(s.name), s.state === "graded", s.name);
});

test("every score a grader emits conforms to its catalog entry", () => {
  const e = evidence({ stepIntents: { auth: 1, explore: 2 }, limit: { fired: "step-cap", role: "r", intent: "explore" } });
  for (const s of gradeEvidence(e)) {
    const spec = specOfScore(s.name);
    assert.ok(spec, s.name);
    assert.equal(s.dataType, spec.dataType);
    assert.equal(s.polarity, spec.polarity);
    assert.equal(s.graderVersion, spec.graderVersion);
    assert.equal(s.source, "deterministic");
  }
});

test("a family suffix inherits its base and an unknown suffix or name has no spec", () => {
  assert.equal(specOfScore("step_intent_mix.auth")?.name, "step_intent_mix");
  assert.equal(specOfScore("context_utilization.dom")?.name, "context_utilization");
  assert.equal(specOfScore("step_intent_mix.nope"), undefined);
  assert.equal(specOfScore("spec_pass_rate.dom"), undefined);
  assert.equal(specOfScore("nonsense"), undefined);
  assert.throws(() => scoreOf({ name: "nonsense", value: 1 }));
});

test("the family suffixes are the closed sets of the contract", () => {
  assert.deepEqual([...STEP_INTENTS], ["auth", "explore", "write_spec", "run_spec", "review", "other"]);
  assert.deepEqual([...CONTEXT_SOURCES], ["route", "dom", "op", "file"]);
});

test("furthest_phase declares the canonical phase order as its categories", () => {
  assert.deepEqual([...(specOfScore("furthest_phase")?.categories ?? [])], [...RUN_PHASES]);
});

test("every boolean score is pass-oriented (higher is better)", () => {
  for (const s of GRADER_CATALOG.filter((x) => x.dataType === "BOOLEAN")) assert.equal(s.polarity, "higher_better", s.name);
});

test("a score comment is capped at the catalog limit", () => {
  const score = scoreOf({ name: "spec_pass_rate", value: 1, comment: "x".repeat(MAX_SCORE_COMMENT_CHARS * 4) });
  assert.equal(score.comment?.length, MAX_SCORE_COMMENT_CHARS);
});

test("pending catalog entries are not graded names, graded ones are", () => {
  assert.equal(isGradedName("context_utilization"), true);
  assert.equal(isGradedName("context_complete"), true);
  assert.equal(isGradedName("selector_stability"), false);
  assert.equal(isGradedName("spec_pass_rate"), true);
  assert.equal(isGradedName("nonsense"), false);
});

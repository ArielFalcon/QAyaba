import { test } from "node:test";
import assert from "node:assert/strict";
import { GRADER_CATALOG } from "@contexts/evaluation/application/index.ts";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import { evidence } from "./evidence-fixtures.ts";

test("the grader catalog lists no mutation_value and grading a finished run emits none", () => {
  assert.equal(GRADER_CATALOG.some((s) => s.name === "mutation_value"), false);
  assert.equal(gradeEvidence(evidence()).some((s) => s.name === "mutation_value"), false);
  assert.deepEqual(gradeEvidence(evidence(), ["mutation_value"]), []);
});

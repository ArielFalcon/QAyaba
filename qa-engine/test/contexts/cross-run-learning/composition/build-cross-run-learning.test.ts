/* buildCrossRunLearning: each optional port is served only when supplied. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrossRunLearning } from "@contexts/cross-run-learning/composition/build-cross-run-learning.ts";

test("a composition with no collaborator serves no port", () => {
  const api = buildCrossRunLearning({});

  assert.equal(api.curriculum, undefined);
  assert.equal(api.processAudit, undefined);
});

test("the supplied optional ports are served as they are", () => {
  const curriculum = {} as never;
  const processAudit = {} as never;

  const api = buildCrossRunLearning({ curriculum, processAudit });

  assert.equal(api.curriculum, curriculum);
  assert.equal(api.processAudit, processAudit);
});

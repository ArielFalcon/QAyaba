/* buildCrossRunLearning: the optional port is served only when supplied. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrossRunLearning } from "@contexts/cross-run-learning/composition/build-cross-run-learning.ts";

test("a composition with no collaborator serves no port", () => {
  const api = buildCrossRunLearning({});

  assert.equal(api.processAudit, undefined);
});

test("the supplied port is served as it is", () => {
  const processAudit = {} as never;

  const api = buildCrossRunLearning({ processAudit });

  assert.equal(api.processAudit, processAudit);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mayHaveLeftTestData } from "@contexts/run-orchestration/domain/orphan-test-data.ts";

test("a run still enqueued or running when the next one comes, or ended as infra-error, may have left test data; one with a verdict of its own did not", () => {
  assert.equal(mayHaveLeftTestData({ status: "running" }), true);
  assert.equal(mayHaveLeftTestData({ status: "enqueued" }), true);
  assert.equal(mayHaveLeftTestData({ status: "done", verdict: "infra-error" }), true);
  assert.equal(mayHaveLeftTestData({ status: "done", verdict: "pass" }), false);
  assert.equal(mayHaveLeftTestData({ status: "done", verdict: null }), false);
});

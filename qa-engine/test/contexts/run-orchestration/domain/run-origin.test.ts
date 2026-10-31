import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOfTrigger } from "@contexts/run-orchestration/domain/run-origin.ts";

test("only a deploy's webhook is a webhook source; a control-API run is manual", () => {
  assert.equal(sourceOfTrigger("webhook"), "webhook");
  assert.equal(sourceOfTrigger("api"), "manual");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunEventSchema, type RunEvent } from "@contexts/run-orchestration/domain/run-event.ts";

test("RunEvent re-exports the frozen wire schema and parses a valid envelope", () => {
  const ev: RunEvent = RunEventSchema.parse({
    seq: 0, runId: "r1", ts: 0,
    body: { type: "run.verdict", verdict: "pass", engineStatus: "success" },
  });
  assert.equal(ev.body.type, "run.verdict");
});

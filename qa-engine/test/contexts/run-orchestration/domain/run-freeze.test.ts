/* The freeze is one function of the run request: the campaign identity and the lessons lever decide it, never a label or the process environment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRunFreeze } from "@contexts/run-orchestration/domain/run-freeze.ts";

const campaign = (variant: Record<string, string> = {}) => ({ id: "ab-1", variant, replicate: 1 });

test("a run without a campaign is not frozen and reads lessons", () => {
  assert.deepEqual(decideRunFreeze({}), { frozen: false, lessons: true });
});

test("a campaign-tagged run is frozen and reads no lessons unless its request declares the learning arm", () => {
  assert.deepEqual(decideRunFreeze({ campaign: campaign() }), { frozen: true, lessons: false });
});

test("the lessons lever lifts the lesson state only: a campaign-tagged run stays frozen", () => {
  assert.deepEqual(decideRunFreeze({ campaign: campaign(), grounding: { lessons: true } }), { frozen: true, lessons: true });
  assert.deepEqual(decideRunFreeze({ campaign: campaign(), grounding: { lessons: false } }), { frozen: true, lessons: false });
});

test("a run without a campaign may switch lessons off, and is still not frozen", () => {
  assert.deepEqual(decideRunFreeze({ grounding: { lessons: false } }), { frozen: false, lessons: false });
  assert.deepEqual(decideRunFreeze({ grounding: { stitcher: false } }), { frozen: false, lessons: true });
});

test("variant labels never change the decision", () => {
  assert.deepEqual(decideRunFreeze({ campaign: campaign({ arm: "treatment", lessons: "on" }) }), decideRunFreeze({ campaign: campaign({ arm: "control" }) }));
});

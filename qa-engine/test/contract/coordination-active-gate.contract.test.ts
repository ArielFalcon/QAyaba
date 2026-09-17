/* Delegation gates: pre-generate + FixLoop regen. Points are independent; coordination is
   the single operating mode (no advisory downgrade exists anymore).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COORDINATION_ACTIVE_POINTS,
  shouldHonorActiveDelegation,
  shouldHonorFixLoopSidekick,
  proposeFromDecision,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

const delegate = {
  action: "delegate" as const,
  reason: "hard",
  evidence: [],
  nextCapability: "sidekick-standard" as const,
};

test("governing points list pre-generate and fix-loop-regen separately", () => {
  assert.deepEqual([...COORDINATION_ACTIVE_POINTS], ["pre-generate", "fix-loop-regen"]);
});

test("delegate proposal is honored only at an enabled point with a sidekick", () => {
  const proposal = proposeFromDecision(delegate);
  assert.equal(
    shouldHonorActiveDelegation({
      proposal,
      enabledPoints: ["pre-generate"],
      point: "pre-generate",
      sidekickAvailable: true,
    }),
    true,
  );
  assert.equal(
    shouldHonorActiveDelegation({
      proposal,
      enabledPoints: [],
      point: "pre-generate",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorActiveDelegation({
      proposal,
      enabledPoints: ["pre-generate"],
      point: "pre-generate",
      sidekickAvailable: false,
    }),
    false,
  );
});

test("direct path is never honored as delegation", () => {
  assert.equal(
    shouldHonorActiveDelegation({
      proposal: proposeFromDecision({
        action: "direct",
        reason: "simple",
        evidence: [],
      }),
      enabledPoints: ["pre-generate"],
      point: "pre-generate",
      sidekickAvailable: true,
    }),
    false,
  );
});

test("fix-loop-regen sidekick is honored only with that point enabled", () => {
  assert.equal(
    shouldHonorFixLoopSidekick({
      enabledPoints: ["fix-loop-regen"],
      capability: "sidekick-standard",
      sidekickAvailable: true,
    }),
    true,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      enabledPoints: ["pre-generate"],
      capability: "sidekick-standard",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      enabledPoints: ["fix-loop-regen"],
      capability: "lead",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      enabledPoints: ["fix-loop-regen"],
      capability: "sidekick-escalated",
      sidekickAvailable: false,
    }),
    false,
  );
});

// Controlled active gates (Fase 13 pre-generate + Fase 8 FixLoop regen). Points are independent.
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

test("active points list pre-generate and fix-loop-regen separately", () => {
  assert.deepEqual([...COORDINATION_ACTIVE_POINTS], ["pre-generate", "fix-loop-regen"]);
});

test("shadow proposals are never honored even with points and sidekick", () => {
  assert.equal(
    shouldHonorActiveDelegation({
      proposal: proposeFromDecision("shadow", delegate),
      enabledPoints: ["pre-generate"],
      point: "pre-generate",
      sidekickAvailable: true,
    }),
    false,
  );
});

test("active delegate is honored only at an enabled point with a sidekick", () => {
  const proposal = proposeFromDecision("active", delegate);
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

test("active direct path is never honored as delegation", () => {
  assert.equal(
    shouldHonorActiveDelegation({
      proposal: proposeFromDecision("active", {
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

test("fix-loop-regen sidekick is honored only in active with that point enabled", () => {
  assert.equal(
    shouldHonorFixLoopSidekick({
      coordinationMode: "active",
      enabledPoints: ["fix-loop-regen"],
      capability: "sidekick-standard",
      sidekickAvailable: true,
    }),
    true,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      coordinationMode: "shadow",
      enabledPoints: ["fix-loop-regen"],
      capability: "sidekick-standard",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      coordinationMode: "active",
      enabledPoints: ["pre-generate"],
      capability: "sidekick-standard",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      coordinationMode: "active",
      enabledPoints: ["fix-loop-regen"],
      capability: "lead",
      sidekickAvailable: true,
    }),
    false,
  );
  assert.equal(
    shouldHonorFixLoopSidekick({
      coordinationMode: "active",
      enabledPoints: ["fix-loop-regen"],
      capability: "sidekick-escalated",
      sidekickAvailable: false,
    }),
    false,
  );
});

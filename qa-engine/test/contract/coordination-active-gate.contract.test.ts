// Controlled active pre-generate gate (Fase 13).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldHonorActiveDelegation,
  proposeFromDecision,
} from "@contexts/qa-run-orchestration/application/coordination/index.ts";

const delegate = {
  action: "delegate" as const,
  reason: "hard",
  evidence: [],
  nextCapability: "sidekick-standard" as const,
};

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

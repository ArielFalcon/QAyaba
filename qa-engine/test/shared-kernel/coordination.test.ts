import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COORDINATION_SETTINGS, resolveCoordinationSettings } from "@kernel/coordination.ts";

test("an app that declares nothing runs with the default limits", () => {
  assert.deepEqual(resolveCoordinationSettings(), DEFAULT_COORDINATION_SETTINGS);
});

test("a limit an app leaves out is the default, and one it sets is its own", () => {
  const settings = resolveCoordinationSettings({ maxFlows: 4, flowBudgetMs: { opencode: 90_000 } });
  assert.equal(settings.maxFlows, 4);
  assert.equal(settings.maxParallel, DEFAULT_COORDINATION_SETTINGS.maxParallel);
  assert.equal(settings.planBudgetMs, DEFAULT_COORDINATION_SETTINGS.planBudgetMs);
  assert.equal(settings.flowBudgetMs.opencode, 90_000);
  assert.equal(settings.flowBudgetMs.codex, DEFAULT_COORDINATION_SETTINGS.flowBudgetMs.codex);
});

test("the defaults themselves are never shared with a resolved setting", () => {
  const settings = resolveCoordinationSettings();
  settings.flowBudgetMs.opencode = 1;
  assert.notEqual(DEFAULT_COORDINATION_SETTINGS.flowBudgetMs.opencode, 1);
});

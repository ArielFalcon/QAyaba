import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COORDINATION_MODE,
  DEFAULT_COORDINATION_SETTINGS,
  effectiveCoordinationMode,
  isCoordinationMode,
  resolveCoordinationSettings,
} from "@kernel/coordination.ts";

test("an app that declares nothing runs in the single mode with the default limits", () => {
  assert.deepEqual(resolveCoordinationSettings(), DEFAULT_COORDINATION_SETTINGS);
  assert.equal(resolveCoordinationSettings().mode, COORDINATION_MODE.SINGLE);
});

test("a limit an app leaves out is the default, and one it sets is its own", () => {
  const settings = resolveCoordinationSettings({ mode: COORDINATION_MODE.LEAD_SIDEKICKS, maxFlows: 4, flowBudgetMs: { opencode: 90_000 } });
  assert.equal(settings.mode, COORDINATION_MODE.LEAD_SIDEKICKS);
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

test("a run's own choice wins over the app's setting, in either direction, and absent leaves the app's", () => {
  const app = { mode: COORDINATION_MODE.SINGLE };
  assert.equal(effectiveCoordinationMode(app, COORDINATION_MODE.LEAD_SIDEKICKS), COORDINATION_MODE.LEAD_SIDEKICKS);
  assert.equal(effectiveCoordinationMode({ mode: COORDINATION_MODE.LEAD_SIDEKICKS }, COORDINATION_MODE.SINGLE), COORDINATION_MODE.SINGLE);
  assert.equal(effectiveCoordinationMode(app), COORDINATION_MODE.SINGLE);
  assert.equal(effectiveCoordinationMode({ mode: COORDINATION_MODE.LEAD_SIDEKICKS }), COORDINATION_MODE.LEAD_SIDEKICKS);
});

test("only the two modes are modes", () => {
  assert.equal(isCoordinationMode("single"), true);
  assert.equal(isCoordinationMode("lead-sidekicks"), true);
  assert.equal(isCoordinationMode("swarm"), false);
  assert.equal(isCoordinationMode(undefined), false);
});

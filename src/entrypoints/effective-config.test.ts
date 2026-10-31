import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../composition/config-loader";
import { buildEffectiveConfig, parseStoredRunConfig, resolveRunConfig, type RunConfigEnvironment } from "./effective-config";

const env: RunConfigEnvironment = { runtime: () => "opencode", staticPromptHash: () => "sha256:x", toolsGranted: true, maxCapture: "full" };
const app = (over: Record<string, unknown> = {}, qa: Record<string, unknown> = {}): AppConfig =>
  ({ name: "a", repo: "o/a", dev: { baseUrl: "https://dev" }, qa: { needsReview: true, testDataPrefix: "qa", ...qa }, report: { onFailure: "x" }, ...over }) as AppConfig;

test("the freeze and the lessons arm are recorded from the request: a campaign freezes the run, the lever lifts the lesson state only", () => {
  const campaign = { id: "c", variant: {}, replicate: 1 };
  const record = (request: Parameters<typeof resolveRunConfig>[1]) => { const c = resolveRunConfig(app(), request, "metadata", env); return [c.campaignFreeze, c.grounding.lessons]; };
  assert.deepEqual(record({}), [false, true]);
  assert.deepEqual(record({ campaign }), [true, false]);
  assert.deepEqual(record({ campaign, grounding: { lessons: true } }), [true, true]);
  assert.deepEqual(record({ grounding: { lessons: false } }), [false, false]);
});

test("parseStoredRunConfig of an old record reads a missing domPack as null and leaves out the keys this version no longer records (kept parseable)", () => {
  const old = JSON.stringify({
    levers: { closedLoop: null, agentBrowser: null, captureMode: null },
    campaignFreeze: null,
    runtime: null,
    prompt: { staticHash: null },
    grounding: { explorer: false, stitcher: null, structuralSignal: "signal", curriculum: "learning" },
    coverage: { mode: "signal", minRatio: 0.7 },
    reflector: true,
  });
  assert.equal(parseStoredRunConfig(old)?.grounding.domPack, null);
  assert.deepEqual(parseStoredRunConfig(old)?.grounding, { stitcher: null, domPack: null, lessons: null });
  assert.equal("reflector" in (parseStoredRunConfig(old) ?? {}), false);
});

test("a stored configuration round-trips, and malformed or missing storage reads as nothing recorded", () => {
  const stored = resolveRunConfig(app(), {}, "metadata", env);
  assert.deepEqual(parseStoredRunConfig(JSON.stringify(stored)), stored);
  assert.equal(parseStoredRunConfig(null), undefined);
  assert.equal(parseStoredRunConfig("{nope"), undefined);
});

test("the coverage the engine reported at the end wins over the one the run started with, and the capture column fills a run that stored nothing", () => {
  const stored = resolveRunConfig(app(), {}, "metadata", env);
  assert.deepEqual(buildEffectiveConfig(stored, [], { coverageMode: "enforce", coverageMinRatio: 0.5, captureMode: null }).coverage, { mode: "enforce", minRatio: 0.5 });
  assert.deepEqual(buildEffectiveConfig(stored, [], { coverageMode: null, coverageMinRatio: null, captureMode: null }).coverage, stored.coverage);
  assert.equal(buildEffectiveConfig(undefined, [], { coverageMode: null, coverageMinRatio: null, captureMode: "off" }).levers.captureMode, "off");
  assert.equal(buildEffectiveConfig(undefined, [], undefined).levers.captureMode, null);
});

test("the recorded configuration follows the request's levers over the app's settings and the environment's tools", () => {
  const configured = app({}, { closedLoop: { enabled: true }, agentBrowser: { enabled: false } });
  assert.deepEqual(resolveRunConfig(configured, {}, "metadata", env).levers, { closedLoop: true, agentBrowser: false, captureMode: "metadata" });
  assert.deepEqual(resolveRunConfig(configured, { closedLoop: false, agentBrowser: true }, "full", env).levers, { closedLoop: false, agentBrowser: true, captureMode: "full" });
  assert.deepEqual(resolveRunConfig(configured, { closedLoop: true }, "off", { ...env, toolsGranted: false }).levers, { closedLoop: false, agentBrowser: false, captureMode: "off" });
});

test("the served effectiveConfig lists the roles the run's turns invoked and nothing for a run with none", () => {
  const stored = resolveRunConfig(app(), {}, "metadata", env);
  const turns = [
    { role: "author", provider: "p", modelRequested: "m1", modelAnswered: null, maxSteps: 10 },
    { role: "author", provider: null, modelRequested: null, modelAnswered: "m2", maxSteps: 40 },
  ];
  assert.deepEqual(buildEffectiveConfig(stored, turns, undefined).agents, { author: { provider: "p", model: "m2", reasoningEffort: null, stepLimit: 40 } });
  assert.deepEqual(buildEffectiveConfig(stored, [], undefined).agents, {});
});

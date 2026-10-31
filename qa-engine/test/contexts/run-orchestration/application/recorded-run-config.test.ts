import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsOfTurns, configInEffect, recordRunConfig, type RunConfigDeclaration, type RunConfigEnvironment, type RunFreezeFact } from "@contexts/run-orchestration/application/recorded-run-config.ts";

const env: RunConfigEnvironment = { runtime: () => "opencode", staticPromptHash: () => "sha256:x", toolsGranted: true, maxCapture: "full" };
const open: RunFreezeFact = { frozen: false, lessons: true };
const app = (over: Record<string, unknown> = {}, qa: Record<string, unknown> = {}): RunConfigDeclaration => ({ qa, ...over });
const record = (declaration: RunConfigDeclaration, request: Parameters<typeof recordRunConfig>[1] = {}, freeze: RunFreezeFact = open, captureMode: "off" | "metadata" | "full" = "metadata", environment: RunConfigEnvironment = env) =>
  recordRunConfig(declaration, request, freeze, captureMode, environment);

test("the request's lever wins over the app's setting, and the app's setting decides when the request says nothing", () => {
  const configured = app({}, { closedLoop: { enabled: true }, agentBrowser: { enabled: false } });
  assert.deepEqual(record(configured).levers, { closedLoop: true, agentBrowser: false, captureMode: "metadata" });
  assert.deepEqual(record(configured, { closedLoop: false, agentBrowser: true }, open, "full").levers, { closedLoop: false, agentBrowser: true, captureMode: "full" });
});

test("the run_spec loop and the authenticated browser are reported on for an app that says nothing and off for one that turns them off", () => {
  const silent = record(app()).levers;
  assert.deepEqual([silent.closedLoop, silent.agentBrowser], [true, true]);
  const optedOut = record(app({}, { closedLoop: { enabled: false }, agentBrowser: { enabled: false } })).levers;
  assert.deepEqual([optedOut.closedLoop, optedOut.agentBrowser], [false, false]);
});

test("a lever that cannot take effect is not reported as applied", () => {
  assert.equal(record(app(), { closedLoop: true, agentBrowser: true }, open, "metadata", { ...env, toolsGranted: false }).levers.closedLoop, false);
  assert.equal(record(app(), { closedLoop: true, agentBrowser: true }, open, "metadata", { ...env, toolsGranted: false }).levers.agentBrowser, false);
});

test("grounding and policy are what the run's app declares, with the engine's defaults where it declares nothing", () => {
  const plain = record(app());
  assert.deepEqual(plain.grounding, { stitcher: null, domPack: true, lessons: true });
  assert.deepEqual(plain.coverage, { mode: "signal", minRatio: 0.7 });
  const stitched = record(app({ services: [{ repo: "o/s" }], boundaries: [{}] }, { changeCoverage: { mode: "enforce", minRatio: 0.9 } }));
  assert.deepEqual(stitched.grounding, { stitcher: "signal", domPack: true, lessons: true });
  assert.deepEqual(stitched.coverage, { mode: "enforce", minRatio: 0.9 });
});

test("the service topology is reported exactly when the engine wires it, and a run's lever turns it off", () => {
  assert.equal(record(app({ services: [{ repo: "o/s" }] })).grounding.stitcher, null);
  assert.equal(record(app({ boundaries: [{}] })).grounding.stitcher, null);
  const withServices = app({ services: [{ repo: "o/s" }], boundaries: [{}] });
  assert.equal(record(withServices).grounding.stitcher, "signal");
  assert.deepEqual(record(withServices, { grounding: { stitcher: false } }).grounding, { stitcher: "off", domPack: true, lessons: true });
  assert.equal(record(app(), { grounding: { stitcher: false } }).grounding.stitcher, null, "an app without a topology has none to turn off");
});

test("domPack: the request wins over the app, the app applies when the request says nothing, and absent on both defaults to true", () => {
  assert.equal(record(app({}, { domPack: true }), { grounding: { domPack: false } }).grounding.domPack, false);
  assert.equal(record(app({}, { domPack: false })).grounding.domPack, false);
  assert.equal(record(app()).grounding.domPack, true);
  assert.equal(record(app({}, { domPack: false }), { grounding: { domPack: true } }).grounding.domPack, true);
});

test("the freeze the shell decided and the lessons arm are recorded as given", () => {
  assert.deepEqual([record(app(), {}, { frozen: false, lessons: true }).campaignFreeze, record(app(), {}, { frozen: false, lessons: true }).grounding.lessons], [false, true]);
  assert.deepEqual([record(app(), {}, { frozen: true, lessons: false }).campaignFreeze, record(app(), {}, { frozen: true, lessons: false }).grounding.lessons], [true, false]);
  assert.equal(record(app(), {}, { frozen: true, lessons: true }).grounding.lessons, true);
});

test("the runtime and the prompt hash come from the environment the shell reads", () => {
  const unknown = record(app(), {}, open, "metadata", { ...env, runtime: () => null, staticPromptHash: () => null });
  assert.deepEqual([unknown.runtime, unknown.prompt], [null, { staticHash: null }]);
  assert.deepEqual([record(app()).runtime, record(app()).prompt], ["opencode", { staticHash: "sha256:x" }]);
});

test("the record has the keys of the stored column and records no structural-signal or dossier lever", () => {
  const recorded = record(app());
  assert.deepEqual(Object.keys(recorded), ["levers", "campaignFreeze", "runtime", "prompt", "grounding", "coverage"]);
  assert.deepEqual(Object.keys(recorded.grounding).sort(), ["domPack", "lessons", "stitcher"]);
});

test("the trace root records the same facts the configuration does", () => {
  const config = record(app({}, { changeCoverage: { mode: "enforce" } }), { closedLoop: false }, { frozen: true, lessons: false }, "full");
  assert.deepEqual(configInEffect(config), {
    runtime: "opencode",
    closedLoop: false,
    agentBrowser: true,
    coveragePolicy: "enforce",
    campaignFreeze: true,
    staticPromptHash: "sha256:x",
    captureMode: "full",
  });
});

test("the roles a run invoked are read from its turns: the last provider and model reported and the largest step limit stated", () => {
  const turn = (over: Partial<Parameters<typeof agentsOfTurns>[0][number]>): Parameters<typeof agentsOfTurns>[0][number] => ({ role: "author", provider: null, modelRequested: null, modelAnswered: null, maxSteps: null, ...over });
  assert.deepEqual(agentsOfTurns([]), {});
  assert.deepEqual(agentsOfTurns([turn({ provider: "p", modelRequested: "m1", maxSteps: 10 })]), { author: { provider: "p", model: "m1", reasoningEffort: null, stepLimit: 10 } });
  assert.deepEqual(
    agentsOfTurns([
      turn({ provider: "p", modelRequested: "m1", modelAnswered: "m2", maxSteps: 10 }),
      turn({ maxSteps: 40 }),
      turn({ role: "lead", provider: "q" }),
      turn({ provider: "z", modelRequested: "m3", maxSteps: 5 }),
    ]),
    {
      author: { provider: "z", model: "m3", reasoningEffort: null, stepLimit: 40 },
      lead: { provider: "q", model: null, reasoningEffort: null, stepLimit: null },
    },
  );
  assert.equal(agentsOfTurns([turn({ maxSteps: 0 })]).author?.stepLimit, 0, "a stated limit of 0 is recorded, not missing");
});

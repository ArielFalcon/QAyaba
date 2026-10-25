import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../orchestrator/config-loader";
import { buildEffectiveConfig, hashStaticPrompts, parseStoredRunConfig, resolveRunConfig, type RunConfigEnvironment } from "./effective-config";

const env: RunConfigEnvironment = { runtime: () => "codex", staticPromptHash: () => "sha256:x", toolsGranted: true, reflectorEnabled: true, campaignFrozen: false, maxCapture: "full" };
const app = (over: Record<string, unknown> = {}, qa: Record<string, unknown> = {}): AppConfig =>
  ({ name: "a", repo: "o/a", dev: { baseUrl: "https://dev" }, qa: { needsReview: true, testDataPrefix: "qa", ...qa }, report: { onFailure: "x" }, ...over }) as AppConfig;

test("the request's lever wins over the app's setting, and the app's setting decides when the request says nothing", () => {
  const configured = app({}, { closedLoop: { enabled: true }, agentBrowser: { enabled: false } });
  assert.deepEqual(resolveRunConfig(configured, "e2e", {}, "metadata", env).levers, { closedLoop: true, agentBrowser: false, captureMode: "metadata" });
  assert.deepEqual(resolveRunConfig(configured, "e2e", { closedLoop: false, agentBrowser: true }, "full", env).levers, { closedLoop: false, agentBrowser: true, captureMode: "full" });
});

test("a lever that cannot take effect is not reported as applied", () => {
  const asked = { closedLoop: true, agentBrowser: true };
  assert.deepEqual(resolveRunConfig(app(), "e2e", asked, "metadata", { ...env, toolsGranted: false }).levers.closedLoop, false);
  const code = resolveRunConfig(app({ code: true, dev: undefined }), "code", asked, "metadata", env).levers;
  assert.deepEqual([code.closedLoop, code.agentBrowser], [null, null]);
});

test("grounding and policy are what the run's app declares, with the engine's defaults where it declares nothing", () => {
  const plain = resolveRunConfig(app(), "e2e", {}, "metadata", env);
  assert.deepEqual(plain.grounding, { stitcher: null, structuralSignal: "signal", curriculum: "learning", domPack: true, dossier: true });
  assert.deepEqual(plain.coverage, { mode: "signal", minRatio: 0.7 });
  assert.equal(plain.reflector, true);
  const stitched = resolveRunConfig(app({ services: [{ repo: "o/s" }], boundaries: [{}] }, { structuralSignals: { mode: "off" }, changeCoverage: { mode: "enforce", minRatio: 0.9 } }), "e2e", {}, "metadata", env);
  assert.deepEqual(stitched.grounding, { stitcher: null, structuralSignal: "off", curriculum: "learning", domPack: true, dossier: null });
  assert.deepEqual(stitched.coverage, { mode: "enforce", minRatio: 0.9 });
  const withBoundaries = resolveRunConfig(app({ services: [{ repo: "o/s" }], boundaries: [{}] }), "e2e", {}, "metadata", env);
  assert.equal(withBoundaries.grounding.stitcher, "signal");
});

test("a run's grounding lever wins over the app's setting and the freeze still wins over the curriculum lever", () => {
  const withServices = app({ services: [{ repo: "o/s" }], boundaries: [{}] });
  const asked = resolveRunConfig(withServices, "e2e", { grounding: { stitcher: false, structuralSignal: false, curriculum: false } }, "metadata", env);
  assert.deepEqual(asked.grounding, { stitcher: "off", structuralSignal: "off", curriculum: "off", domPack: true, dossier: null });
  const frozen = resolveRunConfig(withServices, "e2e", { grounding: { curriculum: true } }, "metadata", { ...env, campaignFrozen: true });
  assert.equal(frozen.grounding.curriculum, "frozen");
});

test("the change dossier is the run's lever, else the app's, on by default, and none while the structural signal is off", () => {
  assert.equal(resolveRunConfig(app(), "e2e", {}, "metadata", env).grounding.dossier, true);
  assert.equal(resolveRunConfig(app({}, { structuralSignals: { mode: "signal", dossier: false } }), "e2e", {}, "metadata", env).grounding.dossier, false);
  assert.equal(resolveRunConfig(app({}, { structuralSignals: { mode: "signal", dossier: true } }), "e2e", {}, "metadata", env).grounding.dossier, true);
  assert.equal(resolveRunConfig(app({}, { structuralSignals: { mode: "signal", dossier: true } }), "e2e", { grounding: { dossier: false } }, "metadata", env).grounding.dossier, false);
  assert.equal(resolveRunConfig(app(), "e2e", { grounding: { dossier: true } }, "metadata", env).grounding.dossier, true);
  assert.equal(resolveRunConfig(app(), "e2e", { grounding: { dossier: true, structuralSignal: false } }, "metadata", env).grounding.dossier, null);
});

test("a campaign freeze freezes the curriculum and switches the reflector off whatever the reflector switch says", () => {
  const frozen = resolveRunConfig(app(), "e2e", {}, "metadata", { ...env, campaignFrozen: true });
  assert.equal(frozen.campaignFreeze, true);
  assert.equal(frozen.grounding.curriculum, "frozen");
  assert.equal(frozen.reflector, false);
});

test("domPack: the request wins over the app, the app applies when the request says nothing, and absent on both defaults to true", () => {
  assert.equal(resolveRunConfig(app({}, { domPack: true }), "e2e", { grounding: { domPack: false } }, "metadata", env).grounding.domPack, false);
  assert.equal(resolveRunConfig(app({}, { domPack: false }), "e2e", {}, "metadata", env).grounding.domPack, false);
  assert.equal(resolveRunConfig(app(), "e2e", {}, "metadata", env).grounding.domPack, true);
  assert.equal(resolveRunConfig(app(), "e2e", { grounding: { domPack: true } }, "metadata", env).grounding.domPack, true);
});

test("parseStoredRunConfig of an old record reads a missing domPack or dossier as null and leaves out a grounding key this version no longer records (kept parseable)", () => {
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
  assert.deepEqual(parseStoredRunConfig(old)?.grounding, { stitcher: null, structuralSignal: "signal", curriculum: "learning", domPack: null, dossier: null });
});

test("a stored configuration round-trips, and malformed or missing storage reads as nothing recorded", () => {
  const stored = resolveRunConfig(app(), "e2e", {}, "metadata", env);
  assert.deepEqual(parseStoredRunConfig(JSON.stringify(stored)), stored);
  assert.equal(parseStoredRunConfig(null), undefined);
  assert.equal(parseStoredRunConfig("{nope"), undefined);
});

test("the coverage the engine reported at the end wins over the one the run started with, and the capture column fills a run that stored nothing", () => {
  const stored = resolveRunConfig(app(), "e2e", {}, "metadata", env);
  assert.deepEqual(buildEffectiveConfig(stored, [], { coverageMode: "enforce", coverageMinRatio: 0.5, captureMode: null }).coverage, { mode: "enforce", minRatio: 0.5 });
  assert.deepEqual(buildEffectiveConfig(stored, [], { coverageMode: null, coverageMinRatio: null, captureMode: null }).coverage, stored.coverage);
  assert.equal(buildEffectiveConfig(undefined, [], { coverageMode: null, coverageMinRatio: null, captureMode: "off" }).levers.captureMode, "off");
  assert.equal(buildEffectiveConfig(undefined, [], undefined).levers.captureMode, null);
});

test("the static prompt hash covers AGENTS.md and every role file, in name order, and changes with any of them", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-prompt-hash-"));
  try {
    mkdirSync(join(root, "agents", "agent"), { recursive: true });
    writeFileSync(join(root, "agents", "AGENTS.md"), "shared");
    writeFileSync(join(root, "agents", "agent", "b.md"), "role b");
    writeFileSync(join(root, "agents", "agent", "a.md"), "role a");
    const first = hashStaticPrompts(root);
    assert.match(first ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(hashStaticPrompts(root), first);
    writeFileSync(join(root, "agents", "agent", "a.md"), "role a changed");
    assert.notEqual(hashStaticPrompts(root), first);
    assert.equal(hashStaticPrompts(join(root, "missing")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that asks for the structural signal gets it even where the app has it off, and it is recorded on", () => {
  const off = app({}, { structuralSignals: { mode: "off" } });
  const asked = resolveRunConfig(off, "e2e", { grounding: { structuralSignal: true, dossier: true } }, "metadata", env);
  assert.equal(asked.grounding.structuralSignal, "signal");
  assert.equal(asked.grounding.dossier, true);
  assert.equal(resolveRunConfig(off, "e2e", {}, "metadata", env).grounding.structuralSignal, "off");
});

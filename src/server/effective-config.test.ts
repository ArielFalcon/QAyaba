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
  assert.deepEqual(resolveRunConfig(configured, "e2e", {}, "metadata", env).levers, { closedLoop: true, agentBrowser: false, coordinationMode: "single", captureMode: "metadata" });
  assert.deepEqual(resolveRunConfig(configured, "e2e", { closedLoop: false, agentBrowser: true, coordinationMode: "lead-sidekicks" }, "full", env).levers, { closedLoop: false, agentBrowser: true, coordinationMode: "lead-sidekicks", captureMode: "full" });
});

test("a lever that cannot take effect is not reported as applied", () => {
  const asked = { closedLoop: true, agentBrowser: true };
  assert.deepEqual(resolveRunConfig(app(), "e2e", asked, "metadata", { ...env, toolsGranted: false }).levers.closedLoop, false);
  const code = resolveRunConfig(app({ code: true, dev: undefined }), "code", asked, "metadata", env).levers;
  assert.deepEqual([code.closedLoop, code.agentBrowser, code.coordinationMode], [null, null, null]);
});

test("grounding and policy are what the run's app declares, with the engine's defaults where it declares nothing", () => {
  const plain = resolveRunConfig(app(), "e2e", {}, "metadata", env);
  assert.deepEqual(plain.grounding, { explorer: false, stitcher: null, structuralSignal: "signal", curriculum: "learning" });
  assert.deepEqual(plain.coverage, { mode: "signal", minRatio: 0.7 });
  assert.equal(plain.reflector, true);
  const stitched = resolveRunConfig(app({ services: [{ repo: "o/s" }], boundaries: [{}] }, { structuralSignals: { mode: "off" }, changeCoverage: { mode: "enforce", minRatio: 0.9 } }), "e2e", {}, "metadata", env);
  assert.deepEqual(stitched.grounding, { explorer: true, stitcher: null, structuralSignal: "off", curriculum: "learning" });
  assert.deepEqual(stitched.coverage, { mode: "enforce", minRatio: 0.9 });
  const withBoundaries = resolveRunConfig(app({ services: [{ repo: "o/s" }], boundaries: [{}] }), "e2e", {}, "metadata", env);
  assert.equal(withBoundaries.grounding.stitcher, "signal");
});

test("a campaign freeze freezes the curriculum and switches the reflector off whatever the reflector switch says", () => {
  const frozen = resolveRunConfig(app(), "e2e", {}, "metadata", { ...env, campaignFrozen: true });
  assert.equal(frozen.campaignFreeze, true);
  assert.equal(frozen.grounding.curriculum, "frozen");
  assert.equal(frozen.reflector, false);
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

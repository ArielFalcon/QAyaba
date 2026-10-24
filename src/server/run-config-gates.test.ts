import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../orchestrator/config-loader";
import { serviceTopologyWired, structuralSignalsMode, structuralSignalsOn, toolsApply } from "./run-config-gates";
import { resolveRunConfig, type RunConfigEnvironment } from "./effective-config";

const app = (over: Record<string, unknown> = {}, qa: Record<string, unknown> = {}): AppConfig =>
  ({ name: "a", repo: "o/a", dev: { baseUrl: "https://dev" }, qa: { needsReview: true, testDataPrefix: "qa", ...qa }, report: { onFailure: "x" }, ...over }) as AppConfig;
const env: RunConfigEnvironment = { runtime: () => null, staticPromptHash: () => null, toolsGranted: true, reflectorEnabled: false, campaignFrozen: false, maxCapture: "metadata" };

test("the tools apply to an e2e run of an app with a DEV address, and to nothing else", () => {
  assert.equal(toolsApply("e2e", app()), true);
  assert.equal(toolsApply("code", app()), false);
  assert.equal(toolsApply("e2e", app({ dev: undefined })), false);
});

test("structural signals default to signal and are on unless the app says off", () => {
  assert.equal(structuralSignalsMode(app()), "signal");
  assert.equal(structuralSignalsOn(app()), true);
  assert.equal(structuralSignalsOn(app({}, { structuralSignals: { mode: "off" } })), false);
});

test("the service topology is wired only with services, boundaries and signals on", () => {
  const wired = { services: [{ repo: "o/s" }], boundaries: [{}] };
  assert.equal(serviceTopologyWired(app(wired)), true);
  assert.equal(serviceTopologyWired(app({ services: wired.services })), false);
  assert.equal(serviceTopologyWired(app({ boundaries: wired.boundaries })), false);
  assert.equal(serviceTopologyWired(app(wired, { structuralSignals: { mode: "off" } })), false);
});

test("effectiveConfig reports exactly what the predicates wire, for every combination", () => {
  for (const target of ["e2e", "code"] as const) {
    for (const dev of [true, false]) {
      for (const mode of ["off", "signal"] as const) {
        for (const boundaries of [true, false]) {
          const a = app({ ...(dev ? {} : { dev: undefined }), services: [{ repo: "o/s" }], ...(boundaries ? { boundaries: [{}] } : {}) }, { structuralSignals: { mode } });
          const c = resolveRunConfig(a, target, { closedLoop: true, agentBrowser: true }, "metadata", env);
          assert.equal(c.levers.closedLoop !== null, toolsApply(target, a));
          assert.equal(c.grounding.stitcher !== null, serviceTopologyWired(a));
          assert.equal(c.grounding.structuralSignal, structuralSignalsMode(a));
        }
      }
    }
  }
});

test("a code-target run reports no tool levers even for an app not marked as code", () => {
  const c = resolveRunConfig(app(), "code", { closedLoop: true }, "metadata", env);
  assert.deepEqual([c.levers.closedLoop, c.levers.agentBrowser], [null, null]);
});

/* What an app's configuration decides about a run's engine, and what the engine falls back to where the app says nothing: read through the composed EngineRootDeps. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineRootDeps } from "./run-engine-factory";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";

const stubAgentDeps = (): AgentDeps => ({
  open: async () => {
    throw new Error("composing a run opens no agent session");
  },
});

const base = (name: string): AppConfig => ({
  name,
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
});
const withQa = (name: string, qa: Partial<AppConfig["qa"]>): AppConfig => ({ ...base(name), qa: { ...base(name).qa, ...qa } });
const compose = (app: AppConfig, run: Partial<Parameters<typeof buildEngineRootDeps>[3]> = {}, deps: Partial<Parameters<typeof buildEngineRootDeps>[1]> = {}) =>
  buildEngineRootDeps(app, { getAgentDeps: stubAgentDeps, ...deps }, "ns", { mode: "diff", ...run });

test("the change-coverage policy is signal at 0.7 with branch cases regenerating where the app says nothing, and each key is the app's where it sets one", () => {
  const plain = compose(base("defaults-coverage-plain"));
  assert.deepEqual(plain.coveragePolicy, { mode: "signal", minRatio: 0.7, branchCases: "regenerate" });
  assert.equal(plain.coveragePolicyMode, "signal");
  assert.equal(plain.coverageMinRatio, 0.7);
  assert.equal(plain.coverageBranchCases, "regenerate");
  const modeOnly = compose(withQa("defaults-coverage-mode", { changeCoverage: { mode: "enforce" } }));
  assert.deepEqual(modeOnly.coveragePolicy, { mode: "enforce", minRatio: 0.7, branchCases: "regenerate" });
  const ratioOnly = compose(withQa("defaults-coverage-ratio", { changeCoverage: { minRatio: 0 } }));
  assert.deepEqual(ratioOnly.coveragePolicy, { mode: "signal", minRatio: 0, branchCases: "regenerate" }, "a declared 0 is the app's, not a missing value");
  const branchOff = compose(withQa("defaults-coverage-branch", { changeCoverage: { branchCases: "off" } }));
  assert.deepEqual(branchOff.coveragePolicy, { mode: "signal", minRatio: 0.7, branchCases: "off" });
});

test("the test-intent lock is signal at an opacity ratio of 0.5 where the app says nothing, and each key is the app's where it sets one", () => {
  assert.deepEqual(compose(base("defaults-lock-plain")).intentLock, { mode: "signal", opacityFlagRatio: 0.5 });
  assert.deepEqual(compose(withQa("defaults-lock-empty", { intentLock: {} })).intentLock, { mode: "signal", opacityFlagRatio: 0.5 });
  assert.deepEqual(compose(withQa("defaults-lock-off", { intentLock: { mode: "off" } })).intentLock, { mode: "off", opacityFlagRatio: 0.5 });
  assert.deepEqual(compose(withQa("defaults-lock-ratio", { intentLock: { opacityFlagRatio: 0 } })).intentLock, { mode: "signal", opacityFlagRatio: 0 });
});

test("the fix loop retries twice where the app says nothing, and the app's count where it sets one (0 included)", () => {
  assert.equal(compose(base("defaults-retries-plain")).maxRetries, 2);
  assert.equal(compose(withQa("defaults-retries-empty", { fixLoop: {} })).maxRetries, 2);
  assert.equal(compose(withQa("defaults-retries-none", { fixLoop: { maxRetries: 0 } })).maxRetries, 0);
  assert.equal(compose(withQa("defaults-retries-five", { fixLoop: { maxRetries: 5 } })).maxRetries, 5);
});

test("the live-DOM arm of the context pack is on where neither the run nor the app says otherwise; the run's lever wins over the app's key", () => {
  assert.equal(compose(base("defaults-dompack-plain")).domPack, true);
  assert.equal(compose(withQa("defaults-dompack-app", { domPack: false })).domPack, false);
  assert.equal(compose(withQa("defaults-dompack-app-on", { domPack: true }), { grounding: { domPack: false } }).domPack, false);
  assert.equal(compose(withQa("defaults-dompack-run-on", { domPack: false }), { grounding: { domPack: true } }).domPack, true);
  assert.equal(compose(base("defaults-dompack-other-lever"), { grounding: { stitcher: false } }).domPack, true);
});

test("the deploy gate of the app's own commit polls every 2 s for 60 s unless the dev block sets either", () => {
  const plain = compose(base("defaults-gate-plain"));
  assert.equal(plain.deployGateIntervalMs, 2000);
  assert.equal(plain.deployGateTimeoutMs, 60_000);
  const set = compose({ ...base("defaults-gate-set"), dev: { baseUrl: "https://dev", pollIntervalMs: 500, deployTimeoutMs: 5000 } });
  assert.equal(set.deployGateIntervalMs, 500);
  assert.equal(set.deployGateTimeoutMs, 5000);
  const intervalOnly = compose({ ...base("defaults-gate-interval"), dev: { baseUrl: "https://dev", pollIntervalMs: 500 } });
  assert.deepEqual([intervalOnly.deployGateIntervalMs, intervalOnly.deployGateTimeoutMs], [500, 60_000]);
});

test("a service that triggers the run keeps its own gate, and the app's dev block never reaches it", () => {
  const app: AppConfig = {
    ...base("defaults-gate-service"),
    dev: { baseUrl: "https://dev", versionUrl: "https://dev/version", pollIntervalMs: 500, deployTimeoutMs: 5000 },
    services: [{ repo: "org/orders-svc", versionUrl: "https://orders/version" }, { repo: "org/pay-svc", versionUrl: "https://pay/version", pollIntervalMs: 1500 }],
  };
  const plain = compose(app, { triggerRepo: "org/orders-svc" });
  assert.deepEqual([plain.deployGateIntervalMs, plain.deployGateTimeoutMs], [10_000, 600_000]);
  const partly = compose(app, { triggerRepo: "org/pay-svc" });
  assert.deepEqual([partly.deployGateIntervalMs, partly.deployGateTimeoutMs], [1500, 600_000]);
});

test("the gates of the other repos of a run over several repos default to 10 s and 10 min, and carry the service's own values where it sets them", () => {
  const app: AppConfig = {
    ...base("defaults-gate-companions"),
    services: [
      { repo: "org/orders-svc", versionUrl: "https://orders/version" },
      { repo: "org/pay-svc", versionUrl: "https://pay/version", pollIntervalMs: 1500, deployTimeoutMs: 30_000 },
      { repo: "org/notify-svc" },
    ],
  };
  const changeSet = {
    anchor: { repo: "org/orders-svc", headSha: { toString: () => "a".repeat(40) } },
    entries: [] as unknown[],
  };
  changeSet.entries = [changeSet.anchor, { repo: "org/pay-svc", headSha: { toString: () => "b".repeat(40) } }, { repo: "org/notify-svc", headSha: { toString: () => "c".repeat(40) } }];
  const config = compose(app, { triggerRepo: "org/orders-svc", changeSet: changeSet as never });
  assert.deepEqual(
    config.companionDeployGates?.map((g) => ({ repo: g.repo, versionUrl: g.versionUrl, intervalMs: g.intervalMs, timeoutMs: g.timeoutMs })),
    [
      { repo: "org/pay-svc", versionUrl: "https://pay/version", intervalMs: 1500, timeoutMs: 30_000 },
      { repo: "org/notify-svc", versionUrl: undefined, intervalMs: 10_000, timeoutMs: 600_000 },
    ],
  );
});

test("the run_spec loop grants 8 calls of 2 minutes and 20 writes where the app says nothing, with no ceiling on the flows' calls", () => {
  /* Composing only hands the registry on: no call reaches it. */
  const registry = {} as never;
  const limitsOf = (qa: Partial<AppConfig["qa"]>) => compose(withQa("defaults-loop", qa), {}, { closedLoopRegistry: registry }).closedLoop?.setting;
  assert.deepEqual(limitsOf({}), { enabled: true, limits: { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 } });
  assert.deepEqual(limitsOf({ closedLoop: { perCallMs: 60_000 } }), { enabled: true, limits: { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 20 } });
  assert.deepEqual(limitsOf({ closedLoop: { maxDevWrites: 0, maxCalls: 2 } }), { enabled: true, limits: { maxCalls: 2, perCallMs: 120_000, maxDevWrites: 0, callsCeiling: 2 } });
  assert.deepEqual(limitsOf({ closedLoop: { enabled: false } }), { enabled: false, limits: { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 } });
});

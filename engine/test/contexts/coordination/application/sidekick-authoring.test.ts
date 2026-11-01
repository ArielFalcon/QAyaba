import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEKICK_AUTHORING,
  sidekickAuthoring,
  sidekickGrants,
  SIDEKICK_CAPABILITY,
  type AuthoringFacts,
  type SidekickAuthoringMode,
  type SidekickCapability,
} from "@contexts/coordination/application/sidekick-authoring.ts";
import { MAX_SESSION_PAGES } from "@kernel/agent-browser.ts";

const facts = (over: Partial<AuthoringFacts> = {}): AuthoringFacts => ({
  hasLogin: true,
  runSpecGranted: true,
  browserGranted: true,
  ...over,
});

test("an app with a login and the authenticated browser granted is authored with that browser, no more flows at once than the browser has pages", () => {
  const decision = sidekickAuthoring(facts());
  assert.equal(decision.mode, SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER);
  assert.equal(decision.maxParallel, MAX_SESSION_PAGES);
});

test("without the authenticated browser, run_spec alone is not held to the browser's page count", () => {
  assert.equal(sidekickAuthoring(facts({ browserGranted: false })).maxParallel, undefined);
});

test("an app with a login and no browser is authored with run_spec alone, and with neither the sidekicks stay out", () => {
  assert.equal(sidekickAuthoring(facts({ browserGranted: false })).mode, SIDEKICK_AUTHORING.RUN_SPEC_ONLY);
  const none = sidekickAuthoring(facts({ browserGranted: false, runSpecGranted: false }));
  assert.equal(none.mode, SIDEKICK_AUTHORING.EXCLUDED);
  assert.match(none.reason ?? "", /login/);
});

test("an app with no login is authored with the unauthenticated browser, one flow at a time, whether or not run_spec is granted", () => {
  for (const runSpecGranted of [true, false]) {
    const decision = sidekickAuthoring(facts({ hasLogin: false, browserGranted: false, runSpecGranted }));
    assert.equal(decision.mode, SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER);
    assert.equal(decision.maxParallel, 1);
  }
});

const MODES = Object.values(SIDEKICK_AUTHORING);
const CAPABILITIES = Object.values(SIDEKICK_CAPABILITY);
const DENY_PATTERN: Readonly<Partial<Record<SidekickCapability, string>>> = { [SIDEKICK_CAPABILITY.RUN_SPEC]: "run_spec", [SIDEKICK_CAPABILITY.PLAYWRIGHT]: "playwright*" };

function everyCombination(): Array<{ mode: SidekickAuthoringMode; loop: boolean; agentBrowser: boolean; geolocation: boolean }> {
  return MODES.flatMap((mode) => [true, false].flatMap((loop) => [true, false].flatMap((agentBrowser) => [true, false].map((geolocation) => ({ mode, loop, agentBrowser, geolocation })))));
}

test("a capability is granted exactly when the session's deny list does not hold its tool, for every mode and every flow", () => {
  for (const { mode, ...flow } of everyCombination()) {
    const grants = sidekickGrants(mode, flow);
    for (const [capability, pattern] of Object.entries(DENY_PATTERN) as Array<[SidekickCapability, string]>) {
      assert.equal(grants.granted.includes(capability), !grants.denyTools.includes(pattern), `${mode} ${JSON.stringify(flow)}: ${capability}`);
    }
  }
});

test("every capability is either granted or withheld, never both and never neither", () => {
  for (const { mode, ...flow } of everyCombination()) {
    const grants = sidekickGrants(mode, flow);
    assert.deepEqual([...grants.granted, ...grants.withheld].sort(), [...CAPABILITIES].sort(), `${mode} ${JSON.stringify(flow)}`);
  }
});

test("run_spec follows the flow's loop, the authenticated browser follows its mode and grant, set_geolocation follows the flow's location", () => {
  const flow = { loop: true, agentBrowser: true, geolocation: true };
  assert.deepEqual([...sidekickGrants(SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, flow).granted].sort(), [SIDEKICK_CAPABILITY.AUTHBROWSER, SIDEKICK_CAPABILITY.RUN_SPEC, SIDEKICK_CAPABILITY.SET_GEOLOCATION].sort());
  assert.deepEqual([...sidekickGrants(SIDEKICK_AUTHORING.RUN_SPEC_ONLY, flow).granted].sort(), [SIDEKICK_CAPABILITY.RUN_SPEC, SIDEKICK_CAPABILITY.SET_GEOLOCATION].sort());
  assert.deepEqual(sidekickGrants(SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER, { ...flow, loop: false, geolocation: false }).granted, [SIDEKICK_CAPABILITY.PLAYWRIGHT]);
  assert.equal(sidekickGrants(SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, { ...flow, agentBrowser: false }).granted.includes(SIDEKICK_CAPABILITY.AUTHBROWSER), false);
});

test("the code-navigation server is always denied a sidekick, since its symbol edits write wherever it points", () => {
  for (const { mode, ...flow } of everyCombination()) assert.ok(sidekickGrants(mode, flow).denyTools.includes("serena*"), mode);
});

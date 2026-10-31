import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEKICK_AUTHORING,
  sidekickAuthoring,
  sidekickDeniedTools,
  type AuthoringFacts,
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

test("the code-navigation server is always denied a sidekick, since its symbol edits write wherever it points", () => {
  for (const mode of [SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, SIDEKICK_AUTHORING.RUN_SPEC_ONLY, SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER]) {
    assert.ok(sidekickDeniedTools(mode, true).includes("serena*"), mode);
  }
});

test("the unauthenticated browser is denied unless the app has no login, and run_spec unless the flow has a loop", () => {
  assert.ok(sidekickDeniedTools(SIDEKICK_AUTHORING.AUTHENTICATED_BROWSER, true).includes("playwright*"));
  assert.ok(sidekickDeniedTools(SIDEKICK_AUTHORING.RUN_SPEC_ONLY, true).includes("playwright*"));
  assert.equal(sidekickDeniedTools(SIDEKICK_AUTHORING.UNAUTHENTICATED_BROWSER, true).includes("playwright*"), false);
  assert.equal(sidekickDeniedTools(SIDEKICK_AUTHORING.RUN_SPEC_ONLY, true).includes("run_spec"), false);
  assert.ok(sidekickDeniedTools(SIDEKICK_AUTHORING.RUN_SPEC_ONLY, false).includes("run_spec"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceOf,
  loginForm,
  loginRequest,
  outcomeOf,
  runLoginDiscovery,
  type StubSite,
  type StubSubmit,
} from "../../../../support/login-discovery-harness.ts";

/* A login that gets in: the password field goes with the request, and signed out the landing page shows the form again. */
const signedIn = (submit: StubSubmit): StubSite => ({
  pages: { "/": loginForm(), "/home": loginForm() },
  authedPages: { "/home": {} },
  submit: { landing: "/home", ...submit },
});

test("a login request that answers after the password field is gone is waited for before the session is saved", async () => {
  const run = await runLoginDiscovery({
    site: signedIn({ requests: [loginRequest({ status: 200, lateMs: 40 })], persistsAfterAnswer: true }),
    input: { postSubmitMinWaitMs: 30_000 },
  });
  const evidence = evidenceOf(run);
  assert.equal(evidence.inFlightAtDeadline, false);
  assert.equal(evidence.requests[0]?.status, 200);
  assert.equal(evidence.freshContextPasswordGone, true);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("a login request that never answers is waited for only within the post-submit window, and nothing is concluded", async () => {
  const run = await runLoginDiscovery({
    site: signedIn({ requests: [loginRequest({ status: null })], persists: false }),
    input: { postSubmitMinWaitMs: 150 },
  });
  const evidence = evidenceOf(run);
  assert.equal(evidence.inFlightAtDeadline, true);
  assert.equal(evidence.passwordGone, true);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

test("a background request that never answers does not hold the login back", async () => {
  const run = await runLoginDiscovery({
    site: signedIn({ requests: [loginRequest({ status: 200 })], background: [{ method: "POST", url: "/api/poll", status: null }] }),
    input: { postSubmitMinWaitMs: 30_000 },
  });
  assert.equal(evidenceOf(run).inFlightAtDeadline, false);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

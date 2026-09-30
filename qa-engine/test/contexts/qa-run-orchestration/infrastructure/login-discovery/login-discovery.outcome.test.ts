import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RENDERED_REQUESTS } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import { POST_SUBMIT_MIN_WAIT_MS } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import {
  button,
  evidenceOf,
  input,
  loginForm,
  outcomeOf,
  runLoginDiscovery,
  stayingSite,
  type StubPage,
} from "../../../../support/login-discovery-harness.ts";

test("a rejected login is credentials-rejected from its submit-time request alone, and the evidence keeps no query", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [{ method: "POST", url: "/api/session?next=%2Fhome&t=tok-abc123", status: 401 }] }) });
  const evidence = evidenceOf(run);
  const [request] = evidence.requests;
  assert.equal(request?.method, "POST");
  assert.equal(request?.pathname, "/api/session");
  assert.equal(request?.status, 401);
  assert.equal(JSON.stringify(evidence).includes("tok-abc123"), false);
  assert.equal(evidence.passwordGone, false);
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.CREDENTIALS_REJECTED });
});

test("only non-GET requests of a login's kind are recorded, sorted, and no more than the cap", async () => {
  const posts = Array.from({ length: MAX_RENDERED_REQUESTS + 2 }, (_, n) => ({ method: "POST", url: `/api/r-${String(MAX_RENDERED_REQUESTS + 1 - n).padStart(2, "0")}`, status: 401 }));
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [...posts, { method: "GET", url: "/api/config", status: 200 }, { method: "POST", url: "/analytics/beacon", resourceType: "ping", status: 204 }] }),
  });
  const paths = evidenceOf(run).requests.map((request) => request.pathname);
  assert.equal(paths.length, MAX_RENDERED_REQUESTS);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(paths.includes("/api/config"), false);
  assert.equal(paths.includes("/analytics/beacon"), false);
});

test("a request that never gets an answer is in flight at the deadline, so nothing is concluded", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [{ method: "POST", url: "/api/session", status: null }] }) });
  const evidence = evidenceOf(run);
  assert.equal(evidence.inFlightAtDeadline, true);
  assert.equal(evidence.requests[0]?.status, null);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

test("a request that fails on the network is not still in flight, and it is not a rejection", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [{ method: "POST", url: "/api/session", status: null, failed: true }] }) });
  assert.equal(evidenceOf(run).inFlightAtDeadline, false);
  assert.equal(evidenceOf(run).requests[0]?.status, null);
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE });
});

test("a form that ignores Enter sends nothing and leaves the stock seed to run", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ enter: false }) });
  assert.equal(evidenceOf(run).submitted, true);
  assert.equal(evidenceOf(run).requests.length, 0);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

test("a password field outside any form is submitted by the submit control after it, not by Enter", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, "text", -1), input(1, "password", -1), button(2, -1)] } } } });
  assert.equal(run.submits.length, 1);
  assert.equal(run.submits[0]?.via, "click");
  assert.equal(run.submits[0]?.i, 2);
});

test("a form-less password field with no usable submit control is not submitted", async () => {
  const layouts = [
    [input(0, "text", -1), input(1, "password", -1)],
    [input(0, "text", -1), input(1, "password", -1), button(2, -1, { disabled: true })],
    [input(0, "text", -1), input(1, "password", -1), button(2, -1, { visible: false })],
    [input(0, "text", -1), input(1, "password", -1), button(2, 4)],
    [input(0, "text", -1), button(1, -1), input(2, "password", -1)],
  ];
  for (const fields of layouts) {
    const run = await runLoginDiscovery({ site: { pages: { "/": { fields } } } });
    assert.equal(run.submits.length, 0);
    assert.equal(evidenceOf(run).filled, true);
    assert.equal(evidenceOf(run).submitted, false);
    assert.deepEqual(run.markers, []);
  }
});


test("a visible captcha widget after the submit is a visible challenge, and an invisible one is only a marker", async () => {
  const visible = await runLoginDiscovery({ site: stayingSite({ requests: [], after: { ...loginForm(), captcha: { present: true, visible: true } } }) });
  assert.equal(evidenceOf(visible).markers.captcha, true);
  assert.equal(evidenceOf(visible).challengeVisible, true);
  assert.deepEqual(outcomeOf(visible), { status: "failed", kind: PRECONDITION_KIND.CAPTCHA_PRESENT });
  const invisible = await runLoginDiscovery({ site: stayingSite({ requests: [], after: { ...loginForm(), captcha: { present: true, visible: false } } }) });
  assert.equal(evidenceOf(invisible).markers.captcha, true);
  assert.equal(evidenceOf(invisible).challengeVisible, false);
  assert.deepEqual(outcomeOf(invisible), { status: "inconclusive", attempted: false });
});

test("a second-factor step on screen after the submit is recorded, and only one seen after it", async () => {
  const step: StubPage = { fields: [input(0, "text", 0)], secondFactorVisible: true };
  const after = await runLoginDiscovery({ site: stayingSite({ requests: [], after: step }) });
  assert.equal(evidenceOf(after).secondFactorVisible, true);
  assert.deepEqual(outcomeOf(after), { status: "failed", kind: PRECONDITION_KIND.SECOND_FACTOR_REQUIRED });
  const before = await runLoginDiscovery({ site: stayingSite({ requests: [], after: loginForm() }, { ...loginForm(), secondFactorVisible: true }) });
  assert.equal(evidenceOf(before).secondFactorVisible, false);
});

test("a submit control that is disabled after the submit is recorded", async () => {
  const disabled = await runLoginDiscovery({ site: stayingSite({ requests: [], after: { fields: [input(0, "email", 0), input(1, "password", 0), button(2, 0, { disabled: true })] } }) });
  const enabled = await runLoginDiscovery({ site: stayingSite({ requests: [] }) });
  assert.equal(evidenceOf(disabled).submitDisabled, true);
  assert.equal(evidenceOf(enabled).submitDisabled, false);
});

test("the wait for the password field to go lasts at least the seed's and grows with the action timeout", async () => {
  const waitedFor = async (actionTimeoutMs?: number): Promise<number | undefined> => {
    const run = await runLoginDiscovery({ site: stayingSite({ requests: [] }), ...(actionTimeoutMs === undefined ? {} : { input: { actionTimeoutMs } }) });
    return run.events.find((event) => event.t === "wait")?.timeout;
  };
  assert.equal(await waitedFor(), POST_SUBMIT_MIN_WAIT_MS);
  assert.equal(await waitedFor(POST_SUBMIT_MIN_WAIT_MS / 2), POST_SUBMIT_MIN_WAIT_MS);
  assert.equal(await waitedFor(POST_SUBMIT_MIN_WAIT_MS * 3), POST_SUBMIT_MIN_WAIT_MS * 3);
});

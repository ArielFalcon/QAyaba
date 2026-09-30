import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_TEXT_MAX, MAX_RENDERED_REQUESTS } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import { POST_SUBMIT_MIN_WAIT_MS } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import {
  STUB_PASS,
  STUB_USER,
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

const RECURRING = "TypeError: icon 12 is not registered at https://app.stub.test/main.js?v=3";

test("an exception already on the page before the submit is not new, whatever numbers or URLs it carries", async () => {
  const before = { kind: "console", isErrorObject: true, text: RECURRING } as const;
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [], errors: [{ ...before, text: "TypeError: icon 47 is not registered at https://cdn.stub.test/other.js?v=9" }] }, { ...loginForm(), errors: [before] }),
  });
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

test("a new Error thrown in the submit handler is a new exception, named by its first line, and the login cannot complete", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [], errors: [{ kind: "console", isErrorObject: true, text: "TypeError: handler-marker is null\n    at onSubmit (main.js:1:1)" }] }, { ...loginForm(), errors: [{ kind: "console", isErrorObject: true, text: RECURRING }] }),
  });
  const evidence = evidenceOf(run);
  assert.equal(evidence.newExceptionAfterSubmit, true);
  assert.equal(evidence.firstNewException, "TypeError: handler-marker is null");
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE });
});

test("a plain-text console error after the submit is not an exception", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], errors: [{ kind: "console", isErrorObject: false, text: "TypeError: validation-marker is not a valid email" }] }) });
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, false);
  assert.equal(evidenceOf(run).firstNewException, null);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

test("a page error after the submit is counted, named, and a new exception", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], errors: [{ kind: "pageerror", text: "Uncaught ReferenceError: pageerror-marker" }] }) });
  const evidence = evidenceOf(run);
  assert.equal(evidence.pageErrorCount, 1);
  assert.equal(evidence.firstPageError, "Uncaught ReferenceError: pageerror-marker");
  assert.equal(evidence.newExceptionAfterSubmit, true);
});

test("a page error that was already there before the submit is not counted and not new", async () => {
  const before = { kind: "pageerror", text: "Uncaught TypeError: recurring-marker 5" } as const;
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], errors: [{ ...before, text: "Uncaught TypeError: recurring-marker 9" }] }, { ...loginForm(), errors: [before] }) });
  assert.equal(evidenceOf(run).pageErrorCount, 1);
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, false);
});

test("a new exception with a request sent leaves the outcome to the request rules", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [{ method: "POST", url: "/api/session", status: 401 }], errors: [{ kind: "console", isErrorObject: true, text: "TypeError: after-the-request" }] }),
  });
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, true);
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.CREDENTIALS_REJECTED });
});

/* Each spelling written out by hand: raw, percent-encoded, form-encoded, HTML-escaped and JSON-escaped with the ASCII escapes. */
const ECHOES = [
  STUB_USER, "synthetic.user%40demo.example", "SYNTHETIC.USER@DEMO.EXAMPLE",
  STUB_PASS, "sYnth3tic%20pass%261", "sYnth3tic+pass%261", "sYnth3tic pass&amp;1", "sYnth3tic pass\\u00261",
];

test("text that carries the account is scrubbed in every spelling before it is cut, and its URLs lose their queries", async () => {
  const text = `TypeError: ${ECHOES.join(" | ")} https://app.stub.test/x?token=query-marker`;
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [], errors: [{ kind: "console", isErrorObject: true, text }, { kind: "pageerror", text }] }, { ...loginForm(), alerts: [] }),
  });
  const evidence = evidenceOf(run);
  const carried = JSON.stringify(evidence);
  for (const echo of ECHOES) assert.equal(carried.toLowerCase().includes(echo.toLowerCase()), false, `leaked ${echo}`);
  assert.equal(carried.includes("query-marker"), false);
  assert.match(evidence.firstNewException ?? "", /^TypeError: /);
});

test("a credential straddling the cut is removed whole, and the exception is cut to its bound", async () => {
  const text = `TypeError: ${"y".repeat(EVIDENCE_TEXT_MAX - 20)}${STUB_PASS}${"z".repeat(50)}`;
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], errors: [{ kind: "console", isErrorObject: true, text }] }) });
  const seen = evidenceOf(run).firstNewException ?? "";
  assert.equal(seen.includes(STUB_PASS.slice(0, 4)), false, "no prefix of the password survives the cut");
  assert.ok(seen.length <= EVIDENCE_TEXT_MAX);
  assert.ok(seen.startsWith("TypeError: yyyy"));
});

test("a secret that spans lines is removed from an exception before its first line is taken", async () => {
  const password = "first-line-marker\nsecond-line-marker";
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [], errors: [{ kind: "console", isErrorObject: true, text: `TypeError: rejected ${password} for the account` }] }),
    env: { DEV_TEST_PASS: password },
  });
  assert.equal(JSON.stringify(evidenceOf(run)).includes("first-line-marker"), false);
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, true);
});

test("an alert is reported only when it was not on the page before the submit, scrubbed and bounded", async () => {
  const alert = `Invalid sign-in for ${STUB_USER}${"z".repeat(EVIDENCE_TEXT_MAX * 2)}`;
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [], after: { ...loginForm(), alerts: ["Cookie notice", alert] } }, { ...loginForm(), alerts: ["Cookie notice"] }),
  });
  const seen = evidenceOf(run).firstAlert ?? "";
  assert.ok(seen.startsWith("Invalid sign-in for"));
  assert.equal(seen.includes(STUB_USER), false);
  assert.ok(seen.length <= EVIDENCE_TEXT_MAX);
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

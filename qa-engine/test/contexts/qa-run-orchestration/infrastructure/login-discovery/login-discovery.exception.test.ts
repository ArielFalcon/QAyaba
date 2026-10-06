import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import {
  button,
  evidenceOf,
  input,
  loginForm,
  outcomeOf,
  runLoginDiscovery,
  stayingSite,
  type StubError,
} from "../../../../support/login-discovery-harness.ts";

const silent = { status: "inconclusive", attempted: false };
const cannotComplete = { status: "failed", kind: PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE };

const errorObject = (text: string): StubError => ({ kind: "console", isErrorObject: true, text });
const pageError = (text: string): StubError => ({ kind: "pageerror", text });

/* An exception on the login page before the submit and one after it, nothing sent in between. */
const afterSubmit = (before: StubError, after: StubError) => runLoginDiscovery({ site: stayingSite({ requests: [], errors: [after] }, { ...loginForm(), errors: [before] }) });

test("a submit listener is installed on the page before the submit is made", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [] }) });
  const installed = run.events.findIndex((event) => event.t === "watch-installed");
  const submitted = run.events.findIndex((event) => event.t === "submit");
  assert.ok(installed >= 0, "the listener was installed");
  assert.ok(installed < submitted, "and before the submit");
});

test("a submit that reaches its form's submit event, with a new exception and nothing sent, is a login that cannot complete", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], errors: [errorObject("TypeError: handler-marker is null")] }) });
  assert.equal(evidenceOf(run).submitEventFired, true);
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, true);
  assert.deepEqual(outcomeOf(run), cannotComplete);
});

test("an exception first seen after a submit that never reached the form's submit event is not tied to the login", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], submitEvent: false, errors: [errorObject("TypeError: unrelated-marker is null")] }) });
  assert.equal(evidenceOf(run).submitEventFired, false);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a form that ignores Enter fires no submit event", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ enter: false, requests: [], errors: [errorObject("TypeError: unrelated-marker is null")] }) });
  assert.equal(evidenceOf(run).submitEventFired, false);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a password field outside any form, submitted by its control, fires no form submit event", async () => {
  const site = { pages: { "/": { fields: [input(0, "text", -1), input(1, "password", -1), button(2, -1)] } }, submit: { requests: [], errors: [errorObject("TypeError: unrelated-marker is null")] } };
  const run = await runLoginDiscovery({ site });
  assert.equal(evidenceOf(run).submitted, true);
  assert.equal(evidenceOf(run).submitEventFired, false);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a page that was replaced after the submit leaves no submit event to read, so nothing is tied to the login", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [], watchLost: true, errors: [errorObject("TypeError: unrelated-marker is null")] }) });
  assert.equal(evidenceOf(run).submitEventFired, false);
  assert.deepEqual(outcomeOf(run), silent);
});

/* The same exception on both sides of the submit, spelled differently by a number, an id or the channel it came through. */
const RECURRING: ReadonlyArray<[string, StubError, StubError]> = [
  ["a request id in hex", errorObject("Error: request 9f3ac2 timed out"), errorObject("Error: request b7d1e4 timed out")],
  ["a request id of letters a to f only", errorObject("Error: request abcdef timed out"), errorObject("Error: request fedcba timed out")],
  ["a short id mixing letters and digits", errorObject("Error: request req-7c2a failed"), errorObject("Error: request req-1f9e failed")],
  ["a request id mixing letters and digits", errorObject("Error: request req7x2 timed out"), errorObject("Error: request req9z4 timed out")],
  ["a GUID", errorObject("Error: trace 3fa85f64-5717-4562-b3fc-2c963f66afa6 failed"), errorObject("Error: trace 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed")],
  ["a console error and a page error", errorObject("TypeError: Cannot read properties of null (reading 'x')"), pageError("Cannot read properties of null (reading 'x')")],
  ["a DOMException on the console and its bare message as a page error", errorObject("DOMException: Failed to execute 'x' on 'y'"), pageError("Failed to execute 'x' on 'y'")],
  ["an uncaught console error and a page error", errorObject("Uncaught TypeError: x is not a function"), pageError("x is not a function")],
  ["a number and a URL", errorObject("Error: load 12 failed at https://cdn.stub.test/a.js?v=1"), errorObject("Error: load 97 failed at https://cdn.stub.test/b.js?v=2")],
];

for (const [label, before, after] of RECURRING) {
  test(`the same exception on both sides of the submit, differing in ${label}, is not new`, async () => {
    const run = await afterSubmit(before, after);
    assert.equal(evidenceOf(run).newExceptionAfterSubmit, false);
    assert.deepEqual(outcomeOf(run), silent);
  });
}

test("an exception that differs in more than an id or a channel is new", async () => {
  const run = await afterSubmit(errorObject("Error: request 9f3ac2 timed out"), errorObject("Error: session store is unavailable"));
  assert.equal(evidenceOf(run).newExceptionAfterSubmit, true);
  assert.deepEqual(outcomeOf(run), cannotComplete);
});

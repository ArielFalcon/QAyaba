import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_DEADLINE_MS,
  DEFAULT_ACTION_CALL_MS,
  DEFAULT_NAV_TIMEOUT_MS,
  SUBMITTED_MARKER,
} from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import {
  STUB_PASS,
  STUB_USER,
  evidenceOf,
  loginForm,
  loginRequest,
  outcomeOf,
  runLoginDiscovery,
  type DiscoveryRun,
  type StubSite,
  type StubSubmit,
} from "../../../../support/login-discovery-harness.ts";

/* A login that gets in: the form is on the root page, the submit lands on /home, and signed out /home shows the form again. */
const signedIn = (over: Partial<StubSite> = {}, submit: Partial<StubSubmit> = {}): StubSite => ({
  pages: { "/": loginForm(), "/home": loginForm() },
  authedPages: { "/home": {} },
  submit: { requests: [loginRequest({ status: 200 })], landing: "/home", ...submit },
  ...over,
});

/* What the fresh contexts (every browser context after the login's own) were asked to do. */
const freshEvents = (run: DiscoveryRun, kind: string) => {
  const own = run.events.find((event) => event.t === "context")?.id;
  return run.events.filter((event) => event.t === kind && event.ctx !== undefined && event.ctx !== own);
};

/* Every limit the child put on something it asked the browser to do. */
const ACTIONS = ["wait", "goto", "fill", "read", "submit"];
const waitsOf = (run: DiscoveryRun): number[] => run.events.flatMap((event) => (ACTIONS.includes(event.t) && event.timeout !== undefined ? [event.timeout] : []));

test("a fresh-context navigation that fails once is retried, and the second attempt confirms the session", async () => {
  const run = await runLoginDiscovery({ site: signedIn({ gotoFailsOnce: ["/home"] }) });
  assert.equal(freshEvents(run, "goto").length, 2);
  assert.equal(evidenceOf(run).freshContextChecked, true);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("a fresh-context verification that keeps failing still prints the evidence, unconfirmed, and the login stays an attempt", async () => {
  const run = await runLoginDiscovery({ site: signedIn({ gotoFails: ["/home"] }) });
  assert.deepEqual(run.markers, [SUBMITTED_MARKER]);
  const evidence = evidenceOf(run);
  assert.equal(evidence.passwordGone, true);
  assert.equal(evidence.storageStateWritten, true);
  assert.equal(evidence.freshContextChecked, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
  assert.ok(run.stderr.length > 0, "the failure is reported, not swallowed");
  assert.equal(run.stderr.includes(STUB_PASS) || run.stderr.includes(STUB_USER), false);
});

test("a failure to save the session state still prints the evidence, and the login stays an attempt", async () => {
  const run = await runLoginDiscovery({ site: signedIn({}, { saveFails: true }) });
  assert.equal(evidenceOf(run).storageStateWritten, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
  assert.ok(run.stderr.length > 0);
  assert.equal(run.stderr.includes(STUB_PASS) || run.stderr.includes(STUB_USER), false, "the account is removed from what the child reports");
});

test("a session state that was reported saved but is not on disk is not verified, and the login stays an attempt", async () => {
  const run = await runLoginDiscovery({ site: signedIn({}, { saveWritesNothing: true }) });
  assert.equal(evidenceOf(run).storageStateWritten, false);
  assert.equal(evidenceOf(run).freshContextChecked, false);
  assert.equal(run.events.filter((event) => event.t === "context").length, 1, "no fresh context was opened");
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

test("the fresh context is read once the password field has had time to go, not on its first flash of the form", async () => {
  const site = signedIn({ authedPages: { "/home": { initially: loginForm() } } });
  const run = await runLoginDiscovery({ site });
  assert.equal(freshEvents(run, "wait").length, 1);
  assert.equal(evidenceOf(run).freshContextPasswordGone, true);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("a fresh context whose form never goes is still read as showing it", async () => {
  const run = await runLoginDiscovery({ site: signedIn({}, { persists: false }) });
  assert.equal(evidenceOf(run).freshContextPasswordGone, false);
});

test("the fresh navigation is given at least the action timeout, and the usual bound when the app is not slower", async () => {
  const navigationTimeout = async (actionTimeoutMs?: number): Promise<number | undefined> => {
    const run = await runLoginDiscovery({ site: signedIn(), ...(actionTimeoutMs === undefined ? {} : { input: { actionTimeoutMs } }) });
    return freshEvents(run, "goto")[0]?.timeout;
  };
  assert.equal(await navigationTimeout(), DEFAULT_NAV_TIMEOUT_MS);
  assert.equal(await navigationTimeout(DEFAULT_NAV_TIMEOUT_MS / 2), DEFAULT_NAV_TIMEOUT_MS);
  assert.equal(await navigationTimeout(DEFAULT_NAV_TIMEOUT_MS * 2), DEFAULT_NAV_TIMEOUT_MS * 2);
});

test("whatever the action timeout, no wait the child sets outlasts the deadline it must print its evidence by", async () => {
  const run = await runLoginDiscovery({ site: signedIn(), input: { actionTimeoutMs: 100 * CHILD_DEADLINE_MS } });
  const timeouts = waitsOf(run);
  assert.ok(timeouts.length >= 8, "the waits, navigations, typing and key presses were recorded");
  for (const timeout of timeouts) assert.ok(timeout <= CHILD_DEADLINE_MS, `a wait of ${timeout} ms outlasts the deadline`);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("a wait is never asked for zero milliseconds, which the browser reads as no limit at all", async () => {
  const run = await runLoginDiscovery({ site: signedIn(), input: { actionTimeoutMs: 100 * CHILD_DEADLINE_MS, deadlineMs: 1 } });
  const timeouts = waitsOf(run);
  assert.ok(timeouts.length > 0);
  for (const timeout of timeouts) assert.ok(timeout >= 1, `a wait of ${timeout} ms`);
});

test("no wait outlasts a deadline that is moved earlier, the ladder's own navigations included", async () => {
  const run = await runLoginDiscovery({ site: signedIn(), input: { deadlineMs: 5_000 } });
  const timeouts = waitsOf(run);
  assert.ok(timeouts.length >= 8);
  for (const timeout of timeouts) assert.ok(timeout <= 5_000, `a wait of ${timeout} ms outlasts the deadline`);
});

test("the wait for a login request to answer ends at the deadline, not at the end of the post-submit window", async () => {
  const run = await runLoginDiscovery({
    site: signedIn({}, { requests: [loginRequest({ status: null })], persists: false }),
    input: { postSubmitMinWaitMs: 30_000, deadlineMs: 300 },
  });
  assert.equal(evidenceOf(run).inFlightAtDeadline, true);
});

test("typing and key presses are given the usual bound, or the action timeout when the app is slower", async () => {
  const typingTimeout = async (actionTimeoutMs?: number): Promise<number | undefined> => {
    const run = await runLoginDiscovery({ site: signedIn(), ...(actionTimeoutMs === undefined ? {} : { input: { actionTimeoutMs } }) });
    return run.events.find((event) => event.t === "fill")?.timeout;
  };
  assert.equal(await typingTimeout(), DEFAULT_ACTION_CALL_MS);
  assert.equal(await typingTimeout(DEFAULT_ACTION_CALL_MS / 2), DEFAULT_ACTION_CALL_MS);
  assert.equal(await typingTimeout(DEFAULT_ACTION_CALL_MS * 2), DEFAULT_ACTION_CALL_MS * 2);
});

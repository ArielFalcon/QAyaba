import { test } from "node:test";
import assert from "node:assert/strict";
import { FORM_STATE } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import {
  STUB_ORIGIN,
  evidenceOf,
  loginForm,
  outcomeOf,
  runLoginDiscovery,
  stayingSite,
  type StubSite,
  type StubSubmit,
} from "../../../../support/login-discovery-harness.ts";

/* A login that gets in: the form is on the root page, the submit answers and lands on /home, and signed out /home shows the form again. */
const signedInSite = (submit: Partial<StubSubmit> = {}): StubSite => ({
  pages: { "/": loginForm(), "/home": loginForm() },
  authedPages: { "/home": {} },
  submit: { requests: [{ method: "POST", url: "/api/session", status: 200 }], landing: "/home", ...submit },
});

test("a submit that gets in, held by a fresh context that shows no password field, is authenticated", async () => {
  const run = await runLoginDiscovery({ site: signedInSite() });
  const evidence = evidenceOf(run);
  assert.equal(evidence.passwordGone, true);
  assert.equal(evidence.storageStateWritten, true);
  assert.equal(evidence.freshContextChecked, true);
  assert.equal(evidence.freshContextPasswordGone, true);
  assert.equal(evidence.finalPath, "/home");
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("the fresh context is opened with the saved session at the path the submit ended on", async () => {
  const run = await runLoginDiscovery({ site: signedInSite() });
  const contexts = run.events.filter((event) => event.t === "context");
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.storageState, false);
  assert.equal(contexts[1]?.storageState, true);
  assert.deepEqual(run.events.filter((event) => event.t === "goto" && event.ctx === contexts[1]?.id).map((event) => event.to), ["/home"]);
});

test("a submit that ends on another origin is not verified or saved, so nothing is concluded", async () => {
  const run = await runLoginDiscovery({ site: signedInSite({ landing: "https://idp.stub.test/after" }) });
  const evidence = evidenceOf(run);
  assert.equal(evidence.passwordGone, true);
  assert.equal(evidence.storageStateWritten, false);
  assert.equal(evidence.freshContextChecked, false);
  assert.equal(evidence.finalPath, "/");
  assert.equal(run.events.filter((event) => event.t === "context").length, 1);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

test("a fresh context that ends on another origin is not read, so the session is neither confirmed nor called unpersistable", async () => {
  const site = { ...signedInSite({ persists: false }), redirects: { "/home": "https://idp.stub.test/login" }, pages: { "/": loginForm(), "https://idp.stub.test/login": loginForm() } };
  const run = await runLoginDiscovery({ site });
  const evidence = evidenceOf(run);
  assert.equal(evidence.passwordGone, true);
  assert.equal(evidence.freshContextChecked, false);
  assert.equal(run.events.some((event) => event.t === "inspected-foreign-page"), false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

test("a session that lives only in the page is not persistable: the fresh context shows the login form again", async () => {
  const run = await runLoginDiscovery({ site: signedInSite({ persists: false }) });
  const evidence = evidenceOf(run);
  assert.equal(evidence.passwordGone, true);
  assert.equal(evidence.freshContextChecked, true);
  assert.equal(evidence.freshContextPasswordGone, false);
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.SESSION_NOT_PERSISTABLE });
});

test("the dev gate's credentials go to both browser contexts, scoped to the app's origin, and only when the gate is configured", async () => {
  const gated = await runLoginDiscovery({ site: signedInSite(), env: { DEV_ENV_USER: "gate-user", DEV_ENV_PASS: "gate-pass" } });
  assert.deepEqual(gated.events.filter((event) => event.t === "context").map((event) => event.credentialsOrigin), [STUB_ORIGIN, STUB_ORIGIN]);
  const open = await runLoginDiscovery({ site: signedInSite() });
  assert.deepEqual(open.events.filter((event) => event.t === "context").map((event) => event.credentialsOrigin), [null, null]);
});

test("no browser context is asked to record a trace, a video or a HAR", async () => {
  const run = await runLoginDiscovery({ site: signedInSite(), env: { DEV_ENV_USER: "gate-user" } });
  const asked = run.events.filter((event) => event.t === "context").flatMap((event) => event.options ?? []);
  assert.ok(asked.length > 0, "the contexts were opened with options");
  for (const name of ["recordHar", "recordVideo", "trace", "tracesDir"]) assert.equal(asked.includes(name), false, name);
});

test("the ladder stops looking once its budget is spent", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/login": loginForm() } }, input: { budgetMs: 0 } });
  assert.deepEqual(run.gotos, ["/"]);
  assert.equal(evidenceOf(run).form, FORM_STATE.ABSENT);
  assert.equal(run.submits.length, 0);
});

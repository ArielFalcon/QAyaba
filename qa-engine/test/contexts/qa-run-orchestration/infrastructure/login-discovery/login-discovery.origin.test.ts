import { test } from "node:test";
import assert from "node:assert/strict";
import { FORM_STATE } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import {
  STUB_ORIGIN,
  button,
  evidenceOf,
  input,
  loginForm,
  outcomeOf,
  runLoginDiscovery,
  type DiscoveryRun,
  type StubPage,
  type StubSite,
} from "../../../../support/login-discovery-harness.ts";

const FOREIGN = "https://idp.stub.test";

/* Whatever was typed or submitted while the browser stood on another origin. */
const actedOffTheApp = (run: DiscoveryRun) => run.events.filter((event) => (event.t === "fill" || event.t === "submit") && event.at !== STUB_ORIGIN);
const fills = (run: DiscoveryRun) => run.events.filter((event) => event.t === "fill").map((event) => event.as);

test("a page that navigates to another origin while it is being read is never read as the app's", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": {}, [`${FOREIGN}/login`]: loginForm() }, navUnderRead: { onCall: 1, to: `${FOREIGN}/login` } },
  });
  assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
  assert.deepEqual(run.markers, []);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

test("a page that ends up on another origin right after it was read is not filled or submitted", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": loginForm(), [`${FOREIGN}/collect`]: loginForm() }, drifts: [{ on: "evaluate", nth: 1, to: `${FOREIGN}/collect` }] },
  });
  assert.deepEqual(actedOffTheApp(run), []);
  assert.equal(run.events.some((event) => event.t === "fill"), false);
  assert.deepEqual(run.markers, []);
});

test("a page that ends up on another origin right after the origin check that follows its read is not filled", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": loginForm(), [`${FOREIGN}/collect`]: loginForm() }, drifts: [{ on: "url-after-read", nth: 1, to: `${FOREIGN}/collect` }] },
  });
  assert.deepEqual(actedOffTheApp(run), []);
  assert.equal(run.events.some((event) => event.t === "fill"), false);
  assert.deepEqual(run.markers, []);
});

test("a page that changes origin after the user field was typed never gets the password or a submit", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": loginForm(), [`${FOREIGN}/collect`]: loginForm() }, drifts: [{ on: "fill", nth: 1, to: `${FOREIGN}/collect` }] },
  });
  assert.deepEqual(fills(run), ["user"]);
  assert.deepEqual(run.submits, []);
  assert.deepEqual(run.markers, []);
  assert.equal(evidenceOf(run).filled, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

test("a page that changes origin after the password was typed is not submitted and no submit marker is printed", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": loginForm(), [`${FOREIGN}/collect`]: loginForm() }, drifts: [{ on: "fill", nth: 2, to: `${FOREIGN}/collect` }] },
  });
  assert.deepEqual(fills(run), ["user", "pass"]);
  assert.deepEqual(run.submits, []);
  assert.deepEqual(run.markers, []);
  assert.equal(evidenceOf(run).submitted, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: false });
});

const PAGES_THAT_POST_ELSEWHERE: Array<[string, StubPage]> = [
  ["a form whose action leaves the app's origin", { ...loginForm(), forms: [{ sameOrigin: false }] }],
  ["a page whose base address leaves the app's origin", { ...loginForm(), baseSameOrigin: false }],
];

for (const [label, page] of PAGES_THAT_POST_ELSEWHERE) {
  test(`${label} is not a login form: nothing is typed or submitted`, async () => {
    const run = await runLoginDiscovery({ site: { pages: { "/": page } } });
    assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
    assert.equal(evidenceOf(run).form, FORM_STATE.ABSENT);
    assert.equal(evidenceOf(run).ladderHadPasswordField, true);
    assert.deepEqual(run.markers, []);
  });
}

test("a form that posts elsewhere does not hide the same-origin login form beside it", async () => {
  const run = await runLoginDiscovery({
    site: {
      pages: { "/": { fields: [input(0, "email", 0), input(1, "password", 0), input(2, "email", 1), input(3, "password", 1), button(4, 1)], forms: [{ sameOrigin: false }, { sameOrigin: true }] } },
    },
  });
  assert.deepEqual(run.events.filter((event) => event.t === "fill").map((event) => [event.i, event.as]), [[2, "user"], [3, "pass"]]);
});

test("a same-origin login link whose path starts with two slashes is followed as a path, never as a host", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": { links: [{ href: `${STUB_ORIGIN}//members/login`, text: "Sign in" }] }, "//members/login": loginForm() } },
  });
  assert.equal(run.gotos.includes("//members/login"), true);
  assert.equal(evidenceOf(run).form, FORM_STATE.FOUND);
  assert.equal(run.submits.length, 1);
});

test("the fresh context opens the page the submit ended on, even when its path starts with two slashes", async () => {
  const site: StubSite = {
    pages: { "/": loginForm() },
    authedPages: { "//home": {} },
    submit: { requests: [{ method: "POST", url: "/api/session", status: 200 }], landing: `${STUB_ORIGIN}//home` },
  };
  const run = await runLoginDiscovery({ site });
  const contexts = run.events.filter((event) => event.t === "context");
  assert.deepEqual(run.events.filter((event) => event.t === "goto" && event.ctx === contexts[1]?.id).map((event) => event.to), ["//home"]);
  assert.deepEqual(outcomeOf(run), { status: "authenticated" });
});

test("a fresh context that ends up on another origin right after it was read confirms nothing", async () => {
  const site: StubSite = {
    pages: { "/": loginForm(), "/home": loginForm(), [`${FOREIGN}/x`]: loginForm() },
    authedPages: { "/home": {} },
    submit: { requests: [{ method: "POST", url: "/api/session", status: 200 }], landing: "/home" },
    drifts: [{ on: "evaluate", nth: 1, to: `${FOREIGN}/x`, context: 2 }],
  };
  const run = await runLoginDiscovery({ site });
  assert.equal(evidenceOf(run).freshContextChecked, false);
  assert.deepEqual(outcomeOf(run), { status: "inconclusive", attempted: true });
});

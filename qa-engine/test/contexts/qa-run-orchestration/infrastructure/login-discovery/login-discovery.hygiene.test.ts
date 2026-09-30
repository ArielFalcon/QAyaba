import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_TEXT_MAX } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.page-readers.ts";
import {
  STUB_PASS,
  STUB_USER,
  evidenceOf,
  loginForm,
  loginRequest,
  runLoginDiscovery,
  stayingSite,
  type StubSite,
} from "../../../../support/login-discovery-harness.ts";

/* A login that gets in and lands on `landing`; signed out that page shows the form again. */
const landingOn = (landing: string): StubSite => ({
  pages: { "/": loginForm() },
  authedPages: { "/": {}, [landing]: {} },
  submit: { requests: [loginRequest({ status: 200 })], landing },
});

const HASHES: ReadonlyArray<[string, string, string]> = [
  ["a hash that is not a route", "/#access_token=eyJhbGciOi.tok-marker.sig&state=1", "/"],
  ["a hash that carries a token after a route", "/#/dashboard?token=tok-marker", "/#/dashboard"],
  ["a hash route with a parameter", "/#/callback=tok-marker", "/#/callback"],
  ["a hash route joined with an ampersand", "/#/home&code=tok-marker", "/#/home"],
  ["a bang hash route with a parameter", "/#!/reports=tok-marker", "/#!/reports"],
  ["a plain hash route", "/#/dashboard", "/#/dashboard"],
];

for (const [label, landing, expected] of HASHES) {
  test(`the final path keeps a hash route and drops a hash token: ${label}`, async () => {
    const run = await runLoginDiscovery({ site: landingOn(landing) });
    const evidence = evidenceOf(run);
    assert.equal(evidence.finalPath, expected);
    assert.equal(JSON.stringify(evidence).includes("tok-marker"), false);
  });
}

test("a path's query and a login link's hash token never reach the pages tried", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": { links: [{ href: "/signin?token=tok-marker&x=1#state=tok-marker", text: "Sign in" }] } } },
  });
  const evidence = evidenceOf(run);
  assert.equal(evidence.ladder.includes("/signin"), true);
  assert.equal(JSON.stringify(evidence).includes("tok-marker"), false);
});

test("the account is removed from the pages tried and from the final path", async () => {
  const route = `/u/${STUB_USER}`;
  const run = await runLoginDiscovery({
    site: { pages: { "/": {}, [route]: loginForm() }, authedPages: { [route]: {} }, submit: { requests: [loginRequest({ status: 200 })], landing: route } },
    input: { routes: [route] },
  });
  assert.equal(evidenceOf(run).ladder.length, 2, "the route was visited");
  const carried = JSON.stringify(evidenceOf(run));
  assert.equal(carried.includes(STUB_USER), false);
  assert.equal(carried.includes(encodeURIComponent(STUB_USER)), false);
});

test("a password inside a request path is removed from the request's path", async () => {
  const url = `/api/session/${encodeURIComponent(STUB_PASS)}`;
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest({ url, postData: "{}" })] }) });
  const [request] = evidenceOf(run).requests;
  assert.ok(request?.pathname.startsWith("/api/session/"), "the request is attributed to the login");
  assert.equal(JSON.stringify(evidenceOf(run)).includes(STUB_PASS.slice(0, 5)), false);
  assert.equal(JSON.stringify(evidenceOf(run)).includes(encodeURIComponent(STUB_PASS).slice(0, 8)), false);
});

test("a password with a quote, a backslash and a slash is removed from a request path in the browser's own spelling", async () => {
  const password = "pa'ss\"w/o\\rd";
  const spelledByBrowser = new URL(`https://app.stub.test/api/s/${password}`).pathname.slice("/api/s/".length);
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [loginRequest({ url: `/api/s/${password}`, postData: "{}" })] }),
    env: { DEV_TEST_PASS: password },
  });
  assert.equal(evidenceOf(run).requests.length, 1, "the request is attributed to the login");
  const carried = JSON.stringify(evidenceOf(run));
  assert.equal(carried.includes(spelledByBrowser), false, `the path still holds ${spelledByBrowser}`);
  assert.equal(carried.includes("o/rd"), false);
});

test("an alert the page cut at its text bound, in the middle of the password, leaves no prefix of the password behind", async () => {
  const head = "see https://x.stub.test/";
  const tail = " retry with ";
  const kept = STUB_PASS.slice(0, 5);
  const text = head + "a".repeat(PAGE_TEXT_MAX - kept.length - head.length - tail.length) + tail + kept;
  assert.equal(text.length, PAGE_TEXT_MAX);
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest()], after: { ...loginForm(), alerts: [text] } }) });
  const alert = evidenceOf(run).firstAlert ?? "";
  assert.ok(alert.startsWith("see "), "the alert is still reported");
  assert.equal(alert.includes(kept), false);
  assert.equal(alert.includes(kept.slice(0, 3)), false);
});

test("an alert that stays under the page's text bound is reported whole, up to the note's own bound", async () => {
  const text = `Sign-in refused ${"x".repeat(50)}`;
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest()], after: { ...loginForm(), alerts: [text] } }) });
  assert.equal(evidenceOf(run).firstAlert, text);
});

test("the fresh context is opened on the route the submit ended on, never on a hash token", async () => {
  const run = await runLoginDiscovery({ site: landingOn("/#/dashboard?token=tok-marker") });
  const own = run.events.find((event) => event.t === "context")?.id;
  const opened = run.events.filter((event) => event.t === "goto" && event.ctx !== own).map((event) => event.to);
  assert.deepEqual(opened, ["/#/dashboard"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { FORM_STATE } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import {
  LOGIN_WELL_KNOWN_PATHS,
  MAX_GATED_ROUTES,
  SUBMITTED_MARKER,
  buildLoginDiscoveryScript,
} from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import { STUB_ORIGIN, STUB_PASS, STUB_USER, button, input, loginForm, nodeChecks, runLoginDiscovery } from "../../../../support/login-discovery-harness.ts";

const FOREIGN = "https://idp.stub.test";

test("the ladder opens the declared path, then the root, a login link, at most three gated routes and the well-known paths", async () => {
  const routes = ["/reports", "/orders", "/settings", "/billing"];
  const run = await runLoginDiscovery({
    site: { pages: { "/": { links: [{ href: "/enter-here", text: "Sign in" }] } } },
    input: { loginPath: "/custom-login", routes },
  });
  assert.deepEqual(run.gotos, ["/custom-login", "/", "/enter-here", ...routes.slice(0, MAX_GATED_ROUTES), ...LOGIN_WELL_KNOWN_PATHS]);
  assert.equal(run.evidence?.form, FORM_STATE.ABSENT);
  assert.equal(run.submits.length, 0);
});

test("with no declared path the ladder starts at the root", async () => {
  const run = await runLoginDiscovery({ site: { pages: {} } });
  assert.equal(run.gotos[0], "/");
  assert.equal(run.gotos.includes("/custom-login"), false);
});

test("a login link that leaves the app's origin is never followed", async () => {
  const run = await runLoginDiscovery({
    site: {
      pages: {
        "/": {
          links: [
            { href: `${FOREIGN}/login`, text: "Log in" },
            { href: "//idp.stub.test/signin", text: "Sign in" },
            { href: "/members/signin", text: "Members" },
          ],
        },
      },
    },
  });
  assert.equal(run.gotos.includes("/members/signin"), true);
  assert.equal(run.gotos.some((to) => to.includes("idp.stub.test")), false);
});

test("a declared path on another origin is never opened", async () => {
  const run = await runLoginDiscovery({ site: { pages: {} }, input: { loginPath: "//idp.stub.test/login" } });
  assert.equal(run.gotos.some((to) => to.includes("idp.stub.test")), false);
  assert.equal(run.gotos[0], "/");
});

test("a gated route that redirects to the login page is followed there and its form is used", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/gate": loginForm() }, redirects: { "/private": "/gate" } },
    input: { routes: ["/private"] },
  });
  assert.equal(run.evidence?.form, FORM_STATE.FOUND);
  assert.deepEqual(run.gotos, ["/", "/private"]);
  assert.equal(run.evidence?.ladder.includes("/private"), true);
  assert.equal(run.submits.length, 1);
});

test("a page whose navigation fails does not end the ladder", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/login": loginForm() }, gotoFails: ["/"] } });
  assert.equal(run.evidence?.form, FORM_STATE.FOUND);
  assert.equal(run.gotos.at(-1), "/login");
});

test("the ladder stops at the first page with a login form, so two such pages still get one submit", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm(), "/login": loginForm() } } });
  assert.deepEqual(run.gotos, ["/"]);
  assert.equal(run.submits.length, 1);
  assert.deepEqual(run.markers, [SUBMITTED_MARKER]);
});

test("the user field is the nearest visible text-like input before the password in the same form; decoys elsewhere are left alone", async () => {
  const run = await runLoginDiscovery({
    site: {
      pages: {
        "/": {
          fields: [
            input(0, "search", 1),
            input(1, "text", -1),
            input(2, "text", 0),
            input(3, "email", 0),
            input(4, "text", 1),
            input(5, "text", 0, { visible: false }),
            input(6, "password", 0),
            button(7, 0),
          ],
        },
      },
    },
  });
  const fills = run.events.filter((event) => event.t === "fill");
  assert.deepEqual(fills.map((event) => [event.i, event.as]), [[3, "user"], [6, "pass"]]);
});

for (const [type, takesUser] of [["text", true], ["email", true], ["tel", true], ["search", false], ["number", false]] as const) {
  test(`a ${type} input before the password ${takesUser ? "is taken as the user field" : "is not taken as the user field"}`, async () => {
    const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, type, 0), input(1, "password", 0), button(2, 0)] } } } });
    assert.equal(run.evidence?.filled, takesUser);
    assert.equal(run.submits.length, takesUser ? 1 : 0);
  });
}

test("a password field that is not showing is not a login form, though the page did have one", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, "text", 0), input(1, "password", 0, { visible: false }), button(2, 0)] } } } });
  assert.equal(run.evidence?.form, FORM_STATE.ABSENT);
  assert.equal(run.evidence?.ladderHadPasswordField, true);
  assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
});

test("a hidden password field beside a showing one in another form does not take the account", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": { fields: [input(0, "text", 0), input(1, "password", 0, { visible: false }), input(2, "text", 1), input(3, "password", 1), button(4, 1)] } } },
  });
  assert.deepEqual(run.events.filter((event) => event.t === "fill").map((event) => [event.i, event.as]), [[2, "user"], [3, "pass"]]);
});

test("a user field the visitor cannot type in is passed over for the nearest one that can be typed in", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": { fields: [input(0, "text", 0), input(1, "email", 0, { disabled: true }), input(2, "password", 0), button(3, 0)] } } },
  });
  assert.deepEqual(run.events.filter((event) => event.t === "fill").map((event) => [event.i, event.as]), [[0, "user"], [2, "pass"]]);
});

test("a form whose only user field cannot be typed in is not filled or submitted", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, "text", 0, { disabled: true }), input(1, "password", 0), button(2, 0)] } } } });
  assert.equal(run.evidence?.filled, false);
  assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
});

test("a page that navigates under the first read is read again on the same origin, and its form is used", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": {}, "/next": loginForm() }, navUnderRead: { onCall: 1, to: `${STUB_ORIGIN}/next` } },
  });
  assert.equal(run.evidence?.form, FORM_STATE.FOUND);
  assert.equal(run.submits.length, 1);
});

test("a native form post is the login's own request when its body carries the account", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": loginForm() }, submit: { requests: [{ method: "POST", url: "/session", resourceType: "document", navigation: true, postData: `u=${encodeURIComponent(STUB_USER)}`, status: 401 }] } },
  });
  assert.equal(run.evidence?.requests.length, 1);
});

test("a form with two password fields is never filled or submitted", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, "text", 0), input(1, "password", 0), input(2, "password", 0), button(3, 0)] } } } });
  assert.equal(run.evidence?.form, FORM_STATE.AMBIGUOUS);
  assert.equal(run.evidence?.ladderHadPasswordField, true);
  assert.equal(run.evidence?.filled, false);
  assert.equal(run.evidence?.submitted, false);
  assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
  assert.deepEqual(run.markers, []);
});

test("a two-password form does not hide the single-password form beside it", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { "/": { fields: [input(0, "text", 0), input(1, "password", 0), input(2, "password", 0), input(3, "email", 1), input(4, "password", 1), button(5, 1)] } } },
  });
  assert.deepEqual(run.events.filter((event) => event.t === "fill").map((event) => [event.i, event.as]), [[3, "user"], [4, "pass"]]);
});

test("a typed value that does not stick stops the attempt before anything is submitted", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm() }, dropFill: [1] } });
  assert.equal(run.evidence?.form, FORM_STATE.FOUND);
  assert.equal(run.evidence?.filled, false);
  assert.equal(run.evidence?.submitted, false);
  assert.equal(run.submits.length, 0);
});

test("a login form with no user field is not filled or submitted", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": { fields: [input(0, "password", 0), button(1, 0)] } } } });
  assert.equal(run.evidence?.form, FORM_STATE.FOUND);
  assert.equal(run.evidence?.filled, false);
  assert.equal(run.events.some((event) => event.t === "fill" || event.t === "submit"), false);
});

test("a login form on another origin is never inspected, filled or submitted", async () => {
  const run = await runLoginDiscovery({
    site: { pages: { [`${FOREIGN}/auth`]: loginForm() }, redirects: { "/sso": `${FOREIGN}/auth` } },
    input: { routes: ["/sso"] },
  });
  assert.equal(run.evidence?.form, FORM_STATE.ABSENT);
  assert.equal(run.evidence?.ladderHadPasswordField, false);
  assert.equal(run.evidence?.submitted, false);
  assert.equal(run.events.some((event) => event.t === "inspected-foreign-page" || event.t === "fill" || event.t === "submit"), false);
});

test("the submit is Enter pressed in the password field", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm() } } });
  assert.equal(run.submits.length, 1);
  assert.equal(run.submits[0]?.via, "press");
  assert.equal(run.submits[0]?.key, "Enter");
  assert.equal(run.submits[0]?.i, 1);
  assert.equal(run.evidence?.submitted, true);
  assert.equal(run.evidence?.filled, true);
});

test("stdout carries the submitted marker before the one evidence line and nothing else, never a credential", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm() } } });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.lines.map((line) => ("marker" in line ? "marker" : "evidence" in line ? "evidence" : "other")), ["marker", "evidence"]);
  assert.equal(run.stdout.includes(STUB_USER) || run.stdout.includes(STUB_PASS), false);
  assert.equal(run.stderr.includes(STUB_USER) || run.stderr.includes(STUB_PASS), false);
});

test("a crash while submitting still leaves the submitted marker and no evidence", async () => {
  const run = await runLoginDiscovery({ site: { pages: { "/": loginForm() } }, env: { STUB_PRESS_ERROR: `press failed for ${STUB_PASS}` } });
  assert.deepEqual(run.markers, [SUBMITTED_MARKER]);
  assert.equal(run.evidence, undefined);
  assert.notEqual(run.exitCode, 0);
  assert.equal(run.stderr.includes(STUB_PASS), false);
});

test("a run that submits nothing prints no marker and still ends with its evidence", async () => {
  const run = await runLoginDiscovery({ site: { pages: {} } });
  assert.deepEqual(run.markers, []);
  assert.equal(run.evidence?.submitted, false);
  assert.equal(run.lines.length, 1);
});

test("a crash reports on stderr with the credentials removed and prints no evidence", async () => {
  const run = await runLoginDiscovery({ site: { pages: {} }, env: { STUB_LAUNCH_ERROR: `browser died while signing in ${STUB_USER} with ${STUB_PASS}` } });
  assert.notEqual(run.exitCode, 0);
  assert.equal(run.evidence, undefined);
  assert.equal(run.stderr.includes("browser died"), true);
  assert.equal(run.stderr.includes(STUB_USER) || run.stderr.includes(STUB_PASS), false);
});

test("the generated script is valid JavaScript", async () => {
  assert.equal(await nodeChecks(buildLoginDiscoveryScript()), true);
});

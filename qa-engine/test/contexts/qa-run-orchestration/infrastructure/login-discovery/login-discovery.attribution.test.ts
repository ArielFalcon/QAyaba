import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";
import {
  STUB_PASS,
  STUB_USER,
  evidenceOf,
  loginForm,
  loginRequest,
  outcomeOf,
  runLoginDiscovery,
  stayingSite,
  type StubRequest,
} from "../../../../support/login-discovery-harness.ts";

const rejected = { status: "failed", kind: PRECONDITION_KIND.CREDENTIALS_REJECTED };
const silent = { status: "inconclusive", attempted: false };

test("a form that ignores Enter, in a window with a third party's telemetry, has sent no login", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ enter: false, background: [{ method: "POST", url: "https://telemetry.stub.test/v1/collect", status: 200, postData: '{"event":"page_view"}' }] }),
  });
  assert.deepEqual(evidenceOf(run).requests, []);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a background refresh the app makes on its own, refused with 401, is not the login being rejected", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [{ method: "POST", url: "/api/auth/refresh", status: 401 }] }) });
  assert.deepEqual(evidenceOf(run).requests, []);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a login request that carries the account and is refused with 401 is the login being rejected", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest()] }) });
  assert.equal(evidenceOf(run).requests.length, 1);
  assert.deepEqual(outcomeOf(run), rejected);
});

/* A user name is often short or common, and an app's own traffic names routes the same way. */
for (const user of ["admin", "test"]) {
  test(`the app's own background traffic is not the login when the user name is "${user}"`, async () => {
    const run = await runLoginDiscovery({
      site: stayingSite({ enter: false, background: [{ method: "POST", url: `/api/${user}/test/refresh`, status: 401 }] }),
      env: { DEV_TEST_USER: user },
    });
    assert.deepEqual(evidenceOf(run).requests, []);
    assert.deepEqual(outcomeOf(run), silent);
  });
}

test("a request that carries the user name and not the password is not the login", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest({ url: `/api/lookup?user=${encodeURIComponent(STUB_USER)}`, postData: JSON.stringify({ username: STUB_USER }) })] }) });
  assert.deepEqual(evidenceOf(run).requests, []);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a login whose user name is short is attributed through its password, even beside traffic that names the user", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [loginRequest({ postData: JSON.stringify({ username: "admin", password: STUB_PASS }) })], background: [{ method: "POST", url: "/api/admin/refresh", status: 401 }] }),
    env: { DEV_TEST_USER: "admin" },
  });
  assert.deepEqual(evidenceOf(run).requests.map((request) => request.pathname), ["/api/session"]);
  assert.deepEqual(outcomeOf(run), rejected);
});

test("a login with no password set has no request attributed to it", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ enter: false, background: [{ method: "POST", url: "/api/refresh", status: 401, postData: "{}" }] }),
    env: { DEV_TEST_PASS: "" },
  });
  assert.deepEqual(evidenceOf(run).requests, []);
  assert.deepEqual(outcomeOf(run), silent);
});

test("a request with no body does not carry a password that reads as the word an empty body is shown as", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ enter: false, background: [{ method: "POST", url: "/api/refresh", status: 401 }] }),
    env: { DEV_TEST_PASS: "null" },
  });
  assert.deepEqual(evidenceOf(run).requests, []);
});

/* The password as a request can carry it: in a body of any encoding or in the address, with or without the user name beside it. */
const CARRIED: ReadonlyArray<[string, Partial<StubRequest>]> = [
  ["a JSON body", { postData: JSON.stringify({ username: STUB_USER, password: STUB_PASS }) }],
  ["the password alone", { postData: JSON.stringify({ password: STUB_PASS }) }],
  ["a form body with percent escapes", { postData: `u=${encodeURIComponent(STUB_USER)}&p=${encodeURIComponent(STUB_PASS)}` }],
  ["a form body with plus for spaces", { postData: `p=${encodeURIComponent(STUB_PASS).replace(/%20/g, "+")}` }],
  ["the address alone", { url: `/api/session?password=${encodeURIComponent(STUB_PASS)}`, postData: "{}" }],
];

for (const [label, over] of CARRIED) {
  test(`a login request that carries the password in ${label} is attributed to the login`, async () => {
    const run = await runLoginDiscovery({ site: stayingSite({ requests: [loginRequest(over)] }) });
    assert.equal(evidenceOf(run).requests.length, 1);
    assert.deepEqual(outcomeOf(run), rejected);
  });
}

test("a password with a quote, a backslash and a slash is recognised in its JSON-escaped spelling", async () => {
  const password = 'pa"ss\\w/rd';
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [loginRequest({ postData: JSON.stringify({ password }) })] }),
    env: { DEV_TEST_PASS: password },
  });
  assert.equal(evidenceOf(run).requests.length, 1);
});

test("a percent escape in lower case is the same account as one in capitals", async () => {
  const password = "a/b c";
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [loginRequest({ postData: `p=${encodeURIComponent(password).toLowerCase()}` })] }),
    env: { DEV_TEST_PASS: password },
  });
  assert.equal(evidenceOf(run).requests.length, 1);
});

test("a request made before the submit is never the login's, even when its address happens to carry the account", async () => {
  const warm = loginRequest({ url: `/api/warm?u=${encodeURIComponent(STUB_USER)}`, status: 401 });
  const run = await runLoginDiscovery({ site: { pages: { "/": { ...loginForm(), loadRequests: [warm] } }, submit: { enter: false } } });
  assert.deepEqual(evidenceOf(run).requests, []);
  assert.deepEqual(outcomeOf(run), silent);
});

/* What a native GET form puts in the address: the user name and the password. */
const ACCOUNT_QUERY = `user=${encodeURIComponent(STUB_USER)}&password=${encodeURIComponent(STUB_PASS)}`;

test("a native GET form is a login: the top-frame navigation whose address carries the password is its request", async () => {
  const navigation: StubRequest = { method: "GET", url: `/login?${ACCOUNT_QUERY}`, resourceType: "document", navigation: true, status: 200 };
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [navigation] }) });
  const evidence = evidenceOf(run);
  assert.deepEqual(evidence.requests, [{ method: "GET", pathname: "/login", status: 200 }]);
  assert.equal(JSON.stringify(evidence).includes(encodeURIComponent(STUB_USER)), false);
  assert.equal(JSON.stringify(evidence).includes(encodeURIComponent(STUB_PASS)), false);
  assert.deepEqual(outcomeOf(run), { status: "failed", kind: PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE });
});

const NOT_A_LOGIN_NAVIGATION: ReadonlyArray<[string, StubRequest]> = [
  ["a top-frame navigation whose address does not carry the password", { method: "GET", url: `/dashboard?user=${encodeURIComponent(STUB_USER)}`, resourceType: "document", navigation: true, status: 200 }],
  ["a navigation inside a frame of the page", { method: "GET", url: `/login?${ACCOUNT_QUERY}`, resourceType: "document", navigation: true, subframe: true, status: 200 }],
  ["a script's GET that carries the password", { method: "GET", url: `/api/check?${ACCOUNT_QUERY}`, resourceType: "fetch", status: 200 }],
  ["a service worker's navigation, which has no frame", { method: "GET", url: `/login?${ACCOUNT_QUERY}`, resourceType: "document", navigation: true, serviceWorker: true, status: 200 }],
];

for (const [label, request] of NOT_A_LOGIN_NAVIGATION) {
  test(`${label} is not the login's request`, async () => {
    const run = await runLoginDiscovery({ site: stayingSite({ requests: [request] }) });
    assert.deepEqual(evidenceOf(run).requests, []);
    assert.deepEqual(outcomeOf(run), silent);
  });
}

test("a background request that never gets an answer does not count as a login still in flight", async () => {
  const run = await runLoginDiscovery({ site: stayingSite({ requests: [{ method: "POST", url: "/api/poll", status: null }] }) });
  assert.equal(evidenceOf(run).inFlightAtDeadline, false);
  assert.deepEqual(outcomeOf(run), silent);
});

test("only the login's requests are listed when unrelated traffic goes out beside them", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [loginRequest(), { method: "POST", url: "/api/auth/refresh", status: 401 }], background: [{ method: "POST", url: "https://telemetry.stub.test/collect", status: 200 }] }),
  });
  assert.deepEqual(evidenceOf(run).requests.map((request) => request.pathname), ["/api/session"]);
});

test("the host a request goes to is not the account, however alike its name", async () => {
  const run = await runLoginDiscovery({
    site: stayingSite({ requests: [{ method: "POST", url: "https://telemetry.stub.test/collect", status: 200, postData: "{}" }] }),
    env: { DEV_TEST_USER: "telemetry" },
  });
  assert.deepEqual(evidenceOf(run).requests, []);
});

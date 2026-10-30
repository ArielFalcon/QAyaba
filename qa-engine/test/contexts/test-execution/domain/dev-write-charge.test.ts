/* A DEV write is charged to the spec only with evidence the spec caused it: a page request the worker's control load, run with no spec action, also sent is the page's own upkeep, exempt up to the count the control saw; every other write is charged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeTestWrites, type RecordedWrite, type TestWriteLedger } from "@contexts/test-execution/domain/dev-write-charge.ts";

const DEV = "https://dev.example.com";
const REFRESH_SHAPES: Array<{ shape: string; method: string; url: string }> = [
  { shape: "a form refresh at a separate identity provider", method: "POST", url: "https://id.example.com/realms/r/protocol/openid-connect/token" },
  { shape: "a JSON refresh at the identity provider", method: "POST", url: "https://id.example.com/oauth/token" },
  { shape: "a refresh on the app's own origin", method: "POST", url: `${DEV}/api/auth/refresh` },
  { shape: "a cookie renewal with no body", method: "POST", url: `${DEV}/session/renew` },
  { shape: "a load-time beacon", method: "POST", url: `${DEV}/beacon/heartbeat` },
];

function ledger(requests: RecordedWrite[], extra: Partial<TestWriteLedger> = {}): TestWriteLedger {
  return { writes: requests.reduce((sum, r) => sum + r.count, 0), pending: 0, done: true, requests, ...extra };
}
const page = (method: string, url: string, count = 1): RecordedWrite => ({ method, url, sender: "page", count });
const api = (method: string, url: string, count = 1): RecordedWrite => ({ method, url, sender: "api", count });

for (const { shape, method, url } of REFRESH_SHAPES) {
  test(`${shape} that the control also sent is charged 0`, () => {
    const out = chargeTestWrites(ledger([page(method, url)]), [{ method, url, count: 1 }]);
    assert.equal(out.charged, 0);
    assert.deepEqual(out.exemptRequests, [{ method, url, count: 1 }]);
    assert.deepEqual(out.chargedRequests, []);
  });
}

test("a request is exempt up to the count the control saw: the rest of what the test sent is charged", () => {
  const url = `${DEV}/api/auth/refresh`;
  const out = chargeTestWrites(ledger([page("POST", url, 3)]), [{ method: "POST", url, count: 1 }]);
  assert.equal(out.charged, 2);
  assert.deepEqual(out.exemptRequests, [{ method: "POST", url, count: 1 }]);
  assert.deepEqual(out.chargedRequests, [{ method: "POST", url, count: 2 }]);
});

test("a page request the control did not send is charged whatever its body would have said: fifty of them cost fifty", () => {
  const out = chargeTestWrites(ledger([page("POST", `${DEV}/api/orders`, 50)]), []);
  assert.equal(out.charged, 50);
});

test("the api client's request is charged although the control saw the same endpoint", () => {
  const url = "https://id.example.com/oauth/token";
  const out = chargeTestWrites(ledger([api("POST", url)]), [{ method: "POST", url, count: 5 }]);
  assert.equal(out.charged, 1);
  assert.deepEqual(out.exemptRequests, []);
});

test("a request recorded with no sender is never exempt", () => {
  const url = `${DEV}/api/auth/refresh`;
  const out = chargeTestWrites(ledger([{ method: "POST", url, sender: "unknown", count: 1 }]), [{ method: "POST", url, count: 1 }]);
  assert.equal(out.charged, 1);
});

test("the method and the address are both the key: the same path by another method, or another origin, is a write", () => {
  const url = `${DEV}/api/auth/refresh`;
  const out = chargeTestWrites(ledger([page("PUT", url), page("POST", "https://other.example.com/api/auth/refresh")]), [{ method: "POST", url, count: 9 }]);
  assert.equal(out.charged, 2);
});

test("without a control every request is charged", () => {
  const url = `${DEV}/api/auth/refresh`;
  const out = chargeTestWrites(ledger([page("POST", url, 4)]), undefined);
  assert.equal(out.charged, 4);
  assert.deepEqual(out.exemptRequests, []);
  assert.deepEqual(out.chargedRequests, [{ method: "POST", url, count: 4 }]);
});

test("a write the ledger could not record is charged in full, and so is a request a test left pending when it did not finish", () => {
  const url = `${DEV}/api/auth/refresh`;
  const out = chargeTestWrites({ writes: 30, pending: 2, done: false, requests: [page("POST", url, 9)] }, [{ method: "POST", url, count: 9 }]);
  assert.equal(out.charged, 21 + 2);
  const finished = chargeTestWrites({ writes: 30, pending: 2, done: true, requests: [page("POST", url, 9)] }, [{ method: "POST", url, count: 9 }]);
  assert.equal(finished.charged, 21, "a finished test has nothing out");
});

test("the exemption of one test is not carried to the next: each test's page loads and renews on its own", () => {
  const url = `${DEV}/api/auth/refresh`;
  const control = [{ method: "POST", url, count: 1 }];
  assert.equal(chargeTestWrites(ledger([page("POST", url)]), control).charged, 0);
  assert.equal(chargeTestWrites(ledger([page("POST", url)]), control).charged, 0);
});

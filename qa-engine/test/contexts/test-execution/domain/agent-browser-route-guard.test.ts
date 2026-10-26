import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouteGuard, routePatternError, mutatingEntryError, type RouteGuardPolicy } from "@contexts/test-execution/domain/agent-browser-route-guard.ts";

const POLICY: RouteGuardPolicy = { origins: ["https://dev.example.com", "https://cdn.example.com:8443"], denyRoutes: [], allowMutating: [] };
const guard = (over: Partial<RouteGuardPolicy> = {}) => createRouteGuard({ ...POLICY, ...over });

test("a read of a declared origin is allowed whatever the safe method", () => {
  const g = guard();
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.equal(g.decide({ method, url: "https://dev.example.com/orders?page=2" }).allow, true, method);
  }
});

test("a read-only decision ignores every allowMutating entry, and reads are decided as before", () => {
  const g = guard({ allowMutating: ["POST /api/search", "/graphql"] });
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/search" }, { readOnly: true }).allow, false);
  assert.equal(g.decide({ method: "PATCH", url: "https://dev.example.com/graphql" }, { readOnly: true }).allow, false);
  assert.equal(g.decide({ method: "GET", url: "https://dev.example.com/api/search" }, { readOnly: true }).allow, true);
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/search" }).allow, true, "a decision that is not read-only keeps the app's entries");
});

test("every method that can write is blocked, with the reason named", () => {
  const g = guard();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "PROPFIND"]) {
    const decision = g.decide({ method, url: "https://dev.example.com/api/orders" });
    assert.equal(decision.allow, false, method);
    if (!decision.allow) assert.equal(decision.reason, "method");
  }
});

test("a mutating method is allowed only on a path an allowMutating entry names", () => {
  const g = guard({ allowMutating: ["POST /api/search", "/graphql", "DELETE /api/drafts/*"] });
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/search" }).allow, true);
  assert.equal(g.decide({ method: "PUT", url: "https://dev.example.com/api/search" }).allow, false, "the entry names POST alone");
  assert.equal(g.decide({ method: "PATCH", url: "https://dev.example.com/graphql" }).allow, true, "an entry without a method covers every mutating method");
  assert.equal(g.decide({ method: "DELETE", url: "https://dev.example.com/api/drafts/42" }).allow, true);
  assert.equal(g.decide({ method: "DELETE", url: "https://dev.example.com/api/drafts/42/comments" }).allow, false, "a single * stops at a segment");
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/orders" }).allow, false);
});

test("an allowMutating match is on the path alone, not on the query, and does not survive a dot segment", () => {
  const g = guard({ allowMutating: ["POST /api/search"] });
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/search?q=a" }).allow, true);
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/api/search/../orders" }).allow, false);
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/API/search" }).allow, false, "an allowance is case sensitive");
});

test("a denied route is blocked for every method, however the path is spelled", () => {
  const g = guard({ denyRoutes: ["/admin/**", "/settings/billing", "/export*"], allowMutating: ["/admin/**"] });
  const blocked = [
    "https://dev.example.com/admin",
    "https://dev.example.com/admin/users/7",
    "https://dev.example.com/settings/billing",
    "https://dev.example.com/settings/billing/",
    "https://dev.example.com//admin/users",
    "https://dev.example.com/ADMIN/users",
    "https://dev.example.com/%61dmin/users",
    "https://dev.example.com/admin;jsessionid=1/users",
    "https://dev.example.com/exports",
    "https://dev.example.com/public/../admin/users",
  ];
  for (const url of blocked) {
    const decision = g.decide({ method: "GET", url });
    assert.equal(decision.allow, false, url);
    if (!decision.allow) assert.equal(decision.reason, "deny-route", url);
  }
  assert.equal(g.decide({ method: "POST", url: "https://dev.example.com/admin/users" }).allow, false, "a deny wins over an allowMutating entry");
  assert.equal(g.decide({ method: "GET", url: "https://dev.example.com/settings/profile" }).allow, true);
  assert.equal(g.decide({ method: "GET", url: "https://dev.example.com/administrators" }).allow, true, "/admin/** is not a prefix match on the name");
});

test("an origin the run does not declare is blocked, and so is a different port or scheme of a declared host", () => {
  const g = guard();
  for (const url of [
    "https://other.example.org/",
    "http://dev.example.com/",
    "https://dev.example.com:8443/",
    "https://evil.dev.example.com/",
    "https://localhost/",
    "http://127.0.0.1:458/api/runs",
    "https://dev.example.com.attacker.net/",
  ]) {
    const decision = g.decide({ method: "GET", url });
    assert.equal(decision.allow, false, url);
    if (!decision.allow) assert.equal(decision.reason, "origin", url);
  }
  assert.equal(g.decide({ method: "GET", url: "https://cdn.example.com:8443/a.js" }).allow, true);
});

test("a wildcard origin covers its subdomains and only those", () => {
  const g = guard({ origins: ["https://*.example.com"] });
  assert.equal(g.decide({ method: "GET", url: "https://a.example.com/" }).allow, true);
  assert.equal(g.decide({ method: "GET", url: "https://example.com/" }).allow, false);
});

test("a web socket is judged by the origin of the http(s) address it maps to", () => {
  const g = guard();
  assert.equal(g.decide({ method: "GET", url: "wss://dev.example.com/socket" }).allow, true);
  const plain = g.decide({ method: "GET", url: "ws://dev.example.com/socket" });
  assert.equal(plain.allow, false, "ws maps to http, which is not declared");
  if (!plain.allow) assert.equal(plain.reason, "origin", "it is an origin that is refused, not a kind of address");
  assert.equal(g.decide({ method: "GET", url: "wss://other.example.org/socket" }).allow, false);
});

test("a scheme that reaches no network is allowed and one that reads the machine is not", () => {
  const g = guard();
  for (const url of ["about:blank", "data:image/png;base64,AAAA", "blob:https://dev.example.com/1234"]) assert.equal(g.decide({ method: "GET", url }).allow, true, url);
  for (const url of ["file:///etc/passwd", "ftp://dev.example.com/", "chrome://settings", "javascript:alert(1)", "not a url"]) {
    const decision = g.decide({ method: "GET", url });
    assert.equal(decision.allow, false, url);
    if (!decision.allow) assert.equal(decision.reason, "scheme", url);
  }
});

test("a block never carries the query, the fragment or credentials of the address", () => {
  const decision = guard().decide({ method: "POST", url: "https://user:pw@dev.example.com/api/orders?token=secret#frag" });
  assert.equal(decision.allow, false);
  if (!decision.allow) {
    assert.doesNotMatch(decision.detail, /secret|frag|pw/);
    assert.match(decision.detail, /\/api\/orders/);
  }
});

test("a route pattern must be an absolute path and a mutating entry an optional method then such a path", () => {
  assert.equal(routePatternError("/admin/**"), undefined);
  assert.equal(routePatternError("/a/*/b"), undefined);
  assert.notEqual(routePatternError("admin"), undefined);
  assert.notEqual(routePatternError("https://dev.example.com/admin"), undefined);
  assert.notEqual(routePatternError("/a b"), undefined);
  assert.notEqual(routePatternError("/a?x=1"), undefined);
  assert.notEqual(routePatternError("/***"), undefined);
  assert.equal(mutatingEntryError("POST /api/x"), undefined);
  assert.equal(mutatingEntryError("/api/x"), undefined);
  assert.notEqual(mutatingEntryError("FETCH /api/x"), undefined);
  assert.notEqual(mutatingEntryError("GET /api/x"), undefined, "a read needs no allowance");
  assert.notEqual(mutatingEntryError("POST api/x"), undefined);
});

test("a ** in the middle of a pattern crosses segments, and the characters of a pattern that a regular expression would read are read as themselves", () => {
  const g = guard({ denyRoutes: ["/files/**/secret", "/export.csv", "/a+b", "/q(1)"] });
  for (const path of ["/files/secret", "/files/a/secret", "/files/a/b/secret", "/export.csv", "/a+b", "/q(1)"]) {
    const decision = g.decide({ method: "GET", url: `https://dev.example.com${path}` });
    assert.equal(decision.allow === false && decision.reason, "deny-route", path);
  }
  for (const path of ["/files/a/other", "/files/secrets", "/exportXcsv", "/aab", "/q1"]) assert.equal(g.decide({ method: "GET", url: `https://dev.example.com${path}` }).allow, true, path);
});

test("a pattern is held to its length: one character is the least, and 200 the most", () => {
  assert.notEqual(routePatternError(""), undefined);
  assert.equal(routePatternError(`/${"a".repeat(199)}`), undefined);
  assert.notEqual(routePatternError(`/${"a".repeat(200)}`), undefined);
  assert.equal(routePatternError("/"), undefined);
});

test("an allowance names a mutating method from the list and a path, nothing else", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(mutatingEntryError(`${method} /x`), undefined, method);
  assert.notEqual(mutatingEntryError("POST"), undefined);
  assert.notEqual(mutatingEntryError("POST /a b"), undefined, "the path is held to the pattern rules");
  assert.notEqual(mutatingEntryError(""), undefined);
});

test("a ** that is not between two slashes covers any run of characters, segments included", () => {
  const g = guard({ denyRoutes: ["/exp**"] });
  for (const path of ["/exp", "/export", "/export/a/b", "/expand/x"]) assert.equal(g.decide({ method: "GET", url: `https://dev.example.com${path}` }).allow, false, path);
  assert.equal(g.decide({ method: "GET", url: "https://dev.example.com/ex" }).allow, true);
});

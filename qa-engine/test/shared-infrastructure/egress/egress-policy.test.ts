/* What a sandboxed child may reach is a list of declared origins, compiled once into rules the proxy and the DNS filter ask. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileEgressPolicy, EgressPolicyError, mergeEgressPolicies, originOf } from "../../../src/shared-infrastructure/egress/egress-policy.ts";

test("an origin allows its host on its port, and the scheme's default port when none is written", () => {
  const policy = compileEgressPolicy(["https://dev.example.com", "http://plain.example.com", "https://alt.example.com:8443"]);
  assert.equal(policy.allows("dev.example.com", 443), true);
  assert.equal(policy.allows("dev.example.com", 80), false);
  assert.equal(policy.allows("plain.example.com", 80), true);
  assert.equal(policy.allows("plain.example.com", 443), false);
  assert.equal(policy.allows("alt.example.com", 8443), true);
  assert.equal(policy.allows("alt.example.com", 443), false);
});

test("hosts compare case-insensitively and ignore a trailing dot", () => {
  const policy = compileEgressPolicy(["https://Dev.Example.com"]);
  assert.equal(policy.allows("DEV.example.COM", 443), true);
  assert.equal(policy.allows("dev.example.com.", 443), true);
});

test("a wildcard origin allows subdomains at any depth and never the bare domain", () => {
  const policy = compileEgressPolicy(["https://*.cdn.example.com"]);
  assert.equal(policy.allows("a.cdn.example.com", 443), true);
  assert.equal(policy.allows("a.b.cdn.example.com", 443), true);
  assert.equal(policy.allows("cdn.example.com", 443), false);
  assert.equal(policy.allows("evilcdn.example.com", 443), false);
  assert.equal(policy.allows("a.cdn.example.com.evil.net", 443), false);
});

test("a name is allowed on any port of the policy when the question is only about the name (DNS)", () => {
  const policy = compileEgressPolicy(["https://dev.example.com", "http://*.static.example.net:8080"]);
  assert.equal(policy.allowsName("dev.example.com"), true);
  assert.equal(policy.allowsName("x.static.example.net"), true);
  assert.equal(policy.allowsName("other.example.com"), false);
});

test("the ports a policy needs a listener for are those it declares", () => {
  const policy = compileEgressPolicy(["https://a.example.com", "http://b.example.com", "https://c.example.com:8443"]);
  assert.deepEqual([...policy.ports].sort((x, y) => x - y), [80, 443, 8443]);
});

test("an empty policy allows nothing", () => {
  const policy = compileEgressPolicy([]);
  assert.equal(policy.allows("dev.example.com", 443), false);
  assert.equal(policy.allowsName("dev.example.com"), false);
  assert.equal(policy.ports.size, 0);
});

test("an origin that is not an origin is refused with the offending text", () => {
  for (const bad of ["dev.example.com", "ftp://x.example.com", "https://x.example.com/path", "https://user:pw@x.example.com", "https://*", "https://*.com", "https://a.*.example.com", "https://x.example.com:0", "https://x.example.com:99999", "", "https://"]) {
    assert.throws(() => compileEgressPolicy([bad]), (err: unknown) => err instanceof EgressPolicyError && err.message.includes(JSON.stringify(bad)), bad);
  }
});

test("a bare slash after the host is the same origin", () => {
  assert.equal(compileEgressPolicy(["https://dev.example.com/"]).allows("dev.example.com", 443), true);
});

test("an IP literal is an origin of the plain-http kind only, since a TLS handshake carries no IP in its server name", () => {
  const policy = compileEgressPolicy(["http://10.0.0.5:8080"]);
  assert.equal(policy.allows("10.0.0.5", 8080), true);
  assert.throws(() => compileEgressPolicy(["https://10.0.0.5"]), EgressPolicyError);
});

test("merging policies allows what any of them allows", () => {
  const merged = mergeEgressPolicies([compileEgressPolicy(["https://a.example.com"]), compileEgressPolicy(["https://b.example.com"])]);
  assert.equal(merged.allows("a.example.com", 443), true);
  assert.equal(merged.allows("b.example.com", 443), true);
  assert.equal(merged.allows("c.example.com", 443), false);
  assert.equal(mergeEgressPolicies([]).allows("a.example.com", 443), false);
});

test("originOf reduces a URL to its origin and refuses what is not one", () => {
  assert.equal(originOf("https://dev.example.com/app/home?x=1"), "https://dev.example.com");
  assert.equal(originOf("http://dev.example.com:8080/x"), "http://dev.example.com:8080");
  assert.equal(originOf("not a url"), undefined);
});

test("a wildcard over a public suffix is refused: every tenant of it would be reachable", () => {
  for (const origin of ["https://*.co.uk", "https://*.github.io", "https://*.herokuapp.com", "https://*.vercel.app", "https://*.s3.amazonaws.com:443", "https://*.com.au"]) {
    assert.throws(() => compileEgressPolicy([origin]), (err: unknown) => err instanceof EgressPolicyError && /public suffix/.test(err.message), origin);
  }
});

test("a wildcard one label below a public suffix, and a plain host on one, are still fine", () => {
  assert.doesNotThrow(() => compileEgressPolicy(["https://*.example.co.uk", "https://*.acme.github.io", "https://acme.github.io", "https://*.example.com"]));
});

test("an address is declared only by a rule that is that IP literal, on that port", () => {
  const policy = compileEgressPolicy(["http://10.1.2.3:8080", "https://dev.example.com", "https://*.example.org"]);
  assert.equal(policy.declaresAddress("10.1.2.3", 8080), true);
  assert.equal(policy.declaresAddress("10.1.2.3", 80), false);
  assert.equal(policy.declaresAddress("10.1.2.4", 8080), false);
  assert.equal(policy.declaresAddress("dev.example.com", 443), false, "a name is not an address");
});

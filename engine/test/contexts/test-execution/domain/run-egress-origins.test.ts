/* Which origins a run's sandboxed children may reach is decided from the app's declared origins and the registry groups. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedHostMatcher, resolveRunOrigins } from "@contexts/test-execution/domain/run-egress-origins.ts";

const REGISTRIES = { npm: ["https://registry.npmjs.org"], maven: ["https://repo.maven.apache.org"], pip: ["https://pypi.org"] };

test("an e2e run's specs reach the app's own origin and what the app declares, nothing else", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com/app", allowedOrigins: ["https://idp.example.com", "https://*.cdn.example.com"] } }, REGISTRIES);
  assert.deepEqual(origins.dev, ["https://dev.example.com", "https://idp.example.com", "https://*.cdn.example.com"]);
});

test("an e2e run's installs reach the npm registry and the app's own extra registries", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com" }, egress: { installOrigins: ["https://npm.internal.example.com"] } }, REGISTRIES);
  assert.deepEqual(origins.install, ["https://registry.npmjs.org", "https://npm.internal.example.com"]);
});

test("the app's own origin is not repeated when it also declares it", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com", allowedOrigins: ["https://dev.example.com"] } }, REGISTRIES);
  assert.deepEqual(origins.dev, ["https://dev.example.com"]);
});

test("a port in the app's URL stays in its origin, an unparsable or non-http base URL contributes none, and declared origins keep their order and are never repeated", () => {
  assert.deepEqual(resolveRunOrigins({ dev: { baseUrl: "http://localhost:4200/x", allowedOrigins: ["https://a.example.com:8443", "https://b.example.com", "https://a.example.com:8443"] } }, REGISTRIES).dev, ["http://localhost:4200", "https://a.example.com:8443", "https://b.example.com"]);
  assert.deepEqual(resolveRunOrigins({ dev: { baseUrl: "not a url", allowedOrigins: ["https://idp.example.com"] } }, REGISTRIES).dev, ["https://idp.example.com"]);
  assert.deepEqual(resolveRunOrigins({ dev: { baseUrl: "ftp://files.example.com" } }, REGISTRIES).dev, []);
});

test("an install reaches the npm group only, the app's extra origins after it, and nothing twice; no npm group leaves only what the app declares", () => {
  const both = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com" }, egress: { installOrigins: ["https://registry.npmjs.org", "https://mirror.example.com"] } }, REGISTRIES);
  assert.deepEqual(both.install, ["https://registry.npmjs.org", "https://mirror.example.com"]);
  assert.deepEqual(resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com" } }, {}).install, []);
  assert.deepEqual(resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com" }, egress: { installOrigins: ["https://mirror.example.com"] } }, { maven: ["https://repo.maven.apache.org"] }).install, ["https://mirror.example.com"]);
});

test("the hosts an app leaves blocked on purpose are the names its blocked origins cover, and an app that declares none leaves none", () => {
  const blocked = blockedHostMatcher({ dev: { baseUrl: "https://dev.example.com", blockedOrigins: ["https://*.ingest.example.net", "https://stats.example.com"] } });
  assert.equal(blocked("o123.ingest.example.net"), true);
  assert.equal(blocked("stats.example.com"), true);
  assert.equal(blocked("ingest.example.net"), false, "a wildcard covers subdomains only");
  assert.equal(blocked("fonts.example.com"), false);
  assert.equal(blockedHostMatcher({ dev: { baseUrl: "https://dev.example.com" } })("stats.example.com"), false);
});

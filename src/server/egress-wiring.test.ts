/* Which origins a run's children may reach is decided from the app's config and the registries file; the controller itself is tested where it lives. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistryGroups, resolveEgressMode, resolveRunOrigins } from "./egress-wiring";

const REGISTRIES = { npm: ["https://registry.npmjs.org"], maven: ["https://repo.maven.apache.org"], pip: ["https://pypi.org"] };

test("QA_EGRESS_MODE: enforce is the default, warn is the operator's choice, anything else is a configuration error", () => {
  assert.equal(resolveEgressMode({}), "enforce");
  assert.equal(resolveEgressMode({ QA_EGRESS_MODE: "" }), "enforce");
  assert.equal(resolveEgressMode({ QA_EGRESS_MODE: "warn" }), "warn");
  assert.throws(() => resolveEgressMode({ QA_EGRESS_MODE: "off" }), /QA_EGRESS_MODE/);
});

test("an e2e run's specs reach the app's own origin and what the app declares, nothing else", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com/app", allowedOrigins: ["https://idp.example.com", "https://*.cdn.example.com"] } }, "e2e", REGISTRIES);
  assert.deepEqual(origins.dev, ["https://dev.example.com", "https://idp.example.com", "https://*.cdn.example.com"]);
});

test("an e2e run's installs reach the npm registry and the app's own extra registries", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com" }, egress: { installOrigins: ["https://npm.internal.example.com"] } }, "e2e", REGISTRIES);
  assert.deepEqual(origins.install, ["https://registry.npmjs.org", "https://npm.internal.example.com"]);
});

test("a code run has no DEV site and its toolchain reaches every registry group, since the ecosystem is found in the repository", () => {
  const origins = resolveRunOrigins({}, "code", REGISTRIES);
  assert.deepEqual(origins.dev, []);
  assert.deepEqual(origins.install, ["https://registry.npmjs.org", "https://repo.maven.apache.org", "https://pypi.org"]);
});

test("the app's own origin is not repeated when it also declares it", () => {
  const origins = resolveRunOrigins({ dev: { baseUrl: "https://dev.example.com", allowedOrigins: ["https://dev.example.com"] } }, "e2e", REGISTRIES);
  assert.deepEqual(origins.dev, ["https://dev.example.com"]);
});

test("registries are read from the groups file, and a malformed group is refused with its name", () => {
  const groups = loadRegistryGroups("/root", () => "npm:\n  - https://registry.npmjs.org\n");
  assert.deepEqual(groups, { npm: ["https://registry.npmjs.org"] });
  assert.throws(() => loadRegistryGroups("/root", () => "npm: https://registry.npmjs.org\n"), /"npm"/);
  assert.throws(() => loadRegistryGroups("/root", () => "npm:\n  - https://registry.npmjs.org/path\n"), /invalid egress origin/);
});

test("a missing registries file declares no registry, which is closed", () => {
  const groups = loadRegistryGroups("/root", () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
  assert.deepEqual(groups, {});
});

test("the registries file the repo ships parses, and every origin in it compiles", async () => {
  const { qayabaRoot } = await import("../paths");
  const groups = loadRegistryGroups(qayabaRoot());
  assert.ok((groups.npm?.length ?? 0) > 0, "the e2e target needs the npm registry");
});

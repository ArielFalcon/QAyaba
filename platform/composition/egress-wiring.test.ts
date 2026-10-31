/* The registries file is read here (the egress mode is a setting, platform/settings/sandbox-status.ts); which origins a run may reach is decided in the engine (test-execution), and the controller is tested where it lives. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistryGroups } from "./egress-wiring";

const REGISTRIES = { npm: ["https://registry.npmjs.org"], maven: ["https://repo.maven.apache.org"], pip: ["https://pypi.org"] };

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
  const { qayabaRoot } = await import("../settings/paths");
  const groups = loadRegistryGroups(qayabaRoot());
  assert.ok((groups.npm?.length ?? 0) > 0, "the e2e target needs the npm registry");
});


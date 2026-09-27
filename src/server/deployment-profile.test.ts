import { test } from "node:test";
import assert from "node:assert/strict";
import { exportRoot, profileCapabilities, resolveDeploymentProfile } from "./deployment-profile";

test("resolveDeploymentProfile defaults to full when unset or blank", () => {
  assert.equal(resolveDeploymentProfile({}), "full");
  assert.equal(resolveDeploymentProfile({ QAYABA_PROFILE: "  " }), "full");
  assert.equal(resolveDeploymentProfile({ QAYABA_PROFILE: "full" }), "full");
});

test("resolveDeploymentProfile accepts slim case-insensitively", () => {
  assert.equal(resolveDeploymentProfile({ QAYABA_PROFILE: "slim" }), "slim");
  assert.equal(resolveDeploymentProfile({ QAYABA_PROFILE: " SLIM " }), "slim");
});

test("resolveDeploymentProfile throws on an unknown value instead of falling back to full", () => {
  assert.throws(() => resolveDeploymentProfile({ QAYABA_PROFILE: "slimm" }), /QAYABA_PROFILE must be/);
});

test("slim disables every remote/peripheral effector; full enables them", () => {
  assert.deepEqual(profileCapabilities("slim"), { remotePublication: false, selfMaintenance: false, githubLogin: false });
  assert.deepEqual(profileCapabilities("full"), { remotePublication: true, selfMaintenance: true, githubLogin: true });
});

test("exportRoot honors QAYABA_EXPORT_DIR, else <QAYABA_ROOT>/data/exports", () => {
  assert.equal(exportRoot({ QAYABA_EXPORT_DIR: "/x/exports" }), "/x/exports");
  assert.equal(exportRoot({ QAYABA_ROOT: "/app" }), "/app/data/exports");
});

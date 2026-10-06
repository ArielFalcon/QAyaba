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
  const { remotePublication, selfMaintenance, githubLogin } = profileCapabilities("slim");
  assert.deepEqual([remotePublication, selfMaintenance, githubLogin], [false, false, false]);
  const full = profileCapabilities("full");
  assert.deepEqual([full.remotePublication, full.selfMaintenance, full.githubLogin], [true, true, true]);
});

test("slim keeps runtime secrets out of the filesystem; full persists them to .env", () => {
  assert.equal(profileCapabilities("slim").persistRuntimeSecrets, false);
  assert.equal(profileCapabilities("full").persistRuntimeSecrets, true);
});

test("exportRoot honors QAYABA_EXPORT_DIR, else <QAYABA_ROOT>/data/exports", () => {
  assert.equal(exportRoot({ QAYABA_EXPORT_DIR: "/x/exports" }), "/x/exports");
  assert.equal(exportRoot({ QAYABA_ROOT: "/app" }), "/app/data/exports");
});

test("slim offers only the opencode provider (its image ships no codex binary); full offers both", () => {
  assert.deepEqual(profileCapabilities("slim").agentProviders, ["opencode"]);
  assert.deepEqual([...profileCapabilities("full").agentProviders].sort(), ["codex", "opencode"]);
});

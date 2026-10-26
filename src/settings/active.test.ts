import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { agentTimeout, reviewerTimeoutMs, stallMs, agentPromptCapMs } from "../integrations/opencode-client";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { DEFAULT_REVIEWER_TIMEOUT_MS, DEFAULT_STALL_MS } from "./defaults";
import { activeEnvironment, resetActiveSettingsForTests } from "./active";
import { activeSettings, createSettingsStore, installSettingsStore } from "./store";

afterEach(() => resetActiveSettingsForTests());

test("an installed store is the process's active settings and follows its reloads", () => {
  const env: Record<string, string | undefined> = { PORT: "8100" };
  const store = createSettingsStore(env);
  installSettingsStore(store);
  assert.equal(activeSettings().server.port, 8100);
  env.PORT = "8101";
  store.reload();
  assert.equal(activeSettings().server.port, 8101);
});

test("with no store installed the active environment is the process environment", () => {
  assert.equal(activeEnvironment(), process.env);
});

test("the agent timeouts come from the active settings", () => {
  installSettingsStore(createSettingsStore({ OPENCODE_TIMEOUT_MS: "120000", OPENCODE_REVIEWER_TIMEOUT_MS: "45000", OPENCODE_STALL_MS: "9000" }));
  assert.equal(agentTimeout("diff"), 120_000);
  assert.equal(agentTimeout("exhaustive"), 120_000);
  assert.equal(reviewerTimeoutMs(), 45_000);
  assert.equal(stallMs(), 9_000);
  assert.ok(agentPromptCapMs() >= 120_000, "the transport ceiling covers the generator's budget");
});

test("the agent timeouts keep their defaults when nothing sets them", () => {
  installSettingsStore(createSettingsStore({}));
  assert.equal(reviewerTimeoutMs(), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(stallMs(), DEFAULT_STALL_MS);
  assert.ok(agentTimeout("diff") < agentTimeout("exhaustive"), "each run mode keeps its own budget");
});

test("redaction by value follows the environment of the installed settings", () => {
  const secret = "ghp_installedSettingsSecret0123456789";
  installSettingsStore(createSettingsStore({ GITHUB_TOKEN: secret }));
  const text = new RedactionPortAdapter().redact(`push failed for ${secret}`);
  assert.ok(!text.includes(secret));
});

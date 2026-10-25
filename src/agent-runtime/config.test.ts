import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultAgentRuntimeConfig,
  configFromEnv,
  validateAgentRuntimeConfig,
  publicAgentConfig,
  reviewerIndependence,
} from "./config";

test("defaultAgentRuntimeConfig prefers single/opencode when OPENCODE_API_KEY exists", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" });
  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "opencode");
  assert.equal(cfg.assignments.primary.provider, "opencode");
});

test("defaultAgentRuntimeConfig falls back to single/codex when only CODEX_API_KEY exists", () => {
  const cfg = defaultAgentRuntimeConfig({ CODEX_API_KEY: "codex-key" });
  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "codex");
  assert.equal(cfg.assignments.primary.provider, "codex");
});

test("single mode only requires the selected provider key", () => {
  const cfg = defaultAgentRuntimeConfig({ CODEX_API_KEY: "codex-key" });
  const result = validateAgentRuntimeConfig(cfg, { codex: true, opencode: false });
  assert.equal(result.ok, true);
});

test("dual mode requires both provider keys and at least two visible providers", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "codex" as const, model: "gpt-5.4" },
      chat: { provider: "codex" as const, model: "gpt-5.4-mini" },
    },
  };
  assert.equal(validateAgentRuntimeConfig(cfg, { opencode: true, codex: true }).ok, true);
  assert.match(validateAgentRuntimeConfig(cfg, { opencode: true, codex: false }).errors.join("\n"), /CODEX_API_KEY/);
});

test("dual mode: reviewer defaults to the primary's COMPLEMENT, not a hardcoded codex", () => {
  const keys = { OPENCODE_API_KEY: "ok", CODEX_API_KEY: "ck" };
  /* primary=codex with no explicit reviewer provider → reviewer must be opencode (independent
     judgment), NOT codex again (the old hardcoded fallback collapsed both roles onto codex).
   */
  const codexPrimary = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "codex" });
  assert.equal(codexPrimary.assignments.primary.provider, "codex");
  assert.equal(codexPrimary.assignments.reviewer.provider, "opencode");
  const opencodePrimary = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "opencode" });
  assert.equal(opencodePrimary.assignments.reviewer.provider, "codex");
  const explicit = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "codex", AGENT_REVIEWER_PROVIDER: "codex" });
  assert.equal(explicit.assignments.reviewer.provider, "codex");
});

test("dual mode with one provider asks for single-mode downgrade confirmation", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode" as const, model: "opencode-go/minimax-m3" },
      chat: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, false);
  assert.equal(result.requiresSingleDowngradeConfirmation, true);
  assert.equal(result.downgradeProvider, "opencode");
});

test("publicAgentConfig never exposes API key values", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-secret", CODEX_API_KEY: "codex-secret" });
  const pub = publicAgentConfig(cfg, { opencode: true, codex: true });
  const body = JSON.stringify(pub);
  assert.doesNotMatch(body, /opencode-go-secret|codex-secret/);
  assert.deepEqual(pub.keys, { opencode: true, codex: true });
});

/* The reviewer sharing the generator's model is a recorded property, not a precondition: the
   config validates, carries one warning naming both assignments, and the run record says so.
 */

test("single mode: the default config validates ok", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" });
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.equal(result.ok, true, `default single-mode config must validate ok; errors: ${result.errors.join("; ")}`);
});

test("dual mode: the default config validates ok", () => {
  const keys = { OPENCODE_API_KEY: "ok", CODEX_API_KEY: "ck" };
  const cfg = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual" });
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, true, `default dual-mode config must validate ok; errors: ${result.errors.join("; ")}`);
});

const SHARED = "fixture-provider/shared-model";

test("a config whose reviewer shares the primary's model validates ok and carries one warning naming both assignments", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    assignments: {
      primary: { provider: "opencode" as const, model: SHARED },
      reviewer: { provider: "opencode" as const, model: SHARED },
      chat: { provider: "opencode" as const, model: "fixture-provider/chat-model" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /reviewer/);
  assert.match(result.warnings[0]!, /primary/);
  assert.match(result.warnings[0]!, new RegExp(`opencode/${SHARED}`));
  assert.equal(reviewerIndependence(cfg), "shared-model");
});

test("dual mode: a reviewer on the primary's model validates ok and carries the same warning", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: SHARED },
      reviewer: { provider: "opencode" as const, model: SHARED },
      chat: { provider: "codex" as const, model: "fixture-provider/chat-model" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test("a config with distinct models carries no warning", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    assignments: {
      primary: { provider: "opencode" as const, model: "fixture-provider/primary-model" },
      reviewer: { provider: "opencode" as const, model: "fixture-provider/reviewer-model" },
      chat: { provider: "opencode" as const, model: "fixture-provider/chat-model" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.deepEqual(result.warnings, []);
  assert.equal(reviewerIndependence(cfg), "distinct-model");
});

test("the same model name under two providers is distinct", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: SHARED },
      reviewer: { provider: "codex" as const, model: SHARED },
      chat: { provider: "codex" as const, model: "fixture-provider/chat-model" },
    },
  };
  assert.equal(reviewerIndependence(cfg), "distinct-model");
});

test("a missing key or an empty model still produces an error", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    assignments: {
      primary: { provider: "opencode" as const, model: "" },
      reviewer: { provider: "opencode" as const, model: SHARED },
      chat: { provider: "opencode" as const, model: SHARED },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: false, codex: false });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /OPENCODE_API_KEY is required/);
  assert.match(result.errors.join("\n"), /primary model is required/);
});

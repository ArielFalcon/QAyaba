import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configFromEnv,
  providerConfig,
  validateAgentRuntimeConfig,
  publicAgentConfig,
  reviewerIndependence,
  retiredSelectorWarnings,
} from "./config";

test("configFromEnv assigns every role to the one runtime", () => {
  const cfg = configFromEnv({ OPENCODE_API_KEY: "opencode-go-key" });
  assert.equal(cfg.assignments.primary.provider, "opencode");
  assert.equal(cfg.assignments.reviewer.provider, "opencode");
  assert.equal(cfg.assignments.chat.provider, "opencode");
});

test("configFromEnv ignores runtime mode and provider selection variables and yields the single-runtime config", () => {
  const plain = configFromEnv({ OPENCODE_API_KEY: "ok" });
  const withSelectors = configFromEnv({
    OPENCODE_API_KEY: "ok",
    AGENT_RUNTIME_MODE: "dual",
    AGENT_SINGLE_PROVIDER: "other",
    AGENT_PRIMARY_PROVIDER: "other",
    AGENT_REVIEWER_PROVIDER: "other",
    AGENT_CHAT_PROVIDER: "other",
  });
  assert.deepEqual(withSelectors, plain);
  assert.deepEqual(Object.keys(withSelectors), ["assignments", "defaulted"]);
});

test("a retired runtime selector in the environment is reported, one warning per variable", () => {
  assert.deepEqual(retiredSelectorWarnings({ OPENCODE_API_KEY: "ok" }), []);
  const warnings = retiredSelectorWarnings({ AGENT_RUNTIME_MODE: "dual", AGENT_REVIEWER_PROVIDER: "other", AGENT_REVIEWER_MODEL: "m" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /AGENT_RUNTIME_MODE/);
  assert.match(warnings[1] ?? "", /AGENT_REVIEWER_PROVIDER/);
});

test("a role's model comes from AGENT_<ROLE>_MODEL when set", () => {
  const cfg = configFromEnv({ AGENT_REVIEWER_MODEL: "fixture-provider/reviewer-model" });
  assert.equal(cfg.assignments.reviewer.model, "fixture-provider/reviewer-model");
  assert.notEqual(cfg.assignments.primary.model, "fixture-provider/reviewer-model");
});

test("the runtime config only requires the runtime's key", () => {
  const cfg = configFromEnv({});
  assert.equal(validateAgentRuntimeConfig(cfg, { opencode: true }).ok, true);
  assert.match(validateAgentRuntimeConfig(cfg, { opencode: false }).errors.join("\n"), /OPENCODE_API_KEY is required/);
});

test("publicAgentConfig never exposes API key values and carries no mode or provider selector", () => {
  const cfg = configFromEnv({ OPENCODE_API_KEY: "opencode-go-secret" });
  const pub = publicAgentConfig(cfg, { opencode: true });
  const body = JSON.stringify(pub);
  assert.doesNotMatch(body, /opencode-go-secret/);
  assert.deepEqual(pub.keys, { opencode: true });
  assert.equal("mode" in pub, false);
  assert.equal("singleProvider" in pub, false);
});

/* The reviewer sharing the generator's model is a recorded property, not a precondition: the
   config validates, carries one warning naming both assignments, and the run record says so.
 */

test("the default config validates ok", () => {
  const result = validateAgentRuntimeConfig(configFromEnv({ OPENCODE_API_KEY: "opencode-go-key" }), { opencode: true });
  assert.equal(result.ok, true, `default config must validate ok; errors: ${result.errors.join("; ")}`);
});

const SHARED = "fixture-provider/shared-model";

test("a config whose reviewer shares the primary's model validates ok and carries one warning naming both assignments", () => {
  const cfg = {
    assignments: {
      primary: { provider: "opencode" as const, model: SHARED },
      reviewer: { provider: "opencode" as const, model: SHARED },
      chat: { provider: "opencode" as const, model: "fixture-provider/chat-model" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /reviewer/);
  assert.match(result.warnings[0]!, /primary/);
  assert.match(result.warnings[0]!, new RegExp(`opencode/${SHARED}`));
  assert.equal(reviewerIndependence(cfg), "shared-model");
});

test("a config with distinct models carries no warning", () => {
  const cfg = {
    assignments: {
      primary: { provider: "opencode" as const, model: "fixture-provider/primary-model" },
      reviewer: { provider: "opencode" as const, model: "fixture-provider/reviewer-model" },
      chat: { provider: "opencode" as const, model: "fixture-provider/chat-model" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true });
  assert.deepEqual(result.warnings, []);
  assert.equal(reviewerIndependence(cfg), "distinct-model");
});

test("a missing key or an empty model still produces an error", () => {
  const cfg = {
    assignments: {
      primary: { provider: "opencode" as const, model: "" },
      reviewer: { provider: "opencode" as const, model: SHARED },
      chat: { provider: "opencode" as const, model: SHARED },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: false });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /OPENCODE_API_KEY is required/);
  assert.match(result.errors.join("\n"), /primary model is required/);
});

test("providerConfig marks the tiers no AGENT_<TIER>_MODEL names as defaulted", () => {
  const cfg = providerConfig("opencode", { AGENT_PRIMARY_MODEL: "opencode-go/chosen" });
  assert.deepEqual(cfg.defaulted, ["reviewer", "chat"]);
  assert.equal(cfg.assignments.primary.model, "opencode-go/chosen");
});

test("the reviewer's independence compares the models the author and the reviewer actually run on", () => {
  const declared = (agent: string): string | undefined => (agent === "qa-author" ? "opencode-go/judge" : undefined);
  const cfg = { ...providerConfig("opencode", { AGENT_REVIEWER_MODEL: "opencode-go/judge" }), defaulted: ["primary"] as const };
  assert.equal(reviewerIndependence(cfg, declared), "shared-model");
  assert.equal(reviewerIndependence(cfg, () => undefined), "distinct-model");
});

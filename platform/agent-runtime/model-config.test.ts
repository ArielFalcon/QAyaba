import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewerIndependence, providerConfig, validateAgentRuntimeConfig } from "./config";
import { AGENT_PROVIDERS, type DeclaredModels } from "./types";

function opencodeAgentModels(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as {
    agent?: Record<string, { model?: string }>;
  };
  const out: Record<string, string> = {};
  for (const [name, a] of Object.entries(raw.agent ?? {})) if (a.model) out[name] = a.model;
  return out;
}

const roster = (models: Record<string, string>): DeclaredModels => (agent) => models[agent];

test("a tier no operator chose runs the model its namesake agent declares in agents/opencode.json", () => {
  const cfg = providerConfig("opencode", {}, roster({ "qa-author": "p/author", "qa-reviewer": "p/reviewer", "qa-assistant": "p/assistant" }));
  assert.equal(cfg.assignments.primary.model, "p/author");
  assert.equal(cfg.assignments.reviewer.model, "p/reviewer");
  assert.equal(cfg.assignments.chat.model, "p/assistant");
  assert.deepEqual([...(cfg.defaulted ?? [])].sort(), ["chat", "primary", "reviewer"]);
});

test("the operator's AGENT_<TIER>_MODEL wins over the declared model and ends the tier's defaulting", () => {
  const cfg = providerConfig("opencode", { AGENT_REVIEWER_MODEL: "p/chosen" }, roster({ "qa-author": "p/author", "qa-reviewer": "p/reviewer", "qa-assistant": "p/assistant" }));
  assert.equal(cfg.assignments.reviewer.model, "p/chosen");
  assert.equal(cfg.defaulted?.includes("reviewer"), false);
});

test("a roster that declares no model for a tier gives the config no model there, and validation refuses it", () => {
  const cfg = providerConfig("opencode", {}, roster({ "qa-author": "p/author", "qa-assistant": "p/assistant" }));
  assert.equal(cfg.assignments.reviewer.model, "");
  const result = validateAgentRuntimeConfig(cfg, { opencode: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("reviewer model is required")));
});

test("agents/opencode.json declares a model for the agent of every tier", () => {
  const models = opencodeAgentModels();
  for (const agent of ["qa-author", "qa-reviewer", "qa-assistant"]) assert.ok(models[agent], `${agent} must declare a model`);
});

test("the default config validates ok, and carries the shared-model warning exactly when its reviewer runs the primary's model", () => {
  const cfg = providerConfig("opencode", {});
  const result = validateAgentRuntimeConfig(cfg, { opencode: true });
  assert.equal(result.ok, true, `errors: ${result.errors.join("; ")}`);
  assert.equal(result.warnings.length, reviewerIndependence(cfg) === "shared-model" ? 1 : 0);
});

/* Every provider's default config is usable whatever its reviewer's model: independence never blocks it. */
test("the default config of EVERY provider validates ok", () => {
  for (const provider of AGENT_PROVIDERS) {
    const result = validateAgentRuntimeConfig(providerConfig(provider, {}), { opencode: true });
    assert.equal(result.ok, true, `[${provider}] errors: ${result.errors.join("; ")}`);
  }
});

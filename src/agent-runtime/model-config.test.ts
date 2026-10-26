import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewerIndependence, providerConfig, validateAgentRuntimeConfig } from "./config";
import { AGENT_PROVIDERS } from "./types";
import { CATALOGED_MODELS, normalizeModelName } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";

/* Guard against the model "split-brain": config.ts's DEFAULT_MODELS (used by the runtime
   reconfig layer) and opencode/opencode.json (the file that actually runs the agents) must
   agree. Whether the reviewer shares the generator's model is a recorded property of the run, never
   a precondition of the config. When the default
   reviewer drifted out of the opencode.json catalog, validateAssignedModels threw on every
   applyConfig and the operator-facing docs advertised a model the system was not running.
 */

function opencodeAgentModels(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as {
    agent?: Record<string, { model?: string }>;
  };
  const out: Record<string, string> = {};
  for (const [name, a] of Object.entries(raw.agent ?? {})) if (a.model) out[name] = a.model;
  return out;
}

test("every default opencode role model exists in opencode.json's agent catalog", () => {
  const catalog = new Set(Object.values(opencodeAgentModels()));
  const cfg = providerConfig("opencode", {});
  for (const role of ["primary", "reviewer", "chat"] as const) {
    const model = cfg.assignments[role].model;
    assert.ok(
      catalog.has(model),
      `default opencode ${role} model '${model}' is not in opencode.json (catalog: ${[...catalog].join(", ")}). ` +
        `An assigned model outside the catalog makes validateAssignedModels throw on applyConfig.`,
    );
  }
});

test("the default config validates ok, and carries the shared-model warning exactly when its reviewer runs the primary's model", () => {
  const cfg = providerConfig("opencode", {});
  const result = validateAgentRuntimeConfig(cfg, { opencode: true });
  assert.equal(result.ok, true, `errors: ${result.errors.join("; ")}`);
  assert.equal(result.warnings.length, reviewerIndependence(cfg) === "shared-model" ? 1 : 0);
});

test("opencode.json declares a model for qa-author and for qa-reviewer", () => {
  const models = opencodeAgentModels();
  assert.ok(models["qa-author"], "qa-author must declare a model");
  assert.ok(models["qa-reviewer"], "qa-reviewer must declare a model");
});

test("config.ts default reviewer matches opencode.json's qa-reviewer (single source of truth)", () => {
  const models = opencodeAgentModels();
  const cfg = providerConfig("opencode", {});
  assert.equal(
    cfg.assignments.reviewer.model,
    models["qa-reviewer"],
    "config.ts DEFAULT_MODELS.opencode.reviewer must equal the model opencode.json actually runs for qa-reviewer.",
  );
});

/* config.ts's DEFAULT_MODELS.opencode.primary must match opencode.json's qa-author model —
   not drift to qa-maintainer's model. The primary role that GENERATES tests on the e2e path must
   not be silently misdocumented. This guard makes that drift fail loudly.
 */
test("config.ts default primary matches opencode.json's qa-author (single source of truth)", () => {
  const models = opencodeAgentModels();
  const cfg = providerConfig("opencode", {});
  assert.equal(
    cfg.assignments.primary.model,
    models["qa-author"],
    "config.ts DEFAULT_MODELS.opencode.primary must equal the model opencode.json actually runs for qa-author.",
  );
});

/* Every provider's default config is usable whatever its reviewer's model: independence never blocks it. */
test("the default config of EVERY provider validates ok", () => {
  for (const provider of AGENT_PROVIDERS) {
    const result = validateAgentRuntimeConfig(providerConfig(provider, {}), { opencode: true });
    assert.equal(result.ok, true, `[${provider}] errors: ${result.errors.join("; ")}`);
  }
});

/* A role assigned a model the window catalog holds nothing for runs on the conservative default budget. Read from the real defaults of both providers, so a model added or retired in config.ts needs no edit here. */
test("every default role model of every provider has a window in the model-window catalog", () => {
  for (const provider of AGENT_PROVIDERS) {
    for (const [role, { model }] of Object.entries(providerConfig(provider, {}).assignments)) {
      assert.ok(CATALOGED_MODELS.includes(normalizeModelName(model)), `default ${provider} ${role} model '${model}' has no window in the catalog`);
    }
  }
});

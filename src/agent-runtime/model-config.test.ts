import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewerIndependence, singleProviderConfig, validateAgentRuntimeConfig } from "./config";
import { CODEX_MODELS } from "./codex-strategy";
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
  const cfg = singleProviderConfig("opencode", {});
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
  const cfg = singleProviderConfig("opencode", {});
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.equal(result.ok, true, `errors: ${result.errors.join("; ")}`);
  assert.equal(result.warnings.length, reviewerIndependence(cfg) === "shared-model" ? 1 : 0);
});

test("opencode.json declares a model for qa-generator and for qa-reviewer", () => {
  const models = opencodeAgentModels();
  assert.ok(models["qa-generator"], "qa-generator must declare a model");
  assert.ok(models["qa-reviewer"], "qa-reviewer must declare a model");
});

test("config.ts default reviewer matches opencode.json's qa-reviewer (single source of truth)", () => {
  const models = opencodeAgentModels();
  const cfg = singleProviderConfig("opencode", {});
  assert.equal(
    cfg.assignments.reviewer.model,
    models["qa-reviewer"],
    "config.ts DEFAULT_MODELS.opencode.reviewer must equal the model opencode.json actually runs for qa-reviewer.",
  );
});

/* config.ts's DEFAULT_MODELS.opencode.primary must match opencode.json's qa-generator model —
   not drift to qa-maintainer's model. The primary role that GENERATES tests on the e2e path must
   not be silently misdocumented. This guard makes that drift fail loudly.
 */
test("config.ts default primary matches opencode.json's qa-generator (single source of truth)", () => {
  const models = opencodeAgentModels();
  const cfg = singleProviderConfig("opencode", {});
  assert.equal(
    cfg.assignments.primary.model,
    models["qa-generator"],
    "config.ts DEFAULT_MODELS.opencode.primary must equal the model opencode.json actually runs for qa-generator.",
  );
});

/* Every provider's default config is usable whatever its reviewer's model: independence never blocks it. */
test("the default config of EVERY provider validates ok", () => {
  for (const provider of ["opencode", "codex"] as const) {
    const result = validateAgentRuntimeConfig(singleProviderConfig(provider, {}), { opencode: true, codex: true });
    assert.equal(result.ok, true, `[${provider}] errors: ${result.errors.join("; ")}`);
  }
});

/* The Codex reviewer model must exist in the CODEX_MODELS catalog so validateAssignedModels
   does not throw on applyConfig. Driven by the real exported catalog so that a catalog change
   that removes or renames a model automatically breaks this test — hardcoded IDs would silently
   miss drift.
 */
test("codex reviewer model id is present in the CODEX_MODELS catalog", () => {
  const catalogIds = new Set(CODEX_MODELS.map((m) => m.id));
  const cfg = singleProviderConfig("codex", {});
  assert.ok(
    catalogIds.has(cfg.assignments.reviewer.model),
    `codex reviewer model '${cfg.assignments.reviewer.model}' is not in CODEX_MODELS ` +
      `(${[...catalogIds].join(", ")}). An out-of-catalog model makes validateAssignedModels throw.`,
  );
});

/* A role assigned a model the window catalog holds nothing for runs on the conservative default budget. Read from the real defaults of both providers, so a model added or retired in config.ts needs no edit here. */
test("every default role model of both providers has a window in the model-window catalog", () => {
  for (const provider of ["opencode", "codex"] as const) {
    for (const [role, { model }] of Object.entries(singleProviderConfig(provider, {}).assignments)) {
      assert.ok(CATALOGED_MODELS.includes(normalizeModelName(model)), `default ${provider} ${role} model '${model}' has no window in the catalog`);
    }
  }
});

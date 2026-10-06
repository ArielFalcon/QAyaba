#!/usr/bin/env node
/*
 * Builds the effective OpenCode config for the slim image from agents/opencode.json:
 *   - the Playwright MCP runs its globally installed binary against the image's own Chromium
 *     (no `npx` registry resolution, no browser download at run time);
 *   - auto-update is off and session sharing is disabled (nothing leaves for a hosted share service);
 *   - slim/opencode.override.json, when present, is deep-merged last (objects merge, everything
 *     else replaces) — the place to declare a corporate LLM provider and re-point agent models;
 *   - an override that declares `provider` also LOCKS OpenCode to exactly those providers
 *     (`enabled_providers`), so no role can reach any other LLM endpoint;
 *   - every model reference of the effective config (`model`, `small_model`, `agent.<role>.model`)
 *     must resolve to an enabled provider and a model that provider declares. Otherwise the CLI
 *     exits non-zero listing every offending key, so the image build fails instead of a role
 *     silently calling an unreachable provider.
 * Serena and engram stay enabled: they feed exploration, generation and the stitcher's proposer.
 * The result is written once at build time and read by BOTH roles (the agents' runtime and the
 * orchestrator's prompt budgets), so they can never disagree on which model runs.
 *
 *   node slim/opencode-config.mjs <base.json> [override.json] > effective.json
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PW_CHROMIUM = "/usr/local/bin/pw-chromium";

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function slimOpencodeConfig(base, override) {
  const cfg = structuredClone(base);
  const pw = cfg.mcp?.playwright;
  if (pw && Array.isArray(pw.command)) {
    const args = pw.command[0] === "npx" ? pw.command.slice(2) : pw.command.slice(1);
    const withoutExec = args.filter((a, i) => a !== "--executable-path" && args[i - 1] !== "--executable-path");
    pw.command = ["playwright-mcp", ...withoutExec, "--executable-path", PW_CHROMIUM];
  }
  cfg.autoupdate = false;
  const effective = override ? deepMerge(cfg, override) : cfg;
  effective.share = "disabled";
  if (isPlainObject(override?.provider) && Object.keys(override.provider).length > 0) {
    effective.enabled_providers = Object.keys(override.provider);
  }
  return effective;
}

function modelRefViolation(ref, enabled, declared) {
  if (typeof ref !== "string") return `must be a "<provider>/<model>" string`;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return `"${ref}" is not "<provider>/<model>"`;
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (enabled && !enabled.includes(provider)) return `"${ref}": provider "${provider}" is not enabled (enabled: ${enabled.join(", ")})`;
  if (Object.hasOwn(declared, provider)) {
    const models = declared[provider]?.models;
    if (!isPlainObject(models) || !Object.hasOwn(models, model)) return `"${ref}": model "${model}" is not declared under provider "${provider}"`;
  }
  return undefined;
}

/**
 * Lists every model reference of an effective config that cannot resolve: the key it sits under and
 * why. A provider that the config does not declare (a built-in one) is checked only against the
 * enabled set. With the provider lock on, an agent that sets no model and has no top-level `model`
 * to inherit would fall back to OpenCode's default provider, so it is reported too.
 */
export function validateModelRefs(cfg) {
  const enabled = Array.isArray(cfg.enabled_providers) ? cfg.enabled_providers : undefined;
  const declared = isPlainObject(cfg.provider) ? cfg.provider : {};
  const violations = [];
  const check = (key, ref) => {
    const reason = modelRefViolation(ref, enabled, declared);
    if (reason) violations.push({ key, reason });
  };
  for (const key of ["model", "small_model"]) if (cfg[key] !== undefined) check(key, cfg[key]);
  for (const [role, agent] of Object.entries(isPlainObject(cfg.agent) ? cfg.agent : {})) {
    const ref = agent?.model;
    if (ref !== undefined) check(`agent.${role}.model`, ref);
    else if (enabled && cfg.model === undefined) {
      violations.push({ key: `agent.${role}.model`, reason: "not set, and there is no top-level model to inherit while providers are locked" });
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, overridePath] = process.argv.slice(2);
  if (!basePath) {
    console.error("usage: opencode-config.mjs <base.json> [override.json]");
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const override = overridePath && existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, "utf8")) : undefined;
  const effective = slimOpencodeConfig(base, override);
  const violations = validateModelRefs(effective);
  if (violations.length > 0) {
    console.error(`opencode-config: ${violations.length} model reference(s) cannot resolve in the effective config:`);
    for (const { key, reason } of violations) console.error(`  ${key}: ${reason}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(effective, null, 2) + "\n");
}

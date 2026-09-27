#!/usr/bin/env node
/*
 * Builds the effective OpenCode config for the slim image from agents/opencode.json:
 *   - the Playwright MCP runs its globally installed binary against the image's own Chromium
 *     (no `npx` registry resolution, no browser download at run time);
 *   - auto-update is off;
 *   - slim/opencode.override.json, when present, is deep-merged last (objects merge, everything
 *     else replaces) — the place to declare a corporate LLM provider and re-point agent models.
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
  return override ? deepMerge(cfg, override) : cfg;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, overridePath] = process.argv.slice(2);
  if (!basePath) {
    console.error("usage: opencode-config.mjs <base.json> [override.json]");
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const override = overridePath && existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, "utf8")) : undefined;
  process.stdout.write(JSON.stringify(slimOpencodeConfig(base, override), null, 2) + "\n");
}

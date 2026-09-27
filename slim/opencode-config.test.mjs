import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deepMerge, slimOpencodeConfig, PW_CHROMIUM } from "./opencode-config.mjs";

const base = JSON.parse(readFileSync(new URL("../agents/opencode.json", import.meta.url), "utf8"));

test("the Playwright MCP runs the global binary on the image's Chromium, keeping its original flags", () => {
  const cfg = slimOpencodeConfig(base);
  const cmd = cfg.mcp.playwright.command;
  assert.equal(cmd[0], "playwright-mcp");
  assert.ok(!cmd.includes("npx") && !cmd.includes("@playwright/mcp"), "no npx resolution at run time");
  assert.deepEqual(cmd.slice(-2), ["--executable-path", PW_CHROMIUM]);
  for (const flag of base.mcp.playwright.command.slice(2)) assert.ok(cmd.includes(flag), `keeps ${flag}`);
});

test("Serena and engram stay enabled with their commands untouched", () => {
  const cfg = slimOpencodeConfig(base);
  assert.deepEqual(cfg.mcp.serena, base.mcp.serena);
  assert.deepEqual(cfg.mcp.engram, base.mcp.engram);
});

test("auto-update is off and every agent keeps its prompt and tools", () => {
  const cfg = slimOpencodeConfig(base);
  assert.equal(cfg.autoupdate, false);
  assert.deepEqual(Object.keys(cfg.agent), Object.keys(base.agent));
  assert.equal(cfg.agent["qa-generator"].prompt, base.agent["qa-generator"].prompt);
});

test("an override declares a provider and re-points models without dropping the rest of the agent", () => {
  const override = {
    provider: { corp: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://llm.corp/v1" }, models: { big: { limit: { context: 200000, output: 8192 } } } } },
    agent: { "qa-generator": { model: "corp/big" } },
  };
  const cfg = slimOpencodeConfig(base, override);
  assert.equal(cfg.agent["qa-generator"].model, "corp/big");
  assert.equal(cfg.agent["qa-generator"].prompt, base.agent["qa-generator"].prompt);
  assert.equal(cfg.provider.corp.models.big.limit.context, 200000);
  assert.equal(cfg.agent["qa-reviewer"].model, base.agent["qa-reviewer"].model);
});

test("deepMerge replaces arrays and scalars, merges objects", () => {
  assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 5 } }), { a: [3], b: { c: 1, d: 5 } });
});

test("re-running on an already-slim config is idempotent", () => {
  const once = slimOpencodeConfig(base);
  assert.deepEqual(slimOpencodeConfig(once), once);
});

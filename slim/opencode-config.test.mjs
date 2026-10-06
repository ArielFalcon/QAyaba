import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, slimOpencodeConfig, validateModelRefs, PW_CHROMIUM } from "./opencode-config.mjs";

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

const gateway = (id, models) => ({
  [id]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://llm.corp/v1" }, models: Object.fromEntries(models.map((m) => [m, {}])) },
});
const allRolesOn = (ref) => Object.fromEntries(Object.keys(base.agent).map((role) => [role, { model: ref }]));

test("an override that declares providers locks OpenCode to exactly those providers", () => {
  const override = { provider: { ...gateway("corp", ["big"]), ...gateway("corp-two", ["small"]) } };
  assert.deepEqual(slimOpencodeConfig(base, override).enabled_providers, ["corp", "corp-two"]);
});

test("the lock holds even when the override tries to enable another provider", () => {
  const override = { enabled_providers: ["opencode-go", "corp"], provider: gateway("corp", ["big"]) };
  assert.deepEqual(slimOpencodeConfig(base, override).enabled_providers, ["corp"]);
});

test("without an override the provider set stays the base config's", () => {
  assert.ok(!("enabled_providers" in slimOpencodeConfig(base)));
  assert.ok(!("enabled_providers" in slimOpencodeConfig(base, { agent: { "qa-generator": { model: "x/y" } } })));
});

test("session sharing is disabled with and without an override", () => {
  assert.equal(slimOpencodeConfig(base).share, "disabled");
  assert.equal(slimOpencodeConfig(base, { provider: gateway("corp", ["big"]) }).share, "disabled");
});

test("an override cannot turn session sharing back on", () => {
  assert.equal(slimOpencodeConfig(base, { share: "auto", provider: gateway("corp", ["big"]) }).share, "disabled");
});

test("the base config validates cleanly: its providers are built in, not declared", () => {
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base)), []);
});

test("a fully re-pointed gateway config validates cleanly", () => {
  const override = { model: "corp/big", small_model: "corp/small", provider: gateway("corp", ["big", "small"]), agent: allRolesOn("corp/big") };
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base, override)), []);
});

test("a model id that itself contains a slash resolves against the first segment only", () => {
  const override = { provider: gateway("corp", ["vendor/big"]), agent: allRolesOn("corp/vendor/big") };
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base, override)), []);
});

test("every agent still pointing at a provider the lock disabled is listed", () => {
  const override = { provider: gateway("corp", ["big"]), agent: { "qa-generator": { model: "corp/big" } } };
  const keys = validateModelRefs(slimOpencodeConfig(base, override)).map((v) => v.key);
  assert.deepEqual(keys, Object.keys(base.agent).filter((role) => role !== "qa-generator").map((role) => `agent.${role}.model`));
});

test("a model the gateway does not declare is reported with its key", () => {
  const override = { provider: gateway("corp", ["big"]), agent: { ...allRolesOn("corp/big"), "qa-reviewer": { model: "corp/typo" } } };
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base, override)).map((v) => v.key), ["agent.qa-reviewer.model"]);
});

test("top-level model and small_model are checked like agent models", () => {
  const override = { model: "corp/typo", small_model: "elsewhere/small", provider: gateway("corp", ["big"]), agent: allRolesOn("corp/big") };
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base, override)).map((v) => v.key), ["model", "small_model"]);
});

test("a reference that is not <provider>/<model> is reported", () => {
  const override = { provider: gateway("corp", ["big"]), agent: { ...allRolesOn("corp/big"), "qa-assistant": { model: "big" } } };
  assert.deepEqual(validateModelRefs(slimOpencodeConfig(base, override)).map((v) => v.key), ["agent.qa-assistant.model"]);
});

test("with the lock on, an agent that sets no model and has no top-level model to inherit is reported", () => {
  const cfg = slimOpencodeConfig(base, { provider: gateway("corp", ["big"]), agent: allRolesOn("corp/big") });
  delete cfg.agent["qa-explorer"].model;
  assert.deepEqual(validateModelRefs(cfg).map((v) => v.key), ["agent.qa-explorer.model"]);
  cfg.model = "corp/big";
  assert.deepEqual(validateModelRefs(cfg), []);
});

test("every violation carries a reason that names the offending reference", () => {
  const override = { provider: gateway("corp", ["big"]), agent: { ...allRolesOn("corp/big"), "qa-reviewer": { model: "corp/typo" } } };
  const [violation] = validateModelRefs(slimOpencodeConfig(base, override));
  assert.match(violation.reason, /corp\/typo/);
});

function runCli(override) {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-slim-config-"));
  try {
    const overridePath = join(dir, "override.json");
    writeFileSync(overridePath, JSON.stringify(override));
    const basePath = fileURLToPath(new URL("../agents/opencode.json", import.meta.url));
    return spawnSync(process.execPath, [fileURLToPath(new URL("./opencode-config.mjs", import.meta.url)), basePath, overridePath], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the build step fails and lists every offending key when a role would call an unreachable provider", () => {
  const result = runCli({ provider: gateway("corp", ["big"]), agent: { "qa-generator": { model: "corp/big" }, "qa-reviewer": { model: "corp/typo" } } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "", "no effective config is emitted when it is invalid");
  for (const role of Object.keys(base.agent).filter((r) => r !== "qa-generator")) assert.ok(result.stderr.includes(`agent.${role}.model`), `lists ${role}`);
});

test("the build step prints the effective config when every model resolves", () => {
  const result = runCli({ provider: gateway("corp", ["big"]), agent: allRolesOn("corp/big") });
  assert.equal(result.status, 0, result.stderr);
  const cfg = JSON.parse(result.stdout);
  assert.deepEqual(cfg.enabled_providers, ["corp"]);
  assert.equal(cfg.share, "disabled");
});

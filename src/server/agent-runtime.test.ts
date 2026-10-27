import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntimeManager } from "./agent-runtime";
import type { EnvStoreFs } from "./env-store";
import type { AgentProvider, AgentRuntimeStrategy } from "../agent-runtime/types";
import { providerConfig } from "../agent-runtime/config";

function memoryFs(initial = ""): EnvStoreFs & { content: string } {
  return {
    content: initial,
    read() { return this.content || null; },
    write(content: string) { this.content = content; },
  };
}

function strategy(
  provider: AgentProvider,
  restarts: AgentProvider[],
  restartOpts?: Partial<Record<AgentProvider, unknown[]>>,
  disposed?: AgentProvider[],
): AgentRuntimeStrategy {
  /* The runtime offers the roster's default assignments next to the fixed ids the tests reassign to. */
  const defaults = Object.values(providerConfig(provider, {}).assignments).map((a) => ({ id: a.model }));
  const models = [
    ...defaults,
    { id: "opencode-go/minimax-m3.1-flash-free" },
    { id: "opencode/deepseek-v4.1-flash-free" },
    { id: "opencode-go/glm-5.3-flash" },
    { id: "opencode-go/minimax-m3" },
    { id: "opencode-go/kimi-k2.7-code" },
  ];
  return {
    provider,
    health: async () => ({ provider, status: "healthy", configured: true }),
    listModels: async () => models,
    openSession: async () => {
      throw new Error("not used");
    },
    restart: async (opts) => {
      restarts.push(provider);
      restartOpts?.[provider]?.push(opts);
      return { provider, status: "healthy", configured: true };
    },
    dispose: () => { disposed?.push(provider); },
  };
}

test("agent runtime manager boots on opencode and reports missing key as needs_config", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: {},
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.validation.ok, false);
  assert.equal(cfg.health?.opencode?.status, "needs_config");
  assert.equal("mode" in cfg, false);
  assert.equal("singleProvider" in cfg, false);
});

test("agent runtime manager applies an opencode key and restarts opencode", async () => {
  const restarts: AgentProvider[] = [];
  const env: Record<string, string | undefined> = {};
  const fs = memoryFs();
  const manager = createAgentRuntimeManager({
    env,
    fs,
    strategies: { opencode: strategy("opencode", restarts) },
  });

  const result = await manager.applyConfig({ apiKeys: { opencode: "open-key" } });

  assert.deepEqual(result.restarted, ["opencode"]);
  assert.equal(env.OPENCODE_API_KEY, "open-key");
  assert.match(fs.content, /^OPENCODE_API_KEY=open-key$/m);
  assert.doesNotMatch(JSON.stringify(result), /open-key/);
});

test("agent runtime manager passes the current runtime env to the provider restart", async () => {
  const restarts: AgentProvider[] = [];
  const restartOpts: Record<AgentProvider, unknown[]> = { opencode: [] };
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs("OPENCODE_API_KEY=open-key\n"),
    strategies: { opencode: strategy("opencode", restarts, restartOpts) },
  });

  await manager.applyConfig({ apiKeys: { opencode: "rotated-key" } });

  const opts = restartOpts.opencode[0] as { env?: Record<string, string>; apiKey?: string };
  assert.equal(opts.apiKey, "rotated-key");
  assert.equal(opts.env?.AGENT_PRIMARY_MODEL, providerConfig("opencode", {}).assignments.primary.model);
  assert.equal(opts.env?.AGENT_RUNTIME_MODE, undefined, "no runtime mode is written");
  assert.equal(opts.env?.AGENT_SINGLE_PROVIDER, undefined);
  assert.equal(opts.env?.AGENT_PRIMARY_PROVIDER, undefined);
});

test("agent runtime manager rejects missing model instead of silently falling back", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({ assignments: { primary: { provider: "opencode", model: "" } } }),
    /primary model is required/,
  );
});

test("agent runtime manager rejects a configured model that is not listed by its provider", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({
      assignments: {
        primary: { provider: "opencode", model: "opencode-go/not-a-real-model" },
      },
    }),
    /primary model 'opencode-go\/not-a-real-model' is not available for opencode/,
  );
  assert.deepEqual(restarts, []);
});

test("applyConfig accepts a shared reviewer model and logs the warning once", async () => {
  const shared = "fixture-provider/shared-model";
  const restarts: AgentProvider[] = [];
  const base = strategy("opencode", restarts);
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", AGENT_PRIMARY_MODEL: shared, AGENT_REVIEWER_MODEL: shared, AGENT_CHAT_MODEL: shared },
    fs: memoryFs(),
    strategies: { opencode: { ...base, listModels: async () => [{ id: shared }] } },
  });
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = await manager.applyConfig({});
    assert.equal(result.config.validation.ok, true);
    assert.equal(result.config.validation.warnings?.length, 1);
    const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("independent judgment"));
    assert.equal(lines.length, 1);
    assert.match((JSON.parse(lines[0]!) as { m: string }).m, /^\[qa\] /);
  } finally {
    warn.mock.restore();
  }
});

test("applyConfig logs no warning when the reviewer runs another model", async () => {
  const restarts: AgentProvider[] = [];
  const base = strategy("opencode", restarts);
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", AGENT_PRIMARY_MODEL: "fixture-provider/model-a", AGENT_REVIEWER_MODEL: "fixture-provider/model-b", AGENT_CHAT_MODEL: "fixture-provider/model-a" },
    fs: memoryFs(),
    strategies: { opencode: { ...base, listModels: async () => [{ id: "fixture-provider/model-a" }, { id: "fixture-provider/model-b" }] } },
  });
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = await manager.applyConfig({});
    assert.deepEqual(result.config.validation.warnings, []);
    assert.equal(warn.mock.calls.length, 0);
  } finally {
    warn.mock.restore();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntimeManager } from "./agent-runtime";
import { OpenCodeRuntimeStrategy } from "../agent-runtime/opencode-strategy";
import { CodexRuntimeStrategy } from "../agent-runtime/codex-strategy";
import type { EnvStoreFs } from "./env-store";
import type { AgentProvider, AgentProviderHealth, AgentRuntimeStrategy } from "../agent-runtime/types";
import { configFromEnv, runtimeRoleModelsFromConfig } from "../agent-runtime/config";
import {
  modelWindowBytes,
  roleWindowBytes,
  setRuntimeRoleModels,
} from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";

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
  const models = provider === "opencode"
    ? [
        { id: "opencode-go/glm-5.3-flash" },
        { id: "opencode-go/muse-spark-1.3-contributor" },
        { id: "opencode-go/kimi-k2.7-code" },
      ]
    : [
        { id: "gpt-5.4" },
        { id: "gpt-5.4-mini" },
        { id: "gpt-5.5" },
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

test("agent runtime manager boots single/opencode and reports missing key as needs_config", async () => {
  const env: Record<string, string | undefined> = {};
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs(),
    strategies: { opencode: new OpenCodeRuntimeStrategy({ env }), codex: new CodexRuntimeStrategy({ env }) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "opencode");
  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.validation.ok, false);
  assert.equal(cfg.health?.opencode?.status, "needs_config");
});

function reporting(provider: AgentProvider, health: Partial<AgentProviderHealth>): AgentRuntimeStrategy {
  return { ...strategy(provider, []), health: async () => ({ provider, status: "healthy", configured: true, ...health }) };
}

test("agent runtime manager asks for the key again when the orchestrator restarted while the agent service kept its own", async () => {
  const env: Record<string, string | undefined> = { AGENT_SUPERVISOR_URL: "http://agents:4097" };
  const supervisorHoldingAKey = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: { opencode: { provider: "opencode", status: "healthy", configured: true } } }),
  });
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs(),
    strategies: { opencode: new OpenCodeRuntimeStrategy({ env, fetchImpl: supervisorHoldingAKey }), codex: reporting("codex", { status: "needs_config", configured: false }) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.health?.opencode?.status, "needs_config");
  assert.ok(cfg.health?.opencode?.error, "the operator is told to paste the key again");
  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.validation.ok, false);
});

test("agent runtime manager shows an unreachable agent service as a failure, not as a missing key", async () => {
  const env: Record<string, string | undefined> = { AGENT_SUPERVISOR_URL: "http://agents:4097" };
  const unreachable = async () => { throw new Error("connect ECONNREFUSED"); };
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs(),
    strategies: { opencode: new OpenCodeRuntimeStrategy({ env, fetchImpl: unreachable }), codex: reporting("codex", { status: "needs_config", configured: false }) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.health?.opencode?.status, "failed");
  assert.match(cfg.health?.opencode?.error ?? "", /ECONNREFUSED/);
});

test("agent runtime manager reports needs_config when the supervisor lost the key this process still holds", async () => {
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "yesterdays-key" },
    fs: memoryFs(),
    strategies: { opencode: reporting("opencode", { status: "needs_config", configured: false }), codex: reporting("codex", { status: "needs_config", configured: false }) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.health?.opencode?.status, "needs_config");
  assert.equal(cfg.health?.opencode?.configured, false);
  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.validation.ok, false);
});

test("agent runtime manager restarts a provider through its strategy even when this process holds no key", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: {},
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const health = await manager.restart("opencode");

  assert.deepEqual(restarts, ["opencode"]);
  assert.equal(health.status, "healthy");
});

test("an empty key, as the slim stack passes it when none is set, reads as needing configuration", async () => {
  const env: Record<string, string | undefined> = { OPENCODE_API_KEY: "" };
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs(),
    strategies: { opencode: new OpenCodeRuntimeStrategy({ env }), codex: strategy("codex", []) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.health?.opencode?.status, "needs_config");
  assert.equal(cfg.health?.opencode?.configured, false);
});

test("agent runtime manager applies a codex key and restarts only codex", async () => {
  const restarts: AgentProvider[] = [];
  const env: Record<string, string | undefined> = { OPENCODE_API_KEY: "open-key" };
  const fs = memoryFs("OPENCODE_API_KEY=open-key\n");
  const manager = createAgentRuntimeManager({
    env,
    fs,
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const result = await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  assert.equal(result.config.singleProvider, "codex");
  assert.deepEqual(result.restarted, ["codex"]);
  assert.equal(env.CODEX_API_KEY, "codex-key");
  assert.match(fs.content, /^CODEX_API_KEY=codex-key$/m);
  assert.doesNotMatch(JSON.stringify(result), /codex-key/);
});

test("agent runtime manager disposes the outgoing provider when switching single provider", async () => {
  const restarts: AgentProvider[] = [];
  const disposed: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs("OPENCODE_API_KEY=open-key\n"),
    strategies: {
      opencode: strategy("opencode", restarts, undefined, disposed),
      codex: strategy("codex", restarts, undefined, disposed),
    },
  });

  await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  assert.deepEqual(disposed, ["opencode"]);
  assert.deepEqual(restarts, ["codex"]);
});

test("agent runtime manager passes current runtime env to provider restarts", async () => {
  const restarts: AgentProvider[] = [];
  const restartOpts: Record<AgentProvider, unknown[]> = { opencode: [], codex: [] };
  const env: Record<string, string | undefined> = { OPENCODE_API_KEY: "open-key" };
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs("OPENCODE_API_KEY=open-key\n"),
    strategies: {
      opencode: strategy("opencode", restarts, restartOpts),
      codex: strategy("codex", restarts, restartOpts),
    },
  });

  await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  const opts = restartOpts.codex[0] as { env?: Record<string, string>; apiKey?: string };
  assert.equal(opts.apiKey, "codex-key");
  assert.equal(opts.env?.AGENT_RUNTIME_MODE, "single");
  assert.equal(opts.env?.AGENT_SINGLE_PROVIDER, "codex");
  assert.equal(opts.env?.AGENT_PRIMARY_PROVIDER, "codex");
  assert.equal(opts.env?.AGENT_PRIMARY_MODEL, "gpt-5.4");
});

test("agent runtime manager requires confirmation before downgrading dual with one provider", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", CODEX_API_KEY: "codex-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({
      mode: "dual",
      assignments: {
        primary: { provider: "codex", model: "gpt-5.4" },
        reviewer: { provider: "codex", model: "gpt-5.4" },
        chat: { provider: "codex", model: "gpt-5.4-mini" },
      },
    }),
    /confirmSingleDowngrade/,
  );
});

test("agent runtime manager downgrades confirmed single-provider dual config to single", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", CODEX_API_KEY: "codex-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const result = await manager.applyConfig({
    mode: "dual",
    confirmSingleDowngrade: true,
    assignments: {
      /* primary and reviewer must be DIFFERENT models — identical models here would trip the
         reviewer!=primary runtime guard and this test isn't exercising that guard.
       */
      primary: { provider: "codex", model: "gpt-5.4" },
      reviewer: { provider: "codex", model: "gpt-5.5" },
      chat: { provider: "codex", model: "gpt-5.4-mini" },
    },
  });

  assert.equal(result.config.mode, "single");
  assert.equal(result.config.singleProvider, "codex");
  assert.equal(result.downgraded, true);
});

test("agent runtime manager rejects missing model instead of silently falling back", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
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
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
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

/* applyConfig mutates the LIVE AgentRuntimeConfig.assignments (via the guarded PUT
   /api/agent-config operator path) and must re-call setRuntimeRoleModels. Otherwise after a live
   role→model reassignment, roleWindowBytes keeps budgeting against the STALE boot snapshot until
   process restart. Reassigning to a SMALLER-window model leaves the budget too generous.
 */
test("agent runtime manager re-injects runtime role models on applyConfig so roleWindowBytes reflects the NEW model, not the stale boot snapshot", async () => {
  const restarts: AgentProvider[] = [];
  const env: Record<string, string | undefined> = {
    OPENCODE_API_KEY: "open-key",
    CODEX_API_KEY: "codex-key",
    AGENT_RUNTIME_MODE: "dual",
    AGENT_SINGLE_PROVIDER: "opencode",
    AGENT_REVIEWER_PROVIDER: "opencode",
    AGENT_REVIEWER_MODEL: "opencode-go/minimax-m3",
  };

  /* (a) boot path: mirrors opencode-client.ts's module-load wiring — resolve the real runtime
     assignments once from configFromEnv() and inject them into the qa-engine catalog seam.
   */
  setRuntimeRoleModels(runtimeRoleModelsFromConfig(configFromEnv(env)));

  try {
    const bytesBeforeReconfig = roleWindowBytes("qa-reviewer");
    assert.equal(bytesBeforeReconfig, modelWindowBytes("minimax-m3"), "sanity: boot injected the 32K reviewer model");

    const manager = createAgentRuntimeManager({
      env,
      fs: memoryFs(),
      strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
    });

    /* (b) live reconfiguration: reassign qa-reviewer to a DIFFERENT-window model via the guarded
       operator path (PUT /api/agent-config → applyConfig).
     */
    await manager.applyConfig({
      mode: "dual",
      assignments: { reviewer: { provider: "codex", model: "gpt-5.5" } },
    });

    /* (c) roleWindowBytes must now reflect gpt-5.5's window (128K), not the stale minimax-m3 (32K)
       snapshot from boot.
     */
    const bytesAfterReconfig = roleWindowBytes("qa-reviewer");
    assert.equal(
      bytesAfterReconfig,
      modelWindowBytes("gpt-5.5"),
      "roleWindowBytes must budget against the newly-assigned model after live reconfiguration",
    );
    assert.notEqual(
      bytesAfterReconfig,
      modelWindowBytes("minimax-m3"),
      "must not still budget against the stale boot-time model",
    );
  } finally {
    setRuntimeRoleModels(undefined);
  }
});

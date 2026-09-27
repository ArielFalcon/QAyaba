/* Per-role prompt byte budgets. Reads agents/opencode.json so model identities stay in agents/, not in the engine. That filesystem read is not an env-read confinement violation — the invariant forbids a new process.env read inside qa-engine, not fs. When the JSON is unavailable or the role is absent, DEFAULT_WINDOW_TOKENS is a conservative fallback. Budget is bytes via 1 token ≈ 4 bytes; no tokenizer at this layer. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BYTES_PER_TOKEN = 4;

export const INPUT_PROMPT_SAFETY_MARGIN = 0.75;

const MODEL_WINDOW_TOKENS: Record<string, number> = {
  "qwen3.7-plus": 64_000,
  "glm-5.3-flash": 1_000_000,
  "muse-spark-1.3-contributor": 1_048_576,
  "kimi-k2.7-code": 224_000,
  "minimax-m3": 32_000,
  "qwen3.8-flash": 32_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.5": 128_000,
};

export const DEFAULT_WINDOW_TOKENS = 32_000;

export function modelWindowBytes(modelName: string): number {
  const tokens = MODEL_WINDOW_TOKENS[modelName] ?? DEFAULT_WINDOW_TOKENS;
  return Math.floor(tokens * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
}

export function normalizeModelName(raw: string): string {
  const prefix = "opencode-go/";
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

const warnedFallbacks = new Set<string>();
function warnFallbackOnce(
  role: string,
  reason: string,
  outcome: string = `fell through to the DEFAULT window (${DEFAULT_WINDOW_TOKENS} tokens) — the assembled-prompt budget for this role is the conservative default, not its real model window`,
): void {
  const key = `${role}:${reason}`;
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  console.warn(
    `[model-window-catalog] role '${role}' ${outcome}: ${reason}. ` +
      `Confirm the role→model mapping in agents/opencode.json and the catalog in this file (see \`opencode models\`).`,
  );
}

export interface RuntimeRoleModels {
  primary: string;
  reviewer: string;
  chat: string;
}

const AGENT_TO_RUNTIME_ROLE: Record<string, keyof RuntimeRoleModels> = {
  "qa-generator": "primary",
  "qa-reviewer": "reviewer",
  "qa-assistant": "chat",
};

let injectedRuntimeModels: RuntimeRoleModels | undefined;

export function setRuntimeRoleModels(models: RuntimeRoleModels | undefined): void {
  injectedRuntimeModels = models;
}

/* A model's context window as declared in agents/opencode.json's own provider block (`provider.<id>.models.<model>.limit.context`, the field OpenCode itself reads for custom providers). Lets a custom or corporate provider carry its window in agents/ instead of this file. Undefined on any miss — never throws. */
export function configuredContextTokens(modelRef: string, configPath: string): number | undefined {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) return undefined;
  try {
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider?: Record<string, { models?: Record<string, { limit?: { context?: unknown } }> }>;
    };
    const context = raw.provider?.[modelRef.slice(0, slash)]?.models?.[modelRef.slice(slash + 1)]?.limit?.context;
    return typeof context === "number" && Number.isFinite(context) && context > 0 ? context : undefined;
  } catch {
    return undefined;
  }
}

/* Window for a model reference: the provider-declared window, else the catalog entry, else the conservative default. */
function windowBytesFor(modelRef: string, configPath: string): { bytes: number; known: boolean } {
  const declared = configuredContextTokens(modelRef, configPath);
  if (declared !== undefined) return { bytes: Math.floor(declared * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN), known: true };
  const modelName = normalizeModelName(modelRef);
  return { bytes: modelWindowBytes(modelName), known: modelName in MODEL_WINDOW_TOKENS };
}

/* Best-effort read of a role's model directly from agents/opencode.json — used both by the ordinary fallback path (non-visible roles, or no injected assignment) AND by the disagreement check below. Returns undefined on ANY failure (missing file, unparseable JSON, absent role/model) — never throws. */
function readOpencodeJsonModel(role: string, configPath: string): string | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      agent?: Record<string, { model?: string }>;
    };
    return raw.agent?.[role]?.model;
  } catch {
    return undefined;
  }
}

/** Resolve the byte budget for a ROLE. 1. If the role is one of the three VISIBLE roles AND a runtime assignment has been injected (setRuntimeRoleModels), resolve the model from THAT assignment first (env/dual-mode aware). A disagreement against opencode.json's own declared model for the same role is warned once (not a read failure — a real cross-source mismatch), but the runtime assignment always wins. 2. Never throws; always returns a positive byte count. */
export function roleWindowBytes(
  role: string,
  agentsConfigPath?: string,
): number {
  const configPath = agentsConfigPath ?? join(process.cwd(), "agents", "opencode.json");

  const runtimeRole = AGENT_TO_RUNTIME_ROLE[role];
  if (runtimeRole && injectedRuntimeModels) {
    const modelRef = injectedRuntimeModels[runtimeRole];
    const modelName = normalizeModelName(modelRef);

    const opencodeModel = readOpencodeJsonModel(role, configPath);
    if (opencodeModel && normalizeModelName(opencodeModel) !== modelName) {
      warnFallbackOnce(
        role,
        `AgentRuntimeConfig.assignments resolved '${modelName}' but agents/opencode.json configures ` +
          `'${normalizeModelName(opencodeModel)}' for this role — using the runtime assignment (the source of truth for what actually executes)`,
        `is using the RUNTIME-RESOLVED model's real window (NOT the default) despite a cross-source disagreement`,
      );
    }

    const window = windowBytesFor(modelRef, configPath);
    if (!window.known) {
      warnFallbackOnce(role, `runtime-assigned model '${modelName}' not in the catalog`);
    }
    return window.bytes;
  }

  try {
    if (!existsSync(configPath)) {
      warnFallbackOnce(role, `config not found at ${configPath}`);
      return modelWindowBytes("__fallback__");
    }
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      agent?: Record<string, { model?: string }>;
    };
    const modelRef = raw.agent?.[role]?.model;
    if (!modelRef) {
      warnFallbackOnce(role, "role absent from agents.agent map (no model assigned)");
      return modelWindowBytes("__fallback__");
    }
    const window = windowBytesFor(modelRef, configPath);
    if (!window.known) {
      warnFallbackOnce(role, `model '${normalizeModelName(modelRef)}' not in the catalog`);
    }
    return window.bytes;
  } catch {
    warnFallbackOnce(role, "config unreadable or unparseable JSON");
    return modelWindowBytes("__fallback__");
  }
}

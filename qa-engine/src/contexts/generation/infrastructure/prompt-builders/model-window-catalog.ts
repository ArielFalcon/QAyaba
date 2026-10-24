/* Per-role prompt byte budgets. Reads agents/opencode.json so model identities stay in agents/, not in the engine. That filesystem read is not an env-read confinement violation — the invariant forbids a new process.env read inside qa-engine, not fs. A window the agent runtime reports for the role's model (setLiveModelWindows) wins over this file's catalog. When the JSON is unavailable, the role is absent or its model is neither reported nor cataloged, DEFAULT_WINDOW_TOKENS is a conservative fallback. Budget is bytes via 1 token ≈ 4 bytes; no tokenizer at this layer. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BYTES_PER_TOKEN = 4;

export const INPUT_PROMPT_SAFETY_MARGIN = 0.75;

/* Provider prefixes a role's model reference may carry. Both the Go subscription and the plain
   `opencode` provider serve free models, and a reference keeps its prefix wherever it is written. */
const PROVIDER_PREFIXES = ["opencode-go/", "opencode/", "deepseek-api/"];

const MODEL_WINDOW_TOKENS: Record<string, number> = {
  "qwen3.7-plus": 64_000,
  "glm-5.3-flash": 1_000_000,
  "minimax-m3.1-flash-free": 1_000_000,
  "deepseek-v4.1-flash-free": 200_000,
  "deepseek-v4.1-flash": 1_048_576,
  "beam-free": 1_048_576,
  "muse-spark-1.3-contributor": 1_048_576,
  "kimi-k2.7-code": 224_000,
  "minimax-m3": 1_000_000,
  "qwen3.8-flash": 32_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.5": 128_000,
};

/* The ids the catalog holds a window for. The model-name guard derives what no prompt may name from this list, so a cataloged model needs no edit there. */
export const CATALOGED_MODELS: readonly string[] = Object.keys(MODEL_WINDOW_TOKENS);

export const DEFAULT_WINDOW_TOKENS = 32_000;

export function modelWindowBytes(modelName: string): number {
  return tokensToBytes(MODEL_WINDOW_TOKENS[modelName] ?? DEFAULT_WINDOW_TOKENS);
}

function tokensToBytes(tokens: number): number {
  return Math.floor(tokens * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
}

/* The context window the agent runtime reports for each model it serves, keyed by the provider/model reference a role is
   assigned. It wins over the catalog, which then only answers for a model the runtime did not report. */
let liveModelWindows: Readonly<Record<string, number>> | undefined;

export function setLiveModelWindows(windows: Readonly<Record<string, number>> | undefined): void {
  liveModelWindows = windows;
}

function liveWindowBytes(modelRef: string): number | undefined {
  const tokens = liveModelWindows?.[modelRef];
  return tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0 ? tokensToBytes(tokens) : undefined;
}

/* The runtime's window for the reference when it reported one, else the catalog's for the bare model name. */
function windowBytesFor(role: string, modelRef: string, source: string): number {
  const live = liveWindowBytes(modelRef);
  if (live !== undefined) return live;
  const modelName = normalizeModelName(modelRef);
  if (!(modelName in MODEL_WINDOW_TOKENS)) warnFallbackOnce(role, `${source} '${modelName}' not in the catalog and not reported by the runtime`);
  return modelWindowBytes(modelName);
}

export function normalizeModelName(raw: string): string {
  const prefix = PROVIDER_PREFIXES.find((p) => raw.startsWith(p));
  return prefix ? raw.slice(prefix.length) : raw;
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

    return windowBytesFor(role, modelRef, "runtime-assigned model");
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
    return windowBytesFor(role, modelRef, "model");
  } catch {
    warnFallbackOnce(role, "config unreadable or unparseable JSON");
    return modelWindowBytes("__fallback__");
  }
}

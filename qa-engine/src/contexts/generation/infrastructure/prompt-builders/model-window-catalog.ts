// Model-window catalog for per-role byte budget enforcement (Phase 2 / Slice F).
//
// migration-tier-4c Slice 5a: relocated verbatim from src/integrations/model-window-catalog.ts
// (prompts.ts's own sibling — both moved together). This module's own `existsSync`/`readFileSync`
// fs read of `agents/opencode.json` is NOT a CLAUDE.md env-read-confinement violation: that
// invariant forbids a NEW `process.env` read inside qa-engine/src, not a filesystem read — qa-engine
// already reads the filesystem freely elsewhere (manifest-fs.ts, context-pack.ts, etc.). Pure
// relocation in THIS commit — D-4c-6's roleWindowBytes split-brain fix (resolving the role's model
// from AgentRuntimeConfig.assignments FIRST) lands as its own follow-up commit, once this file is
// already in its new home.
//
// This module resolves the per-role byte budget the ContextAssembler enforces on
// every boundary prompt. The budget is expressed in BYTES using the documented
// approximation: 1 token ≈ 4 bytes (≈ 4 chars in typical English/code content).
// No real tokenizer is used — the `opencode-go/*` models are opaque and no
// per-model tokenizer is available at this layer.
//
// The catalog maps ROLE names to model context windows (in tokens). The role →
// model mapping is read at runtime from `agents/opencode.json` so `src/` does
// not hard-code model identities (those live in `agents/`). When the JSON is
// unavailable or the role is absent, the DEFAULT_WINDOW_TOKENS fallback is used —
// a conservative value that is safe for any current model in the roster.
//
// ⚠ VALUES SOURCED from the live provider catalog (`opencode models --refresh` →
// ~/.cache/opencode/models.json). Older hard-coded rosters (qwen3.7-plus, qwen3.8-flash,
// minimax-m3) keep their conservative legacy entries since they may still appear in
// historical run inputs; confirm before reusing them as active roster entries.
//
// Compaction coordination note (Phase 2 / Slice F):
//   The budget here bounds only the ORCHESTRATOR-ASSEMBLED INPUT PROMPT. It cannot
//   bound the agent's accumulated tool-call outputs mid-turn; that is the runtime
//   domain. `agents/opencode.json` keeps `compaction.auto: true` so the OpenCode
//   runtime compacts accumulated tool outputs before they hit the model's hard
//   context limit. The `preserve_recent_tokens` / `tail_turns` values in that file
//   are tuned conservatively so the ground-truth content pushed in the VOLATILE band
//   (positioned near the task, per Phase-1 canonical order) remains within the
//   preserved-recent window at write time. These values are provisional pending
//   Phase-0 window-pressure telemetry; raise them only after confirming observed
//   turn sizes via `agent_turns`.
//
// Session policy note (Phase 2 / Slice F):
//   The REVIEWER always runs in its own independent session (independence invariant
//   — it must judge the generator's output without access to the generator's
//   reasoning). Generator session-reuse across its own regeneration passes is a
//   MEASURED option: validate via `cacheRead` trends in `agent_turns` before
//   enabling it as a default. It is NOT a default change in this slice.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The bytes-per-token approximation applied uniformly across all models.
// Rationale: opencode-go/* model tokenizers are opaque; 4 bytes/token is a
// reasonable approximation for mixed English/code content (roughly 3-5 bytes per
// token in practice). Using 4 is conservative enough to stay under real limits
// while still providing meaningful budget guidance.
export const BYTES_PER_TOKEN = 4;

// Safety margin: the orchestrator-assembled input prompt is budgeted to this
// fraction of the model's full context window. The remainder is reserved for:
//   - The agent's own system prompt (injected by OpenCode from agents/opencode.json)
//   - Tool definitions and tool call overhead
//   - The agent's output tokens (model response)
//   - Headroom for mis-estimated byte→token conversion
// 0.75 is conservative: it leaves 25% of the window for the above overhead,
// which is ample for typical tool/system-prompt sizes while keeping the input
// prompt in a safe range.
export const INPUT_PROMPT_SAFETY_MARGIN = 0.75;

// Per-model context-window catalog in TOKENS.
// Values sourced from the OpenCode provider catalog (~/.cache/opencode/models.json after
// `opencode models --refresh`), cross-checked across providers for each model. The "probe
// with real serving limits" rule: entries hold the ADVERTISED context; the 0.75 safety
// margin below leaves the 25% headroom for system prompt/tools/output.
//
// Current roster (from agents/opencode.json):
//   glm-5.3-flash              → qa-generator, qa-proposer, qa-explorer, qa-worker(+code),
//                                qa-assistant, qa-reflector (primary writer + high-frequency roles)
//   muse-spark-1.3-contributor → qa-reviewer (independent judge)
//   kimi-k2.7-code             → qa-maintainer (self-maintenance; smallest input window of the roster)
const MODEL_WINDOW_TOKENS: Record<string, number> = {
  // Generator model (current qa-generator in agents/opencode.json): qwen3.7-plus.
  // 64K conservative starting point (matches kimi) until the real window is confirmed — raise after
  // telemetry. Without this entry the model falls to the 32K DEFAULT, halving the qa-generator prompt
  // budget (which is what shed the volatile sections and broke the two seam-d pinning tests).
  "qwen3.7-plus": 64_000,
  // Advertised 1M context / 128K output (cached-read 0.03). Workhorse of the roster.
  "glm-5.3-flash": 1_000_000,
  // Advertised 1,048,576 context (Meta contributor tier).
  "muse-spark-1.3-contributor": 1_048_576,
  // Advertised 262,144 context with a 224,000 input sub-limit (smaller of the two documented).
  "kimi-k2.7-code": 224_000,
  // Reviewer model: minimax-m3.
  // Reviewer prompts are typically smaller (spec contents + DOM slice), so 32K
  // is used as a conservative starting value. Raise after Phase-0 data.
  "minimax-m3": 32_000,
  // Worker / flash tier models: qwen3.8-flash.
  // Workers receive per-objective prompts (smaller scope), 32K is safe.
  "qwen3.8-flash": 32_000,
  // Codex models (T-P2-4): gpt-5.4, gpt-5.4-mini and gpt-5.5 (reviewer).
  // GPT-5 series supports 128K+ context (conservative entry; raise after telemetry confirms).
  // Without entries these fall to the 32K default, silently truncating context on large runs.
  // ⚠ PROVISIONAL — confirm the exact window via `openai models` or OpenAI docs once available.
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.5": 128_000,
};

// Fallback window in tokens when the role or model is not in the catalog.
// 32K is conservative enough for any model in the current roster.
// ⚠ PROVISIONAL — should not be lower than the smallest known model window.
export const DEFAULT_WINDOW_TOKENS = 32_000;

// Compute the effective budget in BYTES for an assembled input prompt destined
// for the given model (identified by the short model name from agents/opencode.json,
// without the "opencode-go/" prefix). Returns:
//   floor(windowTokens × SAFETY_MARGIN × BYTES_PER_TOKEN)
// If the model is not in the catalog, uses DEFAULT_WINDOW_TOKENS.
export function modelWindowBytes(modelName: string): number {
  const tokens = MODEL_WINDOW_TOKENS[modelName] ?? DEFAULT_WINDOW_TOKENS;
  return Math.floor(tokens * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
}

// Normalize an `opencode-go/model-name` reference to the bare model name used
// as catalog key. Strips the "opencode-go/" prefix if present.
export function normalizeModelName(raw: string): string {
  const prefix = "opencode-go/";
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

// FIX 8c: a fall-through to the default window is silent today, so a model-name/catalog mismatch
// (e.g. the roster in agents/opencode.json renamed a model the catalog still keys by the old name)
// is invisible — every prompt would quietly use the conservative DEFAULT_WINDOW_TOKENS instead of the
// model's real, larger window. Warn ONCE per (role, reason) so the mismatch is observable without
// spamming the log on every assemble() call. Module-level set survives for the process lifetime.
//
// `outcome` (migration-tier-4d Slice 4, residual v — FIX): describes what ACTUALLY happens for THIS
// call site. Most callers genuinely fall through to DEFAULT_WINDOW_TOKENS (the default below covers
// them), but the D-4c-6 cross-source-disagreement call site does NOT fall through to anything — it
// keeps using the runtime-resolved model's REAL window and only flags the mismatch for an operator to
// confirm. The old hardcoded "fell through to the DEFAULT window" text was misleading there (nothing
// fell through); this parameter lets that call site say what actually happened instead.
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

// migration-tier-4c Slice 5b (D-4c-6, the split-brain fix). BEFORE this fix, roleWindowBytes read
// agents/opencode.json EXCLUSIVELY for every role — but the model a role ACTUALLY executes under at
// runtime is decided by AgentRuntimeConfig.assignments (src/agent-runtime/config.ts), which is
// env/dual-mode aware (AGENT_RUNTIME_MODE=dual, AGENT_REVIEWER_PROVIDER/AGENT_REVIEWER_MODEL env
// overrides, etc.) — opencode.json only ever configures the OpenCode runtime's OWN roster, which in
// dual mode can differ entirely from what the reviewer/chat role is actually running on (a Codex
// model, a different provider). Two independent sources of truth for "what model does this role
// run" is a split-brain: the byte budget was silently computed against the WRONG model's context
// window whenever dual mode or an env override was active.
//
// AFTER this fix: for the three VISIBLE roles that have their OWN AgentRuntimeConfig assignment
// (qa-generator↔primary, qa-reviewer↔reviewer, qa-assistant↔chat — the SAME legacy-agent-name→role
// map `src/agent-runtime/types.ts`'s roleForLegacyAgent already establishes), the model is resolved
// from the INJECTED runtime assignment FIRST. opencode.json stays the resolution path for every
// OTHER role (qa-worker, qa-worker-code, qa-explorer, qa-maintainer, qa-reflector — none of these has
// its own AgentRuntimeConfig assignment; assignmentForRole aliases them to `primary`, which would be
// WRONG here since opencode.json genuinely assigns them a cheaper, different model) — UNCHANGED. When
// no runtime assignment has been injected at all (not wired — e.g. a bare unit test, or a process
// that never called setRuntimeRoleModels), the ENTIRE resolution degrades to the pre-fix
// opencode.json-only behavior — never a hard failure.
export interface RuntimeRoleModels {
  primary: string; // full model ref, e.g. "opencode-go/deepseek-v4-pro" or "gpt-5.4"
  reviewer: string;
  chat: string;
}

// The SAME three legacy-agent-name keys prompts.ts/opencode-client.ts already call roleWindowBytes
// with (qa-generator/qa-reviewer/qa-assistant) — mirrors src/agent-runtime/types.ts's own
// LEGACY_AGENT_TO_ROLE map for just these three "visible" entries (qa-engine may not import that
// src/ file directly; this is the same tiny, stable mapping, structurally mirrored).
const AGENT_TO_RUNTIME_ROLE: Record<string, keyof RuntimeRoleModels> = {
  "qa-generator": "primary",
  "qa-reviewer": "reviewer",
  "qa-assistant": "chat",
};

// Module-level injection seam (mirrors the RawAgentTransport/RawEventStreamOpener late-bound-setter
// discipline from Slices 2/3): the shell resolves configFromEnv() ONCE at composition time and
// injects the three resolved model refs here. `undefined` (the default) means "not wired" — every
// existing pre-fix caller/test keeps working via the opencode.json-only fallback below.
let injectedRuntimeModels: RuntimeRoleModels | undefined;

export function setRuntimeRoleModels(models: RuntimeRoleModels | undefined): void {
  injectedRuntimeModels = models;
}

// Best-effort read of a role's model directly from agents/opencode.json — used both by the ordinary
// fallback path (non-visible roles, or no injected assignment) AND by the disagreement check below.
// Returns undefined on ANY failure (missing file, unparseable JSON, absent role/model) — never throws.
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

// Resolve the byte budget for a ROLE.
//   1. If the role is one of the three VISIBLE roles AND a runtime assignment has been injected
//      (setRuntimeRoleModels), resolve the model from THAT assignment first (env/dual-mode aware).
//      A disagreement against opencode.json's own declared model for the same role is warned once
//      (not a read failure — a real cross-source mismatch), but the runtime assignment always wins.
//   2. Otherwise, read the role's model from `agents/opencode.json` at `agentsConfigPath` (defaults
//      to the process-cwd relative path used by the rest of `src/`) — the pre-fix behavior, verbatim.
// Falls back gracefully at every step (logging ONCE per role/reason so a mismatch is observable,
// FIX 8c): config missing/unparseable, role absent from agents.agent map, or model not in the
// catalog all degrade to DEFAULT_WINDOW_TOKENS. Never throws; always returns a positive byte count.
export function roleWindowBytes(
  role: string,
  agentsConfigPath?: string,
): number {
  const configPath = agentsConfigPath ?? join(process.cwd(), "agents", "opencode.json");

  const runtimeRole = AGENT_TO_RUNTIME_ROLE[role];
  if (runtimeRole && injectedRuntimeModels) {
    const modelRef = injectedRuntimeModels[runtimeRole];
    const modelName = normalizeModelName(modelRef);

    // Cross-source disagreement check (D-4c-6): opencode.json may declare a DIFFERENT model for
    // this role than the injected runtime assignment resolved — this is expected in dual mode or
    // under an env override, but worth surfacing so an operator can confirm it is intentional.
    const opencodeModel = readOpencodeJsonModel(role, configPath);
    if (opencodeModel && normalizeModelName(opencodeModel) !== modelName) {
      warnFallbackOnce(
        role,
        `AgentRuntimeConfig.assignments resolved '${modelName}' but agents/opencode.json configures ` +
          `'${normalizeModelName(opencodeModel)}' for this role — using the runtime assignment (the source of truth for what actually executes)`,
        `is using the RUNTIME-RESOLVED model's real window (NOT the default) despite a cross-source disagreement`,
      );
    }

    if (!(modelName in MODEL_WINDOW_TOKENS)) {
      warnFallbackOnce(role, `runtime-assigned model '${modelName}' not in the catalog`);
    }
    return modelWindowBytes(modelName);
  }

  // Not a visible role, or no runtime assignment injected — the pre-fix opencode.json-only path.
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
    const modelName = normalizeModelName(modelRef);
    if (!(modelName in MODEL_WINDOW_TOKENS)) {
      warnFallbackOnce(role, `model '${modelName}' not in the catalog`);
    }
    return modelWindowBytes(modelName);
  } catch {
    // Config unreadable or unparseable; return the safe fallback.
    warnFallbackOnce(role, "config unreadable or unparseable JSON");
    return modelWindowBytes("__fallback__");
  }
}

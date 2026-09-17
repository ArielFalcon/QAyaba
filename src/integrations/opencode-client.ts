
/*
 * Provider I/O edge: thin OpenCode SDK primitives (session create/prompt/abort) plus a few
 * control-plane wrappers. Domain/policy lives in qa-engine.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RunMode } from "../types";
import { parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief } from "../qa/exploration-brief";
import { saveAgentTurn } from "../server/history";

import { configFromEnv, runtimeRoleModelsFromConfig } from "../agent-runtime/config";
import { setRuntimeRoleModels } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { installHttpDispatcher } from "../util/net";


import {
  activityRouter,
  registerRunSession,
  unregisterRunSession,
  startActivitySink,
  setRawEventStreamOpener,
  type LiveActivity,
  type RawEventStreamOpener,
} from "@contexts/generation/infrastructure/sse/event-stream";
export { activityRouter, registerRunSession, unregisterRunSession, startActivitySink };
export type { LiveActivity };

/* Re-export so control-plane importers keep resolving extractJsonObjects/parseVerdict here. */
import { type FinalVerdict, extractJsonObjects, parseVerdict } from "./verdict-parse";
export { extractJsonObjects, parseVerdict };

import {
  specFileForFlow,
  buildWorkerPrompt,
  buildWorkerPromptAssembled,
  buildPrompt,
  buildPromptAssembled,
  buildExplorerPrompt,
  buildContextTask,
  renderArchitectureContext,
  buildReviewerPrompt,
  buildReviewerPromptAssembled,
  reviewObjective,
  renderReviewSpecs,
  renderExecutionResult,
  setExplorationBriefCollaborators,
} from "@contexts/generation/infrastructure/prompt-builders/prompts";
export { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult };
export type { AssembledPrompt, ExecutionResultCase } from "@contexts/generation/infrastructure/prompt-builders/prompts";


setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });


const runtimeConfig = configFromEnv();
setRuntimeRoleModels(runtimeRoleModelsFromConfig(runtimeConfig));


import {
  checkCircuit,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetCircuit,
} from "@contexts/generation/infrastructure/resilience/circuit-breaker";
export { resetCircuit };
import {
  createAgentDeps,
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  withStallWatchdog,
  withUsageSink,
  withSessionRegistration,
  getOpenSessions as engineGetOpenSessions,
  getOpenSessionCount as engineGetOpenSessionCount,
  registerSessionWatchdogNotify,
  unregisterSessionWatchdogNotify,
  notifySessionActivity,
  type AgentDeps,
  type AgentSession,
  type AgentOpenDescriptor,
  type AgentTurnEvent,
  type UsageSnapshot,
  type RawAgentTransport,
  type RawPromptResult,
  type RawAgentErrorPayload,
} from "@contexts/generation/infrastructure/agent-transport-policy";
export {
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  withStallWatchdog,
  withUsageSink,
  withSessionRegistration,
  registerSessionWatchdogNotify,
  unregisterSessionWatchdogNotify,
  notifySessionActivity,
};
export type { AgentDeps, AgentSession, AgentOpenDescriptor, AgentTurnEvent, UsageSnapshot };

/*
 * Read fallback model mapping from opencode.json (root-level key). Keeps the
 * fallback logic in one place so the orchestrator can retry with a different
 * model when the primary is unavailable. Opt-in: absent `model_fallback` key
 * (the default) means no fallback — the primary error propagates unchanged.
 */
function getFallbackModel(agent: string): string | undefined {
  try {
    const configPath = join(process.cwd(), "agents", "opencode.json");
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return raw.model_fallback?.[agent] as string | undefined;
  } catch {
    return undefined;
  }
}

/*
 * Shared OpenCode SDK client — lazy-initialised once, reused by SSE stream AND
 * session operations. This avoids creating two independent HTTP connections to
 * the OpenCode server (official best practice: one client, many operations).
 */
let sharedClient: Awaited<ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>> | undefined;

async function getSharedClient() {
  checkCircuit();
  if (sharedClient) return sharedClient;
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    sharedClient = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://agents:4096",
      ...(serverPassword
        ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } }
        : {}),
    });
    recordCircuitSuccess();
  } catch (err) {
    recordCircuitFailure();
    throw err;
  }
  return sharedClient;
}

/*
 * Separate v2 SDK client, used ONLY for the live event subscription (observability
 * path). Sessions/verdict stay on the v1 blocking client above — the deliberate
 * split (docs/tui-vnext.md §5 D5): events→v2 scoped subscribe (advisory-only, zero
 * verdict risk), generation/verdict→v1 blocking prompt (the determinism keystone).
 */
let sharedEventClient: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient> | undefined;

async function getEventClient() {
  checkCircuit();
  if (sharedEventClient) return sharedEventClient;
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    sharedEventClient = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://agents:4096",
      ...(serverPassword
        ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } }
        : {}),
    });
    recordCircuitSuccess();
  } catch (err) {
    recordCircuitFailure();
    throw err;
  }
  return sharedEventClient;
}

export function disposeSharedClient(): void {
  sharedClient = undefined;
  sharedEventClient = undefined;
  /*
   * The breaker is process-global and decoupled from the client lifecycle; reset it here
   * so a restart-to-recover does not immediately re-throw "circuit breaker is OPEN".
   */
  resetCircuit();
}


const rawEventStreamOpener: RawEventStreamOpener = {
  open: async (directory) => {
    const client = await getEventClient();
    const result = await client.event.subscribe({ directory });
    return result.stream as AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> | undefined;
  },
};
setRawEventStreamOpener(rawEventStreamOpener);


export function getOpenSessions(): ReturnType<typeof engineGetOpenSessions> {
  return engineGetOpenSessions();
}

export function getOpenSessionCount(): number {
  return engineGetOpenSessionCount();
}


export async function askAssistant(
  
  input: { context: string; question: string; instruction?: string; agent?: string; runId?: string },
  deps: AgentDeps,
  cwd: string,
): Promise<string> {
  const instruction = input.instruction ??
    [
      `Answer the operator's question about this QA run using ONLY the run context below.`,
      ``,
      `RESPONSE STRUCTURE (for questions about a test failure or run status):`,
      `  1. One-line summary of what happened (verdict, phase, key numbers)`,
      `  2. Key detail: what failed and why (1-3 sentences, root cause in plain language)`,
      `  3. What to do next (if applicable: wait, re-run, check the issue, continue)`,
      ``,
      `OUTPUT:`,
      `- Reply with the ANSWER ONLY. Never include your reasoning, planning, or thought`,
      `  process — no "Let me look at…", no step-by-step deliberation. Just the answer.`,
      `- Respond in the SAME language as the question (Spanish → Spanish, English → English),`,
      `  in neutral, standard language — no regional slang. Never use emojis.`,
      ``,
      `FORMATTING — your answer is rendered as Markdown in the terminal, so use it:`,
      `  · **bold** for emphasis and key numbers.`,
      `  · \`inline code\` for file names, commands, selectors and identifiers.`,
      `  · "-" bullet lists for enumerations; short "##" headings when the answer spans topics.`,
      `  Keep it concise and scannable — a few short paragraphs, not a wall of text.`,
      ``,
      `PLAIN LANGUAGE — talk about the user's tests, not the tool's internals:`,
      `  · Say what the agent is DOING (generating tests, exploring the page), not phase`,
      `    names (classify/generate/validate/execute) or pipeline mechanics.`,
      `  · Never mention "heartbeat"; say "the agent is still active" instead.`,
      `  · Describe outcomes in plain words rather than raw step/status/verdict tokens.`,
      ``,
      `- If the context lacks the answer, reply (in the question's language): "No tengo suficiente información para responder eso."`,
    ].join("\n");
  const role = input.agent ?? "qa-assistant";
  
  const session = await deps.open(role, cwd, {
    descriptor: { role, runId: input.runId },
  });
  try {
    /*
     * textOnly drops the model's reasoning parts: the assistant's return value is shown
     * verbatim to the operator, so a leaked chain-of-thought would surface in the chat.
     */
    return await session.prompt([
      instruction,
      `Do not use any tools.`,
      `---`,
      input.context,
      `---`,
      `Question: ${input.question}`,
    ].join("\n"), { textOnly: true });
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}


/*
 * The reviewer is a bounded, read-only judge (10 steps, contents inlined in the prompt) —
 * it must never inherit the generator's 25-minute worst-case budget: a hung reviewer would
 * add that whole window to the run before the loop fails closed.
 * Shared with CodexRuntimeStrategy so both providers use one per-role budget.
 */
export const REVIEWER_TIMEOUT_MS = Number(process.env.OPENCODE_REVIEWER_TIMEOUT_MS) || 6 * 60 * 1000;
/*
 * The explorer is a read-only PRE-pass; cap it well below the generator/diff budget so a hung
 * explorer cannot hold the sequential queue for the full window before the generator even starts.
 * 90s proved too tight on large microservice monorepos (petclinic): the read-only brief needs room
 * to finish; 240s still sits far under the generator's 25-minute worst case.
 * Shared with CodexRuntimeStrategy so both providers use one per-role budget.
 */
export const EXPLORER_TIMEOUT_MS = Number(process.env.OPENCODE_EXPLORER_TIMEOUT_MS) || 240 * 1000;
/*
 * The fan-out planner for a SCOPED mode (diff/manual — one commit or one guidance string) derives
 * objectives from the brief + code; it must NOT navigate (F3), so it needs nowhere near the generator's
 * per-mode budget. Bound it with its OWN deadline: it reads OPENCODE_PLANNER_TIMEOUT_MS, NOT the global
 * OPENCODE_TIMEOUT_MS override (which, set to e.g. 900s, would otherwise let a misbehaving planner
 * consume the generator's whole window — the hang that produced 0 specs). Applied to diff/manual
 * REGARDLESS of whether the explorer brief arrived: a brief-less planner still only widens+plans a
 * single scope, and reverting it to the 5–10 min generator budget would re-open the hang on exactly the
 * monorepos this targets. Matched to EXPLORER_TIMEOUT_MS (240s) — the explorer does the comparable
 * read+widen and needed that much on petclinic — and folded into the dispatcher Math.max below.
 * complete/exhaustive (whole-repo analysis, no scope) keep the per-mode generator budget.
 */
const PLANNER_TIMEOUT_MS = Number(process.env.OPENCODE_PLANNER_TIMEOUT_MS) || 240 * 1000;


const TIMEOUT_BY_MODE: Record<RunMode, number> = {
  diff: 5 * 60 * 1000,
  complete: 15 * 60 * 1000,
  exhaustive: 25 * 60 * 1000,
  manual: 10 * 60 * 1000,
  context: 10 * 60 * 1000,
};

export function agentTimeout(mode: RunMode): number {
  return Number(process.env.OPENCODE_TIMEOUT_MS) || TIMEOUT_BY_MODE[mode];
}

const MAX_AGENT_TIMEOUT_MS = Math.max(...Object.values(TIMEOUT_BY_MODE));


/*
 * Default stall threshold: STRICTLY less than the shortest mode timeout (diff = 5 min).
 * Configurable via OPENCODE_STALL_MS. 180 seconds without any agent activity event triggers the
 * watchdog — tight enough to catch a truly hung session well before the coarse deadline, yet with
 * headroom for a single legitimately-long tool call (e.g. a large Serena index scan) that emits no
 * intermediate SSE events. Raise OPENCODE_STALL_MS for very large repos if healthy runs trip it.
 */
const DEFAULT_STALL_MS = 180_000;

export function stallMs(): number {
  return Number(process.env.OPENCODE_STALL_MS) || DEFAULT_STALL_MS;
}


/*
 * Integration boundary: real connection to `opencode serve`. Not covered by unit
 * tests (like the Playwright runner). The SDK is imported lazily so tests do not
 * require the package. OPENCODE_SERVE_URL points to the `opencode` container.
 * Usage capture is driven SOLELY by `opts.onUsage` on each open() — the single, typed mechanism.
 * Callers that want the snapshots wrap this AgentDeps (via withUsageSink) to inject onUsage into
 * every open() (the runner/pipeline path via the facade). There is no factory-level usage sink (it
 * was dead in the production strategy path, which always constructs this with no argument).
 * Raw transport (genuinely raw @opencode-ai/sdk primitives — client construction,
 * session.create/prompt/abort/delete). Injected into qa-engine's createAgentDeps, which owns ALL
 * policy (circuit-breaker gating, fallback-model retry, telemetry assembly, sanitize-before-emit).
 * Raw response-shape validation (res.error, missing id) is a genuinely raw-transport concern and
 * stays HERE — qa-engine's policy layer only sees a clean RawPromptResult or a rejected promise.
 */
async function buildRawAgentTransport(): Promise<RawAgentTransport> {
  const client = await getSharedClient();

  return {
    createSession: async (cwd) => {
      const created = await client.session.create({ query: { directory: cwd } });
      if (created.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: the session returned no id");
      return { id };
    },
    promptSession: async ({ id, cwd, agent, text, model }): Promise<RawPromptResult> => {
      const res = await client.session.prompt({
        path: { id },
        query: { directory: cwd },
        body: { agent, parts: [{ type: "text", text }], ...(model ? { model } : {}) },
      });
      if (res.error) {
        throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
      }
      /*
       * A provider/agent fault (out of credits, auth, rate-limit, output-length) is embedded in the
       * assistant message (info.error), NOT in res.error — surfaced as data, classified by the
       * policy layer's agentErrorToInfra.
       */
      const info = res.data?.info as
        | { error?: RawAgentErrorPayload; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost?: number }
        | undefined;
      return {
        agentError: info?.error,
        parts: (res.data?.parts ?? []) as Array<{ type: string; text?: string }>,
        tokens: info?.tokens
          ? {
              input: info.tokens.input ?? 0,
              output: info.tokens.output ?? 0,
              reasoning: info.tokens.reasoning ?? 0,
              cacheRead: info.tokens.cache?.read ?? 0,
              cacheWrite: info.tokens.cache?.write ?? 0,
            }
          : undefined,
        cost: info?.cost,
      };
    },
    abortSession: async (id) => {
      await client.session.abort({ path: { id } });
    },
    deleteSession: async (id) => {
      await client.session.delete({ path: { id } });
    },
  };
}

export async function defaultAgentDeps(): Promise<AgentDeps> {
  /*
   * The undici transport timeout must exceed EVERY per-prompt withTimeout, or it aborts the
   * request before our own deadline fires. The reviewer, the explorer and the planner each have their
   * OWN budget (REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) independent of the
   * generator's; if an operator sets a small OPENCODE_TIMEOUT_MS (or raises a per-role one) it must NOT
   * drag the transport below any of them. Take the max + headroom.
   */
  const generatorMax = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  const dispatcherTimeoutMs = Math.max(generatorMax, REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) + 30_000;
  await installHttpDispatcher(dispatcherTimeoutMs);

  const raw = await buildRawAgentTransport();

  return createAgentDeps(raw, {
    defaultPromptTimeoutMs: dispatcherTimeoutMs,
    getFallbackModel,
    persistTurn: (t) => {
      saveAgentTurn({
        runId: t.runId,
        sessionId: t.sessionId,
        role: t.role,
        round: t.round,
        isRepair: t.isRepair,
        ts: t.ts,
        objective: t.objective ?? null,
        promptText: t.promptText,
        outputText: t.outputText,
        promptBytes: t.promptBytes,
        tokensInput: t.tokensInput,
        tokensOutput: t.tokensOutput,
        tokensReasoning: t.tokensReasoning,
        tokensCacheRead: t.tokensCacheRead,
        tokensCacheWrite: t.tokensCacheWrite,
        cost: t.cost,
      });
    },
  });
}



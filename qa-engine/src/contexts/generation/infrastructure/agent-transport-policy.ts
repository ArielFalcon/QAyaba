/* Session-transport policy: circuit-breaker gating, fallback-model retry on transient fault, turn/usage telemetry, sanitize-before-emit. Consumes injected primitives. Does not read process.env or cwd-relative config — the composition-root shell injects resolved timeouts and getFallbackModel. qa-engine never imports src/. */
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./resilience/circuit-breaker.ts";
import { createStallWatchdog, type StallWatchdog } from "./resilience/stall-watchdog.ts";
import { AgentTimeoutError, AgentUnavailableError, StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import { sanitizeText } from "./sanitize-text.ts";

/* Types declared locally — qa-engine never imports src/. */

export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** A single agent prompt/response turn captured at the transport funnel. outputText is sanitized BEFORE emitting (sanitizeText, the qa-engine twin of src/orchestrator/sanitizer.ts). runId is null when the session was opened without a descriptor. */
export interface AgentTurnEvent {
  runId: string | null;
  sessionId: string;
  role: string;
  objective: string | undefined;
  round: number;
  isRepair: boolean;
  promptText: string;
  promptBytes: number;
  outputText: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  ts: string;
  sectionSizes: Record<string, number> | null;
}

export interface AgentSession {
  id: string;
  prompt(
    text: string,
    opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null },
  ): Promise<string>;
  dispose(): Promise<void>;
  selfTimed?: boolean;
}

export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
}

export interface AgentDeps {
  open(
    agent: string,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      onTurn?: (t: AgentTurnEvent) => void;
      descriptor?: AgentOpenDescriptor;
    },
  ): Promise<AgentSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}


export interface RawAgentErrorPayload {
  name: string;
  data?: { message?: string; statusCode?: number; providerID?: string };
}

export interface RawPromptResult {
  agentError?: RawAgentErrorPayload;
  parts: Array<{ type: string; text?: string }>;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost?: number;
}

export interface RawAgentTransport {
  createSession(cwd: string): Promise<{ id: string }>;
  promptSession(args: {
    id: string;
    cwd: string;
    agent: string;
    text: string;
    model?: { providerID: string; modelID: string };
  }): Promise<RawPromptResult>;
  abortSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}


export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError(`${label}: timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function parseModelRef(ref: string): { providerID: string; modelID: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i >= ref.length - 1) return undefined;
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

function textOf(p: { type: string; text?: string }): string {
  return typeof p.text === "string" ? p.text : "";
}

function stripReasoningWrappers(s: string): string {
  return s.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
}

function extractText(parts: Array<{ type: string; text?: string }> | undefined, opts?: { textOnly?: boolean }): string {
  const all = parts ?? [];
  if (!opts?.textOnly) {
    return all.map(textOf).join("");
  }
  const textOnly = all.filter((p) => p.type === "text").map(textOf).join("");
  if (textOnly.trim() !== "") return textOnly;
  return stripReasoningWrappers(all.map(textOf).join(""));
}

export function agentErrorToInfra(error: RawAgentErrorPayload): AgentUnavailableError {
  const d = error.data ?? {};
  const detail = d.message ? `: ${d.message}` : "";
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";
  switch (error.name) {
    case "ProviderAuthError":
      return new AgentUnavailableError(
        `OpenCode provider '${d.providerID ?? "?"}' rejected the request (auth / out of credits)${detail}. ` +
          `${tail} — check OPENCODE_API_KEY and your OpenCode credit balance.`,
      );
    case "APIError": {
      const code = d.statusCode ? ` ${d.statusCode}` : "";
      const hint =
        d.statusCode === 429 ? " — rate-limited, retry later" :
        d.statusCode === 402 ? " — out of credits / billing" :
        d.statusCode === 401 || d.statusCode === 403 ? " — auth (check OPENCODE_API_KEY)" :
        "";
      return new AgentUnavailableError(`OpenCode API error${code}${detail}${hint}. ${tail}.`);
    }
    case "MessageOutputLengthError":
      return new AgentUnavailableError(`the model hit its output-length limit before finishing the turn. ${tail}.`);
    case "MessageAbortedError":
      return new AgentUnavailableError(`the agent turn was aborted${detail}. ${tail}.`);
    default:
      return new AgentUnavailableError(`OpenCode agent error (${error.name})${detail}. ${tail}.`);
  }
}


interface SessionEntry {
  id: string;
  agent: string;
  cwd: string;
  openedAt: number;
}

const sessionRegistry = new Map<string, SessionEntry>();

export function getOpenSessions(): SessionEntry[] {
  return [...sessionRegistry.values()];
}

export function getOpenSessionCount(): number {
  return sessionRegistry.size;
}


export interface AgentDepsCollaborators {

  defaultPromptTimeoutMs: number;
  /** Reads agents/opencode.json's model_fallback map for `agent`. Shell-injected (fs-read confinement — see this module's header): absent (the default) means no fallback, so a primary failure propagates unchanged. */
  getFallbackModel(agent: string): string | undefined;
  /** Best-effort turn persistence (writes to the local run history). Invoked only when the caller supplied a run context (opts.descriptor.runId) and no caller-supplied onTurn overrides it. */
  persistTurn?(t: AgentTurnEvent): void;
}

export function createAgentDeps(raw: RawAgentTransport, collab: AgentDepsCollaborators): AgentDeps {
  return {
    open: async (agent, cwd, opts) => {
      const created = await raw.createSession(cwd);
      const id = created.id;
      const entry: SessionEntry = { id, agent, cwd, openedAt: Date.now() };
      sessionRegistry.set(id, entry);

      const onAbort = () => {
        raw.abortSession(id).catch(() => {});
        raw.deleteSession(id).catch(() => {});
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const promptTimeoutMs = opts?.timeoutMs ?? collab.defaultPromptTimeoutMs;

      const abortRun = () => raw.abortSession(id).catch(() => {});

      const defaultOnTurn = opts?.descriptor?.runId
        ? (t: AgentTurnEvent) => {
            try {
              collab.persistTurn?.(t);
            } catch (err) {
              console.warn(`[qa] agent_turns persist failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        : undefined;
      const effectiveOnTurn = opts?.onTurn ?? defaultOnTurn;

      let _round = 0;

      return {
        id,
        prompt: (text, promptOpts) =>
          withTimeout(
            (() => {
              checkCircuit();
              const thisRound = _round++;
              const runPrompt = (modelOverride?: string) => {
                const overrideModel = modelOverride ? parseModelRef(modelOverride) : undefined;
                return raw
                  .promptSession({ id, cwd, agent, text, ...(overrideModel ? { model: overrideModel } : {}) })
                  .then((res) => {
                    if (res.agentError) {
                      throw agentErrorToInfra(res.agentError);
                    }
                    recordCircuitSuccess();
                    if (res.tokens) {
                      const snapshot: UsageSnapshot = {
                        input: res.tokens.input ?? 0,
                        output: res.tokens.output ?? 0,
                        reasoning: res.tokens.reasoning ?? 0,
                        cacheRead: res.tokens.cacheRead ?? 0,
                        cacheWrite: res.tokens.cacheWrite ?? 0,
                        cost: res.cost ?? 0,
                      };
                      opts?.onUsage?.(snapshot);
                    }
                    const outputRaw = extractText(res.parts, promptOpts);
                    /* Emit a per-turn event alongside onUsage. Sanitize output_text before emitting so any DEV-environment data in the agent reply is redacted at the earliest point (before storage or logging by callers). */
                    if (effectiveOnTurn) {
                      const sanitizedOutput = sanitizeText(outputRaw).text;
                      const turnEvent: AgentTurnEvent = {
                        runId: opts?.descriptor?.runId ?? null,
                        sessionId: id,
                        role: opts?.descriptor?.role ?? agent,
                        objective: opts?.descriptor?.objective,
                        round: promptOpts?.round ?? thisRound,
                        isRepair: promptOpts?.isRepair ?? false,
                        promptText: text,
                        promptBytes: Buffer.byteLength(text, "utf8"),
                        outputText: sanitizedOutput,
                        tokensInput: res.tokens?.input ?? null,
                        tokensOutput: res.tokens?.output ?? null,
                        tokensReasoning: res.tokens?.reasoning ?? null,
                        tokensCacheRead: res.tokens?.cacheRead ?? null,
                        tokensCacheWrite: res.tokens?.cacheWrite ?? null,
                        cost: res.cost ?? null,
                        ts: new Date().toISOString(),
                        sectionSizes: promptOpts?.sectionSizes ?? null,
                      };
                      effectiveOnTurn(turnEvent);
                    }
                    return outputRaw;
                  })
                  .catch((err) => {
                    recordCircuitFailure();
                    throw err;
                  });
              };
              return runPrompt(opts?.model).catch((err) => {
                if (opts?.signal?.aborted || isInfraError(err)) throw err;
                const fallback = collab.getFallbackModel(agent);
                if (fallback) {
                  console.warn(`[qa] primary model failed for ${agent}, retrying with fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
                  return runPrompt(fallback);
                }
                throw err;
              });
            })(),
            promptTimeoutMs,
            "OpenCode prompt",
          ).catch((err: unknown) => {
            abortRun();
            throw err;
          }),
        dispose: async () => {
          try {
            await raw.deleteSession(id);
          } catch (err) {
            console.warn(`[qa] session ${id} dispose failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            opts?.signal?.removeEventListener("abort", onAbort);
            sessionRegistry.delete(id);
          }
        },
      };
    },
    cleanupOrphans: async (maxAgeMs: number) => {
      const now = Date.now();
      let cleaned = 0;
      for (const [id, entry] of sessionRegistry) {
        if (now - entry.openedAt > maxAgeMs) {
          try {
            await raw.deleteSession(id);
          } catch (err) {
            console.warn(`[qa] orphan cleanup failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
          sessionRegistry.delete(id);
          cleaned++;
        }
      }
      return cleaned;
    },
  };
}


const sessionWatchdogNotifiers = new Map<string, () => void>();

/** Called by withStallWatchdog when a session opens. Not part of the public API surface. */
export function registerSessionWatchdogNotify(sessionId: string, notify: () => void): void {
  sessionWatchdogNotifiers.set(sessionId, notify);
}

/** Called by withStallWatchdog when a session is disposed or the watchdog stops. */
export function unregisterSessionWatchdogNotify(sessionId: string): void {
  sessionWatchdogNotifiers.delete(sessionId);
}

/** Notify the watchdog for a session (called from the SSE event loop on each activity). */
export function notifySessionActivity(sessionId: string): void {
  sessionWatchdogNotifiers.get(sessionId)?.();
}


export type WatchdogFactory = (onStall: () => void) => StallWatchdog;

export function withStallWatchdog(
  baseDeps: AgentDeps,
  opts: {
    stallMs: number;
    watchdogFactory?: WatchdogFactory;
  },
): AgentDeps {
  const threshold = opts.stallMs;
  const factory: WatchdogFactory = opts.watchdogFactory ?? ((onStall) => createStallWatchdog({ stallMs: threshold, onStall }));

  return {
    ...baseDeps,
    open: async (agent, cwd, openOpts) => {
      const inner = await baseDeps.open(agent, cwd, openOpts);

      if (inner.selfTimed) return inner;

      let rejectInFlight: ((err: unknown) => void) | undefined;

      const watchdog = factory(() => {
        const err = new StalledAgentError(
          `Agent session stalled: no activity for ${threshold}ms. Aborting session to free resources.`,
        );
        rejectInFlight?.(err);
        unregisterSessionWatchdogNotify(inner.id);
        inner.dispose().catch(() => {});
      });

      registerSessionWatchdogNotify(inner.id, () => watchdog.notify());

      const wrapped: typeof inner = {
        id: inner.id,
        prompt: (text, promptOpts) =>
          new Promise<string>((resolve, reject) => {
            rejectInFlight = reject;
            watchdog.notify();
            inner.prompt(text, promptOpts).then(
              (v) => {
                rejectInFlight = undefined;
                watchdog.stop();
                resolve(v);
              },
              (e) => {
                rejectInFlight = undefined;
                watchdog.stop();
                reject(e);
              },
            );
          }),
        dispose: async () => {
          watchdog.stop();
          unregisterSessionWatchdogNotify(inner.id);
          await inner.dispose();
        },
      };

      return wrapped;
    },
  };
}

export function withUsageSink(
  baseDeps: AgentDeps,
  onUsage?: (u: UsageSnapshot) => void,
  onTurn?: (t: AgentTurnEvent) => void,
): AgentDeps {
  if (!onUsage && !onTurn) return baseDeps;
  return {
    ...baseDeps,
    open: (agent, cwd, opts) =>
      baseDeps.open(agent, cwd, {
        ...opts,
        ...(onUsage ? { onUsage: opts?.onUsage ?? onUsage } : {}),
        ...(onTurn ? { onTurn: opts?.onTurn ?? onTurn } : {}),
      }),
  };
}

export function withSessionRegistration(
  baseDeps: AgentDeps,
  collaborators: {
    register: (sessionId: string, runId: string, cwd: string) => void;
    unregister: (sessionId: string) => void;
  },
): AgentDeps {
  const { register, unregister } = collaborators;

  return {
    ...baseDeps,
    open: async (agent, cwd, opts) => {
      const inner = await baseDeps.open(agent, cwd, opts);
      const runId = opts?.descriptor?.runId;
      if (runId) register(inner.id, runId, cwd);

      return {
        ...inner,
        dispose: async () => {
          if (runId) unregister(inner.id);
          await inner.dispose();
        },
      };
    },
  };
}

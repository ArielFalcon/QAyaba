/* Session-transport policy: circuit-breaker gating, fallback-model retry on transient fault, turn/usage telemetry, sanitize-before-emit. Consumes injected primitives. Does not read process.env or cwd-relative config — the composition-root shell injects resolved timeouts and getFallbackModel. qa-engine never imports src/. */
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./resilience/circuit-breaker.ts";
import { createStallWatchdog, type StallWatchdog } from "./resilience/stall-watchdog.ts";
import { AgentTimeoutError, AgentUnavailableError, StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import type { AgentPromptOpts, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import { sanitizeText } from "./sanitize-text.ts";
import { buildTurnStepBudget, type TurnCallMetrics, type TurnStepBudget } from "../domain/turn-efficiency-summary.ts";
import { finalStepText } from "../domain/step-exhaustion.ts";

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
  /** Step limit and whether the turn hit it (its `exhausted` is null while unknown). Null when the runtime has no step-budget concept (Codex) or the measurement failed. */
  stepBudget: TurnStepBudget | null;
  /** What the agent did this turn, measured from its tool calls. Null when unsupported, unobserved, or the measurement failed. */
  callMetrics: TurnCallMetrics | null;
}

export interface AgentSession {
  id: string;
  prompt(text: string, opts?: AgentPromptOpts): Promise<string>;
  dispose(): Promise<void>;
  selfTimed?: boolean;
}

export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
  /** `false` keeps the session out of SSE/stall-watchdog registration while its turns still persist under `runId` (mirrors the kernel port's AgentOpenDescriptor). */
  liveObservation?: boolean;
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

/** Masks configured secret values in provider-originated text. The shell injects it (it alone knows which values are secret); absent means the text passes through unchanged. */
export type SecretRedactor = (text: string) => string;

export function agentErrorToInfra(error: RawAgentErrorPayload, redact: SecretRedactor = (text) => text): AgentUnavailableError {
  const d = error.data ?? {};
  /* A gateway may echo the credential it rejected, so everything the provider supplied is masked before it enters a message that is logged and published. */
  const detail = d.message ? `: ${redact(d.message)}` : "";
  const providerID = d.providerID ? redact(d.providerID) : undefined;
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";
  switch (error.name) {
    case "ProviderAuthError":
      return new AgentUnavailableError(
        `OpenCode provider '${providerID ?? "?"}' rejected the request (auth / out of credits)${detail}. ` +
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
  /**
   * Flushes the call-efficiency tracker for the session whose prompt just resolved and returns that turn's metrics
   * (null when the session was not observed). Shell-injected: this module cannot import the SSE tracker (event-stream.ts already imports this one).
   */
  takeTurnCalls?(sessionId: string, promptText: string, providedPaths?: readonly string[]): TurnCallMetrics | null;
  /**
   * Opens attempt `attempt` (0 for the primary model, 1 for the fallback retry) of a prompt on the session, before it is sent:
   * the tracker decides there whether that attempt's steps can be observed completely, waiting a bounded time for its event stream
   * if need be. A failure is logged and leaves the attempt unobserved. Shell-injected like takeTurnCalls.
   */
  prepareAttempt?(sessionId: string, attempt: number): Promise<void> | void;
  /** The agent's configured step limit (agents/opencode.json `agent.<id>.maxSteps`), or undefined when it has none. Shell-injected like getFallbackModel. */
  maxStepsFor?(agent: string): number | undefined;
  /** Masks the exact values of configured secrets (an LLM gateway key has no recognizable shape, so the shape-based sanitizer cannot find it). Applied to provider-fault messages and to the emitted turn's output. Shell-injected; absent means no masking beyond sanitizeText. */
  redact?: SecretRedactor;
}

/* Measurement is best-effort and must never disturb the prompt path: a fault is logged loudly and yields null. */
function measureOrNull<T>(label: string, measure: () => T): T | null {
  try {
    return measure();
  } catch (err) {
    console.error(`[qa] turn efficiency: ${label} failed, recording null: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/*
 * Circuit breaking runs at two levels, with the same threshold and cooldown:
 * - Provider level (TRANSPORT_BREAKER_KEY): fed by every raw transport rejection — session
 *   creation or prompt — whatever role hit it, and reset only by a prompt the transport answers
 *   (creating a session proves reachability, not that the server can do work). It gates session
 *   creation and every role's prompts, so an unhealthy agent server fails fast after one threshold
 *   of failures instead of one threshold per role.
 * - Role level (descriptor.role ?? agent): fed by that role's prompt outcomes, including model or
 *   agent faults embedded in an answered response (which never count against the provider), and
 *   gates only that role's prompts — a run-away role never blocks a healthy one.
 * The provider key is a sentinel no agent role uses.
 */
const TRANSPORT_BREAKER_KEY = "<agent-transport>";

/* A prompt runs on the primary model first (attempt 0) and, when that faults transiently, once more on the fallback model (attempt 1). */
const PRIMARY_ATTEMPT = 0;
const FALLBACK_ATTEMPT = 1;

async function countingTransportFailure<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    recordCircuitFailure(TRANSPORT_BREAKER_KEY);
    throw err;
  }
}

export function createAgentDeps(raw: RawAgentTransport, collab: AgentDepsCollaborators): AgentDeps {
  return {
    open: async (agent, cwd, opts) => {
      checkCircuit(TRANSPORT_BREAKER_KEY);
      const created = await countingTransportFailure(() => raw.createSession(cwd));
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

      /* Role-level breaker key: the same role identity AgentTurnEvent.role already uses (the
         descriptor's role when given, else the raw agent id). */
      const breakerRole = opts?.descriptor?.role ?? agent;

      let _round = 0;

      /* Opens an attempt on the tracker; false when that failed, so the attempt's steps are known to be unobserved. */
      const prepareAttempt = (sessionId: string, attempt: number): Promise<boolean> => {
        if (!collab.prepareAttempt) return Promise.resolve(true);
        return Promise.resolve()
          .then(() => collab.prepareAttempt!(sessionId, attempt))
          .then(
            () => true,
            (err: unknown) => {
              console.error(`[qa] turn efficiency: preparing attempt ${attempt} failed, its steps are unobserved: ${err instanceof Error ? err.message : String(err)}`);
              return false;
            },
          );
      };

      return {
        id,
        prompt: (text, promptOpts) =>
          withTimeout(
            (() => {
              checkCircuit(TRANSPORT_BREAKER_KEY);
              checkCircuit(breakerRole);
              const thisRound = _round++;
              const runPrompt = (attempt: number, modelOverride?: string) => {
                const overrideModel = modelOverride ? parseModelRef(modelOverride) : undefined;
                return prepareAttempt(id, attempt)
                  .then((observed) =>
                    countingTransportFailure(() =>
                      raw.promptSession({ id, cwd, agent, text, ...(overrideModel ? { model: overrideModel } : {}) }),
                    ).then((res) => ({ res, observed })),
                  )
                  .then(({ res, observed }) => {
                    recordCircuitSuccess(TRANSPORT_BREAKER_KEY);
                    if (res.agentError) {
                      throw agentErrorToInfra(res.agentError, collab.redact);
                    }
                    recordCircuitSuccess(breakerRole);
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
                    const finalText = finalStepText(res.parts);
                    /* The tracker is flushed once per resolved prompt, whether or not a turn sink is listening, and the exhaustion state is decided once from that flush and the final step's text: every consumer (the persisted turn and the caller's stats) reads these same values. An attempt that could not be prepared was not observed completely, whatever the tracker says. */
                    const flushed = collab.takeTurnCalls
                      ? measureOrNull("call metrics", () => collab.takeTurnCalls!(id, text, promptOpts?.providedPaths))
                      : null;
                    const callMetrics = flushed && !observed ? { ...flushed, stepsUsed: null, observationComplete: false } : flushed;
                    const stepBudget = collab.maxStepsFor
                      ? measureOrNull("step budget", () =>
                          buildTurnStepBudget({
                            maxSteps: collab.maxStepsFor!(agent) ?? null,
                            stepsUsed: callMetrics?.stepsUsed ?? null,
                            finalStepText: finalText,
                          }),
                        )
                      : null;
                    /* Emit a per-turn event alongside onUsage. Sanitize output_text before emitting so any DEV-environment data in the agent reply is redacted at the earliest point (before storage or logging by callers). */
                    if (effectiveOnTurn) {
                      const sanitizedOutput = sanitizeText(collab.redact ? collab.redact(outputRaw) : outputRaw).text;
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
                        stepBudget,
                        callMetrics,
                      };
                      effectiveOnTurn(turnEvent);
                    }
                    if (stepBudget && promptOpts?.onTurnStats) {
                      const stats: AgentTurnStats = {
                        maxSteps: stepBudget.maxSteps,
                        stepsUsed: callMetrics?.stepsUsed ?? null,
                        exhausted: stepBudget.exhausted,
                        writeCount: callMetrics?.writeCount ?? null,
                        observationComplete: callMetrics?.observationComplete ?? false,
                      };
                      try {
                        promptOpts.onTurnStats(stats);
                      } catch (err) {
                        console.error(`[qa] turn stats callback failed: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }
                    return promptOpts?.finalStepOnly ? finalText : outputRaw;
                  })
                  .catch((err) => {
                    recordCircuitFailure(breakerRole);
                    throw err;
                  });
              };
              return runPrompt(PRIMARY_ATTEMPT, opts?.model).catch((err) => {
                if (opts?.signal?.aborted || isInfraError(err)) throw err;
                const fallback = collab.getFallbackModel(agent);
                if (fallback) {
                  console.warn(`[qa] primary model failed for ${agent}, retrying with fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
                  return runPrompt(FALLBACK_ATTEMPT, fallback);
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
      /* A run context registers the session for live observation (SSE + stall watchdog) unless the
         descriptor opts out: the explorer's turns persist under its runId, but registering it would
         start feeding the stall watchdog and change its liveness window. */
      const runId = opts?.descriptor?.liveObservation === false ? undefined : opts?.descriptor?.runId;
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

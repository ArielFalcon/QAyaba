/* Session-transport policy: circuit-breaker gating, fallback-model retry on transient fault, turn/usage telemetry, sanitize-before-emit. Consumes injected primitives. Does not read process.env or cwd-relative config — the composition-root shell injects resolved timeouts and getFallbackModel. qa-engine never imports src/. */
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./resilience/circuit-breaker.ts";
import { createStallWatchdog, type StallWatchdog } from "./resilience/stall-watchdog.ts";
import { AgentTimeoutError, AgentUnavailableError, StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import type { AgentPromptOpts, AgentTurnStats } from "@kernel/ports/agent-runtime.port.ts";
import { sanitizeText } from "../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { redactByValue } from "../../../shared-infrastructure/redaction/run-secret-redaction.ts";
import { sha256Hex } from "../../../shared-kernel/content-hash.ts";
import { carryAgentErrorType, classifyAgentFault, classifyProviderError, type AgentErrorType } from "../domain/agent-error-class.ts";
import type { TimeLimitSource, TurnLimit } from "@kernel/turn-limit.ts";
import { buildTurnStepBudget, type TurnCallMetrics, type TurnStepBudget } from "../domain/turn-efficiency-summary.ts";
import { finalStepText } from "../domain/step-exhaustion.ts";
import type { TurnEnd } from "@kernel/turn-end.ts";

/* Types declared locally — qa-engine never imports src/. */

export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** What an attempt spent, as its runtime reports it. The cost is absent when the runtime reports none: it is never made up. */
export type AttemptUsage = Omit<UsageSnapshot, "cost"> & { cost?: number };

/** A single agent prompt/response turn captured at the transport funnel. outputText is sanitized BEFORE emitting (sanitizeText from shared-infrastructure/redaction). runId is null when the session was opened without a descriptor. */
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
  /** Step limit and whether the turn hit it (its `exhausted` is null while unknown). Null when the runtime has no step-budget concept or the measurement failed. */
  stepBudget: TurnStepBudget | null;
  /** What the agent did this turn, measured from its tool calls. Null when unsupported, unobserved, or the measurement failed. */
  callMetrics: TurnCallMetrics | null;
  /** How the turn ended; absent when the transport does not say. A turn that did not answer carries empty output, no usage and the calls measured up to its end. */
  ended?: TurnEnd;
  /** Wall time from when the prompt was sent to when the turn ended (answered, timed out or aborted); null when the runtime did not measure it. */
  durationMs: number | null;
  /*
   * What the turn did, for its trace and its record; each is absent or null where the runtime cannot say. The model
   * asked for is the one the prompt named (null: the agent's configured model); the one that answered is what the runtime
   * reported back.
   */
  modelRequested?: string | null;
  modelAnswered?: string | null;
  provider?: string | null;
  /** The attempt that ended the turn: 1 the primary model, 2 the fallback. */
  attempt?: number | null;
  fallbackUsed?: boolean;
  /** The class of the last failure an attempt of the turn met (the primary's, when the fallback answered); null when none. */
  errorType?: AgentErrorType | null;
  /** sha256 of each section of the prompt as the assembler built it, by section id, and of the bytes actually sent. */
  sectionHashes?: Record<string, string> | null;
  promptHash?: string | null;
  /** The time limit that bound the prompt, and the limit that ended the turn (null when none did). */
  limitApplied?: TimeLimitSource | null;
  limitFired?: TurnLimit | null;
}

/** What the runtime reported of the assistant message that answered a prompt. */
export interface AttemptAnswer {
  modelId?: string;
  providerId?: string;
  finish?: string;
  /** Epoch milliseconds the runtime stamped on the message. */
  createdAt?: number;
  completedAt?: number;
}

/**
 * What the transport tells a trace about a prompt, in order: each attempt starts and ends, a fallback is chosen between two
 * attempts, and the turn is recorded last; `prompt` numbers the session's prompts so a late event is told apart from the current
 * prompt's. Told to `AgentDepsCollaborators.onAttempt`, which can neither fail the prompt nor
 * slow it.
 */
export type AttemptEvent = { prompt: number } & (
  | { kind: "start"; attempt: number; requestedModel: string | undefined; at: number; limitApplied: { source: TimeLimitSource; ms: number } }
  | { kind: "end"; attempt: number; at: number; answered?: AttemptAnswer; usage?: AttemptUsage; errorType?: AgentErrorType; error?: unknown; abandoned?: boolean }
  | { kind: "fallback"; model: string; at: number }
  | { kind: "turn"; turn: AgentTurnEvent; at: number }
);

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
  /** The flow of a plan the session is opened for, and the tools its run denied it (mirrors the kernel port's AgentOpenDescriptor). */
  delegationId?: string;
  denyTools?: readonly string[];
}

export interface AgentDeps {
  open(
    agent: string,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      /** Which limit `timeoutMs` is; only a name for the trace. */
      timeLimit?: TimeLimitSource;
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
  /** Which model and provider answered, and how the runtime says it finished. */
  answered?: AttemptAnswer;
}

export interface RawAgentTransport {
  createSession(cwd: string): Promise<{ id: string }>;
  promptSession(args: {
    id: string;
    cwd: string;
    agent: string;
    text: string;
    model?: { providerID: string; modelID: string };
    /** The prompt may use no tool at all: the transport states that to the runtime in whatever form it takes. */
    withoutTools?: boolean;
    /** The prompt may not write or edit a file: the transport states that to the runtime in whatever form it takes. */
    withoutWrites?: boolean;
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
  /** The step limit the orchestrator's own copy of agents/opencode.json declares for the agent (`steps ?? maxSteps`), or undefined when it declares none. It only classifies the exhaustion of a prompt that stated no number (a stated one wins) and is never a source for a prompt. Shell-injected like getFallbackModel. */
  maxStepsFor?(agent: string): number | undefined;
  /** The wall clock a turn's duration is measured by, in epoch milliseconds. Defaults to `Date.now`; injected by tests. */
  now?(): number;
  /** Told what happens to each prompt of the session, in order, for its trace (see `AttemptEvent`). A fault in it is logged and never reaches the prompt. */
  onAttempt?(sessionId: string, event: AttemptEvent): void;
  /** The limit a layer above this one fired on the session's turn in flight (the stall watchdog), when one did. It names the cause when this layer's own timeout closes the turn afterwards. */
  outerLimit?(sessionId: string, prompt: number): TurnLimit | undefined;
}

/* Classification is for the trace: whatever it does, it never changes the error a prompt fails with and never comes before the breaker's count. */
function safeClassify(classify: () => AgentErrorType): AgentErrorType {
  let type: AgentErrorType;
  try {
    type = classify();
  } catch {
    type = "unknown";
  }
  return type;
}

type EndInfo = Omit<Extract<AttemptEvent, { kind: "end" }>, "kind" | "attempt" | "at" | "prompt">;

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

      /* The session's limit, else the transport's default: what a prompt that states no limit of its own is held to. */
      const sessionTimeoutMs = opts?.timeoutMs ?? collab.defaultPromptTimeoutMs;

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

      /* Tells the trace what happens; a fault in it never reaches the prompt. */
      const notify = (event: AttemptEvent): void => {
        if (!collab.onAttempt) return;
        try {
          collab.onAttempt(id, event);
        } catch (err) {
          console.error(`[qa] attempt telemetry failed and was dropped: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      return {
        id,
        prompt: (unredacted, promptOpts) => {
          /* The last seam before the model: the run's own secrets are taken out by value from whatever text got here, and the turn recorded below holds the text that was sent. */
          const text = redactByValue(unredacted);
          checkCircuit(TRANSPORT_BREAKER_KEY);
          checkCircuit(breakerRole);
          const thisRound = _round++;
          const clock = collab.now ?? Date.now;
          const startedAt = clock();
          /* Set once the prompt has ended without an answer (timeout, abort): the turn is recorded then, so an answer that arrives later must record nothing more and must not start a fallback. */
          let closed = false;
          /* Whether the attempt in flight could be observed completely; unobserved until its preparation says otherwise. */
          let observed = false;
          /* What the trace is told: the limit that binds the prompt (the prompt's own, else the session's, else the host's), the attempt in flight, the model that answered and the last failure an attempt met. */
          const limitApplied: { source: TimeLimitSource; ms: number } =
            promptOpts?.timeoutMs !== undefined
              ? { source: promptOpts.timeLimit ?? "prompt-budget", ms: promptOpts.timeoutMs }
              : opts?.timeoutMs !== undefined
                ? { source: opts.timeLimit ?? "session-timeout", ms: opts.timeoutMs }
                : { source: "host-cap", ms: collab.defaultPromptTimeoutMs };
          let liveAttempt: { number: number; requested: string | undefined; end(info: EndInfo): void } | undefined;
          let answeredBy: AttemptAnswer | undefined;
          let lastErrorType: AgentErrorType | undefined;

          /* The tracker is flushed once per prompt, whether or not a turn sink is listening, and every consumer of the turn (the persisted row, the caller's stats) reads that flush. An attempt that could not be prepared was not observed completely, whatever the tracker says. */
          const flushCalls = (): TurnCallMetrics | null => {
            const flushed = collab.takeTurnCalls
              ? measureOrNull("call metrics", () => collab.takeTurnCalls!(id, text, promptOpts?.providedPaths))
              : null;
            return flushed && !observed ? { ...flushed, stepsUsed: null, observationComplete: false } : flushed;
          };
          /* A prompt that states its limit is judged by the number it stated; one that states none, by the agent's configured limit when there is a way to read one. */
          const budgetOf = (callMetrics: TurnCallMetrics | null, finalText: string): TurnStepBudget | null =>
            promptOpts?.stepLimit !== undefined || collab.maxStepsFor
              ? measureOrNull("step budget", () =>
                  buildTurnStepBudget({
                    maxSteps: promptOpts?.stepLimit ?? collab.maxStepsFor?.(agent) ?? null,
                    stepsUsed: callMetrics?.stepsUsed ?? null,
                    finalStepText: finalText,
                  }),
                )
              : null;
          /* Emit a per-turn event alongside onUsage. Sanitize output_text before emitting so any DEV-environment data in the agent reply is redacted at the earliest point (before storage or logging by callers). */
          const emitTurn = (turn: {
            outputRaw: string;
            tokens?: RawPromptResult["tokens"];
            cost?: number;
            stepBudget: TurnStepBudget | null;
            callMetrics: TurnCallMetrics | null;
            ended: TurnEnd;
          }): void => {
            if (!effectiveOnTurn && !collab.onAttempt) return;
            const limitFired: TurnLimit | null =
              collab.outerLimit?.(id, thisRound) ?? (turn.ended === "timeout" ? limitApplied.source : turn.ended === "aborted" ? "cancel" : turn.ended === "exhausted" ? "step-cap" : null);
            const turnEvent: AgentTurnEvent = {
              runId: opts?.descriptor?.runId ?? null,
              sessionId: id,
              role: opts?.descriptor?.role ?? agent,
              objective: opts?.descriptor?.objective,
              round: promptOpts?.round ?? thisRound,
              isRepair: promptOpts?.isRepair ?? false,
              promptText: text,
              promptBytes: Buffer.byteLength(text, "utf8"),
              outputText: sanitizeText(turn.outputRaw).text,
              tokensInput: turn.tokens?.input ?? null,
              tokensOutput: turn.tokens?.output ?? null,
              tokensReasoning: turn.tokens?.reasoning ?? null,
              tokensCacheRead: turn.tokens?.cacheRead ?? null,
              tokensCacheWrite: turn.tokens?.cacheWrite ?? null,
              cost: turn.cost ?? null,
              ts: new Date().toISOString(),
              sectionSizes: promptOpts?.sectionSizes ?? null,
              stepBudget: turn.stepBudget,
              callMetrics: turn.callMetrics,
              ended: turn.ended,
              durationMs: Math.max(0, clock() - startedAt),
              modelRequested: liveAttempt?.requested ?? null,
              modelAnswered: answeredBy?.modelId ?? null,
              provider: answeredBy?.providerId ?? null,
              attempt: liveAttempt?.number ?? null,
              fallbackUsed: liveAttempt?.number === FALLBACK_ATTEMPT + 1,
              errorType: lastErrorType ?? (turn.ended === "timeout" ? "timeout" : turn.ended === "aborted" ? "aborted" : null),
              sectionHashes: promptOpts?.sectionHashes ?? null,
              promptHash: sha256Hex(text),
              limitApplied: limitApplied.source,
              limitFired,
            };
            effectiveOnTurn?.(turnEvent);
            notify({ kind: "turn", prompt: thisRound, turn: turnEvent, at: clock() });
          };
          /* A prompt that ended without an answer still leaves its turn: the calls it made before it ended are the evidence of how it spent its time. */
          const recordUnansweredTurn = (ended: "timeout" | "aborted", errorType?: AgentErrorType): void => {
            closed = true;
            /* The attempt may never settle (the transport can hang): it ends with the turn, and is told apart as abandoned. */
            liveAttempt?.end({ abandoned: true, errorType: errorType ?? (ended === "timeout" ? "timeout" : "aborted") });
            const callMetrics = flushCalls();
            emitTurn({ outputRaw: "", stepBudget: budgetOf(callMetrics, ""), callMetrics, ended });
          };

          const runPrompt = (attempt: number, modelOverride?: string) => {
            const overrideModel = modelOverride ? parseModelRef(modelOverride) : undefined;
            let attemptEnded = false;
            const endAttempt = (info: EndInfo): void => {
              if (attemptEnded) return;
              attemptEnded = true;
              if (info.errorType) lastErrorType = info.errorType;
              notify({ kind: "end", prompt: thisRound, attempt: attempt + 1, at: clock(), ...info });
            };
            liveAttempt = { number: attempt + 1, requested: modelOverride, end: endAttempt };
            notify({ kind: "start", prompt: thisRound, attempt: attempt + 1, requestedModel: modelOverride, at: clock(), limitApplied });
            return prepareAttempt(id, attempt)
              .then((prepared) => {
                observed = prepared;
                return countingTransportFailure(() =>
                  raw.promptSession({ id, cwd, agent, text, ...(overrideModel ? { model: overrideModel } : {}), ...(promptOpts?.withoutTools ? { withoutTools: true } : {}), ...(promptOpts?.withoutWrites ? { withoutWrites: true } : {}) }),
                );
              })
              .then((res) => {
                recordCircuitSuccess(TRANSPORT_BREAKER_KEY);
                answeredBy = res.answered;
                const snapshot: UsageSnapshot | undefined = res.tokens
                  ? {
                      input: res.tokens.input ?? 0,
                      output: res.tokens.output ?? 0,
                      reasoning: res.tokens.reasoning ?? 0,
                      cacheRead: res.tokens.cacheRead ?? 0,
                      cacheWrite: res.tokens.cacheWrite ?? 0,
                      cost: res.cost ?? 0,
                    }
                  : undefined;
                const providerFault = res.agentError ? safeClassify(() => classifyProviderError(res.agentError!)) : undefined;
                endAttempt({
                  ...(res.answered ? { answered: res.answered } : {}),
                  ...(snapshot ? { usage: snapshot } : {}),
                  ...(providerFault ? { errorType: providerFault } : {}),
                });
                if (res.agentError) {
                  throw carryAgentErrorType(agentErrorToInfra(res.agentError), providerFault);
                }
                recordCircuitSuccess(breakerRole);
                if (snapshot) opts?.onUsage?.(snapshot);
                const outputRaw = extractText(res.parts, promptOpts);
                /* The turn was recorded when the prompt ended without this answer; the usage above is all an answer that comes late adds. */
                if (closed) return outputRaw;
                const finalText = finalStepText(res.parts);
                /* The exhaustion state is decided once from the flush and the final step's text: every consumer (the persisted turn and the caller's stats) reads these same values. */
                const callMetrics = flushCalls();
                const stepBudget = budgetOf(callMetrics, finalText);
                emitTurn({ outputRaw, tokens: res.tokens, cost: res.cost, stepBudget, callMetrics, ended: stepBudget?.exhausted === true ? "exhausted" : "completed" });
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
                endAttempt({ error: err, errorType: opts?.signal?.aborted ? "aborted" : safeClassify(() => classifyAgentFault(err)) });
                throw err;
              });
          };
          const attempts = runPrompt(PRIMARY_ATTEMPT, opts?.model).catch((err) => {
            if (closed || opts?.signal?.aborted || isInfraError(err)) throw err;
            const fallback = collab.getFallbackModel(agent);
            if (fallback) {
              console.warn(`[qa] primary model failed for ${agent}, retrying with fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
              notify({ kind: "fallback", prompt: thisRound, model: fallback, at: clock() });
              return runPrompt(FALLBACK_ATTEMPT, fallback);
            }
            throw err;
          });
          /* A fault the runtime only retries until its own reset (a spent quota) ends the prompt now: waiting would only burn the turn's deadline. */
          const providerFault = new Promise<never>((_, reject) => {
            sessionRetryListeners.set(id, (message) => {
              const type = terminalRetryFault(message);
              if (!type || closed) return;
              recordUnansweredTurn("aborted", type);
              reject(carryAgentErrorType(new AgentUnavailableError(`OpenCode provider fault the runtime was retrying: ${message}. INCONCLUSIVE (infrastructure), not a test failure.`), type));
            });
          });
          return withTimeout(Promise.race([attempts, providerFault]), promptOpts?.timeoutMs ?? sessionTimeoutMs, "OpenCode prompt")
            .catch((err: unknown) => {
              abortRun();
              /* An error the prompt itself raised was thrown before any turn was emitted; only a prompt that was cut short from outside (the deadline, the caller's abort) has a turn still to record. */
              if (!closed && err instanceof AgentTimeoutError) recordUnansweredTurn("timeout");
              else if (!closed && opts?.signal?.aborted) recordUnansweredTurn("aborted");
              throw err;
            })
            .finally(() => sessionRetryListeners.delete(id));
        },
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


const sessionRetryListeners = new Map<string, (message: string) => void>();

/* Only a fault no retry within the run can cure is terminal; a rate limit is left to the runtime's own backoff. */
function terminalRetryFault(message: string): AgentErrorType | undefined {
  const type = safeClassify(() => classifyProviderError({ name: "APIError", data: { message } }));
  return type === "quota_exceeded" ? type : undefined;
}

/** Called from the SSE event loop when the runtime reports it is retrying a session's turn (`session.status` of type `retry`). A no-op for a session with no prompt in flight. */
export function notifySessionRetry(sessionId: string, message: string): void {
  sessionRetryListeners.get(sessionId)?.(message);
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
    /** Told, before the turn in flight is rejected, that the watchdog fired on this session: the limit is recorded where it fires. A fault in it is logged and never reaches the watchdog. */
    onStall?: (sessionId: string, stallMs: number) => void;
  },
): AgentDeps {
  const threshold = opts.stallMs;
  const factory: WatchdogFactory = opts.watchdogFactory ?? ((onStall) => createStallWatchdog({ stallMs: threshold, onStall }));

  return {
    ...baseDeps,
    open: async (agent, cwd, openOpts) => {
      const inner = await baseDeps.open(agent, cwd, openOpts);

      /* A liveness watchdog is armed only for a session whose activity it can observe: a self-timed one
         keeps its own clock, and one opened without live observation is never fed by the event stream, so
         an armed timer would trip on silence nobody can see. It stays bounded by its own turn timeout. */
      if (inner.selfTimed || openOpts?.descriptor?.liveObservation === false) return inner;

      let rejectInFlight: ((err: unknown) => void) | undefined;

      const watchdog = factory(() => {
        const err = new StalledAgentError(
          `Agent session stalled: no activity for ${threshold}ms. Aborting session to free resources.`,
        );
        try {
          opts.onStall?.(inner.id, threshold);
        } catch (fault) {
          console.error(`[qa] stall telemetry failed and was dropped: ${fault instanceof Error ? fault.message : String(fault)}`);
        }
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
    /* Told which agent opened which session for which run, whatever its live-observation choice: the run_spec loop gives its right to the generator's sessions through this. Absent: nothing is told. */
    bind?: (session: { sessionId: string; runId: string; agent: string; delegationId?: string; denyTools?: readonly string[] }) => void;
    unbind?: (sessionId: string) => void;
  },
): AgentDeps {
  const { register, unregister, bind, unbind } = collaborators;

  return {
    ...baseDeps,
    open: async (agent, cwd, opts) => {
      const inner = await baseDeps.open(agent, cwd, opts);
      /* A run context registers the session for live observation (SSE + stall watchdog) unless the
         descriptor opts out: such a session's turns persist under its runId, but registering it would
         start feeding the stall watchdog and change its liveness window. */
      const runId = opts?.descriptor?.liveObservation === false ? undefined : opts?.descriptor?.runId;
      if (runId) register(inner.id, runId, cwd);
      const boundRunId = opts?.descriptor?.runId;
      if (boundRunId) {
        const { delegationId, denyTools } = opts?.descriptor ?? {};
        bind?.({ sessionId: inner.id, runId: boundRunId, agent, ...(delegationId !== undefined ? { delegationId } : {}), ...(denyTools?.length ? { denyTools } : {}) });
      }

      return {
        ...inner,
        dispose: async () => {
          if (runId) unregister(inner.id);
          if (boundRunId) unbind?.(inner.id);
          await inner.dispose();
        },
      };
    },
  };
}

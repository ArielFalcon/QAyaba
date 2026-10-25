/*
 * What kind of failure an agent turn or attempt ended in, as a closed set for a trace and for metrics. Pure: it reads the shape of
 * the fault (the provider error payload the runtime embeds in an answer, an HTTP status, a socket code, one of our own error
 * classes), never the model or the provider by name. Quota is told from rate limiting by the status 402 and by provider-neutral
 * words in the message ("quota", "usage limit", "insufficient", "credit", "billing"), because providers answer both with a 429.
 */
import { AgentTimeoutError, StalledAgentError } from "@kernel/domain-error.ts";

export const AGENT_ERROR_TYPES = [
  "quota_exceeded",
  "rate_limited",
  "auth",
  "socket_closed",
  "provider_5xx",
  "output_length",
  "aborted",
  "timeout",
  "circuit_open",
  "unknown",
] as const;

export type AgentErrorType = (typeof AGENT_ERROR_TYPES)[number];

const isAgentErrorType = (value: unknown): value is AgentErrorType => typeof value === "string" && (AGENT_ERROR_TYPES as readonly string[]).includes(value);

/*
 * The class a transport decided for a fault it is about to throw, kept beside the error and not on it: a thrown error stays exactly
 * what it was (no new own property, enumerable or not), and whoever classifies it later reads the class here.
 */
const carried = new WeakMap<object, AgentErrorType>();

/* Returns `err` itself. Nothing is recorded for a value that is not an object, or for no class. */
export function carryAgentErrorType<T>(err: T, type: AgentErrorType | undefined): T {
  if (type !== undefined && typeof err === "object" && err !== null) carried.set(err, type);
  return err;
}

export function carriedAgentErrorType(err: unknown): AgentErrorType | undefined {
  return typeof err === "object" && err !== null ? carried.get(err) : undefined;
}

/* The provider error payload the runtime embeds in an assistant message (the same shape the transport policy turns into an infra error). */
export interface ProviderErrorPayload {
  name: string;
  data?: { message?: string; statusCode?: number };
}

const QUOTA_WORDS = /quota|usage limit|insufficient|credit|billing|exceeded your current|payment required/i;
const SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_ABORTED"]);
const SOCKET_WORDS = /other side closed|socket hang up|socket closed|connection (was )?(closed|reset)|terminated/i;
const CIRCUIT_WORDS = /circuit breaker is open/i;

function byStatus(status: number | undefined, message: string | undefined): AgentErrorType | undefined {
  if (status === undefined) return undefined;
  if (status === 402) return "quota_exceeded";
  if (status === 429) return message !== undefined && QUOTA_WORDS.test(message) ? "quota_exceeded" : "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status <= 599) return "provider_5xx";
  return undefined;
}

export function classifyProviderError(payload: ProviderErrorPayload): AgentErrorType {
  const message = payload.data?.message;
  switch (payload.name) {
    case "ProviderAuthError":
      return "auth";
    case "MessageOutputLengthError":
      return "output_length";
    case "MessageAbortedError":
      return "aborted";
    default:
      return byStatus(payload.data?.statusCode, message) ?? (message !== undefined && QUOTA_WORDS.test(message) ? "quota_exceeded" : "unknown");
  }
}

function numericField(source: object, key: string): number | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function causeOf(err: object): unknown {
  return (err as { cause?: unknown }).cause;
}

/* How many causes deep a fault is followed: a chain longer than this, or one that loops, is not classified by what is at its end. */
export const MAX_CAUSE_DEPTH = 5;

/* A fault thrown on the way to, or by, the runtime. A fault that already carries its classification (a provider payload turned into an infra error) keeps it. A cause chain is followed to a bounded depth and never through a fault it has already visited. */
export function classifyAgentFault(err: unknown): AgentErrorType {
  return classifyFault(err, new Set(), 0);
}

function classifyFault(err: unknown, visited: Set<object>, depth: number): AgentErrorType {
  if (typeof err !== "object" || err === null) return "unknown";
  if (visited.has(err) || depth > MAX_CAUSE_DEPTH) return "unknown";
  visited.add(err);
  const kept = carriedAgentErrorType(err);
  if (kept !== undefined) return kept;
  const declared = (err as { agentErrorType?: unknown }).agentErrorType;
  if (isAgentErrorType(declared)) return declared;
  if (err instanceof AgentTimeoutError || err instanceof StalledAgentError) return "timeout";
  const named = err as { name?: unknown; code?: unknown; message?: unknown };
  if (named.name === "AgentTimeoutError" || named.name === "StalledAgentError") return "timeout";
  if (named.name === "CircuitOpenError" || (typeof named.message === "string" && CIRCUIT_WORDS.test(named.message))) return "circuit_open";
  if (named.name === "AbortError") return "aborted";
  const message = typeof named.message === "string" ? named.message : undefined;
  const code = typeof named.code === "string" ? named.code : undefined;
  if ((code !== undefined && SOCKET_CODES.has(code)) || (message !== undefined && SOCKET_WORDS.test(message))) return "socket_closed";
  const status = numericField(err, "status") ?? numericField(err, "statusCode");
  const fromStatus = byStatus(status, message);
  if (fromStatus !== undefined) return fromStatus;
  const cause = causeOf(err);
  return cause !== undefined ? classifyFault(cause, visited, depth + 1) : "unknown";
}

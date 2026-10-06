import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultAgentDeps,
  disposeSharedClient,
  startActivitySink,
  type LiveActivity,
  type AgentDeps,
  type AgentOpenDescriptor,
  type AgentTurnEvent,
} from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";
import type { UsageSnapshot } from "../qa/usage";
import {
  AGENT_NAME_FOR_ROLE,
  type AgentModelInfo,
  type AgentProviderHealth,
  type AgentRole,
  type AgentRuntimeSession,
  type AgentRuntimeStrategy,
} from "./types";

/* The HTTP call the strategy makes to the agent supervisor, injectable so its answers can be scripted. */
export type SupervisorFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface OpenCodeRuntimeStrategyOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: SupervisorFetch;
  depsFactory?: () => Promise<AgentDeps>;
  startEvents?: (
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    opts?: { onRunEvent?: (runId: string, body: RunEventBody) => void },
  ) => Promise<void>;
  dispose?: () => void;
  configPath?: string;
  /* The deadline of one supervisor health call, as an abort signal; injectable so no test waits on a clock. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

const SUPERVISOR_HEALTH_TIMEOUT_MS = 1500;
const RUNTIME_STATUSES: ReadonlySet<string> = new Set(["stopped", "starting", "healthy", "degraded", "failed", "needs_config"]);

/*
 * Why a supervisor that holds a key still reads as unconfigured: this process masks the key in logs
 * and error output, and guards the onboarding proposer, from its OWN environment.
 */
export const KEY_LOST_HERE =
  "The agent service holds an LLM gateway key that this process does not have (the orchestrator restarted): paste the key again. This process needs it to mask the key in logs and error output.";

/*
 * Why a supervisor and an orchestrator that both hold a key still read as unconfigured: they hold
 * different ones (an orchestrator-only restart re-reads the stack's environment file, which can carry
 * an older key), so the key this process masks is not the one the agent runs with.
 */
export const KEY_MISMATCH_HERE =
  "The agent service and this process hold different LLM gateway keys (the orchestrator restarted with an older one): paste the key again. This process needs the key in use to mask it in logs and error output.";

/*
 * A short, non-reversible mark of a key: the first 12 hex characters of its SHA-256. The agent
 * supervisor reports the same mark for the key it holds (agents/agent-supervisor.mjs keyFingerprint),
 * so the two processes are compared without either one sending the key.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/* Used only when opencode.json is missing; keep aligned with agents/opencode.json. */
const FALLBACK_MODELS: AgentModelInfo[] = [
  { id: "opencode-go/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "opencode-go/muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
  { id: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code" },
];

export class OpenCodeRuntimeStrategy implements AgentRuntimeStrategy {
  readonly provider = "opencode" as const;
  private depsPromise: Promise<AgentDeps> | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly depsFactory: () => Promise<AgentDeps>;
  private readonly startEvents: NonNullable<OpenCodeRuntimeStrategyOptions["startEvents"]>;
  private readonly disposeClient: () => void;
  private readonly configPath: string;
  private readonly fetchImpl: SupervisorFetch;
  private readonly timeoutSignal: (ms: number) => AbortSignal;

  constructor(opts: OpenCodeRuntimeStrategyOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as SupervisorFetch);
    this.timeoutSignal = opts.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.depsFactory = opts.depsFactory ?? defaultAgentDeps;
    this.startEvents = opts.startEvents ?? startActivitySink;
    this.disposeClient = opts.dispose ?? disposeSharedClient;
    this.configPath = opts.configPath ?? join(process.cwd(), "agents", "opencode.json");
  }

  /*
   * The supervisor owns the OpenCode process and the key it was started with, so its state is the
   * truth about the process — with two exceptions, both because this process needs the key in use
   * itself: a key only the supervisor holds (KEY_LOST_HERE), and a key that differs from the
   * supervisor's, known by its fingerprint (KEY_MISMATCH_HERE), still read as needs_config. A
   * supervisor that cannot be read is a failure with its cause, never a missing key: the operator
   * must not be told to paste a key that is not the problem. The local key decides only when no
   * supervisor is configured or it does not list the provider.
   */
  async health(): Promise<AgentProviderHealth> {
    const localKey = this.env.OPENCODE_API_KEY;
    const hasKey = Boolean(localKey);
    let supervised: SupervisedState | undefined;
    try {
      supervised = await supervisorHealth(this.fetchImpl, this.env, this.provider, this.timeoutSignal(SUPERVISOR_HEALTH_TIMEOUT_MS));
    } catch (err) {
      return { provider: this.provider, status: "failed", configured: hasKey, error: err instanceof Error ? err.message : String(err) };
    }
    if (supervised) {
      if (supervised.health.configured && !localKey) return { provider: this.provider, status: "needs_config", configured: false, error: KEY_LOST_HERE };
      if (supervised.health.configured && localKey && supervised.keyFingerprint !== undefined && supervised.keyFingerprint !== keyFingerprint(localKey)) {
        return { provider: this.provider, status: "needs_config", configured: false, error: KEY_MISMATCH_HERE };
      }
      return supervised.health;
    }
    return hasKey
      ? { provider: this.provider, status: "healthy", configured: true }
      : { provider: this.provider, status: "needs_config", configured: false };
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return modelsFromOpenCodeConfig(this.configPath);
  }

  async openSession(
    role: AgentRole,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      descriptor?: AgentOpenDescriptor;
      onTurn?: (t: AgentTurnEvent) => void;
    },
  ): Promise<AgentRuntimeSession> {
    const deps = await this.deps();
    return deps.open(AGENT_NAME_FOR_ROLE[role], cwd, opts);
  }

  async startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    return this.startEvents(onActivity, signal, { onRunEvent });
  }

  async cleanupOrphans(maxAgeMs: number): Promise<number> {
    const deps = await this.deps();
    return deps.cleanupOrphans?.(maxAgeMs) ?? 0;
  }

  async restart(opts?: { apiKey?: string; env?: Record<string, string> }): Promise<AgentProviderHealth> {
    if (opts?.apiKey) this.env.OPENCODE_API_KEY = opts.apiKey;
    this.depsPromise = undefined;
    this.disposeClient();
    const supervised = await supervisorRestart(this.fetchImpl, this.env, this.provider, opts?.apiKey, opts?.env);
    if (supervised) return supervised;
    return this.health();
  }

  dispose(): void {
    this.depsPromise = undefined;
    this.disposeClient();
  }

  private deps(): Promise<AgentDeps> {
    this.depsPromise ??= this.depsFactory();
    return this.depsPromise;
  }
}

/* What the supervisor reports for a provider: its health, and a fingerprint of the key it holds when it says so. */
interface SupervisedState {
  health: AgentProviderHealth;
  keyFingerprint?: string;
}

/*
 * Throws when the supervisor cannot be reached, answers an error, outlasts `deadline` or answers
 * something that is not a provider state; undefined when none is configured or it does not list the provider.
 */
async function supervisorHealth(
  fetchImpl: SupervisorFetch,
  env: Record<string, string | undefined>,
  provider: "opencode",
  deadline: AbortSignal,
): Promise<SupervisedState | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  return untilAborted(deadline, (async () => {
    const res = await fetchImpl(`${base}/providers`, { signal: deadline });
    if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
    return providerStateFrom(await res.json(), provider);
  })());
}

function providerStateFrom(body: unknown, provider: "opencode"): SupervisedState | undefined {
  const providers = (body as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new Error("supervisor answered something that is not a provider list");
  }
  const entry = (providers as Record<string, unknown>)[provider];
  if (entry === undefined) return undefined;
  const state = entry as { status?: unknown; configured?: unknown; error?: unknown; keyFingerprint?: unknown } | null;
  if (typeof state !== "object" || state === null || typeof state.configured !== "boolean" || typeof state.status !== "string" || !RUNTIME_STATUSES.has(state.status)) {
    throw new Error(`supervisor reported an unreadable state for ${provider}`);
  }
  if (state.keyFingerprint !== undefined && typeof state.keyFingerprint !== "string") {
    throw new Error(`supervisor reported an unreadable key fingerprint for ${provider}`);
  }
  return {
    health: { provider, status: state.status as AgentProviderHealth["status"], configured: state.configured, ...(typeof state.error === "string" ? { error: state.error } : {}) },
    ...(state.keyFingerprint !== undefined ? { keyFingerprint: state.keyFingerprint } : {}),
  };
}

/* Settles with `work`, or rejects as soon as `signal` aborts, even when `work` ignores it. */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function supervisorRestart(
  fetchImpl: SupervisorFetch,
  env: Record<string, string | undefined>,
  provider: "opencode",
  apiKey?: string,
  runtimeEnv?: Record<string, string>,
): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  const res = await fetchImpl(`${base}/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}), ...(runtimeEnv ? { env: runtimeEnv } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`supervisor restart failed (${res.status})`);
  const body = await res.json() as { health?: AgentProviderHealth & { keyFingerprint?: unknown } };
  if (!body.health) return undefined;
  /* The supervisor's key fingerprint is for the comparison in health(); it never travels on to the operator. */
  const { keyFingerprint: _fingerprint, ...health } = body.health;
  return health;
}

function modelsFromOpenCodeConfig(path: string): AgentModelInfo[] {
  if (!existsSync(path)) return FALLBACK_MODELS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { agent?: Record<string, { model?: string }> };
    const ids = new Set<string>();
    for (const agent of Object.values(raw.agent ?? {})) {
      if (agent.model) ids.add(agent.model);
    }
    return (ids.size ? [...ids].map((id) => ({ id })) : FALLBACK_MODELS).sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return FALLBACK_MODELS;
  }
}

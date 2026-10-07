import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultAgentDeps,
  disposeSharedClient,
  listAgentCaps,
  startActivitySink,
  type AgentCap,
  type LiveActivity,
  type AgentDeps,
  type AgentOpenDescriptor,
  type AgentTurnEvent,
} from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";
import type { UsageSnapshot } from "../qa/usage";
import { enforcedStepLimit } from "./step-limit";
import {
  AGENT_NAME_FOR_ROLE,
  AGENT_ROLES,
  type AgentModelInfo,
  type AgentProviderHealth,
  type AgentRole,
  type AgentRuntimeSession,
  type AgentRuntimeStrategy,
  type StepLimits,
} from "./types";

interface OpenCodeRuntimeStrategyOptions {
  env?: Record<string, string | undefined>;
  depsFactory?: () => Promise<AgentDeps>;
  startEvents?: (
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    opts?: { onRunEvent?: (runId: string, body: RunEventBody) => void },
  ) => Promise<void>;
  dispose?: () => void;
  configPath?: string;
  /* The agents the server resolves for a directory, each with its cap: the live read unless a test supplies one. */
  listAgentCaps?: (directory: string) => Promise<ReadonlyArray<AgentCap>>;
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
  private readonly listCaps: NonNullable<OpenCodeRuntimeStrategyOptions["listAgentCaps"]>;

  constructor(opts: OpenCodeRuntimeStrategyOptions = {}) {
    this.env = opts.env ?? process.env;
    this.depsFactory = opts.depsFactory ?? defaultAgentDeps;
    this.startEvents = opts.startEvents ?? startActivitySink;
    this.disposeClient = opts.dispose ?? disposeSharedClient;
    this.configPath = opts.configPath ?? join(process.cwd(), "agents", "opencode.json");
    this.listCaps = opts.listAgentCaps ?? ((directory) => listAgentCaps(directory));
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.OPENCODE_API_KEY) return { provider: this.provider, status: "needs_config", configured: false };
    const supervised = await supervisorHealth(this.env, this.provider);
    if (supervised) return supervised;
    return { provider: this.provider, status: "healthy", configured: true };
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return modelsFromOpenCodeConfig(this.configPath);
  }

  /*
   * What the server enforces, never what a local file says: one read of the agents it resolves for `directory`,
   * each role taking the cap of its own agent. A role whose agent is not listed, is listed without a cap or lists
   * one that is not a safe positive integer is absent, with a warning that names it; a read that fails answers no
   * limit for any role, with one warning. The caller reads once per run.
   */
  async stepLimits(directory: string): Promise<StepLimits> {
    let listed: ReadonlyArray<AgentCap>;
    try {
      listed = await this.listCaps(directory);
    } catch (err) {
      console.warn(`[qa] step limits for ${directory} are unavailable (${err instanceof Error ? err.message : String(err)}); no prompt states a limit`);
      return {};
    }
    const capOf = new Map<string, unknown>(listed.map(({ name, cap }) => [name, cap]));
    const limits: StepLimits = {};
    for (const role of AGENT_ROLES) {
      const agent = AGENT_NAME_FOR_ROLE[role];
      const limit = enforcedStepLimit(capOf.get(agent));
      if (limit === undefined) console.warn(noLimitWarning(role, agent, capOf));
      else limits[role] = limit;
    }
    return limits;
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
    const supervised = await supervisorRestart(this.env, this.provider, opts?.apiKey, opts?.env);
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

/*
 * Why a role has no step limit, for the operator, from the caps the server listed by agent name: its agent is
 * not listed (the warning then names the agents the server does list), is listed without a cap, or lists a cap
 * that cannot be a limit (the warning then carries it).
 */
function noLimitWarning(role: AgentRole, agent: string, capOf: ReadonlyMap<string, unknown>): string {
  const cap = capOf.get(agent);
  const problem = !capOf.has(agent)
    ? `does not list its agent '${agent}' (it lists ${JSON.stringify([...capOf.keys()])})`
    : cap === undefined
      ? `lists its agent '${agent}' without a cap`
      : `lists its agent '${agent}' with a cap that is not a positive integer (${JSON.stringify(cap)})`;
  return `[qa] no step limit for role '${role}': the OpenCode runtime ${problem}; its prompts state no limit`;
}

async function supervisorHealth(env: Record<string, string | undefined>, provider: "opencode"): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}/providers`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
    const body = await res.json() as { providers?: Record<string, AgentProviderHealth> };
    return body.providers?.[provider];
  } catch (err) {
    return { provider, status: "failed", configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function supervisorRestart(
  env: Record<string, string | undefined>,
  provider: "opencode",
  apiKey?: string,
  runtimeEnv?: Record<string, string>,
): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  const res = await fetch(`${base}/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}), ...(runtimeEnv ? { env: runtimeEnv } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`supervisor restart failed (${res.status})`);
  const body = await res.json() as { health?: AgentProviderHealth };
  return body.health;
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

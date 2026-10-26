/* `loadSettings(env)` is the one place the shell reads its environment. It parses every registry entry, collects every problem and throws one SettingsError naming the variables, never a secret's value. The rest of the shell receives the typed groups. */

import { inspect } from "node:util";
import { DEFAULT_PORT, resolveListenHost, resolvePort } from "../server/port";
import { resolveToolsPort } from "../server/tools-endpoint";
import { resolveCampaignFreeze } from "../server/campaign-freeze";
import { resolveReflectorEnabled } from "../server/reflector-switch";
import { resolveJudgeSwitch, type JudgeSwitch } from "../server/judge-settings";
import { resolveEgressMode, type EgressMode } from "../server/egress-wiring";
import { parseCampaignRetentionDays, parseRetentionDays, resolveTelemetryConfig, type TelemetryConfig } from "../telemetry/config";
import { resolveBackendHealthConfig, type BackendHealthConfig } from "../telemetry/backend-health";
import { resolveLangfuseConfig, type LangfuseConfig } from "../telemetry/langfuse-score-sink";
import { resolveRunTimeBudgets } from "@contexts/run-orchestration/application/index";
import { resolveDiffTimeBudgets } from "@contexts/generation/application/index";
import { resolveExecSandboxMode, type ExecSandboxMode } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { DEFAULT_REVIEWER_TIMEOUT_MS, DEFAULT_SELF_REPO, DEFAULT_SESSION_TTL_SECONDS, DEFAULT_STALL_MS } from "./defaults";
import { SETTINGS_REGISTRY, settingDef } from "./registry";

type RunTimeBudgets = ReturnType<typeof resolveRunTimeBudgets>;
type DiffTimeBudgets = ReturnType<typeof resolveDiffTimeBudgets>;

export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export interface SettingProblem {
  readonly env: string;
  readonly message: string;
}

/* Every problem of one load. The message names the variables and what each must be; a secret's value is scrubbed from it. */
export class SettingsError extends Error {
  readonly problems: readonly SettingProblem[];
  constructor(problems: readonly SettingProblem[], secretValues: readonly string[]) {
    const scrubbed = problems.map((problem) => ({ env: problem.env, message: scrub(problem.message, secretValues) }));
    super(`invalid settings:\n${scrubbed.map((problem) => `  ${problem.env}: ${problem.message}`).join("\n")}`);
    this.name = "SettingsError";
    this.problems = scrubbed;
  }
}

function scrub(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) if (value.length > 0) out = out.split(value).join("[redacted]");
  return out;
}

export interface Settings {
  /* The environment the settings were read from, kept as the live map: the seams that build a child's environment, redact by value or expand ${VAR} references in an app config read it, and a variable the onboarding surface applies stays visible. Not part of any dump. */
  readonly environment: EnvironmentMap;
  readonly server: {
    readonly port: number;
    readonly listenHost: string;
    readonly toolsPort: number;
    readonly toolsListenHost: string | undefined;
    readonly selfRepo: string;
    readonly noColor: boolean;
  };
  readonly auth: {
    readonly apiToken: string | undefined;
    readonly signingKey: string | undefined;
    readonly sessionTtlSeconds: number;
    readonly githubOAuthClientId: string | undefined;
  };
  readonly webhook: {
    readonly secret: string | undefined;
    readonly allowUnsigned: boolean;
  };
  readonly agent: {
    readonly serveUrl: string;
    readonly configPath: string | undefined;
    /* Undefined: the run mode's own budget applies. */
    readonly timeoutMs: number | undefined;
    readonly reviewerTimeoutMs: number;
    readonly stallMs: number;
    readonly coordinationEscalatedModel: string | undefined;
    readonly coordinationTelemetryPath: string | undefined;
    /* Undefined: the reflector adapter's own budget applies. */
    readonly reflectorTimeoutMs: number | undefined;
    readonly reflectorEnabled: boolean;
  };
  readonly git: {
    readonly remoteBase: string;
    readonly authorName: string;
    readonly authorEmail: string;
    /* Undefined: the caller's own fallback under the root applies. */
    readonly mirrorDir: string | undefined;
  };
  readonly paths: {
    readonly root: string | undefined;
    readonly logDir: string | undefined;
    readonly historyDbPath: string | undefined;
  };
  readonly sandbox: {
    readonly execSandboxMode: ExecSandboxMode;
    readonly execRoot: string | undefined;
    readonly egressMode: EgressMode;
  };
  readonly run: {
    readonly pwActionTimeoutMs: string | undefined;
    readonly campaignFrozen: boolean;
    readonly runTimeBudgets: RunTimeBudgets;
    readonly diffTimeBudgets: DiffTimeBudgets;
  };
  readonly telemetry: {
    readonly config: TelemetryConfig;
    readonly backendHealth: BackendHealthConfig;
    readonly traceUrlTemplate: string | undefined;
    readonly langfuse: LangfuseConfig | undefined;
  };
  readonly retention: {
    readonly spanDays: number;
    readonly campaignDays: number;
  };
  readonly maintainer: {
    readonly autoMerge: boolean;
    readonly ciCheck: string;
  };
  readonly judges: JudgeSwitch;
  /* Warnings the load produced (a rejected optional integration); the composition root logs them. */
  readonly warnings: readonly string[];
}

class Reader {
  readonly problems: SettingProblem[] = [];
  readonly warnings: string[] = [];

  constructor(readonly env: EnvironmentMap) {}

  /* The variable's value; an empty value counts as unset. Secrets are returned as set, everything else trimmed. */
  str(name: string): string | undefined {
    const def = settingDef(name);
    const raw = this.env[name];
    if (raw === undefined || raw === "") return undefined;
    if (def.secret) return raw;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  /* A positive number, or undefined for anything else: the reading `Number(value) || default` always gave. */
  lenientPositive(name: string): number | undefined {
    const raw = Number(this.str(name));
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  /* A positive whole number; anything else is a problem. */
  positiveInt(name: string, fallback: number): number {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      this.problems.push({ env: name, message: `must be a positive whole number, got ${JSON.stringify(raw)}` });
      return fallback;
    }
    return Number(raw);
  }

  /* True only for the exact value true, as the flags of this shell have always read. */
  flag(name: string): boolean {
    return this.str(name) === "true";
  }

  /* Runs a parser that throws on a bad value and records its message against the variable it names. */
  run<T>(names: readonly string[], parse: () => T, fallback: T): T {
    try {
      return parse();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const named = names.filter((name) => message.includes(name));
      for (const env of named.length > 0 ? named : names) this.problems.push({ env, message });
      return fallback;
    }
  }
}

const SECRET_ENV_NAMES: readonly string[] = SETTINGS_REGISTRY.filter((def) => def.secret).map((def) => def.env);

function secretValuesOf(env: EnvironmentMap): string[] {
  return SECRET_ENV_NAMES.map((name) => env[name]).filter((value): value is string => typeof value === "string" && value.length >= 4);
}

const TELEMETRY_NAMES = SETTINGS_REGISTRY.filter((def) => def.group === "telemetry" || def.group === "retention").map((def) => def.env);

export function loadSettings(env: EnvironmentMap): Settings {
  const r = new Reader(env);

  const port = r.run(["PORT"], () => resolvePort(env), DEFAULT_PORT);
  const listenHost = resolveListenHost(env);
  const toolsPort = r.run(["QA_TOOLS_PORT"], () => resolveToolsPort(env), 0);

  const sessionTtlSeconds = r.positiveInt("AUTH_SESSION_TTL_SECONDS", DEFAULT_SESSION_TTL_SECONDS);

  const telemetryConfig = r.run(TELEMETRY_NAMES, () => resolveTelemetryConfig(env), undefined as unknown as TelemetryConfig);
  const spanDays = r.run(["QA_TELEMETRY_RETENTION_DAYS"], () => parseRetentionDays(env.QA_TELEMETRY_RETENTION_DAYS), 0);
  const campaignDays = r.run(["QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS"], () => parseCampaignRetentionDays(env.QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS), 0);
  const backendHealth = resolveBackendHealthConfig(env);
  const langfuse = resolveLangfuseConfig(env, (message) => r.warnings.push(message));

  const settings: Settings = {
    environment: env,
    server: {
      port,
      listenHost,
      toolsPort,
      toolsListenHost: r.str("QA_TOOLS_LISTEN_HOST"),
      selfRepo: r.str("QAYABA_REPO") ?? DEFAULT_SELF_REPO,
      noColor: r.str("NO_COLOR") !== undefined,
    },
    auth: {
      apiToken: r.str("QA_API_TOKEN"),
      signingKey: r.str("AUTH_SIGNING_KEY"),
      sessionTtlSeconds,
      githubOAuthClientId: r.str("GITHUB_OAUTH_CLIENT_ID"),
    },
    webhook: {
      secret: r.str("WEBHOOK_SECRET"),
      allowUnsigned: r.flag("WEBHOOK_ALLOW_UNSIGNED"),
    },
    agent: {
      serveUrl: r.str("OPENCODE_SERVE_URL") ?? "http://agents:4096",
      configPath: r.str("OPENCODE_CONFIG"),
      timeoutMs: r.lenientPositive("OPENCODE_TIMEOUT_MS"),
      reviewerTimeoutMs: r.lenientPositive("OPENCODE_REVIEWER_TIMEOUT_MS") ?? DEFAULT_REVIEWER_TIMEOUT_MS,
      stallMs: r.lenientPositive("OPENCODE_STALL_MS") ?? DEFAULT_STALL_MS,
      coordinationEscalatedModel: r.str("COORDINATION_ESCALATED_MODEL"),
      coordinationTelemetryPath: r.str("COORDINATION_TELEMETRY_PATH"),
      reflectorTimeoutMs: r.lenientPositive("REFLECTOR_TIMEOUT_MS"),
      reflectorEnabled: r.run(["QA_REFLECTOR_ENABLED"], () => resolveReflectorEnabled(env), false),
    },
    git: {
      remoteBase: r.str("GIT_REMOTE_BASE") ?? "https://github.com",
      authorName: r.str("GIT_AUTHOR_NAME") ?? "qayaba",
      authorEmail: r.str("GIT_AUTHOR_EMAIL") ?? "qayaba@users.noreply.github.com",
      mirrorDir: r.str("MIRROR_DIR"),
    },
    paths: {
      root: r.str("QAYABA_ROOT"),
      logDir: r.str("QAYABA_LOG_DIR"),
      historyDbPath: r.str("HISTORY_DB_PATH"),
    },
    sandbox: {
      execSandboxMode: r.run(["QA_EXEC_SANDBOX"], () => resolveExecSandboxMode(env), "best-effort"),
      execRoot: r.str("QA_EXEC_ROOT"),
      egressMode: r.run(["QA_EGRESS_MODE"], () => resolveEgressMode(env), "enforce"),
    },
    run: {
      pwActionTimeoutMs: r.str("PW_ACTION_TIMEOUT_MS"),
      campaignFrozen: r.run(["QA_CAMPAIGN_FREEZE"], () => resolveCampaignFreeze(env), false),
      runTimeBudgets: r.run(runBudgetNames(), () => resolveRunTimeBudgets(env), undefined as unknown as RunTimeBudgets),
      diffTimeBudgets: r.run(diffBudgetNames(), () => resolveDiffTimeBudgets(env), undefined as unknown as DiffTimeBudgets),
    },
    telemetry: {
      config: telemetryConfig,
      backendHealth,
      traceUrlTemplate: r.str("QA_TRACE_URL_TEMPLATE"),
      langfuse,
    },
    retention: { spanDays, campaignDays },
    maintainer: {
      autoMerge: r.flag("SELF_MAINTAINER_AUTOMERGE"),
      ciCheck: r.str("SELF_MAINTAINER_CI_CHECK") ?? "ci",
    },
    judges: r.run(["QA_JUDGES_ENABLED", "QA_JUDGES_DAILY_TOKENS"], () => resolveJudgeSwitch(env), { enabled: false, dailyTokens: 0 }),
    warnings: r.warnings,
  };

  if (r.problems.length > 0) throw new SettingsError(dedupe(r.problems), secretValuesOf(env));
  return protect(settings);
}

function runBudgetNames(): readonly string[] {
  return SETTINGS_REGISTRY.filter((def) => def.env.startsWith("QA_RUN_TIME_BUDGET_MS_")).map((def) => def.env);
}

function diffBudgetNames(): readonly string[] {
  return SETTINGS_REGISTRY.filter((def) => def.env.startsWith("QA_DIFF_TIME_BUDGET_MS_")).map((def) => def.env);
}

function dedupe(problems: readonly SettingProblem[]): SettingProblem[] {
  const seen = new Set<string>();
  const out: SettingProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.env}\u0000${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(problem);
  }
  return out;
}

/* The load result is frozen, and a dump of it (JSON, util.inspect, a log line) shows the redacted view and never a secret. */
function protect(settings: Settings): Settings {
  const view = (): unknown => describeSettings(settings);
  Object.defineProperty(settings, "toJSON", { value: view, enumerable: false });
  Object.defineProperty(settings, inspect.custom, { value: () => inspect(view(), { depth: 6 }), enumerable: false });
  Object.defineProperty(settings, "environment", { value: settings.environment, enumerable: false });
  for (const group of Object.values(settings)) if (typeof group === "object" && group !== null) Object.freeze(group);
  return Object.freeze(settings);
}

const MASK_SET = "[set]";

/* The settings as a plain object that is safe to log or print: a secret shows only whether it is set. */
export function describeSettings(settings: Settings): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [groupName, group] of Object.entries(settings)) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(group)) fields[key] = describeField(groupName, key, value);
    out[groupName] = fields;
  }
  out.warnings = { count: settings.warnings.length };
  return out;
}

const SECRET_FIELDS: ReadonlySet<string> = new Set(SETTINGS_REGISTRY.filter((def) => def.secret && def.key !== "-").map((def) => `${def.group}.${def.key}`));

function describeField(group: string, key: string, value: unknown): unknown {
  if (SECRET_FIELDS.has(`${group}.${key}`)) return value === undefined ? undefined : MASK_SET;
  if (group === "telemetry" && key === "langfuse") return value === undefined ? undefined : { baseUrl: (value as LangfuseConfig).baseUrl, publicKey: MASK_SET, secretKey: MASK_SET };
  return value;
}

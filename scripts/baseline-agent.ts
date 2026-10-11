/*
 * The plain-agent arm of the pipeline-vs-plain-agent experiment. EXPERIMENT ONLY: nothing in the service
 * calls this, and it is not part of the pipeline.
 *
 *   npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> [--dry-run]
 *                             [--check-auth] [--keep-copy] [--keep-session]
 *
 * It gives one agent (`qa-baseline`) what a developer with a coding agent would have: the whole repository at
 * the commit, a short prompt (the commit message, `git show --stat` and the full diff, plus a few lines of
 * instructions), the live DEV site through the Playwright browser tools, and the ability to run Playwright in
 * the suite directory. No explorer, no grounding, no context map, no reviewer, no regeneration, no
 * deterministic gates: those are what the pipeline adds, and this arm exists to measure what they are worth.
 *
 * The agent works in a THROWAWAY copy of the app's working copy at the commit, under
 * <mirrors>/.baseline/<label> (never the real mirror, never pushed). It runs on the existing `opencode serve`
 * as a dedicated agent defined in an `opencode.json` at the root of that copy: the server resolves its
 * configuration per session directory, so the agent exists only there. Its model and step cap are the
 * generator's, read from agents/opencode.json. After the session (or the wall-clock timeout, which aborts it)
 * the metrics are collected in the SAME shape `probe-report` emits, by replaying the session through the
 * same call tracker, the specs it wrote are run twice with the repo's Playwright runner, and the report is
 * written to config/benchmarks/probe-results/<label>.json.
 *
 * Run it inside the orchestrator container, with the queue idle: DEV is used by one thing at a time.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { CallEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { buildTurnStepBudget, type TurnCallMetrics } from "@contexts/generation/domain/turn-efficiency-summary.ts";
import { finalStepText } from "@contexts/generation/domain/step-exhaustion.ts";
import { AUTH_MATERIAL_FILES } from "../qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts";
import { EXPERIMENT_COPIES_DIR } from "../src/paths.ts";
import {
  DEFAULT_SUITE_DIR, renderMarkdown, totalsOf, turnFromCallMetrics, type PhaseDurations, type ProbeReport, type ProbeSpec, type ReadingContext,
} from "./probe-metrics.ts";
import { assertFileName, defaultProbeResultsDir, writeJsonAtomically } from "./probe-report.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The experiment agent's name, as it is defined in the copy's own opencode.json. */
export const BASELINE_AGENT = "qa-baseline";
/** The agent whose model, step cap and temperature the baseline borrows. */
export const GENERATOR_AGENT = "qa-generator";
/** The Playwright commands the agent may run, and nothing else in the shell. */
export const BASELINE_BASH_ALLOW = ["npx playwright test*", "npx playwright test --list*"] as const;
/** The tools of the Playwright browser server the agent keeps: the same denials as the generator for code, file and drop tools. */
export const BASELINE_BROWSER_TOOLS = ["playwright_browser_navigate", "playwright_browser_snapshot", "playwright_browser_click", "playwright_browser_type"] as const;
/** The longest diff the prompt carries, in characters; a longer one is cut and says so. */
export const MAX_DIFF_CHARS = 200_000;

/* ── the agent's configuration ─────────────────────────────────────────────────────── */

export interface GeneratorSettings {
  model: string;
  /** The step cap, or null when the generator has none. */
  steps: number | null;
  temperature: number | null;
}

/** The generator's model, step cap and temperature from the parsed agents/opencode.json. Nothing here names a model: it is whatever the file says. */
export function generatorSettings(config: unknown): GeneratorSettings {
  const agent = (config as { agent?: Record<string, { model?: unknown; steps?: unknown; maxSteps?: unknown; temperature?: unknown }> } | null)?.agent?.[GENERATOR_AGENT];
  if (!agent || typeof agent.model !== "string" || agent.model === "") {
    throw new Error(`agents/opencode.json declares no model for '${GENERATOR_AGENT}': the baseline borrows the generator's model and has no other source for it`);
  }
  const cap = agent.steps ?? agent.maxSteps;
  return {
    model: agent.model,
    steps: typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? cap : null,
    temperature: typeof agent.temperature === "number" ? agent.temperature : null,
  };
}

type PermissionConfig = Record<string, string | Record<string, string>>;

/** The permission block of the baseline agent. Every tool not named is denied; the order matters (the last matching rule wins). */
export function baselinePermission(): PermissionConfig {
  return {
    "*": "deny",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "allow",
    bash: { "*": "deny", ...Object.fromEntries(BASELINE_BASH_ALLOW.map((pattern) => [pattern, "allow"])) },
    ...Object.fromEntries(BASELINE_BROWSER_TOOLS.map((tool) => [tool, "allow"])),
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    doom_loop: "deny",
    external_directory: { "*": "deny" },
  };
}

/** The `opencode.json` that goes at the root of the throwaway copy. */
export function baselineAgentConfig(g: GeneratorSettings): { $schema: string; agent: Record<string, unknown> } {
  return {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [BASELINE_AGENT]: {
        description: "Experiment arm A: one plain agent with the repository, the live DEV site and a Playwright runner. No pipeline stages.",
        mode: "primary",
        model: g.model,
        ...(g.steps !== null ? { steps: g.steps } : {}),
        ...(g.temperature !== null ? { temperature: g.temperature } : {}),
        permission: baselinePermission(),
      },
    },
  };
}

/* ── permission evaluation (a reimplementation of the server's rule, to audit what it resolved) ── */

export type PermissionAction = "allow" | "deny" | "ask";
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/** The server's wildcard: `*` any run of characters, `?` one character, a trailing ` *` also matches the bare command. */
export function wildcardMatch(text: string, pattern: string): boolean {
  const subject = text.replaceAll("\\", "/");
  let source = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s").test(subject);
}

/** The ordered rules a permission block stands for. A plain action covers every pattern of that permission. */
export function flattenPermission(config: PermissionConfig): PermissionRule[] {
  return Object.entries(config).flatMap(([permission, value]) =>
    typeof value === "string"
      ? [{ permission, pattern: "*", action: value as PermissionAction }]
      : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action: action as PermissionAction })),
  );
}

/** What the rules say about a permission and a pattern: the last rule that matches both, else `ask`. */
export function evaluatePermission(rules: readonly PermissionRule[], permission: string, pattern: string): PermissionAction {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) return rule.action;
  }
  return "ask";
}

export interface PermissionProbe {
  permission: string;
  pattern: string;
  expect: PermissionAction;
}

const probe = (permission: string, pattern: string, expect: PermissionAction): PermissionProbe => ({ permission, pattern, expect });

/** What the baseline agent must and must not be able to do, checked against the rules the server resolved for it. */
export const PERMISSION_PROBES: readonly PermissionProbe[] = [
  probe("read", "src/app/main.ts", "allow"), probe("read", "config/.env", "deny"), probe("read", ".env.production", "deny"),
  probe("glob", "**/*.ts", "allow"), probe("grep", "createOrder", "allow"), probe("list", "src", "allow"),
  probe("edit", "e2e/flows/checkout.spec.ts", "allow"),
  probe("bash", "npx playwright test", "allow"), probe("bash", "npx playwright test --list", "allow"), probe("bash", "npx playwright test flows/a.spec.ts --reporter=list", "allow"),
  probe("bash", "rm -rf /", "deny"), probe("bash", "curl https://example.com", "deny"), probe("bash", "git push origin main", "deny"), probe("bash", "npm install left-pad", "deny"), probe("bash", "node -e 1", "deny"),
  probe("webfetch", "https://example.com", "deny"), probe("websearch", "anything", "deny"), probe("task", "anything", "deny"),
  ...BASELINE_BROWSER_TOOLS.map((tool) => probe(tool, "*", "allow")),
  probe("playwright_browser_run_code_unsafe", "*", "deny"), probe("playwright_browser_evaluate", "*", "deny"), probe("playwright_browser_file_upload", "*", "deny"), probe("playwright_browser_drop", "*", "deny"),
  probe("serena_find_symbol", "*", "deny"), probe("engram_mem_save", "*", "deny"),
  probe("external_directory", "/etc/passwd", "deny"), probe("doom_loop", "*", "deny"),
];

export interface ProbeOutcome extends PermissionProbe {
  actual: PermissionAction;
  ok: boolean;
}

export function checkProbes(rules: readonly PermissionRule[], probes: readonly PermissionProbe[] = PERMISSION_PROBES): ProbeOutcome[] {
  return probes.map((p) => {
    const actual = evaluatePermission(rules, p.permission, p.pattern);
    return { ...p, actual, ok: actual === p.expect };
  });
}

/* ── the prompt ────────────────────────────────────────────────────────────────────── */

export interface PromptInput {
  baseUrl: string;
  /** The app's `qa.testDataPrefix`. */
  testDataPrefix: string;
  /** True when the automatic login did not work for this app: the agent is told where the login is and how to run it. */
  loginUnavailable?: boolean;
  commitMessage: string;
  stat: string;
  diff: string;
}

/** The instructions of the prompt, apart from the commit material. A handful of lines, generic to any app. */
export function baselineInstructions(input: Pick<PromptInput, "baseUrl" | "testDataPrefix" | "loginUnavailable">): string[] {
  return [
    `Write Playwright E2E tests under e2e/ that verify this change against the live DEV site ${input.baseUrl}.`,
    ...(input.loginUnavailable
      ? [
          "The automatic login did not work for this app: e2e/auth.setup.ts is the stock login. Fix it for this app if needed;",
          "`npx playwright test --project=setup` runs it and saves the session that your other tests use.",
        ]
      : ["Authentication is handled for you (the session is injected into Playwright): do not write your own login."]),
    "Run your tests with `npx playwright test` in e2e/ (bash workdir: e2e) and iterate until they pass,",
    "or until you conclude the change has no user-visible behavior to test: then write no spec, say NOOP and say why.",
    `Prefix any data you create with "${input.testDataPrefix}". Do not create data outside specs.`,
  ];
}

const redact = (text: string): string => sanitizeText(text, "model").text;

/** The prompt: the instructions, then the commit message, `git show --stat` and the full diff (cut at MAX_DIFF_CHARS, saying so). Text that leaves the system passes through the engine's redaction first. */
export function buildBaselinePrompt(input: PromptInput): string {
  const diff = input.diff.length > MAX_DIFF_CHARS ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters; ${input.diff.length - MAX_DIFF_CHARS} more not shown]` : input.diff;
  return [
    ...baselineInstructions(input),
    "",
    "Commit message:",
    redact(input.commitMessage.trim()),
    "",
    "git show --stat:",
    redact(input.stat.trim()),
    "",
    "Full diff:",
    redact(diff),
    "",
  ].join("\n");
}

/** Whether the agent's closing words declare that there is nothing to test. */
export function declaresNoop(finalText: string): boolean {
  return /\bNOOP\b/.test(finalText);
}

/* ── the browser wrapper ───────────────────────────────────────────────────────────── */

export interface HarnessEnv {
  baseUrl: string;
  namespace: string;
  testIdAttribute?: string;
  /** Where the orchestrator-side login left the session; applied only if the file is there when Playwright starts. */
  storageStatePath: string;
}

export const WRAPPER_REPO_CONFIG = "playwright.repo.config.ts";
export const WRAPPER_ENV_MODULE = "playwright.baseline-env.ts";
export const WRAPPER_CONFIG = "playwright.config.ts";

/**
 * Two files that go in the suite directory beside the repo's own Playwright config (renamed
 * `playwright.repo.config.ts`). The first sets the few non-secret variables the orchestrator would inject for
 * a pipeline run (the secrets, DEV_*, are already in the environment of both containers). The second is the
 * config the agent's `npx playwright test` finds: the repo's config, plus a browser path when this
 * environment does not hold the browser build the project's Playwright wants (the agents container carries the
 * browsers of the MCP server's Playwright, the orchestrator those of the project's). Neither changes what a test does.
 */
export function harnessFiles(env: HarnessEnv): { envModule: string; config: string } {
  const defaults: Record<string, string> = {
    PW_BASE_URL: env.baseUrl,
    PW_NAMESPACE: env.namespace,
    ...(env.testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: env.testIdAttribute } : {}),
  };
  const envModule = [
    "// qa-baseline harness (experiment only): the non-secret values the orchestrator injects for a pipeline run.",
    'import { existsSync } from "node:fs";',
    `const defaults: Record<string, string> = ${JSON.stringify(defaults, null, 2)};`,
    "for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;",
    "// `--project=setup` is the login run: the repo's config defines that project only under PW_AUTH_SETUP.",
    'if (process.argv.some((a) => a === "--project=setup")) process.env.PW_AUTH_SETUP ??= "1";',
    "// The saved session is applied when it exists, and is where the login run writes it.",
    `if (process.env.PW_AUTH_SETUP || existsSync(${JSON.stringify(env.storageStatePath)})) process.env.PW_STORAGE_STATE ??= ${JSON.stringify(env.storageStatePath)};`,
    "",
  ].join("\n");
  const config = [
    "// qa-baseline harness (experiment only): the repo's own config, unchanged, plus the harness environment",
    "// and, where this environment lacks the browser build the project's Playwright wants, a browser path.",
    `import "./${WRAPPER_ENV_MODULE.replace(/\.ts$/, "")}";`,
    'import { existsSync, readdirSync } from "node:fs";',
    'import { homedir } from "node:os";',
    'import { join } from "node:path";',
    'import { defineConfig } from "@playwright/test";',
    `import base from "./${WRAPPER_REPO_CONFIG.replace(/\.ts$/, "")}";`,
    "",
    "function installedHeadlessShell(): string | undefined {",
    "  // An environment that manages the browsers for this Playwright version says so (the orchestrator image).",
    "  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return undefined;",
    '  const root = join(homedir(), ".cache", "ms-playwright");',
    "  if (!existsSync(root)) return undefined;",
    '  for (const dir of readdirSync(root).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {',
    '    const platform = readdirSync(join(root, dir)).find((n) => n.startsWith("chrome-headless-shell-"));',
    '    const exe = platform ? join(root, dir, platform, "chrome-headless-shell") : undefined;',
    "    if (exe && existsSync(exe)) return exe;",
    "  }",
    "  return undefined;",
    "}",
    "",
    "const executablePath = installedHeadlessShell();",
    "export default defineConfig(base, executablePath ? { use: { launchOptions: { executablePath } } } : {});",
    "",
  ].join("\n");
  return { envModule, config };
}

/* ── the session, replayed through the call tracker ────────────────────────────────── */

interface SessionPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; time?: { start?: number; end?: number } };
  tokens?: unknown;
  cost?: unknown;
}

export interface SessionMessage {
  info: { id?: string; role?: string; time?: { created?: number; completed?: number }; error?: unknown };
  parts: SessionPart[];
}

/**
 * The turn's metrics, measured exactly as the pipeline measures a live one: the session's parts are fed to the same
 * call tracker, with its clock set to the times the parts carry, so buckets, redundant reads, denied calls, the
 * tool sequence, steps, usage over every step and the time to the first call and the first write mean the same thing
 * in both arms. `startedAt` is when the prompt was sent. Null when the session carried no assistant message.
 */
export async function replaySession(sessionId: string, directory: string, startedAt: number, promptText: string, messages: readonly SessionMessage[]): Promise<TurnCallMetrics | null> {
  let clock = startedAt;
  const tracker = new CallEfficiencyTracker({ now: () => clock });
  const stream = Symbol("replay");
  tracker.streamOpening(directory, stream);
  tracker.streamConnected(directory, stream);
  tracker.attach(sessionId, directory);
  await tracker.prepareAttempt(sessionId, 0);

  /* The clock only moves forward, to the time a part carries; a part with none (a step boundary) keeps it where it is. */
  const feed = (part: SessionPart, at?: number): void => {
    if (at !== undefined) clock = Math.max(clock, at);
    tracker.record({ type: "message.part.updated", properties: { part: { ...part, sessionID: sessionId } } });
  };
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    clock = Math.max(clock, message.info.time?.created ?? clock);
    for (const part of message.parts) {
      if (part.type === "step-start" || part.type === "step-finish") feed(part);
      else if (part.type === "tool" && part.state) {
        const start = part.state.time?.start;
        const status = part.state.status;
        /* A call is first seen running, as the live stream shows it; the final state follows at the time the call ended. */
        if (status === "completed" || status === "error") feed({ ...part, state: { ...part.state, status: "running", output: undefined, error: undefined } }, start);
        feed(part, part.state.time?.end ?? start);
      }
    }
    clock = Math.max(clock, message.info.time?.completed ?? clock);
  }
  return tracker.take(sessionId, promptText);
}

/** The text of the last assistant message that said anything: the agent's closing words. */
export function finalTextOf(messages: readonly SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info.role !== "assistant") continue;
    const text = m.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("");
    if (text.trim() !== "") return text;
  }
  return "";
}

/* ── verdicts ──────────────────────────────────────────────────────────────────────── */

/** One execution of the agent's specs, as the repo's Playwright runner classified it. */
export interface SuiteRun {
  verdict: RunVerdict;
  passed: number;
  failed: number;
  flaky: number;
  ms: number;
}

/** Two executions into one: both green is a pass, both red a fail, one of each flaky; a run that could not execute makes the result infra-error, and a run that passed only on retry is flaky. */
export function combineVerdicts(runs: readonly RunVerdict[]): RunVerdict {
  if (runs.length === 0) return "skipped";
  if (runs.includes("infra-error")) return "infra-error";
  if (runs.every((v) => v === "pass")) return "pass";
  if (runs.every((v) => v === "fail")) return "fail";
  return "flaky";
}

export interface Classification {
  verdict: RunVerdict;
  errorClass: string | null;
  note: string;
}

/**
 * What the arm's run was, in the pipeline's own vocabulary: specs that ran give the combined verdict; no spec and a declared
 * no-op is `skipped`; no spec and silence is `infra-error` E-NO-DECISION; a session cut by the clock or by its step cap says so.
 */
export function classifyBaseline(input: { specs: number; noop: boolean; ended: "completed" | "timeout" | "exhausted" | "error"; runs: readonly SuiteRun[]; timeoutMin: number }): Classification {
  if (input.specs > 0 && input.runs.length > 0) {
    const verdict = combineVerdicts(input.runs.map((r) => r.verdict));
    const lead = input.ended === "timeout" ? `time budget of ${input.timeoutMin} min reached; ` : input.ended === "exhausted" ? "step limit reached; " : "";
    return { verdict, errorClass: null, note: `${lead}${input.specs} spec(s), executed ${input.runs.length}x: ${input.runs.map((r) => r.verdict).join(", ")}` };
  }
  if (input.ended === "timeout") return { verdict: "infra-error", errorClass: "E-TIME-BUDGET", note: `time budget of ${input.timeoutMin} min exhausted with no spec written` };
  if (input.ended === "exhausted") return { verdict: "infra-error", errorClass: "E-STEP-BUDGET", note: "step limit reached with no spec written" };
  if (input.ended === "error") return { verdict: "infra-error", errorClass: null, note: "the agent session failed" };
  if (input.noop) return { verdict: "skipped", errorClass: null, note: "the agent declared NOOP and wrote no spec" };
  return { verdict: "infra-error", errorClass: "E-NO-DECISION", note: "the agent ended without writing a spec or declaring NOOP" };
}

/* ── arguments ─────────────────────────────────────────────────────────────────────── */

export interface BaselineArguments {
  app: string;
  sha: string;
  timeoutMin: number | null;
  label: string;
  dryRun: boolean;
  checkAuth: boolean;
  keepCopy: boolean;
  keepSession: boolean;
}

const HEX_COMMIT_ID = /^[0-9a-f]{7,40}$/i;

export function parseArguments(argv: readonly string[]): { ok: true; args: BaselineArguments } | { ok: false; problem: string } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const valued = new Set(["--app", "--sha", "--timeout-min", "--label"]);
  const boolean = new Set(["--dry-run", "--check-auth", "--keep-copy", "--keep-session"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (boolean.has(a)) flags.add(a);
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  for (const required of ["--app", "--sha", "--label"]) if (!values[required]) return { ok: false, problem: `error: ${required} is required` };
  if (!HEX_COMMIT_ID.test(values["--sha"]!)) return { ok: false, problem: "error: --sha must be 7-40 hex characters" };
  let timeoutMin: number | null = null;
  if (values["--timeout-min"] !== undefined) {
    timeoutMin = Number(values["--timeout-min"]);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) return { ok: false, problem: "error: --timeout-min needs a positive number of minutes" };
  }
  if (timeoutMin === null && !flags.has("--dry-run")) return { ok: false, problem: "error: --timeout-min is required (the wall-clock limit of the agent session)" };
  try {
    assertFileName(values["--label"]!, "label");
    assertFileName(values["--app"]!, "app");
  } catch (err) {
    return { ok: false, problem: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    args: {
      app: values["--app"]!, sha: values["--sha"]!, timeoutMin, label: values["--label"]!,
      dryRun: flags.has("--dry-run"), checkAuth: flags.has("--check-auth"), keepCopy: flags.has("--keep-copy"), keepSession: flags.has("--keep-session"),
    },
  };
}

/* ── the run, over injected collaborators ──────────────────────────────────────────── */

/** What the baseline needs to know of an app, from its config. */
export interface AppInfo {
  name: string;
  repo: string;
  baseUrl: string;
  testDataPrefix: string;
  testIdAttribute?: string;
}

export interface CopyPlan {
  repo: string;
  sha: string;
  /** The throwaway working copy. */
  copyDir: string;
  /** The orchestrator-only login material, beside the copy. */
  authDir: string;
  env: HarnessEnv;
  agentConfig: { $schema: string; agent: Record<string, unknown> };
}

export interface CommitMaterial {
  message: string;
  stat: string;
  diff: string;
  changedFiles: string[];
}

export interface AgentRun {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  ended: "completed" | "timeout" | "error";
  error?: string;
  messages: SessionMessage[];
}

export interface BaselineDeps {
  /** Throws when the service's queue is not idle (nothing running, nothing pending). */
  assertQueueIdle(): Promise<void>;
  /** What the queue holds right now, as text, for a dry run that does not refuse. */
  queueState(): Promise<string>;
  loadApp(name: string): AppInfo;
  agentsConfig(): unknown;
  copyDirFor(label: string, app: AppInfo): { copyDir: string; authDir: string };
  copyExists(copyDir: string): boolean;
  /** Clones the working copy at the commit, installs the suite's dependencies, writes the agent's config and the harness files. */
  prepareCopy(plan: CopyPlan): Promise<void>;
  removeCopy(plan: CopyPlan): void;
  commitMaterial(copyDir: string, sha: string): Promise<CommitMaterial>;
  /** The rules the server resolved for the baseline agent in the copy's directory. */
  resolvedPermissions(copyDir: string): Promise<PermissionRule[]>;
  /** The model the server resolved for the generator (`provider/model`), or null when it resolves none. */
  resolvedGeneratorModel(copyDir: string): Promise<string | null>;
  /**
   * Logs in as the pipeline's harness does, leaving the session where the harness env expects it. Before the agent works
   * (`pre-generate`) a login that does not work is reported, not thrown, as for the pipeline; before the suite runs
   * (`pre-execute`, with whatever login the agent left) it throws.
   */
  prepareAuth(app: AppInfo, plan: CopyPlan, phase: "pre-generate" | "pre-execute"): Promise<{ unauthored: boolean }>;
  runAgent(input: { copyDir: string; prompt: string; timeoutMs: number; keepSession: boolean }): Promise<AgentRun>;
  /** The specs the agent added or changed, relative to the suite directory, and the paths it changed outside the suite directory. */
  changedFiles(copyDir: string): Promise<{ specs: string[]; outsideSuite: string[] }>;
  specLines(copyDir: string, specs: readonly string[]): Map<string, number | null>;
  runSuite(input: { copyDir: string; authDir: string; app: AppInfo; namespace: string; specs: readonly string[] }): Promise<SuiteRun>;
  writeReport(label: string, report: ProbeReport): string;
  now(): number;
  out(line: string): void;
}

const MS_PER_MIN = 60_000;
const PROMPT_PREVIEW_LINES = 40;

function emptyPhases(): PhaseDurations {
  return { gate: null, classify: null, setup: null, grounding: null, generation: null, validate: null, health: null, execute: null, coverage: null, retry: null, decide: null };
}

/** Returns the process exit code: 0 ok, 1 refused or failed, 2 bad usage. */
export async function main(argv: string[], deps: BaselineDeps): Promise<number> {
  const out = deps.out;
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    out(parsed.problem);
    for (const line of USAGE.split("\n")) out(line);
    return 2;
  }
  const args = parsed.args;
  let plan: CopyPlan | undefined;
  try {
    if (args.dryRun) out(`[baseline] queue: ${await deps.queueState()} (a dry run does not refuse; a real run does when it is busy)`);
    else await deps.assertQueueIdle();

    const app = deps.loadApp(args.app);
    const generator = generatorSettings(deps.agentsConfig());
    const { copyDir, authDir } = deps.copyDirFor(args.label, app);
    if (deps.copyExists(copyDir)) throw new Error(`${copyDir} already exists: a label names one run, pick another or remove the directory`);
    const namespace = `${app.testDataPrefix}-${args.sha.slice(0, 7)}-${args.label}`;
    plan = {
      repo: app.repo, sha: args.sha, copyDir, authDir,
      env: { baseUrl: app.baseUrl, namespace, ...(app.testIdAttribute ? { testIdAttribute: app.testIdAttribute } : {}), storageStatePath: join(authDir, AUTH_MATERIAL_FILES.storageState) },
      agentConfig: baselineAgentConfig(generator),
    };

    const setupStarted = deps.now();
    out(`[baseline] preparing the throwaway copy of ${app.repo} at ${args.sha.slice(0, 7)}: ${copyDir}`);
    await deps.prepareCopy(plan);
    const material = await deps.commitMaterial(copyDir, args.sha);
    const promptFor = (loginUnavailable: boolean): string =>
      buildBaselinePrompt({ baseUrl: app.baseUrl, testDataPrefix: app.testDataPrefix, loginUnavailable, commitMessage: material.message, stat: material.stat, diff: material.diff });

    const rules = await deps.resolvedPermissions(copyDir);
    const outcomes = checkProbes(rules);
    const wrong = outcomes.filter((o) => !o.ok);
    /* The orchestrator's copy of agents/opencode.json can lag the file the agents container mounts: the model must be the one the server really uses for the generator. */
    const served = await deps.resolvedGeneratorModel(copyDir);
    if (served !== null && served !== generator.model) {
      throw new Error(`the orchestrator's agents/opencode.json gives the generator model '${generator.model}' but the server resolved '${served}': its copy is stale, rebuild or mount agents/opencode.json`);
    }
    out(`[baseline] agent ${BASELINE_AGENT}: model ${generator.model}, step cap ${generator.steps ?? "none"}, temperature ${generator.temperature ?? "default"} (the generator's, from agents/opencode.json)`);
    out(`[baseline] resolved permissions (${rules.length} rules); ${outcomes.length - wrong.length}/${outcomes.length} probes as expected`);
    for (const o of outcomes) out(`  ${o.ok ? "ok  " : "FAIL"} ${o.permission} ${JSON.stringify(o.pattern)} -> ${o.actual}${o.ok ? "" : ` (expected ${o.expect})`}`);
    if (wrong.length > 0) throw new Error(`the server resolved permissions for ${BASELINE_AGENT} that differ from the design in ${wrong.length} probe(s): no session was started`);

    if (args.dryRun) {
      let loginUnavailable = false;
      if (args.checkAuth) {
        const login = await deps.prepareAuth(app, plan, "pre-generate");
        loginUnavailable = login.unauthored;
        out(login.unauthored
          ? "[baseline] the automatic login did not work for this app (as for the pipeline's own pre-generation login); the agent is told to fix e2e/auth.setup.ts and may run it with --project=setup"
          : "[baseline] login succeeded: the session is where the harness env expects it");
      }
      const preview = promptFor(loginUnavailable);
      const lines = preview.split("\n");
      out(`[baseline] prompt (${Buffer.byteLength(preview, "utf8")} bytes, ${lines.length} lines; the first ${Math.min(PROMPT_PREVIEW_LINES, lines.length)} shown):`);
      for (const line of lines.slice(0, PROMPT_PREVIEW_LINES)) out(`  | ${line}`);
      out("[baseline] dry run: no session was started");
      if (!args.keepCopy) {
        deps.removeCopy(plan);
        out("[baseline] the throwaway copy was removed (--keep-copy keeps it)");
      }
      return 0;
    }

    const login = await deps.prepareAuth(app, plan, "pre-generate");
    if (login.unauthored) out("[baseline] the automatic login did not work for this app: the agent is told so, as the pipeline's generator is");
    const prompt = promptFor(login.unauthored);
    const setupMs = deps.now() - setupStarted;
    const timeoutMs = Math.round((args.timeoutMin as number) * MS_PER_MIN);
    out(`[baseline] session started; wall-clock limit ${args.timeoutMin} min`);
    const run = await deps.runAgent({ copyDir, prompt, timeoutMs, keepSession: args.keepSession });

    const metrics = await replaySession(run.sessionId, copyDir, run.startedAt, prompt, run.messages);
    const finalText = finalTextOf(run.messages);
    const budget = buildTurnStepBudget({ maxSteps: generator.steps, stepsUsed: metrics?.stepsUsed ?? null, finalStepText: finalStepText(lastAssistantParts(run.messages)) });
    const ended: "completed" | "timeout" | "exhausted" | "error" = run.ended === "completed" ? (budget.exhausted === true ? "exhausted" : "completed") : run.ended;
    const wallMs = Math.max(0, run.endedAt - run.startedAt);

    const changed = await deps.changedFiles(copyDir);
    const specs = changed.specs;
    await assertIdle(deps);
    const executeStarted = deps.now();
    const runs: SuiteRun[] = [];
    let loginError: string | null = null;
    if (specs.length > 0) {
      /* As before the pipeline's execute phase: log in again with whatever login the agent left; one that cannot log in is fatal. */
      try {
        await deps.prepareAuth(app, plan, "pre-execute");
      } catch (err) {
        loginError = err instanceof Error ? err.message : String(err);
        out(`[baseline] the login failed before the suite could run: ${loginError.slice(0, 300)}`);
      }
      if (loginError === null) {
        out(`[baseline] running the ${specs.length} spec(s) twice with the repo's Playwright runner`);
        for (let i = 0; i < 2; i++) runs.push(await deps.runSuite({ copyDir, authDir, app, namespace, specs }));
      }
    }
    const executeMs = deps.now() - executeStarted;
    const classification = loginError !== null
      ? { verdict: "infra-error" as const, errorClass: "E-PRECONDITION", note: `${specs.length} spec(s) written, but the login could not be completed before execution` }
      : classifyBaseline({ specs: specs.length, noop: declaresNoop(finalText), ended, runs, timeoutMin: args.timeoutMin as number });

    const reading: ReadingContext = { changedFiles: material.changedFiles, briefText: null, suiteDir: DEFAULT_SUITE_DIR };
    const turn = turnFromCallMetrics(
      { role: BASELINE_AGENT, round: 0, isRepair: false, ended, durationMs: wallMs, maxSteps: generator.steps, promptBytes: Buffer.byteLength(prompt, "utf8"), metrics },
      reading,
    );
    const lines = deps.specLines(copyDir, specs);
    const specList: ProbeSpec[] = specs.map((path) => ({ path, lines: lines.get(path) ?? null }));
    const last = runs[runs.length - 1];
    const report: ProbeReport = {
      schema: 1,
      arm: "baseline",
      id: args.label,
      app: app.name,
      sha: args.sha,
      mode: "diff",
      at: new Date(run.startedAt).toISOString(),
      verdict: classification.verdict,
      errorClass: classification.errorClass,
      note: classification.note,
      finished: true,
      totalMs: setupMs + wallMs + executeMs,
      phases: { ...emptyPhases(), setup: setupMs, generation: wallMs, execute: runs.length > 0 ? executeMs : null },
      nested: { explorerMs: null, domCaptureMs: null, reviewMs: null },
      turns: [turn],
      totals: totalsOf([turn]),
      specs: specList,
      execution: last ? { passed: last.passed, failed: last.failed, flaky: runs.reduce((n, r) => n + r.flaky, 0) } : null,
      coverage: null,
      reviewer: null,
      detail: {
        model: generator.model, stepCap: generator.steps, timeoutMin: args.timeoutMin, sessionId: run.sessionId, sessionError: run.error ?? null,
        suiteRuns: runs, declaredNoop: declaresNoop(finalText), changedOutsideSuite: changed.outsideSuite,
        finalText: redact(finalText).slice(0, 4_000), namespace, copyDir: args.keepCopy ? copyDir : null,
      },
    };
    const path = deps.writeReport(args.label, report);
    for (const line of renderMarkdown([report]).split("\n")) out(line);
    out(`\nfull report: ${path}`);
    if (args.keepCopy) out(`throwaway copy kept: ${copyDir}`);
    else deps.removeCopy(plan);
    return 0;
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    if (plan && args.dryRun && !args.keepCopy) {
      try {
        deps.removeCopy(plan);
      } catch {
        /* the copy is a throwaway; its removal failing does not change the error to report */
      }
    }
    return 1;
  }
}

/* DEV is used by one thing at a time: the suite runs only when the queue is still idle. */
async function assertIdle(deps: BaselineDeps): Promise<void> {
  await deps.assertQueueIdle();
}

function lastAssistantParts(messages: readonly SessionMessage[]): Array<{ type: string; text?: string }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.info.role === "assistant") return m.parts.map((p) => ({ type: String(p.type ?? ""), ...(typeof p.text === "string" ? { text: p.text } : {}) }));
  }
  return [];
}

const USAGE = [
  "usage: npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> [--dry-run] [--check-auth] [--keep-copy] [--keep-session]",
  "  EXPERIMENT ONLY. Runs one plain agent (no pipeline stages) on a throwaway copy of the app at the commit, then runs its specs twice,",
  "  and writes config/benchmarks/probe-results/<label>.json in the shape probe-report emits.",
  "  --dry-run       prepare the copy, print the prompt and the permissions the server resolved for the agent, start no session",
  "  --check-auth    with --dry-run: also log in once to DEV, to prove the session the agent's tests use",
  "  --keep-copy     keep the throwaway copy (default: removed at the end of a dry run, kept never otherwise unless set)",
  "  --keep-session  keep the OpenCode session (default: deleted once its metrics are collected)",
  "run inside the orchestrator container, with the queue idle.",
].join("\n");

/* ── the real collaborators ────────────────────────────────────────────────────────── */

const countLines = (text: string): number => (text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length);
const SUITE_DIR = DEFAULT_SUITE_DIR;

/** The throwaway copy's real I/O, imported lazily so a test that injects its own never loads the engine. */
export async function defaultDeps(env: Record<string, string | undefined> = process.env): Promise<BaselineDeps> {
  const { assertQueueIdle, defaultService } = await import("./efficiency-benchmark.ts");
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const { workdirRoot, realGit, getCommitMessage, getCommitDiff, listChangedSpecs, defaultMirrorDeps } = await import("../src/integrations/repo-mirror.ts");
  const { buildSetupAdapter } = await import("../src/server/rewritten-engine-factory.ts");
  const { readConfinedSpecFile } = await import("../qa-engine/src/shared-infrastructure/spec-path-confinement.ts");
  const { runE2E, createDefaultE2eExecuteDeps, e2eTimeoutMs } = await import("../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts");
  const { ProcessKillAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts");
  const { SandboxedBinaryRunnerAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts");
  const { AuthSessionAdapter } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts");
  const { installHttpDispatcher } = await import("../src/util/net.ts");
  const { createDiscoverLogin } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner.ts");
  const { loadContextMapFromDisk } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts");
  const { RedactionPortAdapter } = await import("../src/orchestrator/sanitizer.ts");
  const redaction = new RedactionPortAdapter();

  const service = await defaultService(env);
  const mirrorsRoot = workdirRoot();
  const git = defaultMirrorDeps;
  const slug = (repo: string): string => repo.replaceAll("/", "__");
  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  const serveUrl = env.OPENCODE_SERVE_URL ?? "http://agents:4096";
  const serverPassword = env.OPENCODE_SERVER_PASSWORD;
  const headers = serverPassword ? { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } : undefined;

  return {
    assertQueueIdle: () => assertQueueIdle(service),
    queueState: async () => {
      const res = await fetch(`${service.baseUrl}/api/v1/queue`, { headers: service.token ? { Authorization: `Bearer ${service.token}` } : {} });
      return res.ok ? JSON.stringify(await res.json()) : `unreadable (HTTP ${res.status})`;
    },
    loadApp: (name) => {
      const app = loadAppConfig(name);
      if (app.code === true || !app.dev?.baseUrl) throw new Error(`app '${name}' has no DEV site to test against`);
      if (app.auth?.kind === "mtls") throw new Error(`app '${name}' logs in with a client certificate, whose passphrase would have to reach the agent's shell: the baseline does not support it`);
      return { name: app.name, repo: app.repo, baseUrl: app.dev.baseUrl, testDataPrefix: app.qa.testDataPrefix, ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}) };
    },
    agentsConfig: () => JSON.parse(readFileSync(env.OPENCODE_CONFIG ?? join(ROOT, "agents", "opencode.json"), "utf8")) as unknown,
    copyDirFor: (label) => {
      const base = join(mirrorsRoot, EXPERIMENT_COPIES_DIR);
      return { copyDir: join(base, label), authDir: join(base, `${label}.auth`) };
    },
    copyExists: (copyDir) => existsSync(copyDir),

    prepareCopy: async (plan) => {
      const mirror = join(mirrorsRoot, slug(plan.repo));
      if (!existsSync(mirror)) throw new Error(`there is no mirror of ${plan.repo} at ${mirror}: run the pipeline on the app once first`);
      /* The commit must already be in the mirror: this arm never fetches and never touches it (a read-only look at its objects). */
      await realGit(["cat-file", "-e", `${plan.sha}^{commit}`], mirror).catch(() => {
        throw new Error(`commit ${plan.sha} is not in the mirror of ${plan.repo}: the pipeline fetches it on its first run of that commit`);
      });
      mkdirSync(dirname(plan.copyDir), { recursive: true });
      try {
        await realGit(["clone", "--local", "--no-checkout", mirror, plan.copyDir]);
        /* Nothing in the copy can push: the remote is gone. */
        await realGit(["remote", "remove", "origin"], plan.copyDir);
        await realGit(["checkout", "-f", "--detach", plan.sha], plan.copyDir);
        await realGit(["clean", "-fd", "-e", "node_modules"], plan.copyDir);

        const e2eDir = join(plan.copyDir, SUITE_DIR);
        /* The suite's seed and dependency install are the pipeline's own setup step. */
        await buildSetupAdapter().setup(e2eDir);

        const repoConfig = join(e2eDir, WRAPPER_CONFIG);
        if (!existsSync(repoConfig)) throw new Error(`the suite has no ${WRAPPER_CONFIG} after setup`);
        const original = readFileSync(repoConfig, "utf8");
        const files = harnessFiles(plan.env);
        writeFileSync(join(e2eDir, WRAPPER_REPO_CONFIG), original, "utf8");
        writeFileSync(join(e2eDir, WRAPPER_ENV_MODULE), files.envModule, "utf8");
        writeFileSync(repoConfig, files.config, "utf8");

        writeFileSync(join(plan.copyDir, "opencode.json"), `${JSON.stringify(plan.agentConfig, null, 2)}\n`, "utf8");
        mkdirSync(plan.authDir, { recursive: true, mode: 0o700 });
      } catch (err) {
        rmSync(plan.copyDir, { recursive: true, force: true });
        throw err;
      }
    },
    removeCopy: (plan) => {
      rmSync(plan.copyDir, { recursive: true, force: true });
      rmSync(plan.authDir, { recursive: true, force: true });
    },
    commitMaterial: async (copyDir, sha) => {
      const message = await getCommitMessage(copyDir, sha, git);
      const diff = await getCommitDiff(copyDir, sha, git);
      const stat = await realGit(["show", "--stat", "--format=", "-m", "--first-parent", sha], copyDir);
      const names = await realGit(["show", "--format=", "--name-only", "-m", "--first-parent", sha], copyDir);
      return { message, stat, diff, changedFiles: names.split("\n").map((l) => l.trim()).filter(Boolean) };
    },

    resolvedPermissions: async (copyDir) => {
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      const client = createOpencodeClient({ baseUrl: serveUrl, ...(headers ? { headers } : {}) });
      const res = await client.app.agents({ directory: copyDir });
      if (res.error) throw new Error(`GET /agent failed: ${JSON.stringify(res.error)}`);
      const agent = (res.data ?? []).find((a) => a.name === BASELINE_AGENT);
      if (!agent) throw new Error(`the server resolved no agent '${BASELINE_AGENT}' for ${copyDir}: its project config was not picked up`);
      return agent.permission as PermissionRule[];
    },

    resolvedGeneratorModel: async (copyDir) => {
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      const client = createOpencodeClient({ baseUrl: serveUrl, ...(headers ? { headers } : {}) });
      const res = await client.app.agents({ directory: copyDir });
      const model = (res.data ?? []).find((a) => a.name === GENERATOR_AGENT)?.model;
      return model ? `${model.providerID}/${model.modelID}` : null;
    },

    prepareAuth: async (app, plan, phase) => {
      const adapter = new AuthSessionAdapter({
        env: process.env,
        authDir: plan.authDir,
        ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}),
        /* The login the pipeline's harness gives its own runs, discovery included: authentication is infrastructure and both arms get the same. */
        discovery: { discoverLogin: createDiscoverLogin({ runner }), redact: (text: string) => redaction.redact(text), loadContextMap: loadContextMapFromDisk },
        spawnSetup: async (specDir, childEnv, signal) => {
          const result = await runner.run({ command: "npx", args: ["playwright", "test", "--project=setup"], cwd: specDir, env: childEnv, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
          const logs = `${result.stdout}\n${result.stderr}`;
          return { exitCode: result.timedOut ? 1 : (result.exitCode ?? 1), logs: result.timedOut ? `auth setup timed out\n${logs}` : logs };
        },
      });
      const loaded = loadAppConfig(app.name);
      const session = await adapter.prepare({ specDir: join(plan.copyDir, SUITE_DIR), baseUrl: app.baseUrl, ...(loaded.auth ? { auth: loaded.auth } : {}), phase });
      return { unauthored: session.unauthored };
    },

    runAgent: async ({ copyDir, prompt, timeoutMs, keepSession }) => {
      await installHttpDispatcher(timeoutMs + 60_000);
      const { createOpencodeClient } = await import("@opencode-ai/sdk");
      const client = createOpencodeClient({ baseUrl: serveUrl, ...(headers ? { headers } : {}) });
      const created = await client.session.create({ query: { directory: copyDir } });
      const sessionId = created.data?.id;
      if (!sessionId) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const startedAt = Date.now();
      let ended: AgentRun["ended"] = "completed";
      let error: string | undefined;

      const prompted = client.session.prompt({ path: { id: sessionId }, query: { directory: copyDir }, body: { agent: BASELINE_AGENT, parts: [{ type: "text", text: prompt }] } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clock = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
      try {
        const winner = await Promise.race([prompted.then(() => "answered" as const, (e: unknown) => { throw e; }), clock]);
        if (winner === "timeout") {
          ended = "timeout";
          await client.session.abort({ path: { id: sessionId }, query: { directory: copyDir } }).catch(() => undefined);
          /* The aborted prompt settles shortly; its outcome is not needed, only its being over. */
          await Promise.race([prompted.catch(() => undefined), new Promise((r) => setTimeout(r, 30_000))]);
        } else {
          const info = (await prompted).data?.info as { error?: { name?: string; data?: { message?: string } } } | undefined;
          if (info?.error) {
            ended = "error";
            error = `${info.error.name ?? "error"}: ${info.error.data?.message ?? ""}`.trim();
          }
        }
      } catch (err) {
        ended = "error";
        error = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      const endedAt = Date.now();
      const messages = await client.session.messages({ path: { id: sessionId }, query: { directory: copyDir } });
      if (!keepSession) await client.session.delete({ path: { id: sessionId }, query: { directory: copyDir } }).catch(() => undefined);
      return { sessionId, startedAt, endedAt, ended, ...(error ? { error } : {}), messages: (messages.data ?? []) as unknown as SessionMessage[] };
    },

    changedFiles: async (copyDir) => {
      const specs = await listChangedSpecs(copyDir, SUITE_DIR, git);
      const status = await realGit(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], copyDir);
      const touched = status.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^.* -> /, ""));
      /* The harness's own files, and opencode.json, are ours and not the agent's. */
      const ours = new Set([`${SUITE_DIR}/${WRAPPER_CONFIG}`, `${SUITE_DIR}/${WRAPPER_REPO_CONFIG}`, `${SUITE_DIR}/${WRAPPER_ENV_MODULE}`, "opencode.json"]);
      return { specs, outsideSuite: touched.filter((p) => !p.startsWith(`${SUITE_DIR}/`) && !ours.has(p)) };
    },
    specLines: (copyDir, specs) => {
      const lines = new Map<string, number | null>();
      const root = { mirrorDir: copyDir, specDir: join(copyDir, SUITE_DIR) };
      for (const path of specs) {
        try {
          lines.set(path, countLines(readConfinedSpecFile(root, path)));
        } catch {
          lines.set(path, null);
        }
      }
      return lines;
    },
    runSuite: async ({ copyDir, authDir, app, namespace, specs }) => {
      const started = Date.now();
      const result = await runE2E(
        join(copyDir, SUITE_DIR),
        { baseUrl: app.baseUrl, namespace, specFiles: [...specs], ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}) },
        createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), authDir),
      );
      const count = (status: string): number => result.cases.filter((c) => c.status === status).length;
      return { verdict: result.verdict, passed: count("pass"), failed: count("fail"), flaky: count("flaky"), ms: Date.now() - started };
    },
    writeReport: (label, report) => {
      const path = join(defaultProbeResultsDir(), `${label}.json`);
      writeJsonAtomically(path, report);
      return path;
    },
    now: () => Date.now(),
    out: (line) => console.log(line),
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => main(process.argv.slice(2), deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

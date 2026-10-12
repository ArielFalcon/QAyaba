/*
 * The plain-agent arm of the pipeline-vs-plain-agent experiment. EXPERIMENT ONLY: nothing in the service
 * calls this, and it is not part of the pipeline.
 *
 *   npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> [--dry-run]
 *                             [--check-auth] [--keep-copy] [--keep-session] [--warm <snapshot-label>]
 *                             [--ground-truth <file>] [--keep-specs <dir>]
 *   npm run baseline-agent -- --app <app> --service <owner/repo> --service-sha <sha> --timeout-min <n> --label <l> [...]
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
 * `--warm <label>` starts the copy from a snapshot of the suite (scripts/warm-suite.ts) instead of the stock
 * seed: the same `e2e/` the pipeline arm is restored to, with a login already written for the app. The agent
 * is then not told about the login at all, and the specs the snapshot held are not counted as its own.
 *
 * `--service <owner/repo> --service-sha <sha>` is the cross-repo case: a backend service the app declares changed,
 * and the question is whether the agent finds the front-end behavior it affects. The copy is then the PRIMARY app at
 * its base branch's head (the suite lives there, as in a pipeline cross-repo run), the prompt carries the SERVICE
 * commit's message, stat and diff and says the change is deployed on DEV, and the service's source at that commit
 * sits read-only under services/<repo>/ in the copy, outside the suite directory. `--ground-truth <file>` scores
 * what the agent read and the routes its specs navigate to (scripts/probe-metrics.ts).
 *
 * Run it inside the orchestrator container, with the queue idle: DEV is used by one thing at a time.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { CallEfficiencyTracker } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { buildTurnStepBudget, type TurnCallMetrics } from "@contexts/generation/domain/turn-efficiency-summary.ts";
import { finalStepText } from "@contexts/generation/domain/step-exhaustion.ts";
import { AUTH_MATERIAL_FILES } from "../qa-engine/src/shared-infrastructure/process-sandbox/auth-session-env.ts";
import { EXPERIMENT_COPIES_DIR, WARM_SNAPSHOTS_DIR } from "../src/paths.ts";
import {
  DEFAULT_SUITE_DIR, contentReadsOf, promptSections, renderMarkdown, scoreGroundTruth, totalsOf, turnFromCallMetrics, type GroundTruth, type PhaseDurations, type ProbeReport, type ProbeSpec, type ReadingContext,
} from "./probe-metrics.ts";
import { assertFileName, defaultProbeResultsDir, readGroundTruthFile, writeJsonAtomically } from "./probe-report.ts";
import { saveSuiteFiles, specsOf, suiteDelta } from "./campaign-suite.ts";
import { prepareHarnessAuth } from "./harness-auth.ts";
import { loadSnapshot, restoreSuite, specsTouchedSinceSnapshot, warmSnapshotDir, warmStatus, type LoadedSnapshot } from "./warm-suite.ts";
import { MAX_FILE_BYTES } from "../qa-engine/src/shared-infrastructure/suite-tree.ts";

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
/** Where, at the root of the throwaway copy, a cross-repo case puts the service's source. */
export const SERVICES_DIR = "services";

/** The directory (relative to the copy's root, no trailing slash) a service's source is placed in. */
export function serviceDirOf(repo: string): string {
  return `${SERVICES_DIR}/${repo.split("/").pop()}`;
}

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

/**
 * The permission block of the baseline agent. Every tool not named is denied; the order matters (the last matching rule wins).
 * `readOnlyDirs` are directories of the copy the agent may read but never change (a cross-repo case's service source).
 */
export function baselinePermission(readOnlyDirs: readonly string[] = []): PermissionConfig {
  return {
    "*": "deny",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: { "*": "allow", ...Object.fromEntries(readOnlyDirs.map((dir) => [`${dir}/*`, "deny"])) },
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
export function baselineAgentConfig(g: GeneratorSettings, readOnlyDirs: readonly string[] = []): { $schema: string; agent: Record<string, unknown> } {
  return {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [BASELINE_AGENT]: {
        description: "Experiment arm A: one plain agent with the repository, the live DEV site and a Playwright runner. No pipeline stages.",
        mode: "primary",
        model: g.model,
        ...(g.steps !== null ? { steps: g.steps } : {}),
        ...(g.temperature !== null ? { temperature: g.temperature } : {}),
        permission: baselinePermission(readOnlyDirs),
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

/** What a cross-repo case adds to the probes: the service's source is readable and searchable, and no tool may change it. */
export function servicePermissionProbes(dir: string): PermissionProbe[] {
  return [
    probe("read", `${dir}/src/main/java/Handler.java`, "allow"), probe("read", `${dir}/.env`, "deny"), probe("grep", "DUPLICATE", "allow"), probe("glob", `${dir}/**/*.java`, "allow"),
    probe("edit", `${dir}/src/main/java/Handler.java`, "deny"), probe("edit", `${dir}/new-file.txt`, "deny"), probe("edit", "e2e/flows/checkout.spec.ts", "allow"),
  ];
}

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

/** The backend change a cross-repo case is about, as the prompt names it. */
export interface PromptService {
  repo: string;
  sha: string;
  /** Where the service's source is, relative to the working directory. */
  dir: string;
}

export interface PromptInput {
  baseUrl: string;
  /** The app's `qa.testDataPrefix`. */
  testDataPrefix: string;
  /** True when the automatic login did not work for this app: the agent is told where the login is and how to run it. */
  loginUnavailable?: boolean;
  commitMessage: string;
  stat: string;
  diff: string;
  /** Present when the commit is a backend service's and the application under test is its consumer (the cross-repo case). */
  service?: PromptService;
}

/** The instructions of the prompt, apart from the commit material. A handful of lines, generic to any app. */
export function baselineInstructions(input: Pick<PromptInput, "baseUrl" | "testDataPrefix" | "loginUnavailable" | "service">): string[] {
  const task = input.service
    ? [
        `A change to the backend service ${input.service.repo} (commit ${input.service.sha.slice(0, 7)}) is deployed on the live DEV site ${input.baseUrl}.`,
        `The application under test is the repository in the current directory; the service's source at that commit is under ${input.service.dir}/ (read-only: read it, do not change it).`,
        "Write Playwright E2E tests under e2e/ that verify the front-end behavior this backend change affects, against the live DEV site.",
      ]
    : [`Write Playwright E2E tests under e2e/ that verify this change against the live DEV site ${input.baseUrl}.`];
  return [
    ...task,
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
  const of = input.service ? " of the backend change" : "";
  return [
    ...baselineInstructions(input),
    "",
    `Commit message${of}:`,
    redact(input.commitMessage.trim()),
    "",
    `git show --stat${of}:`,
    redact(input.stat.trim()),
    "",
    `Full diff${of}:`,
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
  /** The commit under test: the app's own, or, in a cross-repo case, the service's (`--service-sha`). */
  sha: string;
  /** The backend service whose commit is under test (cross-repo case), or null for a commit of the app itself. */
  service: { repo: string } | null;
  /** The ground-truth file to score the run against, or null. */
  groundTruthPath: string | null;
  timeoutMin: number | null;
  label: string;
  dryRun: boolean;
  checkAuth: boolean;
  keepCopy: boolean;
  keepSession: boolean;
  /** The label of the warm-start snapshot (scripts/warm-suite.ts) the copy's suite starts from, or null for the stock seed. */
  warm: string | null;
  /** A directory to put every file the agent added or changed in the suite directory into, before the copy is removed; null keeps nothing. */
  keepSpecsDir: string | null;
}

const HEX_COMMIT_ID = /^[0-9a-f]{7,40}$/i;
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseArguments(argv: readonly string[]): { ok: true; args: BaselineArguments } | { ok: false; problem: string } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const valued = new Set(["--app", "--sha", "--timeout-min", "--label", "--warm", "--service", "--service-sha", "--ground-truth", "--keep-specs"]);
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
  const serviceRepo = values["--service"];
  const serviceSha = values["--service-sha"];
  if ((serviceRepo === undefined) !== (serviceSha === undefined)) return { ok: false, problem: "error: --service and --service-sha go together" };
  if (serviceRepo !== undefined) {
    if (values["--sha"] !== undefined) return { ok: false, problem: "error: --sha is the app's own commit: with --service the commit under test is --service-sha" };
    if (!REPO_SLUG.test(serviceRepo)) return { ok: false, problem: "error: --service must be <owner>/<repo>" };
    values["--sha"] = serviceSha!;
  }
  for (const required of ["--app", "--sha", "--label"]) if (!values[required]) return { ok: false, problem: `error: ${required} is required` };
  if (!HEX_COMMIT_ID.test(values["--sha"]!)) return { ok: false, problem: `error: ${serviceRepo !== undefined ? "--service-sha" : "--sha"} must be 7-40 hex characters` };
  let timeoutMin: number | null = null;
  if (values["--timeout-min"] !== undefined) {
    timeoutMin = Number(values["--timeout-min"]);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) return { ok: false, problem: "error: --timeout-min needs a positive number of minutes" };
  }
  if (timeoutMin === null && !flags.has("--dry-run")) return { ok: false, problem: "error: --timeout-min is required (the wall-clock limit of the agent session)" };
  if (values["--keep-specs"] !== undefined && values["--warm"] === undefined) return { ok: false, problem: "error: --keep-specs needs --warm: what the agent delivered is what differs from the snapshot its suite started from" };
  try {
    assertFileName(values["--label"]!, "label");
    assertFileName(values["--app"]!, "app");
    if (values["--warm"] !== undefined) assertFileName(values["--warm"], "warm snapshot label");
  } catch (err) {
    return { ok: false, problem: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    args: {
      app: values["--app"]!, sha: values["--sha"]!, service: serviceRepo !== undefined ? { repo: serviceRepo } : null, groundTruthPath: values["--ground-truth"] ?? null, timeoutMin, label: values["--label"]!,
      dryRun: flags.has("--dry-run"), checkAuth: flags.has("--check-auth"), keepCopy: flags.has("--keep-copy"), keepSession: flags.has("--keep-session"),
      warm: values["--warm"] ?? null, keepSpecsDir: values["--keep-specs"] ?? null,
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
  /** The branch the app's suite is built on (the `baseBranch` of its config, `main` when it states none). */
  baseBranch: string;
  /** The repos of the backend services the app declares. */
  services: string[];
}

/** The backend commit a cross-repo case is about, and where its source goes in the copy. */
export interface ServicePlan {
  repo: string;
  sha: string;
  /** Relative to the copy's root, no trailing slash. */
  dir: string;
}

export interface CopyPlan {
  repo: string;
  /** The commit of `repo` the copy is checked out at: the commit under test, or, in a cross-repo case, the head of its base branch. */
  sha: string;
  /** Set in a cross-repo case: the service whose source is placed read-only in the copy. */
  service?: ServicePlan;
  /** The throwaway working copy. */
  copyDir: string;
  /** The orchestrator-only login material, beside the copy. */
  authDir: string;
  env: HarnessEnv;
  agentConfig: { $schema: string; agent: Record<string, unknown> };
  /** The snapshot the copy's suite directory is made equal to before setup, in place of the stock seed. */
  warm?: LoadedSnapshot;
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
  /** The warm-start snapshot `label` of the app, whole and checked against its manifest; throws when there is none. */
  loadWarmSnapshot(app: string, label: string): LoadedSnapshot;
  agentsConfig(): unknown;
  copyDirFor(label: string, app: AppInfo): { copyDir: string; authDir: string };
  copyExists(copyDir: string): boolean;
  /** The commit the app's base branch is at in its mirror, as the last pipeline sync left it (read-only: nothing is fetched). Throws when there is none. */
  resolveBaseBranchHead(repo: string, branch: string): Promise<string>;
  /** The ground truth in the file; throws, naming it, when it cannot be read or scored. */
  readGroundTruth(path: string): GroundTruth;
  /**
   * Clones the working copy at the commit, puts the warm snapshot's suite in place when the plan has one, installs the suite's dependencies, writes the agent's config and the harness files.
   * With a service in the plan, the service's source at its commit is placed under the plan's service directory, without any git data.
   */
  prepareCopy(plan: CopyPlan): Promise<void>;
  removeCopy(plan: CopyPlan): void;
  /** The message, stat and diff of the commit under test: the plan's own commit, or the service's in a cross-repo case. */
  commitMaterial(plan: CopyPlan): Promise<CommitMaterial>;
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
  /** The specs the agent added or changed, relative to the suite directory (those the warm snapshot held, unchanged, are not its), and the paths it changed outside the suite directory. */
  changedFiles(copyDir: string, warm?: LoadedSnapshot, serviceDir?: string): Promise<{ specs: string[]; outsideSuite: string[] }>;
  /**
   * Copies every file the agent added or changed in the suite directory (specs and the helpers they import, not this harness's own files) to `dest`,
   * keeping relative paths. Throws when it cannot: a copy that is about to be removed holds the only copy of the agent's work.
   */
  keepSuiteFiles(copyDir: string, dest: string, warm: LoadedSnapshot | undefined): Promise<{ files: number; specs: number }>;
  specLines(copyDir: string, specs: readonly string[]): Map<string, number | null>;
  /** The source of each spec, for the routes it navigates to; a spec that cannot be read is null. */
  specSources(copyDir: string, specs: readonly string[]): Map<string, string | null>;
  runSuite(input: { copyDir: string; authDir: string; app: AppInfo; namespace: string; specs: readonly string[] }): Promise<SuiteRun>;
  writeReport(label: string, report: ProbeReport): string;
  now(): number;
  out(line: string): void;
}

const MS_PER_MIN = 60_000;
const WARM_LOGIN_FAILED = "the warm snapshot's auth.setup.ts could not log in to this app (the snapshot may be stale): the case would not be a warm start";
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
    if (args.service && !app.services.includes(args.service.repo)) {
      throw new Error(`${args.service.repo} is not a declared service of app '${app.name}' (declared: ${app.services.join(", ") || "none"}): a cross-repo case is run for a service the app declares`);
    }
    const groundTruth = args.groundTruthPath !== null ? deps.readGroundTruth(args.groundTruthPath) : undefined;
    const warm = args.warm !== null ? deps.loadWarmSnapshot(app.name, args.warm) : undefined;
    if (warm) {
      const status = warmStatus(warm);
      if (!status.warm) throw new Error(`warm snapshot '${warm.label}' is not warm: ${status.note}`);
      out(`[baseline] warm start: the suite starts from snapshot '${warm.label}' (${warm.manifest.files.length} files, taken ${warm.manifest.createdAt}), not from the stock seed`);
    }
    const generator = generatorSettings(deps.agentsConfig());
    const { copyDir, authDir } = deps.copyDirFor(args.label, app);
    if (deps.copyExists(copyDir)) throw new Error(`${copyDir} already exists: a label names one run, pick another or remove the directory`);
    const namespace = `${app.testDataPrefix}-${args.sha.slice(0, 7)}-${args.label}`;
    /* A cross-repo case: the copy is the app at its base branch's head, as in a pipeline cross-repo run; the service's commit is what the agent is told about. */
    const service: ServicePlan | undefined = args.service ? { repo: args.service.repo, sha: args.sha, dir: serviceDirOf(args.service.repo) } : undefined;
    const primarySha = service ? await deps.resolveBaseBranchHead(app.repo, app.baseBranch) : args.sha;
    if (service) {
      out(`[baseline] cross-repo case: the app ${app.repo} at ${app.baseBranch} (${primarySha.slice(0, 7)}, as its mirror holds it: nothing is fetched), the change is ${service.repo}@${service.sha.slice(0, 7)}, its source read-only under ${service.dir}/`);
    }
    plan = {
      repo: app.repo, sha: primarySha, ...(service ? { service } : {}), copyDir, authDir,
      env: { baseUrl: app.baseUrl, namespace, ...(app.testIdAttribute ? { testIdAttribute: app.testIdAttribute } : {}), storageStatePath: join(authDir, AUTH_MATERIAL_FILES.storageState) },
      agentConfig: baselineAgentConfig(generator, service ? [service.dir] : []),
      ...(warm ? { warm } : {}),
    };

    const setupStarted = deps.now();
    out(`[baseline] preparing the throwaway copy of ${app.repo} at ${primarySha.slice(0, 7)}: ${copyDir}`);
    await deps.prepareCopy(plan);
    const material = await deps.commitMaterial(plan);
    const promptFor = (loginUnavailable: boolean): string =>
      buildBaselinePrompt({ baseUrl: app.baseUrl, testDataPrefix: app.testDataPrefix, loginUnavailable, commitMessage: material.message, stat: material.stat, diff: material.diff, ...(service ? { service } : {}) });

    const rules = await deps.resolvedPermissions(copyDir);
    const outcomes = checkProbes(rules, service ? [...PERMISSION_PROBES, ...servicePermissionProbes(service.dir)] : PERMISSION_PROBES);
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
        loginUnavailable = login.unauthored && !warm;
        if (login.unauthored && warm) throw new Error(WARM_LOGIN_FAILED);
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
    /* A warm suite brings its own login: the agent is never told to write one, and one that does not work stops the case (it would not be warm). */
    if (login.unauthored && warm) throw new Error(WARM_LOGIN_FAILED);
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

    const changed = await deps.changedFiles(copyDir, warm, service?.dir);
    const specs = changed.specs;
    if (args.keepSpecsDir !== null) {
      const kept = await deps.keepSuiteFiles(copyDir, args.keepSpecsDir, warm);
      out(`[baseline] kept ${kept.files} file(s), ${kept.specs} spec(s), in ${args.keepSpecsDir}`);
    }
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
    const sources = groundTruth ? deps.specSources(copyDir, specs) : undefined;
    const readSpecs = sources ? specs.flatMap((path) => { const text = sources.get(path); return typeof text === "string" ? [text] : []; }) : [];
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
      /* No stitcher feeds this arm: it has no service links to count, and its prompt carries none of the advisory sections. */
      stitcher: { serviceLinksCount: null, contractDriftCount: null, structuralSignalBytes: null, crossRepoImpactedCount: null, generatorPrompt: promptSections(prompt) },
      ...(groundTruth
        ? { groundTruth: scoreGroundTruth(groundTruth, { briefText: null, filesRead: contentReadsOf([turn]), specSources: specs.length > 0 && readSpecs.length === 0 ? null : readSpecs }) }
        : {}),
      detail: {
        ...(service ? { service: { repo: service.repo, sha: service.sha, dir: service.dir, primaryRepo: app.repo, primaryBranch: app.baseBranch, primarySha } } : {}),
        groundTruthFile: args.groundTruthPath,
        model: generator.model, stepCap: generator.steps, timeoutMin: args.timeoutMin, warmSnapshot: warm?.label ?? null, sessionId: run.sessionId, sessionError: run.error ?? null,
        suiteRuns: runs, declaredNoop: declaresNoop(finalText), changedOutsideSuite: changed.outsideSuite,
        finalText: redact(finalText).slice(0, 4_000), namespace, copyDir: args.keepCopy ? copyDir : null, keptSpecsDir: args.keepSpecsDir,
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
  "usage: npm run baseline-agent -- --app <app> --sha <sha> --timeout-min <n> --label <l> [--dry-run] [--check-auth] [--keep-copy] [--keep-session] [--warm <snapshot-label>] [--ground-truth <file>] [--keep-specs <dir>]",
  "       npm run baseline-agent -- --app <app> --service <owner/repo> --service-sha <sha> --timeout-min <n> --label <l> [...the same options]",
  "  EXPERIMENT ONLY. Runs one plain agent (no pipeline stages) on a throwaway copy of the app at the commit, then runs its specs twice,",
  "  and writes config/benchmarks/probe-results/<label>.json in the shape probe-report emits.",
  "  --dry-run       prepare the copy, print the prompt and the permissions the server resolved for the agent, start no session",
  "  --check-auth    with --dry-run: also log in once to DEV, to prove the session the agent's tests use",
  "  --keep-copy     keep the throwaway copy (default: removed at the end of a dry run, kept never otherwise unless set)",
  "  --keep-session  keep the OpenCode session (default: deleted once its metrics are collected)",
  "  --warm <label>  start the copy's e2e/ from a warm-suite snapshot (login already authored) instead of the stock seed; the prompt then says nothing about the login",
  "  --service <owner/repo> --service-sha <sha>  cross-repo case: the commit under test is a declared backend service's. The copy is the app at its base branch's head",
  "                  (as its mirror holds it: nothing is fetched, so run the pipeline arm first), the prompt carries the service commit and says it is deployed on DEV, and the",
  "                  service's source at that commit is read-only under services/<repo>/. Replaces --sha.",
  "  --keep-specs <dir>  copy every file the agent added or changed in e2e/ (needs --warm) to <dir> before the copy is removed",
  "  --ground-truth <file>  score what the agent read and the routes its specs navigate to against a ground truth (config/benchmarks/ground-truth/)",
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
  const { readConfinedSpecFile, readConfinedSpecBytes } = await import("../qa-engine/src/shared-infrastructure/spec-path-confinement.ts");
  const { runE2E, createDefaultE2eExecuteDeps, e2eTimeoutMs } = await import("../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts");
  const { ProcessKillAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts");
  const { installHttpDispatcher } = await import("../src/util/net.ts");

  const service = await defaultService(env);
  const mirrorsRoot = workdirRoot();
  const git = defaultMirrorDeps;
  const slug = (repo: string): string => repo.replaceAll("/", "__");
  const serveUrl = env.OPENCODE_SERVE_URL ?? "http://agents:4096";
  const serverPassword = env.OPENCODE_SERVER_PASSWORD;
  const headers = serverPassword ? { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } : undefined;

  /* The agent wrote these specs, so they are read only through the confined reader. */
  const readSpecs = (copyDir: string, specs: readonly string[]): Map<string, string | null> => {
    const sources = new Map<string, string | null>();
    const root = { mirrorDir: copyDir, specDir: join(copyDir, SUITE_DIR) };
    for (const path of specs) {
      try {
        sources.set(path, readConfinedSpecFile(root, path));
      } catch {
        sources.set(path, null);
      }
    }
    return sources;
  };

  /**
   * The service's source at its commit, as plain files under the copy's service directory: cloned from the service's mirror (which is only read:
   * nothing is fetched), checked out, and its git data removed, so nothing past the commit can be read and no git command can be run in it.
   */
  const placeServiceSource = async (svc: ServicePlan, copyDir: string): Promise<void> => {
    const mirror = join(mirrorsRoot, slug(svc.repo));
    if (!existsSync(mirror)) throw new Error(`there is no mirror of ${svc.repo} at ${mirror}: the pipeline fetches it on its first run of that service`);
    await realGit(["cat-file", "-e", `${svc.sha}^{commit}`], mirror).catch(() => {
      throw new Error(`commit ${svc.sha} is not in the mirror of ${svc.repo}: the pipeline fetches it on its first run of that commit`);
    });
    const dest = join(copyDir, svc.dir);
    mkdirSync(dirname(dest), { recursive: true });
    await realGit(["clone", "--local", "--no-checkout", mirror, dest]);
    await realGit(["checkout", "-f", "--detach", svc.sha], dest);
    rmSync(join(dest, ".git"), { recursive: true, force: true });
  };

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
      return {
        name: app.name, repo: app.repo, baseUrl: app.dev.baseUrl, testDataPrefix: app.qa.testDataPrefix, baseBranch: app.baseBranch ?? "main", services: (app.services ?? []).map((s) => s.repo),
        ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
      };
    },
    resolveBaseBranchHead: async (repo, branch) => {
      const mirror = join(mirrorsRoot, slug(repo));
      if (!existsSync(mirror)) throw new Error(`there is no mirror of ${repo} at ${mirror}: run the pipeline on the app once first`);
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(branch)) throw new Error(`'${branch}' is not a branch name this arm will pass to git`);
      const head = (await realGit(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], mirror).catch(() => "")).trim();
      if (!head) throw new Error(`the mirror of ${repo} holds no origin/${branch}: run the pipeline on the app once first`);
      return head;
    },
    readGroundTruth: readGroundTruthFile,
    loadWarmSnapshot: (appName, label) => loadSnapshot(warmSnapshotDir(join(mirrorsRoot, WARM_SNAPSHOTS_DIR), appName, label), label),
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
        /* A warm start: the suite directory is the snapshot's, exactly (whatever the commit tracked there goes), so setup finds a login written for the app and leaves it. */
        if (plan.warm) restoreSuite(plan.warm, { mirrorDir: plan.copyDir, e2eDir });
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
        if (plan.service) await placeServiceSource(plan.service, plan.copyDir);
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
    commitMaterial: async (plan) => {
      /* A service's commit is read from its mirror (a read-only look at its objects): the copy holds only its files, no git data. */
      const [copyDir, sha] = plan.service ? [join(mirrorsRoot, slug(plan.service.repo)), plan.service.sha] : [plan.copyDir, plan.sha];
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

    prepareAuth: (app, plan, phase) =>
      prepareHarnessAuth({ appName: app.name, baseUrl: app.baseUrl, ...(app.testIdAttribute !== undefined ? { testIdAttribute: app.testIdAttribute } : {}), specDir: join(plan.copyDir, SUITE_DIR), authDir: plan.authDir, phase }),

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

    changedFiles: async (copyDir, warm, serviceDir) => {
      const listed = await listChangedSpecs(copyDir, SUITE_DIR, git);
      const root = { mirrorDir: copyDir, specDir: join(copyDir, SUITE_DIR) };
      const hashOf = (spec: string): string | null => {
        try {
          return createHash("sha256").update(readConfinedSpecBytes(root, spec, MAX_FILE_BYTES)).digest("hex");
        } catch {
          return null;
        }
      };
      const specs = warm ? specsTouchedSinceSnapshot(listed, warm.manifest, hashOf) : listed;
      const status = await realGit(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], copyDir);
      const touched = status.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^.* -> /, ""));
      /* The harness's own files, and opencode.json, are ours and not the agent's. */
      const ours = new Set([`${SUITE_DIR}/${WRAPPER_CONFIG}`, `${SUITE_DIR}/${WRAPPER_REPO_CONFIG}`, `${SUITE_DIR}/${WRAPPER_ENV_MODULE}`, "opencode.json"]);
      /* The service's source was placed by the harness, whatever the agent did to it (it may not edit it). */
      const placed = (p: string): boolean => serviceDir !== undefined && p.startsWith(`${serviceDir}/`);
      return { specs, outsideSuite: touched.filter((p) => !p.startsWith(`${SUITE_DIR}/`) && !ours.has(p) && !placed(p)) };
    },
    keepSuiteFiles: async (copyDir, dest, warm) => {
      if (!warm) throw new Error("keepSuiteFiles needs the warm snapshot the suite started from");
      const delta = suiteDelta({ mirrorDir: copyDir, e2eDir: join(copyDir, SUITE_DIR) }, warm.manifest, new Set([WRAPPER_CONFIG, WRAPPER_REPO_CONFIG, WRAPPER_ENV_MODULE]));
      saveSuiteFiles(dest, delta.files);
      return { files: delta.files.length, specs: specsOf(delta.files).length };
    },
    specLines: (copyDir, specs) => new Map([...readSpecs(copyDir, specs)].map(([path, text]) => [path, text === null ? null : countLines(text)])),
    specSources: readSpecs,
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

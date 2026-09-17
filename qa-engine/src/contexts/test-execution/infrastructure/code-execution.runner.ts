/* Code-mode runner: install the repo's deps and classify by exit code (binary pass/fail, no flaky). Sandbox is injected — this module never reads process.env. A missing runtime is infra-error, never a pass. Local result type so this file stays src/-free. */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText, type SecretDetection } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { sandboxSpawnOptions, type Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";

/** Local result shape so this file stays src/-free. */
export interface CodeRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
}

export type Ecosystem = "node" | "python" | "go" | "rust" | "maven" | "gradle" | "unknown";

export interface Command {
  cmd: string;
  args: string[];
}

export interface CodeProject {
  ecosystem: Ecosystem;
  install: Command | null;
  test: Command;
}


export interface DetectDeps {
  exists(path: string): boolean;
  readJson(path: string): Record<string, unknown> | null;
}

export const realDetectDeps: DetectDeps = {
  exists: existsSync,
  readJson: (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
};

export function detectCodeProject(repoDir: string, deps: DetectDeps = realDetectDeps): CodeProject {
  const at = (f: string): string => join(repoDir, f);

  if (deps.exists(at("package.json"))) {
    const pm: "npm" | "pnpm" | "yarn" = deps.exists(at("pnpm-lock.yaml"))
      ? "pnpm"
      : deps.exists(at("yarn.lock"))
        ? "yarn"
        : "npm";
    const pkg = deps.readJson(at("package.json")) ?? {};
    /* `--ignore-scripts`: the watched repo is UNTRUSTED code running in the orchestrator. A package.json install lifecycle (preinstall/postinstall/prepare) is arbitrary code execution — the cheapest RCE vector. Skipping it closes that vector (SEC-01). Fail-safe: a repo that genuinely needs a build script will fail its test command → infra-error (inconclusive), never a false pass. (Only the code-mode UNTRUSTED install; the e2e seed install is the orchestrator's own trusted fixtures and keeps its scripts.) */
    const install: Command =
      pm === "npm"
        ? { cmd: "npm", args: [deps.exists(at("package-lock.json")) ? "ci" : "install", "--ignore-scripts"] }
        : { cmd: pm, args: ["install", "--ignore-scripts"] };
    return { ecosystem: "node", install, test: nodeTestCommand(pm, pkg) };
  }

  if (
    deps.exists(at("pyproject.toml")) ||
    deps.exists(at("setup.py")) ||
    deps.exists(at("requirements.txt")) ||
    deps.exists(at("pytest.ini")) ||
    deps.exists(at("tox.ini"))
  ) {
    const install: Command | null = deps.exists(at("requirements.txt"))
      ? { cmd: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"] }
      : deps.exists(at("pyproject.toml")) || deps.exists(at("setup.py"))
        ? { cmd: "python3", args: ["-m", "pip", "install", "-e", "."] }
        : null;
    return { ecosystem: "python", install, test: { cmd: "python3", args: ["-m", "pytest", "-q"] } };
  }

  if (deps.exists(at("go.mod"))) {
    return { ecosystem: "go", install: { cmd: "go", args: ["mod", "download"] }, test: { cmd: "go", args: ["test", "./..."] } };
  }

  if (deps.exists(at("Cargo.toml"))) {
    return { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
  }

  if (deps.exists(at("pom.xml"))) {
    return { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  }
  if (deps.exists(at("build.gradle")) || deps.exists(at("build.gradle.kts"))) {
    const gradlew = deps.exists(at("gradlew"));
    return { ecosystem: "gradle", install: null, test: { cmd: gradlew ? "./gradlew" : "gradle", args: ["test"] } };
  }

  return { ecosystem: "unknown", install: null, test: { cmd: "npm", args: ["test"] } };
}

function nodeTestCommand(pm: "npm" | "pnpm" | "yarn", pkg: Record<string, unknown>): Command {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const hasRealTestScript = typeof scripts.test === "string" && !/no test specified/i.test(scripts.test);
  if (hasRealTestScript) return { cmd: pm, args: ["test"] };

  const deps = {
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.dependencies as Record<string, string>) ?? {}),
  };
  if ("vitest" in deps) return { cmd: "npx", args: ["vitest", "run"] };
  if ("jest" in deps) return { cmd: "npx", args: ["jest"] };
  if ("mocha" in deps) return { cmd: "npx", args: ["mocha"] };
  return { cmd: "node", args: ["--test"] };
}


const MODULE_DESCRIPTORS: Partial<Record<Ecosystem, readonly string[]>> = {
  maven: ["pom.xml"],
  gradle: ["build.gradle", "build.gradle.kts"],
  go: ["go.mod"],
  node: ["package.json"],
};

const RUN_SCOPE_SUPPORTED = new Set<Ecosystem>(["maven", "gradle", "go", "node"]);

function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

export function resolveChangedModules(
  ecosystem: Ecosystem,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists">,
): string[] | null {
  const descriptors = MODULE_DESCRIPTORS[ecosystem];
  if (!descriptors || changedFiles.length === 0) return null;
  const hasDescriptor = (dir: string): boolean => descriptors.some((d) => deps.exists(join(repoDir, dir, d)));

  const modules = new Set<string>();
  for (const file of changedFiles) {
    let dir = parentDir(file);
    let resolved: string | null = null;
    while (dir) {
      if (hasDescriptor(dir)) {
        resolved = dir;
        break;
      }
      dir = parentDir(dir);
    }
    if (resolved === null) return null;
    modules.add(resolved);
  }
  return [...modules].sort();
}

export function scopeTestCommand(project: CodeProject, modules: string[]): Command | null {
  switch (project.ecosystem) {
    case "maven":
      return { cmd: "mvn", args: ["-B", "-pl", modules.join(","), "-am", "test"] };
    case "gradle":
      return { cmd: project.test.cmd, args: modules.map((m) => `:${m.replace(/\//g, ":")}:test`) };
    case "go":
      return { cmd: "go", args: ["test", ...modules.map((m) => `./${m}/...`)] };
    case "node": {
      const t = project.test;
      const direct = t.args.includes("jest") || t.args.includes("vitest") || (t.cmd === "node" && t.args.includes("--test"));
      return direct ? { cmd: t.cmd, args: [...t.args, ...modules] } : null;
    }
    default:
      return project.test;
  }
}

export interface ScopedRun {
  test: Command;
  scoped: boolean;
  note: string;
}

export function scopeForChangedFiles(
  project: CodeProject,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists"> = realDetectDeps,
): ScopedRun {
  if (changedFiles.length === 0) {
    return { test: project.test, scoped: false, note: "non-diff run (no changed-file list) — running the whole repo" };
  }
  if (!RUN_SCOPE_SUPPORTED.has(project.ecosystem)) {
    return { test: project.test, scoped: false, note: `per-module run scoping is not yet supported for ${project.ecosystem} — running the whole repo` };
  }
  const modules = resolveChangedModules(project.ecosystem, repoDir, changedFiles, deps);
  if (!modules || modules.length === 0) {
    return {
      test: project.test,
      scoped: false,
      note: `changed files did not all resolve to a ${project.ecosystem} submodule — running the whole repo`,
    };
  }
  const scopedTest = scopeTestCommand(project, modules);
  if (!scopedTest) {
    return { test: project.test, scoped: false, note: `could not scope the ${project.ecosystem} run command — running the whole repo` };
  }
  return { test: scopedTest, scoped: true, note: `scoped to module(s): ${modules.join(", ")}` };
}

export function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    files.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return files;
}

export function effectiveChangedFiles(
  inputChangedFiles: string[],
  repoDir: string,
  listWrites?: (repoDir: string) => string[],
): string[] {
  if (inputChangedFiles.length > 0) return inputChangedFiles;
  return listWrites ? listWrites(repoDir) : [];
}

/** Default writes probe: the working-tree changes in the mirror (the agent's generated tests are uncommitted there). Best-effort — any git failure yields [] (→ whole-repo fallback), never throws. */
export function gitWorkingChanges(repoDir: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
    return parsePorcelain(out);
  } catch {
    return [];
  }
}


export interface CodeRunOutput {
  exitCode: number | null;
  logs: string;
  spawnError?: string;
}

export interface CodeExecuteDeps {
  detect(repoDir: string): CodeProject;
  runTests(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CodeRunOutput>;
  listWrites?(repoDir: string): string[];
  /* OPTIONAL diagnostic sink for a secret-redaction audit trail (src/orchestrator/sanitizer.ts's recordAudit/SECRET_AUDIT — a security-boundary concern this module does not import directly, to stay src/-free). Absent ⇒ no audit recorded (safe for every unit test that doesn't care about it). */
  recordAudit?(runId: string, detection: SecretDetection): void;
}

export interface CodeExecuteOptions {
  namespace: string;
  onCase?: (c: QaCase) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  changedFiles?: string[];
  log?: (line: string) => void;
}

export const DEFAULT_CODE_MODE_TIMEOUT_MS = 600_000;

export function ranZeroTests(project: CodeProject, out: CodeRunOutput): boolean {
  const log = out.logs;
  const cmd = `${project.test.cmd} ${project.test.args.join(" ")}`;

  if (project.ecosystem === "python" && out.exitCode === 5) return true;

  if (project.ecosystem === "go" && out.exitCode === 0 && /no test files/.test(log) && !/^ok\s/m.test(log)) return true;

  if (project.ecosystem === "node" && /(?:#|ℹ)\s*tests\s+0\b/.test(log)) return true;

  if (/\bnpx (?:jest|vitest)\b/.test(cmd) && /No tests? (?:found|files? found)/i.test(log)) return true;

  if (cmd.includes("npx mocha") && out.exitCode === 0 && /\b0 passing\b/.test(log)) return true;

  if (project.ecosystem === "rust" && out.exitCode === 0 && /running 0 tests/.test(log) && !/running [1-9]\d* tests?/.test(log)) return true;

  if (project.ecosystem === "maven" && out.exitCode === 0 && !/Tests run: [1-9]/.test(log)) return true;

  if (project.ecosystem === "gradle" && out.exitCode === 0 && /> Task :\S*[Tt]est\S*\s+(?:NO-SOURCE|SKIPPED)/.test(log)) return true;

  return false;
}

export function parseTestCounts(logs: string): { pass: number; fail: number; total: number } | null {
  const nodeMatch = logs.match(/(?:[ℹ#])\s*tests\s+(\d+)[\s\S]*?(?:[ℹ#])\s*pass\s+(\d+)[\s\S]*?(?:[ℹ#])\s*fail\s+(\d+)/);
  if (nodeMatch) return { pass: Number(nodeMatch[2]), fail: Number(nodeMatch[3]), total: Number(nodeMatch[1]) };
  const jestMatch = logs.match(/Tests:\s*(\d+)\s+passed?,\s*(\d+)\s+failed?,\s*(\d+)\s+total/i);
  if (jestMatch) return { pass: Number(jestMatch[1]), fail: Number(jestMatch[2]), total: Number(jestMatch[3]) };
  const pyMatch = logs.match(/(\d+)\s+passed?,\s*(\d+)\s+failed/i);
  if (pyMatch) { const p=Number(pyMatch[1]), f=Number(pyMatch[2]); return { pass: p, fail: f, total: p+f }; }
  const mochaMatch = logs.match(/(\d+)\s+passing/i);
  if (mochaMatch) { const p=Number(mochaMatch[1]); return { pass: p, fail: 0, total: p }; }
  return null;
}

export async function runCodeTests(
  repoDir: string,
  opts: CodeExecuteOptions,
  deps: CodeExecuteDeps,
): Promise<CodeRunResult> {
  const detected = deps.detect(repoDir);
  const changed = effectiveChangedFiles(opts.changedFiles ?? [], repoDir, deps.listWrites);
  const scope = scopeForChangedFiles(detected, repoDir, changed);
  opts.log?.(`[qa] code-mode: ${scope.note}`);
  const project: CodeProject = { ...detected, test: scope.test };

  if (opts.signal?.aborted) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: "code-mode run aborted by operator cancel",
    };
  }

  const runPromise = deps.runTests(project, repoDir, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
  const timeoutResult: CodeRunOutput = {
    exitCode: null,
    logs: "",
    spawnError: `code-mode timeout after ${timeoutMs}ms`,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<CodeRunOutput>((resolve) => {
    timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
  });

  let out: CodeRunOutput;
  try {
    out = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }


  const sanitized = sanitizeText(out.logs);
  if (sanitized.detection.redacted) {
    console.warn("[sanitizer] Secrets detected in code-test logs — redacting before publish");
  }
  deps.recordAudit?.(opts.namespace, sanitized.detection);

  const label = `${project.ecosystem} tests (${project.test.cmd} ${project.test.args.join(" ")})`;

  if (out.spawnError) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${project.ecosystem} runtime unavailable: ${out.spawnError}\n\n${sanitized.text}`,
    };
  }

  if (ranZeroTests(project, out)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${label} executed zero tests (no tests were collected) — inconclusive, not a pass\n\n${sanitized.text}`,
    };
  }

  const ok = out.exitCode === 0;
  const status = ok ? "pass" : "fail";
  const detail = ok ? undefined : failureDetail(sanitized.text, 1500);
  const counts = parseTestCounts(sanitized.text);
  const kase: QaCase = { name: label, status, detail, objective: "code test suite", flow: counts ? `${counts.pass} pass / ${counts.fail} fail / ${counts.total} total` : undefined };
  opts.onCase?.(kase);

  return {
    sha: opts.namespace,
    verdict: ok ? "pass" : "fail",
    passed: ok,
    cases: [kase],
    logs: sanitized.text,
  };
}

export function failureDetail(logs: string, maxChars = 1500): string {
  const failing = [...new Set(logs.split("\n").filter((l) => /<<< (?:FAILURE|ERROR)!/.test(l)).map((l) => l.trim()))].slice(0, 20);
  const body = headTail(logs, maxChars);
  return failing.length > 0 ? `Failing tests:\n${failing.join("\n")}\n\n${body}` : body;
}

function headTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[${s.length - maxChars} chars omitted]…\n${s.slice(-half)}`;
}

/** The REAL, spawning CodeExecuteDeps — a FACTORY (not a plain constant) because the privilege-drop sandbox is now injected rather than resolved internally (see this file's header, difference #2). `processKill` defaults to a fresh ProcessKillAdapter — mirrors CodebaseMemoryClient's own constructor-default convention for the same shared-infrastructure primitive. */
export function createDefaultCodeExecuteDeps(
  sandbox: Sandbox | null,
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): CodeExecuteDeps {
  return {
    detect: (repoDir) => detectCodeProject(repoDir),
    listWrites: (repoDir) => gitWorkingChanges(repoDir),
    runTests: (project, repoDir, opts) =>
      new Promise((resolve) => {
        const { cmd, args } = project.test;
        const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
        let stdout = "";
        let stderr = "";
        let resolved = false;

        const finish = (result: CodeRunOutput) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(result);
        };

        const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
        const timer = setTimeout(() => {
          processKill.killTree(child);
          finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: `code-mode timeout after ${timeoutMs}ms` });
        }, timeoutMs);

        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            processKill.killTree(child);
            finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: "aborted by operator cancel" });
          }, { once: true });
        }

        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => finish({ exitCode: null, logs: `${stderr}${stdout}`, spawnError: String(err) }));
        child.on("close", (code) => finish({ exitCode: code, logs: `${stdout}\n${stderr}`.trim() }));
      }),
  };
}


function resolveC8Bin(): string | null {
  try {
    return createRequire(import.meta.url).resolve("c8/bin/c8.js");
  } catch {
    return null;
  }
}

export function coverageCommand(project: CodeProject, repoDir: string, c8Bin: string): Command | null {
  if (project.ecosystem !== "node") return null;
  return {
    cmd: process.execPath,
    args: [
      c8Bin,
      "--reporter=lcovonly",
      "--reports-dir",
      join(repoDir, "coverage"),
      "--all=false",
      "--",
      project.test.cmd,
      ...project.test.args,
    ],
  };
}

/** runCodeCoverage produces coverage/lcov.info for the repo's suite, best-effort. Returns without throwing on any failure (missing c8, non-node ecosystem, timeout, crash) so the caller falls back to "unmeasured". It never reports pass/fail — only a side-effect report. `sandbox` is INJECTED (see this file's header, difference #2) — the composition-root shell resolves it once and passes it to every code-mode entry point (setup/execute/coverage) alike. */
export async function runCodeCoverage(
  repoDir: string,
  sandbox: Sandbox | null,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): Promise<void> {
  if (opts?.signal?.aborted) return;
  const c8Bin = resolveC8Bin();
  if (!c8Bin) return;
  const command = coverageCommand(detectCodeProject(repoDir), repoDir, c8Bin);
  if (!command) return;
  await new Promise<void>((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      processKill.killTree(child);
      finish();
    }, opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS);
    opts?.signal?.addEventListener("abort", () => {
      processKill.killTree(child);
      finish();
    }, { once: true });
    child.on("error", finish);
    child.on("close", finish);
  });
}

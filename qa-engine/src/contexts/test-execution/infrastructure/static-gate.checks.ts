/* Never a fifth duplicate copy (process-kill.adapter.ts's own header: "the ONE killTree"). 2. */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, validateManifest as validateManifestShape, type ManifestValidation } from "@kernel/manifest/manifest-entry.ts";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { redactByValue } from "../../../shared-infrastructure/run-secret-redaction.ts";
import type { ExecCommandClass, ExecSandboxPort } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { SandboxProfile } from "../../../shared-infrastructure/process-sandbox/exec-env.ts";
import { readConfinedSpecFile, readFailureReason, readOwnedSpecFile, scanSpecTree, writeOwnedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";
import type { CheckResult, ValidationResult } from "../application/ports/index.ts";
import {
  detectCodeProject,
  realDetectDeps,
  resolveChangedModules,
  effectiveChangedFiles,
  gitWorkingChanges,
  DEFAULT_CODE_MODE_TIMEOUT_MS,
  type CodeProject,
  type Command,
  type DetectDeps,
} from "./code-execution.runner.ts";

const processKill = new ProcessKillAdapter();


export const DEFAULT_VALIDATE_CHECK_TIMEOUT_MS = 300_000;

/* What is kept of a check's combined output: enough for any real tool report, bounded because the check runs code the agent wrote and may write without limit. */
export const CHECK_OUTPUT_KEEP_CHARS = 500_000;

export interface ValidateDeps {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
}

export async function validateSpecs(
  specDir: string,
  deps: ValidateDeps,
): Promise<ValidationResult> {
  const checks: Array<[string, (d: string) => Promise<CheckResult>]> = [
    ["typecheck", deps.typecheck],
    ["lint", deps.lint],
    ["list", deps.listTests],
    ["manifest", deps.checkManifest],
  ];
  const errors: string[] = [];
  let allFailuresAreInfra = true;
  const results = await Promise.all(
    checks.map(async ([name, run]) => ({ name, res: await run(specDir) })),
  );
  for (const { name, res } of results) {
    if (!res.ok) {
      errors.push(`[${name}] ${res.output.trim()}`);
      if (!res.infra) allFailuresAreInfra = false;
    }
  }

  const zeroAssertionErrors = checkZeroAssertionSpecs(specDir);
  for (const e of zeroAssertionErrors) {
    errors.push(e);
    allFailuresAreInfra = false;
  }

  return { ok: errors.length === 0, errors, infra: errors.length > 0 && allFailuresAreInfra };
}

/* mutation-scope:begin spec-scan */
/* Deterministic check — scan *.spec.ts files under specDir/flows (the GENERATED-spec dir; qayaba writes generated specs there) and return one error per spec with NO assertion. Detects `expect(`, `await expect(`, `expect.soft(`, `expect.poll(`. A missing flows/ dir yields no errors.
   The scan runs in the orchestrator, over files the agent writes, so it lists without following a link and reads through the confined reader: a named pipe cannot hold it, a link cannot lead it out of the spec directory and a device cannot fill its memory. A spec it cannot vouch for (a link out of the spec directory, a pipe, a file it cannot read or that is over the cap) is a finding of its own, never skipped and never taken for fine: the gate is fail-closed, the agent can fix it, and a spec that was not checked must not go on to be run. So is a path it could not walk (a link to a directory, which tsc, ESLint and Playwright may follow to specs that nothing here checked, a directory it could not list, and a directory with more entries than the walk looks at, since the entries past the cap were not checked). A flows/ that is itself a link or a file is a finding too: nothing under it was checked. */
function checkZeroAssertionSpecs(specDir: string): string[] {
  const root: SpecRoot = { mirrorDir: specDir, specDir };
  const flows = join(specDir, "flows");
  const problem = flowsProblem(flows);
  if (problem !== undefined) return [`[zero-assertions] flows: ${problem} — the generated specs are checked only in a real flows/ directory of the spec directory`];
  const errors: string[] = [];
  const tree = scanSpecTree(flows);
  for (const found of tree.specs) {
    const spec = join("flows", found);
    const read = readSpec(root, spec);
    if ("problem" in read) {
      errors.push(`[zero-assertions] ${spec}: spec cannot be checked (${read.problem}) — replace it with a regular file inside the spec directory`);
    } else if (!/\bexpect\s*[.(]/.test(read.source)) {
      errors.push(`[zero-assertions] ${spec}: spec has no expect() calls — remove it or add assertions`);
    }
  }
  for (const unwalked of tree.unwalked) {
    errors.push(`[zero-assertions] ${join("flows", unwalked.path)} ${unwalked.reason} — the specs behind it are not checked: it must be a real directory inside flows/ whose entries can all be listed`);
  }
  return errors;
}

/* Why `flows` is not a directory the scan can walk, or undefined when it is one or is not there. By lstat, so that a link is not a directory. */
function flowsProblem(flows: string): string | undefined {
  try {
    return lstatSync(flows).isDirectory() ? undefined : "is a link or a file, not a directory";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "cannot be examined";
  }
}

/* The text of a spec, or why it cannot be had: the reason of a refusal is the module's own words, any other failure is told by its code alone or, with none, by a fixed reason, so nothing of what a file holds is ever quoted back to the agent. */
function readSpec(root: SpecRoot, spec: string): { source: string } | { problem: string } {
  try {
    return { source: readConfinedSpecFile(root, spec) };
  } catch (err) {
    return { problem: readFailureReason(err) };
  }
}
/* mutation-scope:end spec-scan */

/* `tsc`, `eslint` and `playwright test --list` import and run the project's config and its specs' top-level code, so they are agent-influenced code like a test run: they start through the launcher in the `offline` profile (no network, no session, no account). A code-target compile runs the repo's own build and uses the `install` profile, which reaches package registries only. */
export function runCheck(
  cmd: string,
  args: string[],
  e2eDir: string,
  timeoutMs: number = DEFAULT_VALIDATE_CHECK_TIMEOUT_MS,
  exec: ExecSandboxPort,
  profile: SandboxProfile = "offline",
  commandClass?: ExecCommandClass,
  opts: { stdoutOnly?: boolean } = {},
): Promise<CheckResult> {
  return new Promise((resolve) => {
    /* The launcher starts the child detached, as the leader of its own process group, so killTree can reap grandchildren (npx forks the real tool as a child of the child). */
    const child = exec.spawn(cmd, args, { cwd: e2eDir, profile, ...(commandClass ? { commandClass } : {}) });
    const out = new BoundedOutputTail(CHECK_OUTPUT_KEEP_CHARS);
    let settled = false;
    const settle = (res: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      processKill.killTree(child);
      settle({ ok: false, output: `${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms — killed`, infra: true });
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => out.append(d));
    child.stderr!.on("data", (d: string) => { if (!opts.stdoutOnly) out.append(d); });
    child.on("error", (e) => settle({ ok: false, output: String(e), infra: true }));
    /* The check's output goes back to the agent as feedback: the run's secrets are taken out by value where it enters. */
    child.on("close", (code) => settle({ ok: code === 0, output: redactByValue(out.text()), infra: code === null ? true : undefined }));
  });
}
/* mutation-scope:begin eslint-fix-source */

/* The linter the fixes come from: ESLint, as the static gate runs it. A test names a stand-in. */
export const ESLINT_COMMAND: readonly [string, readonly string[]] = ["npx", ["eslint"]];

/* ESLint's own fixes for the named specs. They are computed in the sandbox with `--fix-dry-run`, because the sandbox uid writes nothing of the mirror, and the orchestrator writes each fixed text through the confined writer, for the named specs only. A linter that cannot run, an answer that cannot be read (a report cut by the output bound included) or a spec that cannot be written fixes nothing. Returns the specs rewritten. */
export async function fixLintedSpecs(
  specDir: string,
  specs: readonly string[],
  exec: ExecSandboxPort,
  linter: readonly [string, readonly string[]] = ESLINT_COMMAND,
  timeoutMs: number = DEFAULT_VALIDATE_CHECK_TIMEOUT_MS,
): Promise<string[]> {
  const named = [...new Set(specs.filter((s) => s.endsWith(".spec.ts") && !isAbsolute(s) && !s.split("/").includes("..")))];
/* mutation-scope:end eslint-fix-source */
  if (named.length === 0) return [];
  const res = await runCheck(linter[0], [...linter[1], "--fix-dry-run", "--format", "json", "--", ...named], specDir, timeoutMs, exec, "offline", "eslint", { stdoutOnly: true });
  if (res.infra) return [];
  let report: unknown;
  try {
    report = JSON.parse(res.output);
  } catch {
    return [];
  }
  if (!Array.isArray(report)) return [];
  const root: SpecRoot = { mirrorDir: specDir, specDir };
  /* The linter names files by the directory as its process sees it, which may be the resolved one. */
  const bases = [specDir, realOrSelf(specDir)];
  const fixed: string[] = [];
  for (const entry of report) {
    const { filePath, output } = (entry ?? {}) as { filePath?: unknown; output?: unknown };
    if (typeof filePath !== "string" || typeof output !== "string") continue;
    const rel = bases.map((base) => relative(base, filePath).split(sep).join("/")).find((candidate) => named.includes(candidate));
    if (rel === undefined || fixed.includes(rel)) continue;
    try {
      writeOwnedSpecFile(root, rel, output);
      fixed.push(rel);
    } catch (err) {
      console.error(`[qa] the linter's fix of ${rel} was not written: ${readFailureReason(err)}`);
    }
  }
  return fixed;
}

function realOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/* The manifest check reads a file; it starts nothing. */
const checkManifestFile = async (e2eDir: string): Promise<CheckResult> => {
  const unreadable = (why: string): CheckResult => ({ ok: false, output: `e2e/.qa/manifest.json unreadable or missing: ${why}` });
  try {
    /* What this check reports goes back to the agent as validation feedback, and the manifest is in a directory the agent writes into: it is read strictly, so that a link or a pipe planted there is refused with a reason that names no content, instead of being followed and quoted back in a parse error. */
    const read = readOwnedSpecFile({ mirrorDir: e2eDir, specDir: e2eDir }, MANIFEST_FILE, MAX_MANIFEST_BYTES);
    if ("reason" in read) return unreadable(read.reason);
    if ("absent" in read) return unreadable("it does not exist");
    const v = validateManifest(JSON.parse(read.bytes.toString("utf8")));
    return { ok: v.ok, output: v.errors.join("\n") };
  } catch (e) {
    return unreadable(String(e));
  }
};

/* The static gate's checks over a launcher: there is no default, because every one of them but the manifest check executes agent-influenced code. */
export function createValidateDeps(exec: ExecSandboxPort): ValidateDeps {
  return {
    typecheck: (e2eDir) => runCheck("npx", ["tsc", "--noEmit"], e2eDir, undefined, exec, "offline", "tsc"),
    lint: (e2eDir) => runCheck("npx", ["eslint", "."], e2eDir, undefined, exec, "offline", "eslint"),
    listTests: (e2eDir) => runCheck("npx", ["playwright", "test", "--list"], e2eDir, undefined, exec, "offline", "playwright-list"),
    checkManifest: checkManifestFile,
  };
}

export function validateManifest(raw: unknown): ManifestValidation {
  const shape = validateManifestShape(raw);
  const errors = [...shape.errors];

  if (Array.isArray(raw)) {
    const ids = new Set<string>();
    raw.forEach((entry) => {
      const m = (entry ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (id.length > 0) {
        if (ids.has(id)) {
          errors.push(`'${id}': duplicate id`);
        } else {
          ids.add(id);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}


const TOOLCHAIN_FAILURE_PATTERNS: readonly RegExp[] = [
  /JAVA_HOME (?:environment variable )?is not (?:correctly set|set|defined)/i,
  /JAVA_HOME is not set and could not be found/i,
  /No compiler is provided in this environment/i,
  /Unable to locate the Javac Compiler/i,
  /Perhaps you are running on a JRE rather than a JDK/i,
];

export function isToolchainFailure(output: string): boolean {
  return TOOLCHAIN_FAILURE_PATTERNS.some((re) => re.test(output));
}

export function compileCommand(
  project: CodeProject,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists"> = realDetectDeps,
): Command | null {
  const resolved = resolveChangedModules(project.ecosystem, repoDir, changedFiles, deps);
  const mods = resolved && resolved.length > 0 ? resolved : null;
  switch (project.ecosystem) {
    case "maven":
      return mods
        ? { cmd: "mvn", args: ["-B", "-pl", mods.join(","), "-am", "test-compile"] }
        : { cmd: "mvn", args: ["-B", "test-compile"] };
    case "gradle":
      return mods
        ? { cmd: project.test.cmd, args: mods.map((m) => `:${m.replace(/\//g, ":")}:testClasses`) }
        : { cmd: project.test.cmd, args: ["testClasses"] };
    case "go":
      return mods ? { cmd: "go", args: ["vet", ...mods.map((m) => `./${m}/...`)] } : { cmd: "go", args: ["vet", "./..."] };
    case "rust":
      return { cmd: "cargo", args: ["check", "--tests"] };
    case "node":
      return deps.exists(join(repoDir, "tsconfig.json")) ? { cmd: "npx", args: ["tsc", "--noEmit"] } : null;
    case "python": {
      const py = changedFiles.filter((f) => f.endsWith(".py"));
      return py.length > 0 ? { cmd: "python3", args: ["-m", "compileall", "-q", ...py] } : null;
    }
    default:
      return null;
  }
}

export interface CodeValidateDeps {
  detect(repoDir: string): CodeProject;
  runCheck(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<CheckResult>;
  listWrites?(repoDir: string): string[];
}

/* A compile of the watched repo runs its own build tooling, which resolves dependencies from registries: the `install` profile. */
export function createCodeValidateDeps(exec: ExecSandboxPort): CodeValidateDeps {
  return {
    detect: (repoDir) => detectCodeProject(repoDir),
    runCheck: (cmd, args, cwd, timeoutMs) => runCheck(cmd, args, cwd, timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS, exec, "install"),
    listWrites: (repoDir) => gitWorkingChanges(repoDir),
  };
}

export async function validateCodeProject(
  repoDir: string,
  deps: CodeValidateDeps,
  opts: { changedFiles?: string[]; timeoutMs?: number } = {},
): Promise<ValidationResult> {
  const project = deps.detect(repoDir);
  const changed = effectiveChangedFiles(opts.changedFiles ?? [], repoDir, deps.listWrites);
  const cmd = compileCommand(project, repoDir, changed);
  if (!cmd) return { ok: true, errors: [], infra: false };
  const res = await deps.runCheck(cmd.cmd, cmd.args, repoDir, opts.timeoutMs);
  if (res.ok) return { ok: true, errors: [], infra: false };
  const infra = res.infra === true || isToolchainFailure(res.output);
  const clean = sanitizeText(res.output).text.trim();
  return { ok: false, errors: [`[compile] ${clean}`], infra };
}

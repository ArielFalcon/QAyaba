/*
 * The checks of `npm run sandbox:smoke` that need the harness itself rather than a spec running inside the sandbox: they start
 * children through the real launcher and read what is left afterwards, from the orchestrator's side, which is where a boundary
 * that fails open shows. Each check says in its name what holding means, and returns the problems it found (none: it holds).
 * Add a check here for every fix whose effect can be observed in a running container.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecSandboxPort } from "../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { QaCase } from "../qa-engine/src/shared-kernel/qa-case.ts";

export interface SmokeCheckContext {
  /* The throwaway project the smoke installed, as a spec directory. */
  e2eDir: string;
  /* Where the check specs are kept: scripts/sandbox-smoke/checks. */
  checksDir: string;
  /* The launcher the run's children are started through, and the run's work dir (readable here: this process is root). */
  exec: ExecSandboxPort;
  workDir: string;
  /* Runs the named spec files of `e2eDir` through the real runner, the way a production run does. */
  runSpecs(specFiles: readonly string[]): Promise<{ verdict: string; cases: ReadonlyArray<Pick<QaCase, "name" | "status">> }>;
}

export interface SmokeCheck {
  name: string;
  run(ctx: SmokeCheckContext): Promise<string[]>;
}

/* `a.spec.ts` must run `a.spec.ts` and not `schema.spec.ts`: Playwright reads a bare argument as an unanchored pattern over the path. */
export const specSelectionIsExact: SmokeCheck = {
  name: "a spec named alone does not also run the spec whose name ends the same way",
  async run(ctx) {
    for (const file of ["a.spec.ts", "schema.spec.ts"]) cpSync(join(ctx.checksDir, "anchor", file), join(ctx.e2eDir, file));
    const run = await ctx.runSpecs(["a.spec.ts"]);
    const names = run.cases.map((c) => c.name);
    const problems: string[] = [];
    if (!names.some((n) => n.includes("anchor-a ran"))) problems.push(`the named spec did not run (cases: ${JSON.stringify(names)})`);
    if (names.some((n) => n.includes("anchor-schema ran"))) problems.push("schema.spec.ts ran although only a.spec.ts was asked for");
    return problems;
  },
};

/* Whether a process is running (a zombie holds nothing and does not count). */
export function isRunning(pid: number, procRoot = "/proc"): boolean {
  try {
    const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
    return !/^State:\s*[ZX]/m.test(status);
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

function pidOf(ctx: SmokeCheckContext): number | undefined {
  const file = join(ctx.workDir, "tmp", "daemon.pid");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
}

/* A spec that leaves a daemon of its own session behind (setsid, a double fork): killing the child's process group does not reach it. */
export const detachedDaemonIsGoneAfterTheCall: SmokeCheck = {
  name: "a daemon a spec detached is gone when the call ends",
  async run(ctx) {
    cpSync(join(ctx.checksDir, "daemon-spawn.spec.ts"), join(ctx.e2eDir, "daemon-spawn.spec.ts"));
    const run = await ctx.runSpecs(["daemon-spawn.spec.ts"]);
    const pid = pidOf(ctx);
    if (pid === undefined || !run.cases.some((c) => c.status === "pass")) return [`the spec that starts the daemon did not run (${run.verdict})`];
    const gone = await waitFor(() => !isRunning(pid), 4000);
    return gone ? [] : [`the daemon (pid ${pid}) is still running after the call`];
  },
};

/* A daemon that outlives its call shares the sandbox uid with the next child, and a process of the same uid can read another's /proc/<pid>/environ. */
export const survivorCannotReadALaterChildEnvironment: SmokeCheck = {
  name: "a survivor of an earlier call cannot read the environment of a later login child",
  async run(ctx) {
    cpSync(join(ctx.checksDir, "daemon-spawn.spec.ts"), join(ctx.e2eDir, "daemon-spawn.spec.ts"));
    /* A child that stays alive through the call, so that the end of the call is not the end of the last child and the daemon is still there when the login child is started. */
    const keeper = ctx.exec.spawn("node", ["-e", "setTimeout(() => {}, 20000)"], { cwd: ctx.e2eDir, profile: "offline", extraEnv: { PW_SMOKE_CONTROL: "SMOKE_CANARY_CONTROL_VALUE" } });
    try {
      await ctx.runSpecs(["daemon-spawn.spec.ts"]);
      const pid = pidOf(ctx);
      const seenFile = join(ctx.workDir, "tmp", "seen.log");
      const sawControl = (): boolean => existsSync(seenFile) && /^CONTROL /m.test(readFileSync(seenFile, "utf8"));
      if (pid === undefined || !isRunning(pid)) return ["precondition: the daemon was not left running while another child was live, so this check proves nothing"];
      if (!(await waitFor(sawControl, 5000))) return ["precondition: the daemon could not read a same-uid child's environment here, so this check proves nothing"];
      const login = ctx.exec.spawn("node", ["-e", "setTimeout(() => {}, 1500)"], { cwd: ctx.e2eDir, profile: "login", account: { user: "smoke-login-user", pass: "SMOKE_CANARY_LOGIN_PASS" } });
      const loginExited = new Promise<void>((resolve) => login.once("exit", () => resolve()));
      const problems: string[] = [];
      if (isRunning(pid)) problems.push(`the survivor (pid ${pid}) was still running after the login child started`);
      await loginExited;
      if (existsSync(seenFile) && /^LOGIN /m.test(readFileSync(seenFile, "utf8"))) problems.push("the survivor read the login child's environment (the test account)");
      return problems;
    } finally {
      keeper.kill("SIGKILL");
    }
  },
};

export const SMOKE_CHECKS: readonly SmokeCheck[] = [specSelectionIsExact, detachedDaemonIsGoneAfterTheCall, survivorCannotReadALaterChildEnvironment];

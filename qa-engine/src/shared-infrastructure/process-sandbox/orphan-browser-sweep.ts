/*
 * Ends the browsers the authenticated agent tools started and nobody stopped: the orchestrator was restarted in place (a hot
 * swap) while a run was holding one. The run's own finally stops its browser, a lifetime wrapper bounds it, and this closes
 * what is left at boot. A browser of ours is told by its command line alone: a debugging pipe and a
 * profile directory inside the runs' work root, which nothing else starts. The signal goes to the process group, since the
 * launcher starts it detached and its renderers share the group. No process table (not Linux): nothing to do.
 */

import { readFileSync, readdirSync } from "node:fs";

export interface OrphanSweepDeps {
  listProcesses(): string[];
  /* The process's arguments, or undefined when it is gone or unreadable. */
  commandLine(pid: number): string[] | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
  ownPid: number;
}

export function procFsDeps(procRoot = "/proc"): OrphanSweepDeps {
  return {
    listProcesses: () => readdirSync(procRoot).filter((name) => /^\d+$/.test(name)),
    commandLine: (pid) => {
      try {
        return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "");
      } catch {
        return undefined;
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    ownPid: process.pid,
  };
}

export function sweepOrphanAgentBrowsers(workRoot: string, deps: OrphanSweepDeps = procFsDeps()): number {
  let names: string[];
  try {
    names = deps.listProcesses();
  } catch {
    return 0;
  }
  const profilePrefix = `--user-data-dir=${workRoot.replace(/\/+$/, "")}/`;
  let killed = 0;
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || pid === deps.ownPid) continue;
    const args = deps.commandLine(pid);
    if (!args || !args.includes("--remote-debugging-pipe") || !args.some((arg) => arg.startsWith(profilePrefix))) continue;
    try {
      deps.kill(-pid, "SIGKILL");
      killed += 1;
    } catch {
      /* Already gone, or not ours to signal. */
    }
  }
  return killed;
}

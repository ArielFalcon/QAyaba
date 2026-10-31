/*
 * Ends what a sandboxed child left running. Every such child is started detached as the one sandbox uid, and `killTree` signals
 * its process group, so a process that put itself in a session of its own (setsid, a double fork, a daemon) outlives the call that
 * started it. That uid is the same one the next child runs as, so the survivor could read the next child's `/proc/<pid>/environ`
 * (a login child carries the test account) and its files, keep a connection to an origin a later run declares, or wait for the next
 * app's session. The kernel offers no cleaner handle than the uid, so the reaper kills by uid: every process of the sandbox uid that
 * is not the live child of a launcher call (or a descendant of one) is an orphan and is sent SIGKILL, and the call fails if any is
 * still there afterwards. It is used when a run's scope opens and closes, before each spawn, and when the last live child exits.
 * Zombies are left to whoever reaps them: they hold nothing and cannot act.
 * The process table, the signal and the clock are injected; `procTable` reads /proc, which only exists on Linux (the only place the
 * sandbox uid does).
 */

import { readFileSync, readdirSync } from "node:fs";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  zombie: boolean;
}

export interface ProcessTable {
  list(): ProcessInfo[];
  /* SIGKILL to the process alone. A process that is already gone is not an error. */
  kill(pid: number): void;
  sleepSync(ms: number): void;
  now(): number;
}

/* Processes of the sandbox uid are still alive after the reaper tried to end them. */
export class SandboxResidueError extends Error {
  constructor(readonly pids: readonly number[]) {
    super(`${pids.length} process(es) of the sandbox uid survived SIGKILL (pids ${pids.slice(0, 10).join(", ")}${pids.length > 10 ? ", ..." : ""}): they could read the next child's environment`);
    this.name = "SandboxResidueError";
  }
}

export const DEFAULT_REAP_TIMEOUT_MS = 2_000;
const REAP_POLL_MS = 20;

/* The pids of the children the launcher started that have not exited yet, per uid, for the whole process: a second launcher in the same process (an operator script, another composition) must not have its live children taken for orphans by this one's reaper. */
const live = new Map<number, Set<number>>();

/* What the registry needs of a child: its pid and a way to hear that it ended. */
export interface TrackableChild {
  pid?: number | undefined;
  once(event: string, listener: () => void): unknown;
}

export function trackSandboxChild(uid: number, child: TrackableChild, onSettled?: () => void): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const pids = live.get(uid) ?? new Set<number>();
  live.set(uid, pids);
  pids.add(pid);
  const settle = (): void => {
    if (!pids.delete(pid)) return;
    if (pids.size === 0) live.delete(uid);
    onSettled?.();
  };
  child.once("exit", settle);
  child.once("error", settle);
}

export function liveSandboxChildren(uid: number): ReadonlySet<number> {
  return live.get(uid) ?? new Set<number>();
}

export interface SandboxReaper {
  /* Kills every process of the sandbox uid that is not a live child of the launcher or its descendant, and returns how many it ended. Throws SandboxResidueError when some survive the timeout. */
  reapOrphans(): number;
}

export interface SandboxReaperDeps {
  uid: number;
  table: ProcessTable;
  /* The pids the launcher is running now; defaults to the process-wide registry. */
  liveChildren?: () => ReadonlySet<number>;
  timeoutMs?: number;
  /* Never signalled, whatever the table says: the orchestrator itself. */
  ownPid?: number;
}

export function createSandboxReaper(deps: SandboxReaperDeps): SandboxReaper {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
  const ownPid = deps.ownPid ?? process.pid;
  const liveChildren = deps.liveChildren ?? ((): ReadonlySet<number> => liveSandboxChildren(deps.uid));

  const orphans = (): number[] => {
    const all = deps.table.list();
    const children = new Map<number, number[]>();
    for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
    const protectedPids = new Set<number>();
    const walk = [...liveChildren()];
    while (walk.length > 0) {
      const pid = walk.pop()!;
      if (protectedPids.has(pid)) continue;
      protectedPids.add(pid);
      walk.push(...(children.get(pid) ?? []));
    }
    return all.filter((p) => p.uid === deps.uid && !p.zombie && p.pid > 1 && p.pid !== ownPid && !protectedPids.has(p.pid)).map((p) => p.pid);
  };

  return {
    reapOrphans() {
      const started = deps.table.now();
      const ended = new Set<number>();
      for (;;) {
        const found = orphans();
        if (found.length === 0) return ended.size;
        if (deps.table.now() - started >= timeoutMs) throw new SandboxResidueError(found);
        for (const pid of found) {
          ended.add(pid);
          deps.table.kill(pid);
        }
        deps.table.sleepSync(REAP_POLL_MS);
      }
    },
  };
}

function parseStatus(pid: number, text: string): ProcessInfo | undefined {
  const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(text)?.[1];
  const uid = Number(field("Uid")?.split(/\s+/)[0]);
  const ppid = Number(field("PPid"));
  const state = field("State")?.trim().charAt(0);
  if (!Number.isInteger(uid) || !Number.isInteger(ppid) || state === undefined) return undefined;
  return { pid, ppid, uid, zombie: state === "Z" || state === "X" };
}

export function procTable(procRoot = "/proc"): ProcessTable {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  return {
    list() {
      const out: ProcessInfo[] = [];
      for (const name of readdirSync(procRoot)) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const info = parseStatus(Number(name), readFileSync(`${procRoot}/${name}/status`, "utf8"));
          if (info) out.push(info);
        } catch {
          /* Gone between the listing and the read. */
        }
      }
      return out;
    },
    kill(pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    },
    sleepSync(ms) {
      Atomics.wait(sleeper, 0, 0, ms);
    },
    now: () => performance.now(),
  };
}

/* The reaper of the real process table for this sandbox identity, or undefined where there is no /proc to read (not Linux) or no sandbox uid: the only places the uid exists. */
export function processReaper(sandbox: { uid: number } | null, platform: NodeJS.Platform = process.platform): SandboxReaper | undefined {
  return sandbox !== null && platform === "linux" ? createSandboxReaper({ uid: sandbox.uid, table: procTable() }) : undefined;
}

#!/usr/bin/env node
/*
 * Runs a command in its own process group and makes the whole group die with this process.
 *
 * `npm run mutate` hands Stryker this as the test command. Stryker ends a timed-out run by SIGKILLing
 * the process tree it can list, which this process cannot intercept, and `node --test` starts one
 * process per test file: a file process started while that tree was being listed, or orphaned once
 * its runner died, escaped the kill and kept spinning on an infinite-loop mutant. Killing the process
 * group reaches every process the command started, whenever it started. A watchdog outside this
 * process tree (the shell that starts it exits at once, so it is reparented away and a tree kill
 * never reaches it) kills the group as soon as this process is gone. On a normal exit, or a signal
 * this process can catch, it kills whatever the command left behind itself. POSIX only.
 *
 * usage: node scripts/run-in-group.mjs <command> [args...]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WATCH_FLAG = "--watch-group";
const POLL_MS = 100;

/* Whether a process (pid > 0) or a process group (pid < 0) still exists. */
function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function killGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
}

/* The watchdog: waits for the runner to disappear, then kills the group; ends once the group is empty. */
function watch(runnerPid, pgid) {
  const timer = setInterval(() => {
    if (!exists(-pgid)) {
      clearInterval(timer);
      return;
    }
    if (exists(runnerPid)) return;
    killGroup(pgid);
    clearInterval(timer);
  }, POLL_MS);
}

function run([command, ...args]) {
  if (!command) {
    console.error("usage: node scripts/run-in-group.mjs <command> [args...]");
    process.exit(2);
  }
  const child = spawn(command, args, { detached: true, stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`run-in-group: ${err.message}`);
    process.exit(1);
  });
  spawn(
    "/bin/sh",
    ["-c", '"$0" "$1" "$2" "$3" "$4" </dev/null >/dev/null 2>&1 &', process.execPath, fileURLToPath(import.meta.url), WATCH_FLAG, String(process.pid), String(child.pid)],
    { detached: true, stdio: "ignore" },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      killGroup(child.pid);
      process.exit(1);
    });
  }
  child.on("exit", (code) => {
    killGroup(child.pid);
    process.exit(code ?? 1);
  });
}

const argv = process.argv.slice(2);
if (argv[0] === WATCH_FLAG) watch(Number(argv[1]), Number(argv[2]));
else run(argv);

/* A named pipe can hold a thread forever. Opening one for reading waits for a writer, opening one for writing waits for a reader, and a thread that waits inside a system call cannot be timed out from the test it runs: the timer that would do it runs on the thread that is stuck. A test of "this code does not wait on a pipe", run against code that does (a regression, or a test written first and run against the code it replaces), would then never end, and its process would stay behind for hours.
   The watch is a second thread, which runs while the first is stuck. As soon as anything has the pipe open for reading it opens the pipe for writing (without waiting, so that it succeeds only when there is such a reader), holds it a moment and closes it: the reader's open returns, it reads the end of the file, and the test goes on to its assertion, so the failure comes at once and is the assertion's own. When nothing is reading, it opens the pipe for reading (which never waits) and looks for a writer: a read that finds the pipe empty but not closed has a writer on the other end, so it holds the read end a moment and drains what the writer sends, and the writer's open and write return. Code that never opens the pipe is never seen and never released: nothing changes for it. */

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

/* How often the watch looks for a reader or a writer, and how long it keeps the other end open once it finds one, in milliseconds: long enough for the thread that waits to get from its open to its read or its write. */
const POLL_MS = 20;
const HOLD_MS = 100;

const WATCHER = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const state = new Int32Array(workerData.state);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const stopped = () => Atomics.load(state, 1) === 1;
const scratch = Buffer.alloc(4096);
/* A reader on the pipe is a thread blocked in its open for reading, and the watch is the writer it waits for. Opening a pipe for writing without waiting succeeds only when something has it open for reading; any other kind of file opens at once, and is no reader. */
function releaseReader() {
  let fd;
  try {
    fd = fs.openSync(workerData.path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch {
    return false;
  }
  if (!fs.fstatSync(fd).isFIFO()) {
    fs.closeSync(fd);
    return false;
  }
  Atomics.store(state, 0, 1);
  for (let held = 0; held < workerData.holdMs && !stopped(); held += workerData.pollMs) nap(workerData.pollMs);
  fs.closeSync(fd);
  return true;
}
/* A read that finds nothing to read but does not find the pipe closed has a writer on the other end; one that finds it closed has none. */
function hasWriter(fd) {
  try {
    return fs.readSync(fd, scratch, 0, scratch.length, null) > 0;
  } catch (err) {
    return err.code === "EAGAIN";
  }
}
/* A writer on the pipe is a thread blocked in its open for writing, and the watch is the reader it waits for. */
function releaseWriter() {
  let fd;
  try {
    fd = fs.openSync(workerData.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return;
  }
  try {
    if (!fs.fstatSync(fd).isFIFO() || !hasWriter(fd)) return;
    Atomics.store(state, 0, 1);
    for (let held = 0; held < workerData.holdMs && !stopped(); held += workerData.pollMs) {
      nap(workerData.pollMs);
      hasWriter(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}
while (!stopped()) {
  if (!releaseReader()) releaseWriter();
  nap(workerData.pollMs);
}
`;

export interface NamedPipeWatch {
  /** Ends the watch. True when something had the pipe open, for reading or for writing, while it ran. */
  stop(): boolean;
}

/** Starts watching the named pipe at `path` from another thread. Call `stop()` when the code under test has returned. */
export function watchNamedPipe(path: string): NamedPipeWatch {
  const state = new SharedArrayBuffer(8);
  const flags = new Int32Array(state);
  const worker = new Worker(WATCHER, { eval: true, execArgv: [], workerData: { path, state, pollMs: POLL_MS, holdMs: HOLD_MS } });
  worker.unref();
  return {
    stop(): boolean {
      Atomics.store(flags, 1, 1);
      return Atomics.load(flags, 0) === 1;
    },
  };
}

/** Runs `run` with the pipe at `path` watched, and fails the test when it opened the pipe, for reading or for writing, which waits for the other end that never comes. Returns what `run` returned; what it threw is rethrown once the pipe has been checked. */
export async function withoutWaitingOnNamedPipe<T>(path: string, run: () => T | Promise<T>): Promise<T> {
  const watch = watchNamedPipe(path);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await run() };
  } catch (error) {
    outcome = { error };
  }
  assert.equal(watch.stop(), false, "the code under test opened a named pipe, which waits for the other end that never comes");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

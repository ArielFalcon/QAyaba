/**
 * Runs a byte job (a pure function from bytes to bytes, named by a worker module) in a worker thread started for that one call and
 * ended with it, so CPU work on bytes the agent shaped never holds the event loop. No pool and no state outlive a call.
 * The inputs are handed over by transfer: the caller must not read them again. The caller owns the clock: when its signal aborts the
 * worker is terminated, which works between JavaScript operations and not inside a running `JSON.parse`, so the byte cap of an input
 * stays the bound on its CPU. Every failure has a typed outcome, and none quotes the worker's error, which may quote an input.
 */

import { Worker } from "node:worker_threads";
import { ownedBytes, type ByteJobRequest, type ByteJobResponse } from "./serve-bytes.ts";

/** `crashed` is a worker that died or answered something other than one result per input; `unavailable` is a worker that could not be created at all. */
export type OffLoopFailure = "heap-limit" | "crashed" | "aborted" | "unavailable";

/** One output per input, in the order given; `null` is an input the worker's function refused. */
export type OffLoopOutcome = { kind: "done"; outputs: ReadonlyArray<Buffer | null> } | { kind: "failed"; reason: OffLoopFailure };

export interface OffLoopExecutor {
  run(inputs: readonly Buffer[], signal?: AbortSignal): Promise<OffLoopOutcome>;
}

export interface WorkerExecutorOptions {
  /** Calls `serveBytes` with the function to run. */
  worker: URL;
  maxHeapMb: number;
}

/**
 * The flags that make a module loadable (`--import`, `--require`/`-r`, `--loader`, `--experimental-loader`, `--conditions`/`-C`),
 * each with its value, whether given as `--flag=value` or as `--flag value`. A Worker refuses the flags that belong to a process
 * (`ERR_WORKER_INVALID_EXEC_ARGV`: `--stack-trace-limit`, `--tls-cipher-list`, `--secure-heap`, `--v8-pool-size`, `--node-snapshot`, ...),
 * which `node --test` gives each test file's process, and must not inherit the flags that make a process a test run (its reporter would
 * write over the parent's report file), so the worker is given only what it needs to read its own `.ts` module.
 */
const LOADER_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C"]);
const LOADER_FLAG_WITH_VALUE = /^(--import|--require|--loader|--experimental-loader|--conditions)=/;

export function workerExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!;
    if (LOADER_FLAG_WITH_VALUE.test(arg)) kept.push(arg);
    else if (LOADER_FLAGS.has(arg) && index + 1 < execArgv.length) kept.push(arg, execArgv[++index]!);
  }
  return kept;
}

export function createWorkerExecutor(options: WorkerExecutorOptions): OffLoopExecutor {
  return {
    run: (inputs, signal) =>
      new Promise<OffLoopOutcome>((resolve) => {
        if (signal?.aborted) {
          resolve({ kind: "failed", reason: "aborted" });
          return;
        }
        const handed = inputs.map(ownedBytes);
        const request: ByteJobRequest = { inputs: handed };
        let worker: Worker;
        try {
          worker = new Worker(options.worker, {
            workerData: request,
            transferList: handed.map((bytes) => bytes.buffer as ArrayBuffer),
            resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb },
            execArgv: workerExecArgv(process.execArgv),
          });
        } catch {
          /* Nothing of the error is quoted: it may name an input. */
          resolve({ kind: "failed", reason: "unavailable" });
          return;
        }
        let finished = false;
        const finish = (outcome: OffLoopOutcome): void => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = (): void => {
          finish({ kind: "failed", reason: "aborted" });
          void worker.terminate();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.once("message", (message: ByteJobResponse) => {
          const outputs = message.outputs;
          if (!Array.isArray(outputs) || outputs.length !== inputs.length) finish({ kind: "failed", reason: "crashed" });
          else finish({ kind: "done", outputs: outputs.map((output) => (output === null ? null : Buffer.from(output.buffer, output.byteOffset, output.byteLength))) });
        });
        worker.once("error", (err: Error & { code?: string }) => {
          finish({ kind: "failed", reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "heap-limit" : "crashed" });
        });
        worker.once("exit", () => finish({ kind: "failed", reason: "crashed" }));
      }),
  };
}

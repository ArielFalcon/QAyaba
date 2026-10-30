/**
 * Runs a byte job (a pure function from bytes to bytes, named by a worker module) in a worker thread started for that one call and
 * ended with it, so CPU work on bytes the agent shaped never holds the event loop. No pool and no state outlive a call.
 * The inputs are handed over by transfer: the caller must not read them again. The caller owns the clock: when its signal aborts the
 * worker is terminated, which works between JavaScript operations and not inside a running `JSON.parse`, so the byte cap of an input
 * stays the bound on its CPU. Every failure has a typed outcome, and none quotes the worker's error, which may quote an input.
 */

import { Worker } from "node:worker_threads";
import { ownedBytes, type ByteJobRequest, type ByteJobResponse } from "./serve-bytes.ts";

/** `crashed` is a worker that died or answered something other than one result per input. */
export type OffLoopFailure = "heap-limit" | "crashed" | "aborted";

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

/** A worker inherits the loader flags it needs to read `.ts` files, and must not inherit the flags that make a process a test run: its reporter would write over the parent's report file. */
const TEST_RUNNER_FLAG = /^--test(-|$)/;

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
        const worker = new Worker(options.worker, {
          workerData: request,
          transferList: handed.map((bytes) => bytes.buffer as ArrayBuffer),
          resourceLimits: { maxOldGenerationSizeMb: options.maxHeapMb },
          execArgv: process.execArgv.filter((arg) => !TEST_RUNNER_FLAG.test(arg)),
        });
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

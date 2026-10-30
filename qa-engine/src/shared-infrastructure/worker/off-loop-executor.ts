/**
 * Runs a byte job (a pure function from bytes to bytes, named by a worker module) in a worker thread started for that one call and
 * ended with it, so CPU work on bytes the agent shaped never holds the event loop. No pool and no state outlive a call.
 * The inputs are handed over by transfer: the caller must not read them again. The caller owns the clock: when its signal aborts the
 * worker is terminated, which works between JavaScript operations and not inside a running `JSON.parse`, so the byte cap of an input
 * stays the bound on its CPU. Every failure has a typed outcome, and none quotes the worker's error, which may quote an input.
 */

import { Worker } from "node:worker_threads";
import { ownedBytes, type ByteJobRequest, type ByteJobResponse, type ByteJobStarted } from "./serve-bytes.ts";

/** `crashed` is a worker that died or answered something other than one result per input; `unavailable` is a worker that could not be created at all. */
export type OffLoopFailure = "heap-limit" | "crashed" | "aborted" | "unavailable";

/**
 * How long a call took, in two parts: `startMs`, from the call until the worker said it had begun (the thread, its module, the bytes
 * handed over; null when it never did), and `workMs`, from then to the outcome (0 when it never began).
 */
export interface OffLoopTiming {
  startMs: number | null;
  workMs: number;
}

/** One output per input, in the order given; `null` is an input the worker's function refused. `timing` is told by `runWithin`, which keeps the clock. */
export type OffLoopOutcome = ({ kind: "done"; outputs: ReadonlyArray<Buffer | null> } | { kind: "failed"; reason: OffLoopFailure }) & { timing?: OffLoopTiming };

export interface OffLoopRunHooks {
  /** The worker has begun the work: its fixed cost is paid. */
  onStarted(): void;
}

export interface OffLoopExecutor {
  /** Whether `run` tells its hooks when the worker has begun. An executor that does not is given its budget from the call. */
  readonly reportsStart?: boolean;
  /** `context` is plain data handed to the worker beside the inputs (structured-cloned, never transferred): what the job needs to know that is not one input. */
  run(inputs: readonly Buffer[], signal?: AbortSignal, context?: unknown, hooks?: OffLoopRunHooks): Promise<OffLoopOutcome>;
}

/**
 * The time a worker is given to begin: the thread, its module and the bytes handed over, measured at 1.6 to 2.5 s on real coverage dumps. It
 * bounds a worker that never starts and is no part of the budget of the work, which is counted from the moment the worker says it has begun.
 */
export const WORKER_START_BUDGET_MS = 10_000;

/**
 * Waits for the executor at most `budgetMs` of work and then tells it to end its worker, which is `aborted`. The budget is the work's: an
 * executor that reports its start (`reportsStart`) is given it from the moment its worker has begun, and the start itself is bounded by
 * `startBudgetMs` (a worker that has not begun by then is `unavailable`); one that does not is given the budget from the call. An executor
 * that rejects instead of answering is a worker that was not available: nothing of the error, which may quote an input, is kept. The outcome
 * carries how long the start and the work took.
 */
export async function runWithin(executor: OffLoopExecutor, inputs: readonly Buffer[], budgetMs: number, context?: unknown, startBudgetMs: number = WORKER_START_BUDGET_MS): Promise<OffLoopOutcome> {
  const stop = new AbortController();
  const called = performance.now();
  let begunAt: number | null = null;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let workTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: "start" | "work" | undefined;
  let timeUp!: (why: "start" | "work") => void;
  const timeIsUp = new Promise<"time-up">((resolve) => {
    timeUp = (why) => {
      timedOut = why;
      stop.abort();
      resolve("time-up");
    };
  });
  const armWork = (): void => {
    workTimer = setTimeout(() => timeUp("work"), budgetMs);
  };
  const begun = (): void => {
    if (begunAt !== null) return;
    begunAt = performance.now();
    clearTimeout(startTimer);
    armWork();
  };
  if (executor.reportsStart === true) startTimer = setTimeout(() => timeUp("start"), startBudgetMs);
  else armWork();
  const job = executor.run(inputs, stop.signal, context, { onStarted: begun }).catch((): OffLoopOutcome => ({ kind: "failed", reason: "unavailable" }));
  try {
    const raced = await Promise.race([job, timeIsUp]);
    const ended = performance.now();
    const timing: OffLoopTiming = { startMs: begunAt === null ? null : begunAt - called, workMs: begunAt === null ? 0 : ended - begunAt };
    if (raced === "time-up") return { kind: "failed", reason: timedOut === "start" ? "unavailable" : "aborted", timing };
    return { ...raced, timing };
  } finally {
    clearTimeout(startTimer);
    clearTimeout(workTimer);
  }
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
    reportsStart: true,
    run: (inputs, signal, context, hooks) =>
      new Promise<OffLoopOutcome>((resolve) => {
        if (signal?.aborted) {
          resolve({ kind: "failed", reason: "aborted" });
          return;
        }
        const handed = inputs.map(ownedBytes);
        const request: ByteJobRequest = { inputs: handed, context };
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
        worker.on("message", (message: ByteJobResponse | ByteJobStarted) => {
          if ("started" in message) {
            hooks?.onStarted();
            return;
          }
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

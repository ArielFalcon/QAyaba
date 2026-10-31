/** Worker fixture for the executor's failure outcomes: the first input names what to do. */
import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const mode = Buffer.from((workerData as { inputs: Uint8Array[] }).inputs[0]!).toString();
if (mode === "hog") {
  const kept: number[][] = [];
  for (;;) kept.push(new Array<number>(1_000_000).fill(1));
}
if (mode === "spin") for (;;);
/* "beat:<path>": leaves a byte in the file every few milliseconds for as long as it lives, so a test can tell a worker that ended from one left running. */
if (mode.startsWith("beat:")) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    appendFileSync(mode.slice("beat:".length), "x");
    Atomics.wait(sleeper, 0, 0, 5);
  }
}
if (mode === "exit") process.exit(0);
/* Answers, but not with one result per input; the worker then ends by itself. */
if (mode === "short") parentPort!.postMessage({ outputs: [] });
else if (mode === "not-an-array") parentPort!.postMessage({ outputs: "x" });
else throw new Error("boom");

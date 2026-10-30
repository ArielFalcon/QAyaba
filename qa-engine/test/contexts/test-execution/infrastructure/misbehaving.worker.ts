/** Worker fixture for the executor's failure outcomes: the first input names what to do. */
import { parentPort, workerData } from "node:worker_threads";

const mode = Buffer.from((workerData as { inputs: Uint8Array[] }).inputs[0]!).toString();
if (mode === "hog") {
  const kept: number[][] = [];
  for (;;) kept.push(new Array<number>(1_000_000).fill(1));
}
if (mode === "spin") for (;;);
if (mode === "exit") process.exit(0);
/* Answers, but not with one result per input; the worker then ends by itself. */
if (mode === "short") parentPort!.postMessage({ outputs: [] });
else if (mode === "not-an-array") parentPort!.postMessage({ outputs: "x" });
else throw new Error("boom");

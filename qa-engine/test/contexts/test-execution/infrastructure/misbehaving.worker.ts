/** Worker fixture for the executor's failure outcomes: the first input names what to do. */
import { workerData } from "node:worker_threads";

const mode = Buffer.from((workerData as { inputs: Uint8Array[] }).inputs[0]!).toString();
if (mode === "hog") {
  const kept: number[][] = [];
  for (;;) kept.push(new Array<number>(1_000_000).fill(1));
}
if (mode === "spin") for (;;);
throw new Error("boom");

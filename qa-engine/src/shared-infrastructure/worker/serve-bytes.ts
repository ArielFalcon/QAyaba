/**
 * The worker side of a byte job (`off-loop-executor.ts`): a worker module calls `serveBytes` with one pure function, or
 * `serveBytesWith` with a function that opens one for the context of the call (the opened function may keep state across the inputs
 * of its one call: the worker lives for that call only). An input the function throws on is refused alone (`null`); nothing of the
 * error, which may quote the input, crosses back.
 */

import { parentPort, workerData } from "node:worker_threads";

/** A view that owns its whole `ArrayBuffer`, so a transfer moves the memory and never detaches a pool other buffers share. */
export function ownedBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
}

export interface ByteJobRequest {
  inputs: Uint8Array[];
  context?: unknown;
}
export interface ByteJobResponse {
  outputs: Array<Uint8Array | null>;
}
/** Sent once, before the first input is worked on: the worker's fixed cost (its thread, its module, the bytes handed over) is paid. */
export interface ByteJobStarted {
  started: true;
}

export function serveBytes(fn: (bytes: Buffer) => Buffer): void {
  serveBytesWith(() => fn);
}

export function serveBytesWith<C = undefined>(open: (context: C) => (bytes: Buffer) => Buffer): void {
  if (parentPort === null) throw new Error("serveBytes must run in a worker thread");
  const { inputs, context } = workerData as ByteJobRequest;
  const fn = open(context as C);
  const started: ByteJobStarted = { started: true };
  parentPort.postMessage(started);
  const outputs = inputs.map((input): Uint8Array | null => {
    try {
      return ownedBytes(fn(Buffer.from(input.buffer, input.byteOffset, input.byteLength)));
    } catch {
      return null;
    }
  });
  const response: ByteJobResponse = { outputs };
  parentPort.postMessage(response, outputs.flatMap((output) => (output === null ? [] : [output.buffer as ArrayBuffer])));
}

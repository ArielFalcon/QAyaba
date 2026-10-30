/**
 * The worker side of a byte job (`off-loop-executor.ts`): a worker module calls `serveBytes` with one pure function. An input the
 * function throws on is refused alone (`null`); nothing of the error, which may quote the input, crosses back.
 */

import { parentPort, workerData } from "node:worker_threads";

/** A view that owns its whole `ArrayBuffer`, so a transfer moves the memory and never detaches a pool other buffers share. */
export function ownedBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
}

export interface ByteJobRequest {
  inputs: Uint8Array[];
}
export interface ByteJobResponse {
  outputs: Array<Uint8Array | null>;
}

export function serveBytes(fn: (bytes: Buffer) => Buffer): void {
  if (parentPort === null) throw new Error("serveBytes must run in a worker thread");
  const { inputs } = workerData as ByteJobRequest;
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

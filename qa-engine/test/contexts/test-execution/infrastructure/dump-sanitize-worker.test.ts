/* The off-loop executor with its real worker: the one boundary where a worker thread is started. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeV8Dump } from "@contexts/objective-signal/application/index.ts";
import { createDumpExecutor } from "@contexts/test-execution/infrastructure/run-dump-bridge.ts";
import { createWorkerExecutor } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

const misbehaving = (maxHeapMb = 128) => createWorkerExecutor({ worker: new URL("./misbehaving.worker.ts", import.meta.url), maxHeapMb });

test("the dump worker returns exactly the bytes the sanitizer returns, and refuses what the sanitizer refuses", async () => {
  const dump = Buffer.from(JSON.stringify([{ url: "https://dev.example/a.js", source: "x\n", exfil: "SECRET", functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] }]));
  const notADump = Buffer.from("not json at all");
  const expected = sanitizeV8Dump(dump);
  const outcome = await createDumpExecutor().run([dump, notADump]);
  assert.equal(outcome.kind, "done");
  if (outcome.kind !== "done") return;
  assert.deepEqual(outcome.outputs[0], expected);
  assert.equal(outcome.outputs[1], null);
});

test("a worker that exceeds its heap limit ends with its own typed outcome and leaves this process alive", async () => {
  assert.deepEqual(await misbehaving().run([Buffer.from("hog")]), { kind: "failed", reason: "heap-limit" });
});

test("a worker that dies is a crash, and one that is told to stop while it spins is aborted", async () => {
  assert.deepEqual(await misbehaving().run([Buffer.from("throw")]), { kind: "failed", reason: "crashed" });
  const stop = new AbortController();
  const spinning = misbehaving().run([Buffer.from("spin")], stop.signal);
  stop.abort();
  assert.deepEqual(await spinning, { kind: "failed", reason: "aborted" });
});

test("a signal that is already aborted starts no worker", async () => {
  const stop = new AbortController();
  stop.abort();
  assert.deepEqual(await createWorkerExecutor({ worker: new URL("./does-not-exist.worker.ts", import.meta.url), maxHeapMb: 128 }).run([Buffer.from("x")], stop.signal), { kind: "failed", reason: "aborted" });
});

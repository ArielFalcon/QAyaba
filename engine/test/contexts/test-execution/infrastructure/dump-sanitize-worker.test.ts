/* The off-loop executor with its real worker: the one boundary where a worker thread is started. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeV8Dump } from "@contexts/objective-signal/application/index.ts";
import { createDumpExecutor } from "@contexts/test-execution/infrastructure/run-dump-bridge.ts";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerExecutor, workerExecArgv } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

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

test("a worker that is told to stop is ended, not left running behind the outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-worker-beat-"));
  try {
    const beat = join(dir, "beat");
    const stop = new AbortController();
    const running = misbehaving().run([Buffer.from(`beat:${beat}`)], stop.signal);
    while (!existsSync(beat)) await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    assert.deepEqual(await running, { kind: "failed", reason: "aborted" });
    /* Whatever the worker wrote before it was ended is all it ever writes. */
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settled = statSync(beat).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(statSync(beat).size, settled, "the worker wrote nothing after it was ended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal that is already aborted starts no worker", async () => {
  const stop = new AbortController();
  stop.abort();
  assert.deepEqual(await createWorkerExecutor({ worker: new URL("./does-not-exist.worker.ts", import.meta.url), maxHeapMb: 128 }).run([Buffer.from("x")], stop.signal), { kind: "failed", reason: "aborted" });
});

/* What `node --test` hands each file's process: per-process flags a Worker refuses (ERR_WORKER_INVALID_EXEC_ARGV) around the loader flags the worker needs to read `.ts` files. */
const ISOLATED_TEST_EXEC_ARGV = [
  "--test-concurrency=0", "--stack-trace-limit=10", "--tls-cipher-list=HIGH:!aNULL", "--use-largepages=off", "--secure-heap=0", "--secure-heap-min=2",
  "--v8-pool-size=4", "--node-snapshot", "--trace-event-file-pattern=node_trace.${rotation}.log", "--test-isolation=process",
  "--import=./test-setup.mjs", "--import=tsx",
];

test("a worker is given the module loader flags of its process and no other flag, whatever form the loader flags take", () => {
  assert.deepEqual(workerExecArgv(ISOLATED_TEST_EXEC_ARGV), ["--import=./test-setup.mjs", "--import=tsx"]);
  /* The `tsx` CLI: separate values. */
  assert.deepEqual(workerExecArgv(["--require", "/x/preflight.cjs", "--import", "file:///x/loader.mjs"]), ["--require", "/x/preflight.cjs", "--import", "file:///x/loader.mjs"]);
  assert.deepEqual(workerExecArgv(["-r", "/x/a.cjs", "--loader", "tsx", "--experimental-loader", "tsx", "-C", "dev", "--conditions=prod"]), ["-r", "/x/a.cjs", "--loader", "tsx", "--experimental-loader", "tsx", "-C", "dev", "--conditions=prod"]);
  /* A flag's value is never taken for a flag, and a dropped flag's separate value goes with it. */
  assert.deepEqual(workerExecArgv(["--test-name-pattern", "x", "--stack-trace-limit", "10", "--import", "tsx"]), ["--import", "tsx"]);
  assert.deepEqual(workerExecArgv(["--import"]), []);
  assert.deepEqual(workerExecArgv([]), []);
});

test("the real dump worker starts with the flags node --test gives an isolated test process", async () => {
  /* The flags of the process under test are whatever this runner gave it; the worker must start with any of them. */
  const outcome = await createDumpExecutor().run([Buffer.from("[]")]);
  assert.equal(outcome.kind, "done");
});

test("a worker that exits without answering is a crash, and one that answers something other than one result per input is a crash", { timeout: 20_000 }, async () => {
  assert.deepEqual(await misbehaving().run([Buffer.from("exit")]), { kind: "failed", reason: "crashed" });
  assert.deepEqual(await misbehaving().run([Buffer.from("short")]), { kind: "failed", reason: "crashed" });
  assert.deepEqual(await misbehaving().run([Buffer.from("not-an-array")]), { kind: "failed", reason: "crashed" });
});

test("the executor stops listening to the caller's signal once its job has ended, however it ended", async () => {
  const stop = new AbortController();
  const done = await createDumpExecutor().run([Buffer.from("[]")], stop.signal);
  assert.equal(done.kind, "done");
  assert.equal(getEventListeners(stop.signal, "abort").length, 0, "after a result");
  const crashed = await misbehaving().run([Buffer.from("throw")], stop.signal);
  assert.equal(crashed.kind, "failed");
  assert.equal(getEventListeners(stop.signal, "abort").length, 0, "after a crash");
});

test("a worker that cannot be created is a typed outcome and not a rejection", async () => {
  /* A worker module that is not a file: the runtime refuses to create the worker, synchronously. */
  const unusable = createWorkerExecutor({ worker: new URL("http://worker.invalid/dump.worker.js"), maxHeapMb: 128 });
  assert.deepEqual(await unusable.run([Buffer.from("x")]), { kind: "failed", reason: "unavailable" });
});

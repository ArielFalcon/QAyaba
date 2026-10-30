/* How a read of the coverage dumps ended is a typed record of the read itself (dumps, bytes, time, outcome), told beside the dumps it returns, so a measurement that comes out empty can say whether nothing was there, the executor did not answer, or the files were not all usable. */
import { mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoverageRead } from "@contexts/objective-signal/domain/coverage-collector.ts";
import { readV8Coverage } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import type { OffLoopExecutor, OffLoopOutcome } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

const NS = "qa-bot-abc";
const CHANGED = ["src/svc.ts"];

function rig(t: TestContext, dumps: Record<string, string>): string {
  const e2e = mkdtempSync(join(tmpdir(), "qa-coverage-outcome-"));
  t.after(() => rmSync(e2e, { recursive: true, force: true }));
  if (Object.keys(dumps).length > 0) {
    const dir = join(e2e, ".qa", "coverage", NS);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(dumps)) writeFileSync(join(dir, name), text);
  }
  return e2e;
}

const decoded = (line: number): Buffer => Buffer.from(JSON.stringify({ refused: false, covered: [["src/svc.ts", [line]]], executable: [], scripts: { total: 1, withSourceMap: 0 }, branches: [] }));
const answering = (outcome: OffLoopOutcome): OffLoopExecutor => ({ run: async () => outcome });
const TWO = { "a.json": "bytes of a", "b.json": "bytes of b!" };

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    return await run();
  } finally {
    warn.mock.restore();
  }
}

async function readWith(e2e: string, executor: OffLoopExecutor, limits?: Parameters<typeof readV8Coverage>[3]): Promise<{ dumps: Awaited<ReturnType<typeof readV8Coverage>>; reads: CoverageRead[] }> {
  const reads: CoverageRead[] = [];
  const dumps = await quietly(() => readV8Coverage(e2e, NS, CHANGED, limits, executor, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reads));
  return { dumps, reads };
}

test("a read that completed says so, with the dumps it decoded, their bytes and how long it took", async (t) => {
  const e2e = rig(t, TWO);
  const { dumps, reads } = await readWith(e2e, answering({ kind: "done", outputs: [decoded(1), decoded(2)] }));

  assert.equal(dumps.length, 2);
  assert.equal(reads.length, 1);
  assert.deepEqual([reads[0]!.namespace, reads[0]!.outcome, reads[0]!.dumps, reads[0]!.bytes], [NS, "completed", 2, "bytes of a".length + "bytes of b!".length]);
  /* The time is the read's own: an executor that does not say when its worker began leaves the start unknown. */
  assert.ok(reads[0]!.durationMs >= 0 && reads[0]!.startedAt > 0 && reads[0]!.startMs === null && reads[0]!.workMs >= 0);
});

for (const reason of ["aborted", "heap-limit", "crashed", "unavailable"] as const) {
  test(`an executor that ends ${reason} is the outcome of the read, with the dumps it was given`, async (t) => {
    const e2e = rig(t, TWO);
    const { dumps, reads } = await readWith(e2e, answering({ kind: "failed", reason }));

    assert.deepEqual(dumps, []);
    assert.deepEqual([reads[0]!.outcome, reads[0]!.dumps], [reason, 2]);
  });
}

test("a folder that is not there is absent, not a failure", async (t) => {
  const e2e = rig(t, {});
  const { dumps, reads } = await readWith(e2e, answering({ kind: "done", outputs: [] }));

  assert.deepEqual(dumps, []);
  assert.deepEqual([reads[0]!.outcome, reads[0]!.dumps, reads[0]!.bytes], ["absent", 0, 0]);
});

test("a dump larger than the cap, and a set past the budget, are over the cap", async (t) => {
  const large = rig(t, { "a.json": "x".repeat(40) });
  assert.equal((await readWith(large, answering({ kind: "done", outputs: [] }), { maxFileBytes: 10, maxTotalBytes: 1_000, maxFiles: 10 })).reads[0]!.outcome, "over-cap");

  const together = rig(t, { "a.json": "x".repeat(8), "b.json": "x".repeat(8) });
  assert.equal((await readWith(together, answering({ kind: "done", outputs: [] }), { maxFileBytes: 10, maxTotalBytes: 12, maxFiles: 10 })).reads[0]!.outcome, "over-cap");

  const many = rig(t, { "a.json": "x", "b.json": "x", "c.json": "x" });
  assert.equal((await readWith(many, answering({ kind: "done", outputs: [] }), { maxFileBytes: 10, maxTotalBytes: 1_000, maxFiles: 2 })).reads[0]!.outcome, "over-cap");
});

test("a dump the worker refused makes the read unusable, which is no cap", async (t) => {
  const e2e = rig(t, TWO);
  const { dumps, reads } = await readWith(e2e, answering({ kind: "done", outputs: [decoded(1), null] }));

  assert.deepEqual(dumps, []);
  assert.equal(reads[0]!.outcome, "unusable");
});

test("with the real worker the record still counts the bytes it handed over, and says how long the worker took to begin and to work", async (t) => {
  const dump = JSON.stringify([{ url: "https://dev.example/src/svc.ts", source: "x\n", functions: [] }]);
  const e2e = rig(t, { "a.json": dump, "b.json": dump });
  const reads: CoverageRead[] = [];

  await quietly(() => readV8Coverage(e2e, NS, CHANGED, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reads));

  assert.deepEqual([reads[0]!.outcome, reads[0]!.dumps, reads[0]!.bytes], ["completed", 2, 2 * dump.length]);
  assert.ok(typeof reads[0]!.startMs === "number" && reads[0]!.workMs >= 0, JSON.stringify(reads[0]));
});

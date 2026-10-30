/* The decoding of the coverage dumps is CPU work on bytes the agent shaped, so it runs in the executor and never on the calling stack: the reader reads and confines the files, hands their bytes over, and merges the plain data that comes back. The cause itself is what these cases watch: a fixture that no decoder of this process can read (its bytes are not JSON) and a fake executor that answers with a marker only an executor-driven call can produce. */
import { mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readV8Coverage } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { BranchSink } from "@contexts/objective-signal/infrastructure/v8-branch-coverage.ts";
import type { DecodeContext } from "@contexts/objective-signal/infrastructure/coverage-decode.ts";
import type { OffLoopExecutor, OffLoopOutcome } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

const NS = "qa-bot-abc";
const CHANGED = ["src/svc.ts"];
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rig(t: TestContext, dumps: Record<string, string>): string {
  const e2e = mkdtempSync(join(tmpdir(), "qa-coverage-executor-"));
  t.after(() => rmSync(e2e, { recursive: true, force: true }));
  const dir = join(e2e, ".qa", "coverage", NS);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(dumps)) writeFileSync(join(dir, name), text);
  return e2e;
}

/* What a worker answers for a dump: the plain data of the dump, as bytes. */
const decoded = (line: number): Buffer => Buffer.from(JSON.stringify({ refused: false, covered: [["src/svc.ts", [line]]], executable: [], scripts: { total: 1, withSourceMap: 0 }, branches: [] }));

/* An executor whose job a gate holds open, and the inputs it was given. */
function gatedExecutor(outcome: (inputs: readonly Buffer[]) => OffLoopOutcome): { executor: OffLoopExecutor; received: Buffer[][]; release(): void } {
  const received: Buffer[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor: OffLoopExecutor = {
    run: async (inputs) => {
      received.push([...inputs]);
      await gate;
      return outcome(inputs);
    },
  };
  return { executor, received, release };
}

test("the dumps are decoded by the executor and not on the calling stack: the executor is given each dump's bytes, the loop turns while it works, and what the read returns is what it answered", async (t) => {
  const e2e = rig(t, { "a.json": "bytes of a, which are no JSON", "b.json": "bytes of b, which are no JSON either" });
  const { executor, received, release } = gatedExecutor(() => ({ kind: "done", outputs: [decoded(7), decoded(8)] }));
  let turned = false;
  setImmediate(() => { turned = true; });

  const pending = readV8Coverage(e2e, NS, CHANGED, undefined, executor);
  let settled = false;
  void pending.then(() => { settled = true; });
  await nextTurn();
  await nextTurn();

  assert.deepEqual(received.map((inputs) => inputs.map(String)), [["bytes of a, which are no JSON", "bytes of b, which are no JSON either"]], "one job for the call, with each file's bytes in the order of the names");
  assert.equal(turned, true, "the loop turned while the executor held the job");
  assert.equal(settled, false, "and the read waits for it");

  release();
  const dumps = await pending;
  assert.deepEqual(dumps.map((d) => [...(d.get("src/svc.ts") ?? [])]), [[7], [8]]);
});

/* What the read says on the way, which goes to logs and to Issues. */
async function capturing<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: await run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

const TWO_DUMPS = { "a.json": "bytes of a", "b.json": "bytes of b" };

for (const [reason, said] of [
  ["heap-limit", "ran out of memory"],
  ["crashed", "stopped before it answered"],
  ["unavailable", "could not be started"],
] as const) {
  test(`a worker that ${said} leaves the set unused with its own reason and adds nothing to the collection: the coverage is unknown, not zero`, async (t) => {
    const e2e = rig(t, TWO_DUMPS);
    const scripts = { total: 0, withSourceMap: 0 };
    const branches = new BranchSink();
    const executable = new Map<string, Set<number>>();
    const ranBy = new Map<string, Set<string>>();
    const executor: OffLoopExecutor = { run: async () => ({ kind: "failed", reason }) };

    const { value, warnings } = await capturing(() => readV8Coverage(e2e, NS, CHANGED, undefined, executor, undefined, scripts, branches, undefined, executable, undefined, ranBy));

    assert.deepEqual(value, [], "nothing is measured");
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0]!.includes(said), warnings[0]);
    assert.ok(warnings[0]!.includes("2 file(s)") && !warnings[0]!.includes("a.json"), "it counts the files and names none");
    assert.deepEqual([scripts, executable.size, ranBy.size, branches.result()], [{ total: 0, withSourceMap: 0 }, 0, 0, []]);
  });
}

test("an executor that rejects instead of answering is a worker that could not be started, and nothing of its error is said", async (t) => {
  const e2e = rig(t, TWO_DUMPS);
  const executor: OffLoopExecutor = { run: () => Promise.reject(new Error("quotes bytes of a")) };

  const { value, warnings } = await capturing(() => readV8Coverage(e2e, NS, CHANGED, undefined, executor));

  assert.deepEqual(value, []);
  assert.ok(warnings.length === 1 && warnings[0]!.includes("could not be started") && !warnings[0]!.includes("quotes"), JSON.stringify(warnings));
});

test("a dump the worker refused, or answered with something that is not the plain data of a dump, leaves the whole set unused: the dumps beside it are a part of the whole", async (t) => {
  for (const refusal of [null, Buffer.from("not json"), Buffer.from(JSON.stringify({ refused: false })), Buffer.from(JSON.stringify({ ...JSON.parse(String(decoded(1))), refused: true }))]) {
    const e2e = rig(t, TWO_DUMPS);
    const executor: OffLoopExecutor = { run: async () => ({ kind: "done", outputs: [decoded(1), refusal] }) };

    const { value, warnings } = await capturing(() => readV8Coverage(e2e, NS, CHANGED, undefined, executor));

    assert.deepEqual(value, [], String(refusal));
    assert.ok(warnings.length === 1 && warnings[0]!.includes("1 file(s)") && warnings[0]!.includes("its content could not be used"), JSON.stringify(warnings));
  }
});

test("the worker is told what the collection wants of it: the changed files, a mutant's edit, whether code lines are asked for and whether the collection still has branches to add to", async (t) => {
  const e2e = rig(t, { "a.json": "bytes of a" });
  const contexts: DecodeContext[] = [];
  const executor: OffLoopExecutor = { run: async (inputs, _signal, context) => (contexts.push(context as DecodeContext), { kind: "done", outputs: inputs.map(() => decoded(1)) }) };
  const mutant = { url: "https://dev/src/svc.ts", sha256: "abc", edit: { start: 1, end: 2, replacement: "!" }, original: "x" };
  const abandoned = new BranchSink();
  abandoned.replay([{ abandon: true }]);

  await readV8Coverage(e2e, NS, CHANGED, undefined, executor);
  await readV8Coverage(e2e, NS, CHANGED, undefined, executor, undefined, undefined, new BranchSink(), undefined, new Map(), mutant);
  await readV8Coverage(e2e, NS, CHANGED, undefined, executor, undefined, undefined, abandoned);

  assert.deepEqual(contexts, [
    { changedFiles: CHANGED, executable: false, branches: false },
    { changedFiles: CHANGED, mutant, executable: true, branches: true },
    { changedFiles: CHANGED, executable: false, branches: false },
  ]);
});

test("a call with no dump to decode starts no worker", async (t) => {
  const e2e = rig(t, {});
  const executor: OffLoopExecutor = { run: async () => assert.fail("no job for an empty directory") };

  assert.deepEqual(await readV8Coverage(e2e, NS, CHANGED, undefined, executor), []);
});

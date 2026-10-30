/* The dump folders of a suite run (coverage, fault-injection counters) are written by agent-authored code, so they live in the run's work dir and only validated, re-serialized files reach the mirror the engine reads (and the agent can read). */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUMP_CHECK_BUDGET_MS, openDumpBridge } from "@contexts/test-execution/infrastructure/run-dump-bridge.ts";
import { countInjectedResponses } from "@contexts/objective-signal/infrastructure/fault-injection-counter-reader.ts";
import type { OffLoopExecutor, OffLoopOutcome } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

interface Rig {
  specDir: string;
  dumpRoot: string;
  workRoot: string;
}

function rig(t: TestContext): Rig {
  const root = mkdtempSync(join(tmpdir(), "dump-bridge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specDir = join(root, "mirror", "e2e");
  mkdirSync(join(specDir, ".qa"), { recursive: true });
  const workRoot = join(root, "work");
  const dumpRoot = join(workRoot, "dumps-1");
  mkdirSync(join(dumpRoot, "coverage"), { recursive: true });
  mkdirSync(join(dumpRoot, "fault-injection"), { recursive: true });
  return { specDir, dumpRoot, workRoot };
}

const NS = "qa-bot-abc";
const open = (r: Rig) => openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot });
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/* An executor whose job a gate holds open, and the inputs it was given: the CPU step is observable as the executor's work or as work on the calling stack. */
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
/* The files below a folder; none when the path is not a folder (nothing there, or the plain file that says a set was left out). */
const entries = (dir: string): string[] => (existsSync(dir) && lstatSync(dir).isDirectory() ? readdirSync(dir).sort() : []);
const DUMP = JSON.stringify([{ url: "https://dev.example/a.js", source: "x\n", functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] }]);

test("while the child runs, the mirror's dump folder for the namespace leads to the work dir and holds nothing of its own", (t) => {
  const r = rig(t);
  const bridge = open(r);
  const link = join(r.specDir, ".qa", "coverage", NS);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  writeFileSync(join(link, "w0-0.json"), DUMP);
  assert.deepEqual(entries(join(r.dumpRoot, "coverage")), ["w0-0.json"]);
  bridge.dispose();
});

test("after the child, only a valid dump reaches the mirror, as a plain file the orchestrator wrote", async (t) => {
  const r = rig(t);
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  await bridge.harvest();
  const dir = join(r.specDir, ".qa", "coverage", NS);
  assert.equal(lstatSync(dir).isSymbolicLink(), false);
  assert.deepEqual(entries(dir), ["w0-0.json"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "w0-0.json"), "utf8"))[0].url, "https://dev.example/a.js");
});

test("an arbitrary file the child wrote to the dump folder does not appear in the mirror", async (t) => {
  const r = rig(t);
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  writeFileSync(join(r.dumpRoot, "coverage", "stolen-session.txt"), "cookie=abc");
  writeFileSync(join(r.dumpRoot, "coverage", "w1-0.json"), JSON.stringify([{ url: "u", source: "s", exfil: "SECRET-TOKEN" }]));
  mkdirSync(join(r.dumpRoot, "coverage", "nested"));
  writeFileSync(join(r.dumpRoot, "coverage", "nested", "x.json"), DUMP);
  await bridge.harvest();
  const dir = join(r.specDir, ".qa", "coverage", NS);
  assert.deepEqual(entries(dir), ["w0-0.json", "w1-0.json"]);
  assert.doesNotMatch(readFileSync(join(dir, "w1-0.json"), "utf8"), /SECRET-TOKEN/, "a key the reader does not use is not carried");
});

test("one dump that is not valid keeps the whole set out: a coverage of some of the dumps is not the run's", async (t) => {
  const r = rig(t);
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  writeFileSync(join(r.dumpRoot, "coverage", "w1-0.json"), "not json at all");
  await bridge.harvest();
  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), []);
});

test("a link, a named pipe's name or an oversized file in the dump folder is never followed or copied", async (t) => {
  const r = rig(t);
  const outside = join(r.workRoot, "outside.json");
  writeFileSync(outside, DUMP);
  const bridge = open(r);
  symlinkSync(outside, join(r.dumpRoot, "coverage", "link.json"));
  await bridge.harvest();
  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), []);
});

test("a set of counters that was left out is not the same as a run that left none: the reader is told the count is unknown", async (t) => {
  const r = rig(t);
  const none = open(r);
  await none.harvest();
  assert.equal(countInjectedResponses(r.specDir, NS), 0, "no counter at all: no response was there to corrupt");

  const left = open(r);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 3 }));
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-2.json"), "not json at all");
  await left.harvest();
  assert.equal(countInjectedResponses(r.specDir, NS), undefined, "one counter that cannot be used, so the count of the others is no count");
  assert.deepEqual(entries(join(r.specDir, ".qa", "fault-injection", NS)), [], "and none of them was carried over");
});

test("a set that was left out is cleared by the next run of the same namespace, whose counters are read as they are", async (t) => {
  const r = rig(t);
  const first = open(r);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), "not json at all");
  await first.harvest();
  rmSync(join(r.dumpRoot, "fault-injection", "injected-1.json"));

  const second = open(r);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 2 }));
  await second.harvest();
  assert.equal(countInjectedResponses(r.specDir, NS), 2);
});

test("the counters of the fault-injection pass reach the mirror as counts and nothing else", async (t) => {
  const r = rig(t);
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-12.json"), JSON.stringify({ corrupted: 4, session: "COOKIE" }));
  await bridge.harvest();
  const dir = join(r.specDir, ".qa", "fault-injection", NS);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "injected-12.json"), "utf8")), { corrupted: 4 });
});

test("a run that wrote nothing leaves no folder for the namespace and no link behind", async (t) => {
  const r = rig(t);
  const bridge = open(r);
  await bridge.harvest();
  assert.equal(existsSync(join(r.specDir, ".qa", "coverage", NS)), false);
  assert.equal(existsSync(join(r.specDir, ".qa", "fault-injection", NS)), false);
});

test("disposing without harvesting (a run that timed out) removes the links and copies nothing", (t) => {
  const r = rig(t);
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  bridge.dispose();
  bridge.dispose();
  assert.equal(existsSync(join(r.specDir, ".qa", "coverage", NS)), false);
});

test("what an earlier run left under the namespace, a link or a folder, is replaced and never followed", async (t) => {
  const r = rig(t);
  const elsewhere = join(r.workRoot, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(r.specDir, ".qa", "coverage"), { recursive: true });
  symlinkSync(elsewhere, join(r.specDir, ".qa", "coverage", NS));
  const bridge = open(r);
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  await bridge.harvest();
  assert.deepEqual(entries(elsewhere), [], "nothing is written through the old link");
  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), ["w0-0.json"]);
});

test("a dump folder that is a link, or a namespace that could leave it, is refused", (t) => {
  const r = rig(t);
  assert.throws(() => openDumpBridge({ specDir: r.specDir, namespace: "../../x", dumpRoot: r.dumpRoot, workRoot: r.workRoot }), /namespace/);
  assert.throws(() => openDumpBridge({ specDir: r.specDir, namespace: "a/b", dumpRoot: r.dumpRoot, workRoot: r.workRoot }), /namespace/);
});

test("a Unicode test-data prefix is a folder name like any other: it opens, harvests and disposes", async (t) => {
  const r = rig(t);
  const namespace = "ñame-abc";
  const bridge = openDumpBridge({ specDir: r.specDir, namespace, dumpRoot: r.dumpRoot, workRoot: r.workRoot });
  const link = join(r.specDir, ".qa", "coverage", namespace);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  writeFileSync(join(link, "w0-0.json"), DUMP);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 2 }));

  await bridge.harvest();

  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", namespace)), ["w0-0.json"]);
  assert.equal(countInjectedResponses(r.specDir, namespace), 2);
  bridge.dispose();
  bridge.dispose();
  assert.equal(lstatSync(join(r.specDir, ".qa", "coverage", namespace)).isDirectory(), true, "the harvested folder stays");
});

test("a namespace that is empty, relative, longer than a folder name or not letters and numbers is refused", (t) => {
  const r = rig(t);
  const refused = ["", ".", "..", "-qa", ".qa", "../x", "a/b", "a\\b", `a${String.fromCharCode(0)}b`, "a\nb", "x".repeat(129)];
  for (const namespace of refused) {
    assert.throws(() => openDumpBridge({ specDir: r.specDir, namespace, dumpRoot: r.dumpRoot, workRoot: r.workRoot }), /namespace/, JSON.stringify(namespace));
  }
  openDumpBridge({ specDir: r.specDir, namespace: "x".repeat(128), dumpRoot: r.dumpRoot, workRoot: r.workRoot }).dispose();
});

test("the time the coverage dumps took does not starve the counters beside them: each kind of dump has the check time of its own", async (t) => {
  const r = rig(t);
  /* Every reading of the clock costs six seconds, so one kind's two readings (its start and its first file) fit the check time and a third reading, a second kind's file read against the first kind's start, would not. */
  let clock = 0;
  const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, now: () => (clock += 6_000) });
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  writeFileSync(join(r.dumpRoot, "fault-injection", "mutated-1.json"), JSON.stringify({ corrupted: 4 }));
  await bridge.harvest();
  assert.equal(countInjectedResponses(r.specDir, NS), 4, "the counters were read, not left out for the time the coverage took");
  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), ["w0-0.json"]);
});

test("a kind of dump whose check outlasts its own time is left out, and the count of its counters is unknown", async (t) => {
  const r = rig(t);
  let clock = 0;
  const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, now: () => (clock += 11_000) });
  writeFileSync(join(r.dumpRoot, "fault-injection", "mutated-1.json"), JSON.stringify({ corrupted: 4 }));
  await bridge.harvest();
  assert.equal(countInjectedResponses(r.specDir, NS), undefined);
});

test("the coverage harvest does its CPU step in the executor, not on the calling stack: the loop turns while the job is pending, and what the executor returns is what reaches the mirror", async (t) => {
  const r = rig(t);
  /* Not JSON: the real sanitizer refuses it, so the marker below can only come from the executor. */
  const fixture = "not json at all";
  const marker = '[{"url":"marker"}]';
  const job = gatedExecutor((inputs) => ({ kind: "done", outputs: inputs.map(() => Buffer.from(marker)) }));
  const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, executor: job.executor });
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), fixture);

  let turned = false;
  setImmediate(() => { turned = true; });
  let settled = false;
  const harvesting = Promise.resolve(bridge.harvest()).then(() => { settled = true; });
  await nextTurn();

  assert.deepEqual(job.received.map((inputs) => inputs.map(String)), [[fixture]], "the executor was given exactly the file's bytes");
  assert.equal(turned, true, "the loop turned while the job was pending");
  assert.equal(settled, false, "the harvest waits for the job");
  job.release();
  await harvesting;
  assert.equal(readFileSync(join(r.specDir, ".qa", "coverage", NS, "w0-0.json"), "utf8"), marker);
});

test("a worker that fails leaves the coverage set out with its own reason, and the counters beside it are still read", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  const reasons = [["heap-limit", /ran out of memory/], ["crashed", /stopped before it answered/]] as const;
  for (const [reason, described] of reasons) {
    const r = rig(t);
    const executor: OffLoopExecutor = { run: async () => ({ kind: "failed", reason }) };
    const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, executor });
    writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
    writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 4 }));
    await bridge.harvest();
    assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), [], reason);
    assert.equal(countInjectedResponses(r.specDir, NS), 4, `${reason}: the counters were read`);
    assert.ok(warnings.some((w) => described.test(w)), `${reason}: the log says why; warnings: ${JSON.stringify(warnings)}`);
  }
});

test("a job that outlasts the check time is ended at the deadline: the harvest settles then and the coverage set is left out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  const r = rig(t);
  let ended = false;
  const executor: OffLoopExecutor = {
    run: (_inputs, signal) => {
      signal?.addEventListener("abort", () => { ended = true; });
      return new Promise(() => undefined);
    },
  };
  const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, executor });
  writeFileSync(join(r.dumpRoot, "coverage", "w0-0.json"), DUMP);
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 2 }));
  const harvesting = bridge.harvest();
  t.mock.timers.tick(DUMP_CHECK_BUDGET_MS);
  await harvesting;
  assert.equal(ended, true, "the executor was told to end its worker");
  assert.deepEqual(entries(join(r.specDir, ".qa", "coverage", NS)), []);
  assert.ok(warnings.some((w) => /time to check the files of this directory ran out/.test(w)), `warnings: ${JSON.stringify(warnings)}`);
  assert.equal(countInjectedResponses(r.specDir, NS), 2, "the time the coverage took does not starve the counters");
});

test("a harvest with no coverage dump starts no job", async (t) => {
  const r = rig(t);
  let started = 0;
  const executor: OffLoopExecutor = { run: async () => { started++; return { kind: "done", outputs: [] }; } };
  const bridge = openDumpBridge({ specDir: r.specDir, namespace: NS, dumpRoot: r.dumpRoot, workRoot: r.workRoot, executor });
  writeFileSync(join(r.dumpRoot, "fault-injection", "injected-1.json"), JSON.stringify({ corrupted: 1 }));
  await bridge.harvest();
  assert.equal(started, 0);
});

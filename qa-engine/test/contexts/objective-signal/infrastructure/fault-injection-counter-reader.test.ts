/* The corrupted re-run of the response oracle leaves one small counter file per worker under `.qa/fault-injection/<namespace>`, written by the fixtures of a run of the tests, which executes code the agent wrote; the orchestrator adds them up to tell "no JSON response was there to corrupt" (no score) from "the suite stayed green under corrupted data". The agent can leave a named pipe, a link or a huge file where a counter is expected, so the read goes through the strict read of spec-path-confinement under a cap. The counters are used whole or not at all: when one of them cannot be used the count is unknown (undefined), said aloud in words that quote nothing it holds, because the counters that could be read are a part of the whole and a part of a count is no count. Every case runs against real files, links and pipes under os.tmpdir(); the pipe case runs under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FAULT_INJECTION_COUNTER_BYTES,
  countInjectedResponses,
} from "@contexts/objective-signal/infrastructure/fault-injection-counter-reader.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const NS = "qa-bot-abc1234-run1-fi";
const SECRET_MARK = "SECRETv1-hunter2";

interface Run {
  e2e: string;
  outside: string;
}

function withRun(run: (r: Run) => void | Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-fault-counter-"));
  const e2e = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  mkdirSync(e2e);
  mkdirSync(outside);
  return Promise.resolve(run({ e2e, outside })).finally(() => rmSync(tmp, { recursive: true, force: true }));
}

function capturing<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-fault-counter-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe case is not exercised";

const counterDirOf = (e2e: string): string => join(e2e, ".qa", "fault-injection", NS);
const writeCounter = (e2e: string, name: string, text: string): string => {
  mkdirSync(counterDirOf(e2e), { recursive: true });
  const path = join(counterDirOf(e2e), name);
  writeFileSync(path, text);
  return path;
};

test("the counters of a namespace are added up, one file per worker", async () => {
  await withRun((r) => {
    writeCounter(r.e2e, "injected-101.json", JSON.stringify({ corrupted: 3 }));
    writeCounter(r.e2e, "injected-202.json", JSON.stringify({ corrupted: 4 }));

    const { value, warnings } = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.equal(value, 7);
    assert.deepEqual(warnings, []);
  });
});

test("a counter that holds no number counts for nothing and does not stop the others", async () => {
  await withRun((r) => {
    writeCounter(r.e2e, "injected-1.json", JSON.stringify({ corrupted: 5 }));
    writeCounter(r.e2e, "injected-2.json", JSON.stringify({ corrupted: "many" }));
    writeCounter(r.e2e, "injected-3.json", JSON.stringify({ other: 9 }));
    writeCounter(r.e2e, "injected-4.json", JSON.stringify([1, 2]));

    const { value, warnings } = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.equal(value, 5, "only the counter that holds a number counts");
    assert.deepEqual(warnings, [], "a counter that says nothing is a counter, not a counter that was lost");
  });
});

test("a counter that is not JSON leaves the count unknown, not the sum of the others, said aloud without quoting it", async () => {
  await withRun((r) => {
    writeCounter(r.e2e, "injected-1.json", JSON.stringify({ corrupted: 5 }));
    writeCounter(r.e2e, "injected-5.json", `${SECRET_MARK}=hunter2 { not json`);

    const { value, warnings } = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.equal(value, undefined, "the counter beside it is a part of the count");
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("injected-"), "no file is named");
    assert.ok(!warnings[0]!.includes(SECRET_MARK) && !warnings[0]!.includes("hunter2"), "a parser's message quotes the file: it is not used");
  });
});

test("a namespace with no counters, or no directory at all, is nothing corrupted, and nothing was refused so nothing is said", async () => {
  await withRun((r) => {
    const missing = capturing(() => countInjectedResponses(r.e2e, NS));
    mkdirSync(counterDirOf(r.e2e), { recursive: true });
    const empty = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.deepEqual([missing.value, empty.value], [0, 0]);
    assert.deepEqual([...missing.warnings, ...empty.warnings], []);
  });
});

test("a counter that is a named pipe is not read and not waited on, and the count is unknown: the counters beside it are a part of it", { skip: NO_NAMED_PIPES }, async () => {
  await withRun(async (r) => {
    writeCounter(r.e2e, "injected-1.json", JSON.stringify({ corrupted: 2 }));
    execFileSync("mkfifo", [join(counterDirOf(r.e2e), "planted.json")]);

    const { value, warnings } = await withoutWaitingOnNamedPipe(join(counterDirOf(r.e2e), "planted.json"), () => capturing(() => countInjectedResponses(r.e2e, NS)));

    assert.equal(value, undefined);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes(counterDirOf(r.e2e)), `the warning names the directory: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes("planted.json") && !warnings[0]!.includes("injected-1.json"), "and no file");
  });
});

test("a counter that is a link leaves the count unknown, whatever the file behind it says, and nothing of it is quoted", async () => {
  await withRun((r) => {
    writeCounter(r.e2e, "injected-1.json", JSON.stringify({ corrupted: 1 }));
    writeFileSync(join(r.outside, "counter.json"), JSON.stringify({ corrupted: 1000, note: SECRET_MARK }));
    symlinkSync(join(r.outside, "counter.json"), join(counterDirOf(r.e2e), "linked.json"));

    const { value, warnings } = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.equal(value, undefined, "neither the file outside the mirror nor the counter beside the link is a count");
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("linked.json"), "no file is named");
    assert.ok(!warnings[0]!.includes(SECRET_MARK));
  });
});

test("a namespace directory that is a link, a regular file, or below a link leaves the count unknown, said aloud", async () => {
  await withRun((r) => {
    mkdirSync(join(r.outside, "counters"));
    writeFileSync(join(r.outside, "counters", "injected-1.json"), JSON.stringify({ corrupted: 50 }));
    mkdirSync(join(r.e2e, ".qa", "fault-injection"), { recursive: true });
    symlinkSync(join(r.outside, "counters"), counterDirOf(r.e2e));
    const linked = capturing(() => countInjectedResponses(r.e2e, NS));

    rmSync(counterDirOf(r.e2e));
    writeFileSync(counterDirOf(r.e2e), "not a directory");
    const file = capturing(() => countInjectedResponses(r.e2e, NS));

    rmSync(join(r.e2e, ".qa"), { recursive: true });
    mkdirSync(join(r.outside, "qa", "fault-injection", NS), { recursive: true });
    writeFileSync(join(r.outside, "qa", "fault-injection", NS, "injected-1.json"), JSON.stringify({ corrupted: 50 }));
    symlinkSync(join(r.outside, "qa"), join(r.e2e, ".qa"));
    const below = capturing(() => countInjectedResponses(r.e2e, NS));

    for (const { value, warnings } of [linked, file, below]) {
      assert.equal(value, undefined, "a directory that cannot be used says nothing of how many were corrupted");
      assert.ok(warnings.some((w) => w.includes(counterDirOf(r.e2e))), JSON.stringify(warnings));
    }
  });
});

test("a counter of exactly the cap is read, and one byte more leaves the count unknown, said aloud", async () => {
  await withRun((r) => {
    const padded = (bytes: number): string => `${JSON.stringify({ corrupted: 2 })}${" ".repeat(bytes - JSON.stringify({ corrupted: 2 }).length)}`;
    writeCounter(r.e2e, "injected-1.json", padded(MAX_FAULT_INJECTION_COUNTER_BYTES));
    const exact = capturing(() => countInjectedResponses(r.e2e, NS));

    writeCounter(r.e2e, "injected-2.json", padded(MAX_FAULT_INJECTION_COUNTER_BYTES + 1));
    const over = capturing(() => countInjectedResponses(r.e2e, NS));

    assert.equal(exact.value, 2, "exactly the cap is read");
    assert.deepEqual(exact.warnings, []);
    assert.equal(over.value, undefined, "the counter within the cap is a part of the count with the one over it");
    assert.equal(over.warnings.length, 1);
  });
});

test("counters within the budget are added up, and more than the budget or the entry cap leave the count unknown", async () => {
  await withRun((r) => {
    const counter = JSON.stringify({ corrupted: 1 });
    const size = Buffer.byteLength(counter);
    for (const name of ["a", "b", "c"]) writeCounter(r.e2e, `injected-${name}.json`, counter);

    const exactBudget = capturing(() => countInjectedResponses(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 3, maxFiles: 3 }));
    const overBudget = capturing(() => countInjectedResponses(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 3 - 1, maxFiles: 3 }));
    const overEntries = capturing(() => countInjectedResponses(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 3, maxFiles: 2 }));

    assert.equal(exactBudget.value, 3, "exactly the budget and exactly the entry cap are read whole");
    assert.deepEqual(exactBudget.warnings, []);
    assert.equal(overBudget.value, undefined);
    assert.equal(overEntries.value, undefined);
    assert.equal(overBudget.warnings.length + overEntries.warnings.length, 2, "each is said once");
  });
});

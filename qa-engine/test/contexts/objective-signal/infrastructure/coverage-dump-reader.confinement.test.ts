/* The coverage dumps are written by a run of the tests, which executes code the agent wrote, and read back by the orchestrator: the agent can leave a named pipe, a link or a file of any size where one is expected. A reader that waited on the pipe would hold the whole orchestrator, one that followed the link would read, and put in the coverage signal, a file outside the mirror, and one that read the file whole would fill its memory. The reader goes through the strict read of spec-path-confinement under a cap. A set of dumps is used whole or not at all: when any file of it cannot be used (refused, over a cap, unreadable, not what it should be), or the directory holds more entries than the reader looks at, none of it is used and the line that says so quotes nothing of it, because the coverage of the rest is a ratio the run never made, lower than the real one, and under enforce it would block a valid change. No dump is no measurement, which is "unknown", and unknown never blocks. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_V8_DUMP_BYTES, MAX_V8_DUMP_FILES, MAX_V8_DUMPS_TOTAL_BYTES } from "@contexts/objective-signal/domain/dump-sanitizers.ts";
import {
  V8_DECODE_BUDGET_MS,
  readV8Coverage,
} from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { ObjectiveSignalPortAdapter } from "@contexts/objective-signal/infrastructure/adapters/objective-signal-port.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";
import { inThreadDecoder } from "../support/in-thread-decoder.ts";
import type { OffLoopExecutor } from "../../../../src/shared-infrastructure/worker/off-loop-executor.ts";

const NS = "qa-bot-abc1234-run1";
const SECRET_MARK = "SECRETv1-hunter2";
const ENTRY = { url: "https://dev/src/svc.ts", source: "export const x = 1;", functions: [] };
const DUMP_TEXT = JSON.stringify([ENTRY]);

/* The dumps of a run, read for the one changed file the dumps above are of: what comes back is a list with one entry for each dump that was used, and the cases below are about which dumps those are. */
const CHANGED = ["src/svc.ts"];
const readV8Dumps = (e2e: string, namespace: string, limits?: Parameters<typeof readV8Coverage>[3]) => readV8Coverage(e2e, namespace, CHANGED, limits, inThreadDecoder);

/* <tmp>/e2e is where the tests ran; <tmp>/outside is what no read may reach. */
interface Run {
  e2e: string;
  outside: string;
}

async function withRun(run: (r: Run) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-coverage-confined-"));
  const e2e = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  mkdirSync(e2e);
  mkdirSync(outside);
  try {
    await run({ e2e, outside });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* What the reader says on the way, which goes to logs and to Issues. */
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

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-coverage-confined-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the cases that rely on them are not exercised" : false;

const dumpDirOf = (e2e: string, namespace = NS): string => join(e2e, ".qa", "coverage", namespace);
const writeDump = (e2e: string, name: string, text: string = DUMP_TEXT): string => {
  mkdirSync(dumpDirOf(e2e), { recursive: true });
  const path = join(dumpDirOf(e2e), name);
  writeFileSync(path, text);
  return path;
};
const sparse = (path: string, bytes: number): void => {
  closeSync(openSync(path, "w"));
  truncateSync(path, bytes);
};

/* ── the V8 dumps ──────────────────────────────────────────────────────────────────────────────── */

/* What a warning about a directory gives for each reason a file was left out: the number of files it covers. Never the name of a file. */
function reasonsIn(warning: string): Map<string, number> {
  const reasons = new Map<string, number>();
  for (const [, reason, count] of warning.matchAll(/(?:— |; )([^;—]*?) ×(\d+)/g)) reasons.set(reason!, Number(count));
  return reasons;
}

test("a dump that is a named pipe is not read and not waited on, and the dumps beside it are not used either: part of a set is no measurement", { skip: NO_NAMED_PIPES }, async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    execFileSync("mkfifo", [join(dumpDirOf(r.e2e), "planted.json")]);

    const { value: dumps, warnings } = await withoutWaitingOnNamedPipe(join(dumpDirOf(r.e2e), "planted.json"), () => capturing(() => readV8Dumps(r.e2e, NS)));

    assert.deepEqual(dumps, [], "the regular dump beside it is not used");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes(dumpDirOf(r.e2e)), `the warning names the directory: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes("planted.json") && !warnings[0]!.includes("good.json"), "and no file");
  });
});

test("a dump that is a link is not read, whatever it points at, and the dumps beside it are not used: nothing of the file behind it is in the signal or quoted", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    writeFileSync(join(r.outside, "stolen.json"), JSON.stringify([{ url: `https://outside/${SECRET_MARK}.js`, source: "x" }]));
    writeFileSync(join(r.outside, "notjson.txt"), `${SECRET_MARK}=hunter2 { not json`);
    symlinkSync(join(r.outside, "stolen.json"), join(dumpDirOf(r.e2e), "linked.json"));
    symlinkSync(join(r.outside, "notjson.txt"), join(dumpDirOf(r.e2e), "linked-text.json"));

    const { value: dumps, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual(dumps, [], "neither the links nor the regular dump beside them are used");
    assert.equal(warnings.length, 1);
    assert.ok(/\b2 file/.test(warnings[0]!), `the warning says how many were left out: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes("linked") && !warnings[0]!.includes("good.json"), "and names none of them");
    assert.ok(!warnings[0]!.includes(SECRET_MARK) && !warnings[0]!.includes("hunter2"), "nothing of the file behind a link is quoted");
  });
});

test("a namespace directory that is a link, or that has a link above it, yields no dumps and says so", async () => {
  await withRun(async (r) => {
    mkdirSync(join(r.outside, "dumps"));
    writeFileSync(join(r.outside, "dumps", "d.json"), DUMP_TEXT);
    mkdirSync(join(r.e2e, ".qa", "coverage"), { recursive: true });
    symlinkSync(join(r.outside, "dumps"), dumpDirOf(r.e2e));

    const linkedNamespace = await capturing(() => readV8Dumps(r.e2e, NS));

    rmSync(join(r.e2e, ".qa"), { recursive: true });
    mkdirSync(join(r.outside, "qa", "coverage", NS), { recursive: true });
    writeFileSync(join(r.outside, "qa", "coverage", NS, "d.json"), DUMP_TEXT);
    symlinkSync(join(r.outside, "qa"), join(r.e2e, ".qa"));
    const linkedAbove = await capturing(() => readV8Dumps(r.e2e, NS));

    for (const { value, warnings } of [linkedNamespace, linkedAbove]) {
      assert.deepEqual(value, [], "nothing behind a link is read");
      assert.ok(warnings.length > 0 && warnings.every((w) => w.includes(dumpDirOf(r.e2e))), `the warning names the directory: ${JSON.stringify(warnings)}`);
    }
  });
});

test("a namespace that is a regular file yields no dumps and does not throw, which the reader's header promises", async () => {
  await withRun(async (r) => {
    mkdirSync(join(r.e2e, ".qa", "coverage"), { recursive: true });
    writeFileSync(dumpDirOf(r.e2e), "not a directory");

    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual(value, []);
    assert.ok(warnings.some((w) => w.includes(dumpDirOf(r.e2e))), JSON.stringify(warnings));
  });
});

test("a namespace with no dumps, or no directory at all, is nothing to say: no dump is no measurement, and nothing was refused", async () => {
  await withRun(async (r) => {
    const missing = await capturing(() => readV8Dumps(r.e2e, NS));
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    writeFileSync(join(dumpDirOf(r.e2e), "note.txt"), "not a dump");
    const empty = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual([missing.value, empty.value], [[], []]);
    assert.deepEqual([...missing.warnings, ...empty.warnings], []);
  });
});

test("a dump that is not JSON leaves the set unused, said aloud, and nothing of it is quoted", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    writeDump(r.e2e, "corrupt.json", `${SECRET_MARK}=hunter2 { not json`);

    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual(value, [], "the dump beside it is not used");
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("corrupt.json") && !warnings[0]!.includes("good.json"), "no file is named");
    assert.ok(!warnings[0]!.includes(SECRET_MARK) && !warnings[0]!.includes("hunter2"), "a parser's message quotes the file: it is not used");
  });
});

test("a dump that cannot be read leaves the set unused, said aloud by the failure's code", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    const locked = writeDump(r.e2e, "locked.json");
    chmodSync(locked, 0o000);
    try {
      const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

      assert.deepEqual(value, []);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.includes("EACCES"), warnings[0]);
      assert.ok(!warnings[0]!.includes("locked.json"), "and no file is named");
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});

test("a dump of a few megabytes is read, and the executor is given the dumps in the order of their names", async () => {
  await withRun(async (r) => {
    const big = JSON.stringify([{ url: "https://dev/big.js", source: "x".repeat(3 * 1024 * 1024) }]);
    writeDump(r.e2e, "b-big.json", big);
    writeDump(r.e2e, "a-small.json");
    const decoded: Array<{ url: string | undefined; length: number | undefined }> = [];
    const executor: OffLoopExecutor = {
      run: async (inputs) => {
        for (const input of inputs) {
          const entry = (JSON.parse(input.toString("utf8")) as Array<{ url?: string; source?: string }>)[0];
          decoded.push({ url: entry?.url, length: entry?.source?.length });
        }
        return { kind: "done", outputs: inputs.map(() => covering()) };
      },
    };

    const { value, warnings } = await capturing(() => readV8Coverage(r.e2e, NS, CHANGED, undefined, executor));

    assert.deepEqual(decoded, [{ url: ENTRY.url, length: ENTRY.source.length }, { url: "https://dev/big.js", length: 3 * 1024 * 1024 }]);
    assert.equal(value.length, 2);
    assert.deepEqual(warnings, []);
  });
});

/* Valid JSON all the way (an empty list and then whitespace), so that nothing but its size can keep a dump from being read. */
const paddedDump = (bytes: number): string => `[]${" ".repeat(bytes - 2)}`;

test("a dump of exactly the production cap is read, and one byte more leaves the whole set unused, said aloud", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    const path = writeDump(r.e2e, "huge.json");

    writeFileSync(path, paddedDump(MAX_V8_DUMP_BYTES));
    const exact = await capturing(() => readV8Dumps(r.e2e, NS));
    writeFileSync(path, paddedDump(MAX_V8_DUMP_BYTES + 1));
    const over = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.equal(exact.value.length, 2, "exactly the cap is read, beside the dump within it: the padded dump is an empty list");
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(over.value, [], "one byte more, and the dump within the cap beside it is not used either");
    assert.equal(over.warnings.length, 1);
    assert.ok(!over.warnings[0]!.includes("huge.json") && !over.warnings[0]!.includes("good.json"), "no file is named");
  });
});

/* An unminified DEV bundle leaves dumps of tens of megabytes: the largest one a run of the reference app left weighed 25.8 MiB, and one replicate of the same suite left a bigger one, which the old 32 MiB cap turned into a set that was not used at all and a coverage that read "no changed file mapped". */
test("a dump of 34 MiB, past the size an unminified page leaves, is read beside the rest of the set", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "good.json");
    const path = writeDump(r.e2e, "big.json");

    writeFileSync(path, paddedDump(34 * 1024 * 1024));
    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.equal(value.length, 2, "the big dump and the one beside it are both used");
    assert.deepEqual(warnings, []);
  });
});

/* The cap is a number of bytes, so the boundary is shown with small limits; the production limits are the defaults of the same parameter. */
test("a dump of exactly the file cap is read and one byte more leaves the whole set unused", async () => {
  await withRun(async (r) => {
    const size = Buffer.byteLength(DUMP_TEXT);
    const limits = { maxFileBytes: size, maxTotalBytes: size * 10, maxFiles: 10 };
    writeDump(r.e2e, "exact.json");
    const exact = await capturing(() => readV8Dumps(r.e2e, NS, limits));
    writeDump(r.e2e, "over.json", `${DUMP_TEXT} `);
    const over = await capturing(() => readV8Dumps(r.e2e, NS, limits));

    assert.equal(exact.value.length, 1, "the dump of exactly the cap is the one that is read");
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(over.value, [], "the dump within the cap is not used beside the one over it");
    assert.equal(over.warnings.length, 1);
  });
});

test("the dumps of a namespace are used when their total is within the budget, and none is when it passes it, said aloud with how many were not read", async () => {
  await withRun(async (r) => {
    const size = Buffer.byteLength(DUMP_TEXT);
    for (const name of ["a.json", "b.json", "c.json", "d.json"]) writeDump(r.e2e, name);

    const within = await capturing(() => readV8Dumps(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 4, maxFiles: 10 }));
    const over = await capturing(() => readV8Dumps(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 3 + 1, maxFiles: 10 }));

    assert.equal(within.value.length, 4, "a total of exactly the budget is read");
    assert.deepEqual(within.warnings, []);
    assert.deepEqual(over.value, [], "one byte under four, and the three that fit are not used either");
    assert.equal(over.warnings.length, 1);
    assert.ok(/\b1 file/.test(over.warnings[0]!), `the warning says how many were left out: ${over.warnings[0]}`);
    assert.ok(!over.warnings[0]!.includes("d.json"), "and names none");
  });
});

test("a namespace with more entries than the cap is not used, said aloud, and a namespace with exactly the cap is read whole", async () => {
  await withRun(async (r) => {
    for (const name of ["a.json", "b.json", "c.json"]) writeDump(r.e2e, name);
    const size = Buffer.byteLength(DUMP_TEXT);

    const exact = await capturing(() => readV8Dumps(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 10, maxFiles: 3 }));
    const cut = await capturing(() => readV8Dumps(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: size * 10, maxFiles: 2 }));

    assert.equal(exact.value.length, 3);
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(cut.value, [], "a part of the entries is a part of the set");
    assert.equal(cut.warnings.length, 1, "the cut is said once");
    assert.ok(/\b2 entries\b/.test(cut.warnings[0]!), `and says how many were looked at: ${cut.warnings[0]}`);
    assert.ok(cut.warnings[0]!.includes(dumpDirOf(r.e2e)), "in which directory");
  });
});

test("a namespace with more dumps than the production entry cap is not used, and the cut is said with the cap", async () => {
  await withRun(async (r) => {
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    for (let i = 0; i < MAX_V8_DUMP_FILES + 1; i++) writeFileSync(join(dumpDirOf(r.e2e), `d-${String(i).padStart(5, "0")}.json`), "[]");

    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual(value, [], "no part of it is used");
    assert.ok(warnings.some((w) => new RegExp(`\\b${MAX_V8_DUMP_FILES} entries\\b`).test(w)), `the cut is said: ${JSON.stringify(warnings)}`);
  });
});

test("a warning counts what was left out by why, in one line for the directory, and names none of the files, however many are planted", async () => {
  await withRun(async (r) => {
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(dumpDirOf(r.e2e), `corrupt-${i}.json`), "{ not json");
    writeFileSync(join(r.outside, "target.json"), DUMP_TEXT);
    for (let i = 0; i < 3; i++) symlinkSync(join(r.outside, "target.json"), join(dumpDirOf(r.e2e), `linked-${i}.json`));

    const { warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.equal(warnings.length, 1, "one line for the whole directory, not one per file");
    const reasons = reasonsIn(warnings[0]!);
    assert.deepEqual([...reasons.values()].sort((a, b) => a - b), [3, 40], "how many files each reason covers");
    assert.ok([...reasons.keys()].every((reason) => reason.length > 0), "each reason is said");
    assert.ok(/\b43 file/.test(warnings[0]!), `and how many files in all: ${warnings[0]}`);
    assert.ok(!/(corrupt|linked)-\d/.test(warnings[0]!), "no file is named");
    assert.ok(warnings[0]!.length < 600, "the line is bounded however many are planted");
  });
});

test("a file name never reaches a warning, so it cannot forge a log line or fill one", async () => {
  await withRun(async (r) => {
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    writeFileSync(join(dumpDirOf(r.e2e), "a-line\nbreak [qa] FORGED.json"), "{ not json");
    writeFileSync(join(dumpDirOf(r.e2e), `b-${"x".repeat(200)}.json`), "{ not json");

    const { warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("\n"), "a newline in a name cannot break the line");
    assert.ok(!warnings[0]!.includes("FORGED"), "and nothing of a name is in it");
    assert.ok(!warnings[0]!.includes("xxxxxxxxxx"), "however long");
  });
});

test("every kind of dump that is left out gives its own reason, in words of the reader's own: refused, not JSON, over the budget and gone before it was read", { skip: process.platform === "win32" ? "a backslash cannot be in a file name here" : false }, async () => {
  await withRun(async (r) => {
    const size = Buffer.byteLength(DUMP_TEXT);
    const corrupt = "{ not json";
    writeDump(r.e2e, "a-fine.json");
    writeDump(r.e2e, "b-corrupt.json", corrupt);
    writeFileSync(join(r.outside, "target.json"), DUMP_TEXT);
    symlinkSync(join(r.outside, "target.json"), join(dumpDirOf(r.e2e), "c-linked.json"));
    /* A backslash is a separator to the strict read, so a file named with one is not found again once it is listed. */
    writeFileSync(join(dumpDirOf(r.e2e), "d\\gone.json"), DUMP_TEXT);
    writeDump(r.e2e, "e-over-the-budget.json");

    /* The budget holds the fine dump and the corrupt one, which was read before it was found not to be JSON, and not the last. */
    const budget = size + Buffer.byteLength(corrupt) + size - 1;
    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS, { maxFileBytes: size, maxTotalBytes: budget, maxFiles: 10 }));

    assert.deepEqual(value, [], "the fine dump is not used beside the four that could not be");
    assert.equal(warnings.length, 1);
    const reasons = reasonsIn(warnings[0]!);
    assert.equal(reasons.size, 4, `four reasons, one for each: ${warnings[0]}`);
    assert.deepEqual([...reasons.values()], [1, 1, 1, 1]);
    assert.ok([...reasons.keys()].every((reason) => reason.length > 0), "each is said");
    assert.ok(/\b4 file/.test(warnings[0]!), warnings[0]);
  });
});

/* ── the time the dumps of a run are given ─────────────────────────────────────────────────────── */

/* The answer of a worker that decoded a dump to the lines of the changed file. */
const covering = (): Buffer => Buffer.from(JSON.stringify({ refused: false, covered: [["src/svc.ts", [1]]], executable: [], scripts: { total: 1, withSourceMap: 0 }, branches: [] }));
/* An executor that answers when it is told to stop, as the real one does: with an aborted outcome. */
const waitsToBeStopped = (): { executor: OffLoopExecutor; signals: AbortSignal[] } => {
  const signals: AbortSignal[] = [];
  const executor: OffLoopExecutor = {
    run: (_inputs, signal) =>
      new Promise((resolve) => {
        signals.push(signal!);
        signal!.addEventListener("abort", () => resolve({ kind: "failed", reason: "aborted" }), { once: true });
      }),
  };
  return { executor, signals };
};

test("the dumps of a run are decoded in the time they are given: a run that spends it ends the worker, leaves the set unused and says that it was the time", async (t) => {
  await withRun(async (r) => {
    for (const name of ["a.json", "b.json", "c.json", "d.json"]) writeDump(r.e2e, name);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { executor, signals } = waitsToBeStopped();

    const pending = capturing(() => readV8Coverage(r.e2e, NS, CHANGED, undefined, executor, 100));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signals[0]?.aborted, false, "the worker has the whole of the time");
    t.mock.timers.tick(99);
    assert.equal(signals[0]?.aborted, false, "and it is not stopped before it is spent");
    t.mock.timers.tick(1);
    const { value, warnings } = await pending;

    assert.deepEqual(value, [], "nothing is used of a set that was not all decoded");
    assert.equal(signals[0]?.aborted, true, "the worker was told to stop");
    const timeWarnings = warnings.filter((w) => /\btime\b/.test(w));
    assert.equal(timeWarnings.length, 1, `the time is said once: ${JSON.stringify(warnings)}`);
    assert.ok(timeWarnings[0]!.includes(dumpDirOf(r.e2e)) && timeWarnings[0]!.includes("100 ms"), timeWarnings[0]);
  });
});

test("a run that is given enough time uses every dump, as it did", async () => {
  await withRun(async (r) => {
    for (const name of ["a.json", "b.json", "c.json", "d.json"]) writeDump(r.e2e, name);
    const executor: OffLoopExecutor = { run: async (inputs) => ({ kind: "done", outputs: inputs.map(() => covering()) }) };

    const { value, warnings } = await capturing(() => readV8Coverage(r.e2e, NS, CHANGED, undefined, executor, 10_000));

    assert.equal(value.length, 4);
    assert.deepEqual(warnings, []);
  });
});

test("with the real worker: a run that has no time to start it leaves the set unused and says that it was the time, and one that has time reads both dumps", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "a-fine.json");
    writeDump(r.e2e, "b-fine.json");

    const hurried = await capturing(() => readV8Coverage(r.e2e, NS, CHANGED, undefined, undefined, 1));
    const unhurried = await capturing(() => readV8Coverage(r.e2e, NS, CHANGED, undefined, undefined, 60_000));

    assert.deepEqual(hurried.value, []);
    assert.ok(hurried.warnings.some((w) => /\btime\b/.test(w)), `and the time is said: ${JSON.stringify(hurried.warnings)}`);
    assert.equal(unhurried.value.length, 2);
    assert.deepEqual(unhurried.warnings, []);
  });
});

test("the limits on the dumps of a run keep a freeze to some seconds: the time they are given is a few seconds, and the dump that is decoded is some tens of megabytes at the most", () => {
  const MIB = 1024 * 1024;
  /* The largest dump a run of the reference app left, of an unminified DEV bundle: the page's scripts and their source maps. */
  const largestMeasured = 26 * MIB;

  assert.ok(V8_DECODE_BUDGET_MS >= 2_000 && V8_DECODE_BUDGET_MS <= 15_000, `${V8_DECODE_BUDGET_MS} ms`);
  /* A dump of nothing but empty arrays costs some fifteen times its size in heap and a second of parse for every 12 MiB, so the ceiling is what the worst shape at the cap may hold: 96 MiB of it is 1.4 GB of the 2.24 GB heap Node sizes for this container, and the real shape measured 3.5 times its size. */
  assert.ok(MAX_V8_DUMP_BYTES >= largestMeasured * 1.5 && MAX_V8_DUMP_BYTES <= 96 * MIB, `${MAX_V8_DUMP_BYTES} bytes`);
  /* The budget of a run's dumps together holds some forty of the largest measured, and the clock is what bounds the time they may take: a page of an unminified build is tens of megabytes, so the bytes a run may leave are counted in dumps of that size, not in the smallest ones. */
  assert.ok(MAX_V8_DUMPS_TOTAL_BYTES >= 20 * largestMeasured && MAX_V8_DUMPS_TOTAL_BYTES <= 1024 * MIB, `${MAX_V8_DUMPS_TOTAL_BYTES} bytes`);
});

/* ── what it comes to for the change-coverage signal ───────────────────────────────────────────── */

const CHANGED_DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "+++ b/src/checkout.ts", "@@ -1,0 +1,2 @@", "+a", "+b"].join("\n");
/* A dump that covers both changed lines of src/checkout.ts. */
const COVERING_DUMP = JSON.stringify([{ url: "https://dev/src/checkout.ts", source: "a\nb\n", functions: [{ ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] }] }]);
/* A dump of the same script that ran the first line and not the second: half of the change, under the policy's minimum. */
const HALF_COVERING_DUMP = JSON.stringify([{ url: "https://dev/src/checkout.ts", source: "a\nb\n", functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }] }]);

/* The signal as the run builds it: the real collector over the real readers, the real assembler and the real decision, under a policy that blocks. */
async function measureChangeCoverage(e2e: string, mode: "signal" | "enforce"): Promise<{ status: string; blocked: boolean }> {
  const collector = makeTargetCoverageCollector([], inThreadDecoder);
  const port = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService() },
    { policy: { mode, minRatio: 0.7 }, repoDir: e2e, assembleChangeCoverage, namespace: NS },
  );
  const result = await port.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), e2e, CHANGED_DIFF);
  return { status: result.status, blocked: port.blocks(result.status) };
}

test("a dump that is read measures the change coverage, and one that covers too little of it blocks under enforce: the control for the cases below", async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "covering.json", COVERING_DUMP);
    assert.deepEqual(await capturing(() => measureChangeCoverage(r.e2e, "enforce")).then((c) => c.value), { status: "pass", blocked: false });

    writeDump(r.e2e, "covering.json", HALF_COVERING_DUMP);
    assert.deepEqual(await capturing(() => measureChangeCoverage(r.e2e, "enforce")).then((c) => c.value), { status: "fail", blocked: true });
    assert.deepEqual(await capturing(() => measureChangeCoverage(r.e2e, "signal")).then((c) => c.value), { status: "fail", blocked: false }, "and only enforce blocks");
  });
});

test("a dump that cannot be used leaves the change coverage unknown, which never blocks, even under enforce: not a pass the agent made up, not a failure", async () => {
  await withRun(async (r) => {
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    writeFileSync(join(r.outside, "covering.json"), COVERING_DUMP);
    symlinkSync(join(r.outside, "covering.json"), join(dumpDirOf(r.e2e), "linked.json"));
    writeFileSync(join(dumpDirOf(r.e2e), "corrupt.json"), "{ not json");
    const linkedAndCorrupt = await capturing(() => measureChangeCoverage(r.e2e, "enforce"));

    rmSync(join(dumpDirOf(r.e2e), "linked.json"));
    rmSync(join(dumpDirOf(r.e2e), "corrupt.json"));
    sparse(join(dumpDirOf(r.e2e), "huge.json"), MAX_V8_DUMP_BYTES + 1);
    const tooBig = await capturing(() => measureChangeCoverage(r.e2e, "enforce"));

    for (const { value } of [linkedAndCorrupt, tooBig]) {
      assert.deepEqual(value, { status: "unknown", blocked: false });
    }
  });
});

test("a dump that is a named pipe leaves the change coverage unknown and the signal does not wait on it", { skip: NO_NAMED_PIPES }, async () => {
  await withRun(async (r) => {
    mkdirSync(dumpDirOf(r.e2e), { recursive: true });
    execFileSync("mkfifo", [join(dumpDirOf(r.e2e), "planted.json")]);

    const { value } = await withoutWaitingOnNamedPipe(join(dumpDirOf(r.e2e), "planted.json"), () => capturing(() => measureChangeCoverage(r.e2e, "enforce")));

    assert.deepEqual(value, { status: "unknown", blocked: false });
  });
});

/* The ways a dump is left out, each planted beside the dump that alone covers too little of the change and so alone blocks under enforce. The ratio of what is left would be one the run never made. */
const DUMPS_LEFT_OUT: ReadonlyArray<{ what: string; plant: (r: Run) => void; restore?: (r: Run) => void; skip?: string | false }> = [
  { what: "a dump over the cap", plant: (r) => sparse(join(dumpDirOf(r.e2e), "b-huge.json"), MAX_V8_DUMP_BYTES + 1) },
  { what: "a dump that is not JSON", plant: (r) => writeFileSync(join(dumpDirOf(r.e2e), "b-corrupt.json"), "{ not json") },
  {
    what: "a dump that is a link",
    plant: (r) => {
      writeFileSync(join(r.outside, "covering.json"), COVERING_DUMP);
      symlinkSync(join(r.outside, "covering.json"), join(dumpDirOf(r.e2e), "b-linked.json"));
    },
  },
  {
    what: "more dumps than the reader looks at",
    plant: (r) => {
      for (let i = 0; i < MAX_V8_DUMP_FILES; i++) writeFileSync(join(dumpDirOf(r.e2e), `c-${String(i).padStart(5, "0")}.json`), "[]");
    },
  },
  {
    what: "a dump that cannot be read",
    skip: NO_MODE_RESTRICTIONS,
    plant: (r) => chmodSync(writeDump(r.e2e, "b-locked.json"), 0o000),
    restore: (r) => chmodSync(join(dumpDirOf(r.e2e), "b-locked.json"), 0o644),
  },
];

for (const { what, plant, restore, skip } of DUMPS_LEFT_OUT) {
  test(`${what} next to a dump that blocks under enforce leaves the change coverage unknown, not a failure: the ratio of the rest is not a measurement the run made`, { skip: skip ?? false }, async () => {
    await withRun(async (r) => {
      writeDump(r.e2e, "a-half.json", HALF_COVERING_DUMP);
      const alone = await capturing(() => measureChangeCoverage(r.e2e, "enforce"));

      plant(r);
      try {
        const beside = await capturing(() => measureChangeCoverage(r.e2e, "enforce"));

        assert.deepEqual(alone.value, { status: "fail", blocked: true }, "the control: the dump alone blocks");
        assert.deepEqual(beside.value, { status: "unknown", blocked: false });
      } finally {
        restore?.(r);
      }
    });
  });
}

test("a dump that is a named pipe next to a dump that blocks under enforce leaves the change coverage unknown, and the signal does not wait on it", { skip: NO_NAMED_PIPES }, async () => {
  await withRun(async (r) => {
    writeDump(r.e2e, "a-half.json", HALF_COVERING_DUMP);
    execFileSync("mkfifo", [join(dumpDirOf(r.e2e), "b-planted.json")]);

    const { value } = await withoutWaitingOnNamedPipe(join(dumpDirOf(r.e2e), "b-planted.json"), () => capturing(() => measureChangeCoverage(r.e2e, "enforce")));

    assert.deepEqual(value, { status: "unknown", blocked: false });
  });
});

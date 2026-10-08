/* The coverage dumps and the native reports are written by a run of the tests, which executes code the agent wrote, and read back by the orchestrator: the agent can leave a named pipe, a link or a file of any size where one is expected. A reader that waited on the pipe would hold the whole orchestrator, one that followed the link would read, and put in the coverage signal, a file outside the mirror, and one that read the file whole would fill its memory. The readers go through the strict read of spec-path-confinement under a cap. A set of dumps, or of reports, is used whole or not at all: when any file of it cannot be used (refused, over a cap, unreadable, not what it should be), or the directory holds more entries than the reader looks at, none of it is used and the line that says so quotes nothing of it, because the coverage of the rest is a ratio the run never made, lower than the real one, and under enforce it would block a valid change. No dump is no measurement, which is "unknown", and unknown never blocks. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_COVERAGE_REPORT_BYTES,
  MAX_V8_DUMP_BYTES,
  MAX_V8_DUMP_FILES,
  readNativeReports,
  readV8Dumps,
} from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector.ts";
import { NullValueOracleAdapter } from "@contexts/objective-signal/infrastructure/null-value-oracle.adapter.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { ObjectiveSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const NS = "qa-bot-abc1234-run1";
const SECRET_MARK = "SECRETv1-hunter2";
const ENTRY = { url: "https://dev/src/svc.ts", source: "export const x = 1;", functions: [] };
const DUMP_TEXT = JSON.stringify([ENTRY]);

/* <tmp>/e2e is where the tests ran (and the repository, for a code run); <tmp>/outside is what no read may reach. */
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

test("a dump of a few megabytes is read, and the dumps come back in the order of their names", async () => {
  await withRun(async (r) => {
    const big = JSON.stringify([{ url: "https://dev/big.js", source: "x".repeat(3 * 1024 * 1024) }]);
    writeDump(r.e2e, "b-big.json", big);
    writeDump(r.e2e, "a-small.json");

    const { value, warnings } = await capturing(() => readV8Dumps(r.e2e, NS));

    assert.deepEqual(value.map((d) => d.path), [join(dumpDirOf(r.e2e), "a-small.json"), join(dumpDirOf(r.e2e), "b-big.json")]);
    assert.equal(value[1]!.entries[0]!.source!.length, 3 * 1024 * 1024);
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

    assert.deepEqual(exact.value.map((d) => d.entries.length), [1, 0], "exactly the cap is read: the dump is an empty list");
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(over.value, [], "one byte more, and the dump within the cap beside it is not used either");
    assert.equal(over.warnings.length, 1);
    assert.ok(!over.warnings[0]!.includes("huge.json") && !over.warnings[0]!.includes("good.json"), "no file is named");
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

    assert.deepEqual(exact.value.map((d) => d.path), [join(dumpDirOf(r.e2e), "exact.json")]);
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

/* ── the native reports ────────────────────────────────────────────────────────────────────────── */

type ReportReader = (repoDir: string) => Promise<Array<{ path: string }>>;

/* The reports of one kind, as a run reads them: all the kinds a run can leave together. */
const reportsOf = (kind: "lcov" | "istanbul" | "jacoco"): ReportReader => async (repoDir) => (await readNativeReports(repoDir))[kind];

/* The reports a repository's tooling leaves, in the order a reader tries them. */
const REPORTS: ReadonlyArray<{ reader: string; read: ReportReader; candidates: readonly [string, ...string[]]; text: string }> = [
  { reader: "lcov", read: reportsOf("lcov"), candidates: ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"], text: "SF:src/a.ts\nDA:1,1\nend_of_record\n" },
  { reader: "istanbul", read: reportsOf("istanbul"), candidates: ["coverage/coverage-final.json"], text: JSON.stringify({ "/repo/src/a.ts": { path: "/repo/src/a.ts" } }) },
  { reader: "jacoco", read: reportsOf("jacoco"), candidates: ["target/site/jacoco/jacoco.xml", "build/reports/jacoco/test/jacocoTestReport.xml", "target/jacoco.xml"], text: "<report></report>" },
];

for (const { reader, read, candidates, text } of REPORTS) {
  const first = candidates[0];
  const plant = (repo: string, rel: string, content: string): string => {
    const path = join(repo, ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  test(`${reader}: a report that is a named pipe yields nothing and is not waited on, said aloud`, { skip: NO_NAMED_PIPES }, async () => {
    await withRun(async (r) => {
      mkdirSync(join(r.e2e, first, ".."), { recursive: true });
      execFileSync("mkfifo", [join(r.e2e, first)]);

      const { value, warnings } = await withoutWaitingOnNamedPipe(join(r.e2e, first), () => capturing(() => read(r.e2e)));

      assert.deepEqual(value, []);
      assert.ok(warnings.some((w) => w.includes(first)), JSON.stringify(warnings));
    });
  });

  test(`${reader}: a report that is a link yields nothing, whatever it points at, and nothing of the file behind it is quoted`, async () => {
    await withRun(async (r) => {
      writeFileSync(join(r.outside, "secret.txt"), `${SECRET_MARK}=hunter2`);
      mkdirSync(join(r.e2e, first, ".."), { recursive: true });
      symlinkSync(join(r.outside, "secret.txt"), join(r.e2e, first));

      const { value, warnings } = await capturing(() => read(r.e2e));

      assert.deepEqual(value, [], "the file outside the mirror is not in the signal");
      assert.ok(warnings.some((w) => w.includes(first)), JSON.stringify(warnings));
      assert.ok(!warnings.join("\n").includes(SECRET_MARK) && !warnings.join("\n").includes("hunter2"));
    });
  });

  test(`${reader}: a directory in its place yields nothing and does not throw, which the reader's header promises`, async () => {
    await withRun(async (r) => {
      mkdirSync(join(r.e2e, first), { recursive: true });

      const { value, warnings } = await capturing(() => read(r.e2e));

      assert.deepEqual(value, []);
      assert.ok(warnings.some((w) => w.includes(first)), JSON.stringify(warnings));
    });
  });

  test(`${reader}: a directory above the report that is a link yields nothing, said aloud`, async () => {
    const parent = first.split("/")[0]!;
    await withRun(async (r) => {
      plant(join(r.outside, "real"), first, text);
      symlinkSync(join(r.outside, "real", parent), join(r.e2e, parent));

      const { value, warnings } = await capturing(() => read(r.e2e));

      assert.deepEqual(value, []);
      assert.ok(warnings.some((w) => w.includes(first)), JSON.stringify(warnings));
    });
  });

  test(`${reader}: a report is read whole, and one of more than the cap is left out, said aloud`, async () => {
    await withRun(async (r) => {
      const path = plant(r.e2e, first, text);

      const small = await capturing(() => read(r.e2e));
      assert.equal(small.value.length, 1);
      assert.equal(small.value[0]!.path, path);
      assert.deepEqual(small.warnings, []);

      /* The same report padded with whitespace, which every format reads past: nothing but its size can keep it from being read. */
      writeFileSync(path, text + " ".repeat(MAX_COVERAGE_REPORT_BYTES + 1 - text.length));
      const over = await capturing(() => read(r.e2e));
      assert.deepEqual(over.value, [], "one byte over the cap");
      assert.ok(over.warnings.some((w) => w.includes(first)), JSON.stringify(over.warnings));
    });
  });

  if (candidates.length > 1) {
    test(`${reader}: the first report that is there decides: one it cannot use is not made up for by another further down the list`, async () => {
      await withRun(async (r) => {
        mkdirSync(join(r.e2e, first), { recursive: true });
        plant(r.e2e, candidates[1]!, text);

        const { value } = await capturing(() => read(r.e2e));

        assert.deepEqual(value, [], "the report that was found and refused is the answer: nothing measured");
      });
    });
  }

  test(`${reader}: a report that cannot be read yields nothing, said aloud by the failure's code`, { skip: NO_MODE_RESTRICTIONS }, async () => {
    await withRun(async (r) => {
      const path = plant(r.e2e, first, text);
      chmodSync(path, 0o000);
      try {
        const { value, warnings } = await capturing(() => read(r.e2e));

        assert.deepEqual(value, []);
        assert.ok(warnings.some((w) => w.includes(first) && w.includes("EACCES")), JSON.stringify(warnings));
      } finally {
        chmodSync(path, 0o644);
      }
    });
  });
}

test("lcov: a report of exactly the cap is read, as the text it holds", async () => {
  await withRun(async (r) => {
    mkdirSync(join(r.e2e, "coverage"));
    sparse(join(r.e2e, "coverage", "lcov.info"), MAX_COVERAGE_REPORT_BYTES);

    const { value } = await capturing(() => readNativeReports(r.e2e));

    assert.equal(value.lcov.length, 1);
    assert.equal(value.lcov[0]!.text.length, MAX_COVERAGE_REPORT_BYTES);
  });
});

/* One report of each kind a run can leave, each of which says something different about the change. */
const LCOV_REPORT = "SF:src/checkout.ts\nDA:1,1\nDA:2,0\nend_of_record\n";
const JACOCO_REPORT = '<package name="src"><sourcefile name="Other.java"><line nr="5" ci="1"/></sourcefile></package>';

test("the reports of a run are used whole or not at all: one that cannot be used leaves the reports of every other kind unused", async () => {
  await withRun(async (r) => {
    const plant = (rel: string, content: string): void => {
      mkdirSync(join(r.e2e, rel, ".."), { recursive: true });
      writeFileSync(join(r.e2e, rel), content);
    };
    plant("coverage/lcov.info", LCOV_REPORT);
    plant("target/site/jacoco/jacoco.xml", JACOCO_REPORT);
    const whole = await capturing(() => readNativeReports(r.e2e));

    plant("coverage/coverage-final.json", `${SECRET_MARK}=hunter2 { not json`);
    const partial = await capturing(() => readNativeReports(r.e2e));

    assert.deepEqual([whole.value.lcov.length, whole.value.istanbul.length, whole.value.jacoco.length], [1, 0, 1]);
    assert.deepEqual(whole.warnings, []);
    assert.deepEqual(partial.value, { lcov: [], istanbul: [], jacoco: [] }, "the lcov and the JaCoCo reports are not used beside an Istanbul report that cannot be");
    assert.equal(partial.warnings.length, 1);
    assert.ok(partial.warnings[0]!.includes("coverage-final.json"), "the warning names the report");
    assert.ok(!partial.warnings[0]!.includes(SECRET_MARK) && !partial.warnings[0]!.includes("hunter2"), "and quotes nothing of it");
  });
});

/* ── what it comes to for the change-coverage signal ───────────────────────────────────────────── */

const CHANGED_DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "+++ b/src/checkout.ts", "@@ -1,0 +1,2 @@", "+a", "+b"].join("\n");
/* A dump that covers both changed lines of src/checkout.ts. */
const COVERING_DUMP = JSON.stringify([{ url: "https://dev/src/checkout.ts", source: "a\nb\n", functions: [{ ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] }] }]);
/* A dump of the same script that ran the first line and not the second: half of the change, under the policy's minimum. */
const HALF_COVERING_DUMP = JSON.stringify([{ url: "https://dev/src/checkout.ts", source: "a\nb\n", functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }] }]);

/* The signal as the run builds it: the real collector over the real readers, the real assembler and the real decision, under a policy that blocks. */
async function measureChangeCoverage(e2e: string, mode: "signal" | "enforce"): Promise<{ status: string; blocked: boolean }> {
  const collector = makeTargetCoverageCollector({ target: "e2e", repoDir: e2e, e2eDir: e2e, changedFiles: [] });
  const port = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), oracle: new NullValueOracleAdapter() },
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

/* The same signal for a code run: the real collector over the reports the tooling leaves in the repository. */
async function measureCodeChangeCoverage(repo: string, mode: "signal" | "enforce"): Promise<{ status: string; blocked: boolean }> {
  const collector = makeTargetCoverageCollector({ target: "code", repoDir: repo, e2eDir: repo, changedFiles: ["src/checkout.ts"] });
  const port = new ObjectiveSignalPortAdapter(
    { collector, decide: new DecideCoverageService(), oracle: new NullValueOracleAdapter() },
    { policy: { mode, minRatio: 0.7 }, repoDir: repo, assembleChangeCoverage, namespace: NS },
  );
  const result = await port.measure(BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]), repo, CHANGED_DIFF);
  return { status: result.status, blocked: port.blocks(result.status) };
}

/* The ways a report is left out, each planted beside the lcov report that alone covers half of the change and so alone blocks under enforce. */
const REPORTS_LEFT_OUT: ReadonlyArray<{ what: string; plant: (r: Run) => void }> = [
  {
    what: "a JaCoCo report over the cap",
    plant: (r) => {
      mkdirSync(join(r.e2e, "target", "site", "jacoco"), { recursive: true });
      sparse(join(r.e2e, "target", "site", "jacoco", "jacoco.xml"), MAX_COVERAGE_REPORT_BYTES + 1);
    },
  },
  { what: "an Istanbul report that is not JSON", plant: (r) => writeFileSync(join(r.e2e, "coverage", "coverage-final.json"), "{ not json") },
  {
    what: "a JaCoCo report that is a link",
    plant: (r) => {
      mkdirSync(join(r.e2e, "target", "site", "jacoco"), { recursive: true });
      writeFileSync(join(r.outside, "jacoco.xml"), JACOCO_REPORT);
      symlinkSync(join(r.outside, "jacoco.xml"), join(r.e2e, "target", "site", "jacoco", "jacoco.xml"));
    },
  },
];

for (const { what, plant } of REPORTS_LEFT_OUT) {
  test(`${what} next to an lcov report that blocks under enforce leaves the change coverage of a code run unknown, not a failure`, async () => {
    await withRun(async (r) => {
      mkdirSync(join(r.e2e, "coverage"), { recursive: true });
      writeFileSync(join(r.e2e, "coverage", "lcov.info"), LCOV_REPORT);
      const alone = await capturing(() => measureCodeChangeCoverage(r.e2e, "enforce"));

      plant(r);
      const beside = await capturing(() => measureCodeChangeCoverage(r.e2e, "enforce"));

      assert.deepEqual(alone.value, { status: "fail", blocked: true }, "the control: the lcov report alone blocks");
      assert.deepEqual(beside.value, { status: "unknown", blocked: false });
    });
  });
}

test("an lcov report over the cap leaves the change coverage of a code run unknown, which never blocks, even under enforce", async () => {
  await withRun(async (r) => {
    mkdirSync(join(r.e2e, "coverage"), { recursive: true });
    sparse(join(r.e2e, "coverage", "lcov.info"), MAX_COVERAGE_REPORT_BYTES + 1);

    const { value } = await capturing(() => measureCodeChangeCoverage(r.e2e, "enforce"));

    assert.deepEqual(value, { status: "unknown", blocked: false });
  });
});

test("istanbul: a report that is not JSON yields nothing, said aloud, and nothing of it is quoted", async () => {
  await withRun(async (r) => {
    mkdirSync(join(r.e2e, "coverage"));
    writeFileSync(join(r.e2e, "coverage", "coverage-final.json"), `${SECRET_MARK}=hunter2 { not json`);

    const { value, warnings } = await capturing(() => readNativeReports(r.e2e));

    assert.deepEqual(value.istanbul, []);
    assert.ok(warnings.some((w) => w.includes("coverage-final.json")), JSON.stringify(warnings));
    assert.ok(!warnings.join("\n").includes(SECRET_MARK) && !warnings.join("\n").includes("hunter2"));
  });
});

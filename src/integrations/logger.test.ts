import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonLogger, logJson } from "./logger";

function tempLogDir(): string {
  return mkdtempSync(join(tmpdir(), "logger-test-"));
}

function appLogs(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("app-") && f.endsWith(".log")).sort();
}

/* Advances one second per call so every rotated file gets a distinct timestamped name. */
function steppingClock(startMs = Date.UTC(2026, 0, 1)): () => Date {
  let ms = startMs;
  return () => new Date((ms += 1000));
}

/* ~107-byte JSON lines: at most two fit under a 250-byte cap. */
const MAX_BYTES = 250;
const PAD = "x".repeat(40);

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition not met within 2s");
}

test("opening a log file prunes older app logs down to maxFiles, counting the active file", async () => {
  const dir = tempLogDir();
  try {
    const seeded = [1, 2, 3, 4, 5, 6].map((day) => {
      const name = `app-2020-01-0${day}T00-00-00-000Z.log`;
      writeFileSync(join(dir, name), "{}\n");
      const mtime = new Date(Date.UTC(2020, 0, day));
      utimesSync(join(dir, name), mtime, mtime);
      return name;
    });
    writeFileSync(join(dir, "unrelated.txt"), "keep me");

    const logger = createJsonLogger({ dir, maxFiles: 3 });
    logger.logJson("info", "hello", undefined, false);
    await logger.close();

    const remaining = appLogs(dir);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.includes(seeded[4]!), "second-newest seeded log kept");
    assert.ok(remaining.includes(seeded[5]!), "newest seeded log kept");
    assert.ok(readdirSync(dir).includes("unrelated.txt"), "non-app files are never pruned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ageLogFile(path: string): void {
  const long = new Date(Date.UTC(2020, 0, 1));
  utimesSync(path, long, long);
}

test("maxFiles below 1 keeps only the active log file instead of hanging", async () => {
  const dir = tempLogDir();
  try {
    writeFileSync(join(dir, "app-2020-01-01T00-00-00-000Z.log"), "{}\n");
    ageLogFile(join(dir, "app-2020-01-01T00-00-00-000Z.log"));

    const logger = createJsonLogger({ dir, maxFiles: 0 });
    logger.logJson("info", "hello", undefined, false);
    await logger.close();

    const remaining = appLogs(dir);
    assert.equal(remaining.length, 1);
    assert.notEqual(remaining[0], "app-2020-01-01T00-00-00-000Z.log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotates to a new file before a write would push the active file past maxBytes", async () => {
  const dir = tempLogDir();
  try {
    const logger = createJsonLogger({ dir, maxFiles: 10, maxBytes: MAX_BYTES, now: steppingClock() });
    const messages = Array.from({ length: 12 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    for (const m of messages) logger.logJson("info", m, { pad: PAD }, false);
    await logger.close();

    const files = appLogs(dir);
    assert.ok(files.length > 1, `expected rotation, got ${files.length} file(s)`);
    for (const f of files) {
      const size = statSync(join(dir, f)).size;
      assert.ok(size > 0 && size <= MAX_BYTES, `${f} is ${size} bytes`);
    }
    const logged = files.flatMap((f) =>
      readFileSync(join(dir, f), "utf8").trimEnd().split("\n").map((l) => (JSON.parse(l) as { m: string }).m),
    );
    assert.deepEqual(logged, messages, "every line lands exactly once, in order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line larger than maxBytes gets a file of its own instead of rotating in a loop", async () => {
  const dir = tempLogDir();
  try {
    const logger = createJsonLogger({ dir, maxFiles: 10, maxBytes: MAX_BYTES, now: steppingClock() });
    logger.logJson("info", "small", undefined, false);
    logger.logJson("info", "huge", { pad: "x".repeat(MAX_BYTES * 2) }, false);
    logger.logJson("info", "after", undefined, false);
    await logger.close();

    const perFile = appLogs(dir).map((f) => readFileSync(join(dir, f), "utf8").trimEnd().split("\n").length);
    assert.deepEqual(perFile, [1, 1, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("size rotation still enforces the maxFiles cap", async () => {
  const dir = tempLogDir();
  try {
    const logger = createJsonLogger({ dir, maxFiles: 3, maxBytes: MAX_BYTES, now: steppingClock() });
    /* Each line is flushed before the next, as in production where rotations are maxBytes apart:
       files open asynchronously, so a same-tick burst would prune before earlier files exist. */
    for (let i = 0; i < 12; i++) {
      logger.logJson("info", `line-${i}`, { pad: PAD }, false);
      await waitFor(() => appLogs(dir).some((f) => readFileSync(join(dir, f), "utf8").includes(`"m":"line-${i}"`)));
    }
    await logger.close();

    const files = appLogs(dir);
    assert.equal(files.length, 3);
    const newest = readFileSync(join(dir, files.at(-1)!), "utf8");
    assert.ok(newest.includes('"m":"line-11"'), "the active file is never pruned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed rotation keeps logging to the current file instead of throwing", async (t) => {
  const root = tempLogDir();
  const dir = join(root, "logs");
  const errors = t.mock.method(console, "error", () => {});
  try {
    const logger = createJsonLogger({ dir, maxFiles: 10, maxBytes: MAX_BYTES, now: steppingClock() });
    logger.logJson("info", "first", { pad: PAD }, false);
    await waitFor(() => appLogs(dir).some((f) => statSync(join(dir, f)).size > 0));

    /* A regular file where the log directory was makes opening the next file throw. */
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "");

    assert.doesNotThrow(() => {
      for (let i = 0; i < 6; i++) logger.logJson("info", `line-${i}`, { pad: PAD }, false);
    });
    assert.ok(
      errors.mock.calls.some((c) => String(c.arguments[0]).includes("rotation failed")),
      "the rotation failure is surfaced, not swallowed",
    );
    await logger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* The retry window is driven by a clock the test moves by hand. */
function manualClock(startMs = Date.UTC(2026, 0, 1)): { now: () => Date; advance: (ms: number) => void } {
  let ms = startMs;
  return { now: () => new Date(ms), advance: (by) => (ms += by) };
}

function reportsNaming(errors: { mock: { calls: { arguments: unknown[] }[] } }, dir: string): number {
  return errors.mock.calls.filter((c) => c.arguments.some((a) => String(a).includes(dir))).length;
}

test("a log file that cannot be opened never makes logJson throw, and the line still reaches the console", (t) => {
  const root = tempLogDir();
  const dir = join(root, "logs");
  const errors = t.mock.method(console, "error", () => {});
  const printed = t.mock.method(console, "log", () => {});
  try {
    writeFileSync(dir, ""); /* a regular file where the log directory should be */
    const logger = createJsonLogger({ dir, maxFiles: 5, now: manualClock().now });

    assert.doesNotThrow(() => logger.logJson("info", "still visible", undefined, true));

    assert.ok(printed.mock.calls.some((c) => String(c.arguments[0]).includes('"m":"still visible"')));
    assert.equal(reportsNaming(errors, dir), 1, "the failure is reported with the directory it concerns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed open is retried only once openRetryMs has passed, then file logging resumes", async (t) => {
  const root = tempLogDir();
  const dir = join(root, "logs");
  const errors = t.mock.method(console, "error", () => {});
  const clock = manualClock();
  const openRetryMs = 1000;
  try {
    writeFileSync(dir, "");
    const logger = createJsonLogger({ dir, maxFiles: 5, now: clock.now, openRetryMs });
    logger.logJson("info", "blocked", undefined, false);

    rmSync(dir); /* the directory could be created again, but the window has not passed */
    clock.advance(openRetryMs - 1);
    logger.logJson("info", "within the window", undefined, false);
    assert.equal(existsSync(dir), false, "no open is attempted inside the retry window");
    assert.equal(reportsNaming(errors, dir), 1);

    clock.advance(1);
    logger.logJson("info", "resumed", undefined, false);
    await logger.close();
    const written = appLogs(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
    assert.match(written, /"m":"resumed"/);
    assert.doesNotMatch(written, /within the window/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a log file that fails after opening starts the retry window instead of reopening on the next line", async (t) => {
  const root = tempLogDir();
  const dir = join(root, "logs");
  const errors = t.mock.method(console, "error", () => {});
  const clock = manualClock();
  const openRetryMs = 1000;
  const pid = 8001;
  try {
    /* A directory at the exact path of the next log file makes its asynchronous open fail. */
    const nextFile = `app-${clock.now().toISOString().replace(/[:.]/g, "-")}-p${pid}.log`;
    mkdirSync(join(dir, nextFile), { recursive: true });
    const logger = createJsonLogger({ dir, maxFiles: 5, now: clock.now, openRetryMs, pid });
    logger.logJson("info", "lost with its file", undefined, false);
    await waitFor(() => errors.mock.calls.length > 0);
    const reportedFailure = reportsNaming(errors, dir); /* the write failure names the file inside dir */

    /* From here any open attempt fails synchronously, so every attempt is observable. */
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "");
    assert.doesNotThrow(() => logger.logJson("info", "within the window", undefined, false));
    assert.equal(reportsNaming(errors, dir), reportedFailure, "no reopen is attempted inside the retry window");

    clock.advance(openRetryMs);
    assert.doesNotThrow(() => logger.logJson("info", "after the window", undefined, false));
    assert.equal(reportsNaming(errors, dir), reportedFailure + 1, "the reopen is attempted once the window has passed");
    await logger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type FsCallback = (err: Error | null, ...rest: unknown[]) => void;

test("a log file whose write fails starts the retry window before its error event arrives", async (t) => {
  const dir = tempLogDir();
  const clock = manualClock();
  const openRetryMs = 1000;
  const logFds = new Set<number>();
  let logFileOpenAttempts = 0;
  let failedWrites = 0;
  t.mock.method(console, "error", () => {});
  /* fs doubles for a full disk: writes to a log file fail, and the fd close that precedes the stream's
     'error' event never completes, holding the stream destroyed with its error not yet reported. */
  const realOpen = fs.open.bind(fs) as unknown as (...args: unknown[]) => void;
  const realWrite = fs.write.bind(fs) as unknown as (...args: unknown[]) => void;
  const realClose = fs.close.bind(fs) as unknown as (...args: unknown[]) => void;
  /* Counted when requested, not when completed: a stream requests its open on the next tick, so one
     setImmediate later every attempt is visible, while a completed open would still be pending. */
  t.mock.method(fs, "open", (path: unknown, ...rest: unknown[]) => {
    const cb = rest.pop() as FsCallback;
    const isLogFile = String(path).startsWith(dir);
    if (isLogFile) logFileOpenAttempts++;
    realOpen(path, ...rest, (err: Error | null, fd: number) => {
      if (!err && isLogFile) logFds.add(fd);
      cb(err, fd);
    });
  });
  t.mock.method(fs, "write", (fd: number, ...rest: unknown[]) => {
    if (!logFds.has(fd)) return realWrite(fd, ...rest);
    const cb = rest.at(-1) as FsCallback;
    setImmediate(() => {
      cb(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      failedWrites++;
    });
  });
  t.mock.method(fs, "close", (fd: number, ...rest: unknown[]) => {
    if (!logFds.has(fd)) realClose(fd, ...rest);
  });
  try {
    const logger = createJsonLogger({ dir, maxFiles: 5, now: clock.now, openRetryMs });
    logger.logJson("info", "lost to a full disk", undefined, false);
    await waitFor(() => failedWrites > 0);

    logger.logJson("info", "within the window", undefined, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(logFileOpenAttempts, 1, "no new log file is opened inside the retry window");

    clock.advance(openRetryMs);
    logger.logJson("info", "after the window", undefined, false);
    await new Promise((r) => setImmediate(r));
    assert.equal(logFileOpenAttempts, 2, "a new log file is opened once the window has passed");
    /* Nothing may be in flight at teardown: the second write has failed only after its open completed. */
    await waitFor(() => failedWrites === 2);
  } finally {
    for (const fd of logFds) fs.closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Several processes share one log directory (the service, a manual `npm run qa`, the test suite).
   A logger only ever prunes files no live process can still be writing. */
test("a log file another live process is writing is never pruned, however long ago it last wrote", async () => {
  const dir = tempLogDir();
  const livePids = new Set([4101]);
  const isProcessAlive = (pid: number): boolean => livePids.has(pid);
  try {
    const service = createJsonLogger({ dir, maxFiles: 2, pid: 4101, isProcessAlive, now: steppingClock() });
    service.logJson("info", "service boot", undefined, false);
    await waitFor(() => appLogs(dir).length === 1);
    const serviceFile = appLogs(dir)[0]!;
    ageLogFile(join(dir, serviceFile)); /* the service has been idle for a long time */

    for (let i = 0; i < 4; i++) {
      const other = createJsonLogger({ dir, maxFiles: 2, pid: 5200 + i, isProcessAlive, now: steppingClock(Date.UTC(2026, 0, 2 + i)) });
      other.logJson("info", `other process ${i}`, undefined, false);
      await other.close();
    }

    assert.ok(appLogs(dir).includes(serviceFile), "the live service's active file must survive");
    service.logJson("info", "service keeps logging", undefined, false);
    await service.close();
    assert.match(readFileSync(join(dir, serviceFile), "utf8"), /service keeps logging/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a recently written log file of unknown owner is never pruned", async () => {
  const dir = tempLogDir();
  try {
    const recent = "app-2026-01-01T00-00-00-000Z.log"; /* no owner in the name; mtime is now */
    writeFileSync(join(dir, recent), "{}\n");

    const logger = createJsonLogger({ dir, maxFiles: 1, pid: 6001, isProcessAlive: () => false });
    logger.logJson("info", "hello", undefined, false);
    await logger.close();

    assert.ok(appLogs(dir).includes(recent), "a file written moments ago may still be in use");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale log files of processes that are gone are pruned down to maxFiles", async () => {
  const dir = tempLogDir();
  try {
    const stale = [1, 2, 3, 4].map((day) => {
      const name = `app-2020-01-0${day}T00-00-00-000Z-p${7000 + day}.log`;
      writeFileSync(join(dir, name), "{}\n");
      const mtime = new Date(Date.UTC(2020, 0, day));
      utimesSync(join(dir, name), mtime, mtime);
      return name;
    });

    const logger = createJsonLogger({ dir, maxFiles: 2, pid: 6002, isProcessAlive: () => false });
    logger.logJson("info", "hello", undefined, false);
    await logger.close();

    const remaining = appLogs(dir);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.includes(stale[3]!), "the newest stale file is kept");
    for (const gone of stale.slice(0, 3)) assert.equal(remaining.includes(gone), false, `${gone} must be pruned`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The suite's preload points the default logger at a per-process temp directory, the way it does the
   history DB — a test must never write into (or prune) the real service's data/logs. */
test("under the test preload the default logger writes outside the repository", async () => {
  const dir = process.env.QAYABA_LOG_DIR;
  assert.ok(dir, "the test preload must set QAYABA_LOG_DIR");
  const repoRoot = join(import.meta.dirname, "..", "..");
  assert.equal(dir.startsWith(repoRoot), false, `${dir} must not be inside the repository`);
  logJson("info", "isolation probe", undefined, false);
  await waitFor(() => existsSync(dir) && appLogs(dir).length > 0);
});

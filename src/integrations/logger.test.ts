import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonLogger } from "./logger";

function tempLogDir(): string {
  return mkdtempSync(join(tmpdir(), "logger-test-"));
}

function appLogs(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("app-") && f.endsWith(".log")).sort();
}

/* Advances one second per call so every rotated file gets a distinct timestamped name. */
function steppingClock(): () => Date {
  let ms = Date.UTC(2026, 0, 1);
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

test("maxFiles below 1 keeps only the active log file instead of hanging", async () => {
  const dir = tempLogDir();
  try {
    writeFileSync(join(dir, "app-2020-01-01T00-00-00-000Z.log"), "{}\n");

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

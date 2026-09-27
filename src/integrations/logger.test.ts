import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonLogger } from "./logger";

function tempLogDir(): string {
  return mkdtempSync(join(tmpdir(), "logger-test-"));
}

function appLogs(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("app-") && f.endsWith(".log")).sort();
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

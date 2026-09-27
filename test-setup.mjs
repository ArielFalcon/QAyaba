// Per-test-process isolation for the history SQLite store.
//
// history.ts `ensureDb()` resolves the DB path as `HISTORY_DB_PATH ?? <root>/data/qayaba.db`.
// With no override, EVERY test that touches the store writes to the same on-disk DB, which persists
// across runs. That accumulated state makes `npm test` non-deterministic (the reported test count
// drifts) and causes spurious failures: tests that do not mock `retrieveRules` (e.g. the
// "filtered-retry …" case in pipeline.test.ts) read rules seeded by earlier runs.
//
// This module is preloaded via `node --import ./test-setup.mjs` (see package.json `test` script), so
// it runs before any test imports history.ts. Node propagates `--import` to every test child process,
// so each test FILE gets its own fresh temp DB — `mkdtempSync` guarantees a unique dir per process.
// The dir is removed on process exit. `data/qayaba.db` is never touched by the suite.
//
// Honors an explicit HISTORY_DB_PATH (e.g. set by CI) instead of overriding it.
//
// It also installs the tracked-tree write guard (scripts/test-write-guard.mjs): any write a test makes
// under the repository's tracked tree throws, so tests can only write under os.tmpdir().
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTrackedTreeWriteGuard } from "./scripts/test-write-guard.mjs";

// The JSON logger gets the same treatment through QAYABA_LOG_DIR: a test that logs must never write
// into, or prune, the running service's data/logs.
if (!process.env.HISTORY_DB_PATH || !process.env.QAYABA_LOG_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-test-"));
  process.env.HISTORY_DB_PATH ??= join(dir, "history.db");
  process.env.QAYABA_LOG_DIR ??= join(dir, "logs");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — a leftover temp dir is harmless and the OS reaps tmpdir anyway
    }
  });
}

installTrackedTreeWriteGuard(import.meta.dirname);

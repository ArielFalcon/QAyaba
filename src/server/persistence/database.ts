import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertMigratable, migrate, type Migration } from "./migrations/index";

export interface OpenHistoryOptions {
  /* Called with every statement SQLite runs and whether a transaction was open at that moment. */
  onStatement?: (sql: string, inTransaction: boolean) => void;
  /* Overrides the migration list; tests use it to exercise a failing migration. */
  migrations?: readonly Migration[];
}

/*
 * The history store's handle. Reads go through `read`; every write goes through `write`, which runs the callback in one
 * immediate transaction, so a write statement outside a transaction is a defect.
 */
export interface HistoryDatabase {
  readonly path: string;
  readonly raw: Database.Database;
  read<T>(fn: (db: Database.Database) => T): T;
  write<T>(fn: (db: Database.Database) => T): T;
  close(): void;
}

const openDatabases = new Set<Database.Database>();
let exitHookInstalled = false;

/* One process-exit hook closes whatever is still open, however many databases a process opened. */
function closeAtExit(db: Database.Database): void {
  openDatabases.add(db);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const open of openDatabases) {
      if (open.open) open.close();
    }
  });
}

/*
 * Opens the history database at `path`, creating its directory. A file that cannot be brought to the latest schema is
 * refused before anything is written to it.
 */
export function openHistoryDatabase(path: string, opts: OpenHistoryOptions = {}): HistoryDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const onStatement = opts.onStatement;
  const raw: Database.Database = new Database(path, onStatement ? { verbose: (sql) => onStatement(String(sql), raw.inTransaction) } : {});
  try {
    raw.pragma("foreign_keys = ON");
    /* Wait up to 5s for a held lock instead of throwing SQLITE_BUSY: the 24h online backup and an external reader can briefly contend with a writer. */
    raw.pragma("busy_timeout = 5000");
    assertMigratable(raw, path);
    raw.pragma("journal_mode = WAL");
    migrate(raw, path, opts.migrations);
  } catch (error) {
    raw.close();
    throw error;
  }
  closeAtExit(raw);
  return {
    path,
    raw,
    read: (fn) => fn(raw),
    write: (fn) => raw.transaction(() => fn(raw)).immediate(),
    close: () => {
      openDatabases.delete(raw);
      if (raw.open) raw.close();
    },
  };
}

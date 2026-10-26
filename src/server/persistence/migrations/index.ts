import Database from "better-sqlite3";
import { migration0001, SCHEMA_1_SQL } from "./0001-initial";
import { migration0002 } from "./0002-agent-turn-partial-text";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

/* Ordered by version; a schema change is a new file in this folder appended here. */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

type TableShape = ReadonlyMap<string, ReadonlySet<string>>;

function tableShape(db: Database.Database): TableShape {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const shape = new Map<string, ReadonlySet<string>>();
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    shape.set(name, new Set(columns.map((c) => c.name)));
  }
  return shape;
}

/* The tables and column names schema 1 declares, read from a throwaway in-memory build of it so the migration stays the only place they are written. */
function schemaOneShape(): TableShape {
  const scratch = new Database(":memory:");
  try {
    scratch.exec(SCHEMA_1_SQL);
    return tableShape(scratch);
  } finally {
    scratch.close();
  }
}

function sameColumns(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((c) => b.has(c));
}

function unadoptable(path: string): Error {
  return new Error(`history database at ${path} predates schema 1 and cannot be adopted; remove or move it aside`);
}

/*
 * A file with no schema version that already holds tables is adopted only when it holds exactly schema 1's tables with schema 1's
 * columns: it is then stamped, with no row touched. Anything else is refused and left as it is.
 */
function isAdoptable(db: Database.Database): boolean {
  const expected = schemaOneShape();
  const actual = tableShape(db);
  if (actual.size !== expected.size) return false;
  for (const [table, columns] of expected) {
    const found = actual.get(table);
    if (!found || !sameColumns(found, columns)) return false;
  }
  return true;
}

/* Reads the file and throws when it cannot be brought to the latest schema; writes nothing. */
export function assertMigratable(db: Database.Database, path: string): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(`history database at ${path} has schema version ${version}, newer than this build's ${LATEST_SCHEMA_VERSION}`);
  }
  if (version === 0 && tableShape(db).size > 0 && !isAdoptable(db)) throw unadoptable(path);
}

/* Applies each pending migration in its own transaction, which also sets the schema version. A failing migration rolls back and throws. */
export function migrate(db: Database.Database, path: string, migrations: readonly Migration[] = MIGRATIONS): void {
  assertMigratable(db, path);
  let version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0 && tableShape(db).size > 0) {
    db.transaction(() => {
      db.exec(SCHEMA_1_SQL); // every table exists already; this only adds the indexes that are missing
      db.pragma("user_version = 1");
    })();
    version = 1;
  }
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    try {
      db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      })();
    } catch (error) {
      throw new Error(`history database migration ${migration.version} (src/server/persistence/migrations/${migration.name}.ts) failed on ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

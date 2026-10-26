import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openHistoryDatabase } from "./database";
import { LATEST_SCHEMA_VERSION, type Migration } from "./migrations/index";
import { SCHEMA_1_SQL, migration0001 } from "./migrations/0001-initial";

const SCHEMA_1_TABLES = [...SCHEMA_1_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!).sort();

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "history-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const userVersion = (db: Database.Database): number => db.pragma("user_version", { simple: true }) as number;
const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/* A database as the store built it before schema versions existed: schema 1's tables and no recorded version. */
function buildUnversioned(path: string, mutate?: (db: Database.Database) => void): void {
  const db = new Database(path);
  db.exec(SCHEMA_1_SQL);
  db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r2', 'app', 'abcdef2', '2026-10-02T00:00:00.000Z')").run();
  mutate?.(db);
  db.close();
}

test("an empty database ends at the latest schema version with exactly the tables the migration declares", (t) => {
  const path = join(scratch(t), "history.db");
  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.ok(SCHEMA_1_TABLES.length > 0, "the migration declares tables");
  assert.deepEqual(history.read(tableNames), SCHEMA_1_TABLES);
});

test("reopening a database keeps its rows and its version", (t) => {
  const path = join(scratch(t), "history.db");
  const first = openHistoryDatabase(path);
  first.write((db) => db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z')").run());
  first.close();

  const second = openHistoryDatabase(path);
  t.after(() => second.close());
  assert.equal(second.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(second.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n), 1);
});

test("a database that holds schema 1's tables and columns but no version is stamped, every row preserved", (t) => {
  const path = join(scratch(t), "history.db");
  buildUnversioned(path);
  const before = new Database(path, { readonly: true });
  const hash = (db: Database.Database): string => createHash("sha256").update(JSON.stringify(db.prepare("SELECT * FROM runs ORDER BY id").all())).digest("hex");
  const rowsBefore = hash(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n), 2);
  assert.equal(history.read(hash), rowsBefore);
});

test("a schema 1 database is brought to the latest schema with every row intact and a turn's partial text unknown", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  migration0001.up(before);
  before.pragma("user_version = 1");
  before.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO agent_turns (run_id, session_id, role, round, is_repair, ts, prompt_text, output_text, prompt_bytes) VALUES ('r1', 's1', 'qa-author', 0, 0, '2026-10-01T00:00:00.000Z', 'p', '', 1)").run();
  const rows = (db: Database.Database): string => JSON.stringify([db.prepare("SELECT * FROM runs ORDER BY id").all(), db.prepare("SELECT id, run_id, session_id, role, output_text FROM agent_turns ORDER BY id").all()]);
  const rowsBefore = rows(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read(rows), rowsBefore);
  assert.deepEqual(history.read((db) => db.prepare("SELECT partial_text FROM agent_turns").all()), [{ partial_text: null }]);
});

test("a database missing a schema 1 column is refused with the operator's next step, and the file is not modified", (t) => {
  const path = join(scratch(t), "history.db");
  buildUnversioned(path, (db) => db.exec("ALTER TABLE runs DROP COLUMN change_set"));
  const hashBefore = fileHash(path);

  assert.throws(() => openHistoryDatabase(path), (error: Error) => {
    assert.equal(error.message, `history database at ${path} predates schema 1 and cannot be adopted; remove or move it aside`);
    return true;
  });
  assert.equal(fileHash(path), hashBefore);
});

test("a database holding only some of schema 1's tables is refused and left as it is", (t) => {
  const path = join(scratch(t), "history.db");
  const partial = new Database(path);
  partial.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
  partial.close();
  const hashBefore = fileHash(path);

  assert.throws(() => openHistoryDatabase(path), /cannot be adopted/);
  assert.equal(fileHash(path), hashBefore);
});

test("a database written by a newer build is refused", (t) => {
  const path = join(scratch(t), "history.db");
  const future = new Database(path);
  future.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
  future.close();

  assert.throws(() => openHistoryDatabase(path), /newer than this build/);
});

test("a migration that throws rolls back: the version stays and the tables it created are absent", (t) => {
  const path = join(scratch(t), "history.db");
  const failing: Migration = {
    version: 1,
    name: "0001-failing",
    up(db) {
      db.exec("CREATE TABLE half_done (id INTEGER)");
      throw new Error("boom");
    },
  };

  assert.throws(() => openHistoryDatabase(path, { migrations: [failing] }), (error: Error) => {
    assert.match(error.message, /migration 1 \(src\/server\/persistence\/migrations\/0001-failing\.ts\) failed/);
    assert.match(error.message, /boom/);
    return true;
  });
  const inspect = new Database(path, { readonly: true });
  t.after(() => inspect.close());
  assert.equal(userVersion(inspect), 0);
  assert.deepEqual(tableNames(inspect), []);
});

test("write runs its callback in one transaction and rolls it back when the callback throws", (t) => {
  const path = join(scratch(t), "history.db");
  const seen: Array<[string, boolean]> = [];
  const history = openHistoryDatabase(path, { onStatement: (sql, inTransaction) => seen.push([sql, inTransaction]) });
  t.after(() => history.close());

  assert.throws(() =>
    history.write((db) => {
      db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', 'now')").run();
      throw new Error("abort");
    }),
  );
  assert.equal(history.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n), 0);

  history.write((db) => db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r2', 'app', 'abcdef2', 'now')").run());
  const insert = seen.filter(([sql]) => sql.includes("INSERT INTO runs"));
  assert.equal(insert.length, 2);
  assert.ok(insert.every(([, inTransaction]) => inTransaction), "a write statement runs inside a transaction");
});

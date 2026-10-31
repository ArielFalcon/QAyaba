import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openHistoryDatabase } from "./database";
import { RunRepository } from "./repositories/run.repository";
import { migration0002 } from "./migrations/0002-agent-turn-partial-text";
import { migration0003 } from "./migrations/0003-run-ending-facts";
import { migration0004 } from "./migrations/0004-run-engine-version";
import { migration0005 } from "./migrations/0005-case-expected-status";
import { migration0006 } from "./migrations/0006-run-time-budget";
import { migration0007 } from "./migrations/0007-lesson-observations";
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

/* The columns of `runs` that schema 1 declared: the later schemas add columns, and a migration must leave what these hold exactly as it was. */
const SCHEMA_1_RUN_COLUMNS = ((): string => {
  const scratchDb = new Database(":memory:");
  scratchDb.exec(SCHEMA_1_SQL);
  const names = (scratchDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name).join(", ");
  scratchDb.close();
  return names;
})();

/* A database as the store built it before schema versions existed: schema 1's tables and no recorded version. */
function buildUnversioned(path: string, mutate?: (db: Database.Database) => void): void {
  const db = new Database(path);
  db.exec(SCHEMA_1_SQL);
  db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r2', 'app', 'abcdef2', '2026-10-02T00:00:00.000Z')").run();
  mutate?.(db);
  db.close();
}

/* The tables later schemas added and dropped: each is a migration of its own, and the first schema's list stays what it declared. */
const LATER_TABLES = ["lesson_observations"];
const DROPPED_TABLES = ["curriculum", "learning_rules", "scorecard"];

test("an empty database ends at the latest schema version with exactly the tables the migrations declare", (t) => {
  const path = join(scratch(t), "history.db");
  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.ok(SCHEMA_1_TABLES.length > 0, "the migration declares tables");
  assert.deepEqual(history.read(tableNames), [...SCHEMA_1_TABLES.filter((name) => !DROPPED_TABLES.includes(name)), ...LATER_TABLES].sort());
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
  const hash = (db: Database.Database): string => createHash("sha256").update(JSON.stringify(db.prepare(`SELECT ${SCHEMA_1_RUN_COLUMNS} FROM runs ORDER BY id`).all())).digest("hex");
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
  const rows = (db: Database.Database): string => JSON.stringify([db.prepare(`SELECT ${SCHEMA_1_RUN_COLUMNS} FROM runs ORDER BY id`).all(), db.prepare("SELECT id, run_id, session_id, role, output_text FROM agent_turns ORDER BY id").all()]);
  const rowsBefore = rows(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read(rows), rowsBefore);
  assert.deepEqual(history.read((db) => db.prepare("SELECT partial_text FROM agent_turns").all()), [{ partial_text: null }]);
});

test("a schema 4 database is brought to the latest schema with every case intact and the status its test declared unknown", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  for (const migration of [migration0001, migration0002, migration0003, migration0004]) migration.up(before);
  before.pragma("user_version = 4");
  before.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('r1', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO cases (run_id, name, status, detail, file) VALUES ('r1', 'logs in', 'pass', NULL, 'flows/a.spec.ts')").run();
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.deepEqual(history.read((db) => db.prepare("SELECT name, status, file, expected_status FROM cases").all()), [{ name: "logs in", status: "pass", file: "flows/a.spec.ts", expected_status: null }]);
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
    assert.match(error.message, /migration 1 \(src\/persistence\/migrations\/0001-failing\.ts\) failed/);
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

test("a schema 2 database keeps every run row as it was: the run-ending facts it never recorded read as unknown, and a shadow-log decision reads as shadowed with no decision named", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  migration0001.up(before);
  migration0002.up(before);
  before.pragma("user_version = 2");
  const insert = before.prepare("INSERT INTO runs (id, app, sha, at, decision, limit_fired, limit_role) VALUES (?, 'app', 'abcdef1', '2026-10-01T00:00:00.000Z', ?, ?, ?)");
  insert.run("shadowed", "shadow-log", null, null);
  insert.run("opened", "pr", null, null);
  insert.run("limited", "none", "run-deadline", "primary");
  insert.run("none-recorded", null, null, null);
  const rows = (db: Database.Database): string => JSON.stringify(db.prepare("SELECT id, app, sha, at, decision, limit_fired, limit_role FROM runs ORDER BY id").all());
  const rowsBefore = rows(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read(rows), rowsBefore, "no stored value was rewritten");
  const runs = new RunRepository(history);
  assert.deepEqual(
    ["shadowed", "opened", "limited", "none-recorded"].map((id) => {
      const facts = runs.getRunFacts(id)!;
      return [id, facts.decision, facts.shadowed, facts.limits, facts.limitFired, facts.degradations];
    }),
    [
      ["shadowed", null, true, null, null, null],
      ["opened", "pr", null, null, null, null],
      ["limited", "none", null, null, "run-deadline", null],
      ["none-recorded", null, null, null, null, null],
    ],
  );
});

test("a schema 3 database keeps every run row as it was: the engine version it never recorded reads as unknown", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  migration0001.up(before);
  migration0002.up(before);
  migration0003.up(before);
  before.pragma("user_version = 3");
  before.prepare("INSERT INTO runs (id, app, sha, at, decision) VALUES ('old', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z', 'pr')").run();
  const rows = (db: Database.Database): string => JSON.stringify(db.prepare("SELECT id, app, sha, at, decision FROM runs").all());
  const rowsBefore = rows(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read(rows), rowsBefore, "no stored value was rewritten");
  const runs = new RunRepository(history);
  assert.equal(runs.getRunFacts("old")!.engineVersion, null);
  const { id } = runs.createRecord({ app: "app", sha: "abcdef2", target: "e2e", mode: "diff" });
  runs.updateRecord(id, { facts: { engineVersion: "0.1.0+0123456789ab" } });
  assert.equal(runs.getRunFacts(id)!.engineVersion, "0.1.0+0123456789ab");
});

test("a run's limits, degradations and shadow flag are stored with its facts and read back as they were written", (t) => {
  const history = openHistoryDatabase(join(scratch(t), "history.db"));
  t.after(() => history.close());
  const runs = new RunRepository(history);
  const { id } = runs.createRecord({ app: "app", sha: "abcdef1", target: "e2e", mode: "diff" });
  const limits = [{ fired: "run-deadline", role: "reviewer", scope: "run" as const }, { fired: "repair-cap", role: "qa-author", scope: "turn" as const, turns: 2 }];
  const degradations = [{ reason: "deadline-after-proof" as const, note: "kept" }];
  runs.updateRecord(id, { facts: { decision: "pr", shadowed: true, limits, limitFired: "run-deadline", limitRole: "reviewer", degradations } });
  const facts = runs.getRunFacts(id)!;
  assert.deepEqual([facts.decision, facts.shadowed, facts.limits, facts.degradations, facts.limitFired], ["pr", true, limits, degradations, "run-deadline"]);
  runs.updateRecord(id, { facts: { limits: [], degradations: [] } });
  assert.deepEqual([runs.getRunFacts(id)!.limits, runs.getRunFacts(id)!.degradations], [[], []], "recorded none is not the same as not recorded");
});

test("a schema 6 database is brought to the latest schema with every stored row as it was and the observations table empty", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  for (const migration of [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006]) migration.up(before);
  before.pragma("user_version = 6");
  before.prepare("INSERT INTO runs (id, app, sha, at, decision) VALUES ('old', 'app', 'abcdef1', '2026-10-01T00:00:00.000Z', 'pr')").run();
  before.prepare("INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, at) VALUES ('old', 'app', 'abcdef1', 'diff', 'e2e', 'pass', NULL, '{}', '2026-10-01T00:00:00.000Z')").run();
  const rows = (db: Database.Database): string => JSON.stringify([db.prepare("SELECT * FROM runs").all(), db.prepare("SELECT id, app, sha, mode, target, verdict, error_class, gate_signals, at FROM run_outcomes").all()]);
  const rowsBefore = rows(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  assert.equal(history.read(rows), rowsBefore, "no stored value was rewritten");
  assert.equal(history.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM lesson_observations").get() as { n: number }).n), 0);
  assert.ok(SCHEMA_1_TABLES.filter((table) => !DROPPED_TABLES.includes(table)).every((table) => history.read(tableNames).includes(table)), "nothing but the dead learning tables is dropped");
});

test("a schema 7 database loses the learning tables and the two outcome columns nothing reads, and keeps every other outcome as it was", (t) => {
  const path = join(scratch(t), "history.db");
  const before = new Database(path);
  for (const migration of [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007]) migration.up(before);
  before.pragma("user_version = 7");
  before.prepare("INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, rules_retrieved, reflection, at) VALUES ('r1', 'app', 'abcdef1', 'diff', 'e2e', 'pass', NULL, '{\"static\":true}', '[\"rule-1\"]', 'learned', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO learning_rules (id, app, trigger_text, action_text, error_class, source, at) VALUES ('l1', 'app', 't', 'a', 'E-X', 's', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO curriculum (app, data, updated_at) VALUES ('app', '{}', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES ('app', '{}', '2026-10-01T00:00:00.000Z')").run();
  before.prepare("INSERT INTO lesson_observations (id, app, run_id, sha, repo, kind, scope, served_state, admitted, left_out_reason, fact, at) VALUES ('o1', 'app', 'r1', 'abcdef1', 'org/app', 'data-volatility', '/x', 'equal', 1, NULL, '{}', '2026-10-01T00:00:00.000Z')").run();
  const kept = "id, app, sha, mode, target, verdict, error_class, gate_signals, at";
  const outcomes = (db: Database.Database): string => JSON.stringify(db.prepare(`SELECT ${kept} FROM run_outcomes ORDER BY id`).all());
  const observations = (db: Database.Database): string => JSON.stringify(db.prepare("SELECT * FROM lesson_observations ORDER BY id").all());
  const outcomesBefore = outcomes(before);
  const observationsBefore = observations(before);
  before.close();

  const history = openHistoryDatabase(path);
  t.after(() => history.close());

  assert.equal(history.read(userVersion), LATEST_SCHEMA_VERSION);
  for (const table of DROPPED_TABLES) assert.equal(history.read(tableNames).includes(table), false, table);
  const outcomeColumns = history.read((db) => (db.prepare("PRAGMA table_info(run_outcomes)").all() as Array<{ name: string }>).map((c) => c.name));
  assert.deepEqual(outcomeColumns, kept.split(", "));
  assert.equal(history.read(outcomes), outcomesBefore);
  assert.equal(history.read(observations), observationsBefore);
});

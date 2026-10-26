import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getRecord } from "./history";

/* Campaign-tagged runs are the baselines later graders re-score, so the boot prune keeps them (and their agent turns) for the campaign window
   instead of the ordinary one. The fixture is written to disk BEFORE history.ts opens the database, which prunes when it opens. */
const DAY = 24 * 60 * 60 * 1000;
const iso = (ageDays: number): string => new Date(Date.now() - ageDays * DAY).toISOString();
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const id = (name: string): string => `${name}-${RUN}`;

{
  const seeded = new Database(process.env.HISTORY_DB_PATH!);
  seeded.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, app TEXT NOT NULL, sha TEXT NOT NULL, ref TEXT, target TEXT NOT NULL DEFAULT 'e2e', mode TEXT NOT NULL DEFAULT 'diff',
      status TEXT NOT NULL DEFAULT 'enqueued', step TEXT, step_detail TEXT, verdict TEXT, passed INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, note TEXT,
      retrying INTEGER DEFAULT 0, parent_run_id TEXT, trigger_repo TEXT, at TEXT NOT NULL, logs TEXT DEFAULT '', campaign_id TEXT
    );
    CREATE TABLE agent_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, is_repair INTEGER NOT NULL DEFAULT 0,
      ts TEXT NOT NULL, objective TEXT, prompt_text TEXT NOT NULL, output_text TEXT NOT NULL, prompt_bytes INTEGER NOT NULL DEFAULT 0, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
    );
  `);
  const run = seeded.prepare("INSERT INTO runs (id, app, sha, at, campaign_id) VALUES (?, 'retention', 'abcdef1', ?, ?)");
  const turn = seeded.prepare("INSERT INTO agent_turns (run_id, session_id, role, ts, prompt_text, output_text) VALUES (?, 's', 'qa-author', ?, 'p', 'o')");
  for (const [name, age, campaign] of [["ordinary-old", 60, null], ["ordinary-new", 5, null], ["campaign-mid", 60, "camp"], ["campaign-old", 200, "camp"]] as const) {
    run.run(id(name), iso(age), campaign);
    turn.run(id(name), iso(age));
  }
  seeded.close();
}

test("a run past the ordinary window is pruned unless it belongs to a campaign still inside the campaign window", () => {
  assert.equal(getRecord(id("ordinary-old")), undefined);
  assert.ok(getRecord(id("ordinary-new")));
  assert.ok(getRecord(id("campaign-mid")), "a campaign run keeps its record for the campaign window");
  assert.equal(getRecord(id("campaign-old")), undefined, "past the campaign window it goes too");
});

test("agent turns follow the same windows", () => {
  const db = new Database(process.env.HISTORY_DB_PATH!, { readonly: true });
  try {
    const kept = (db.prepare("SELECT run_id FROM agent_turns WHERE run_id LIKE ? ORDER BY run_id").all(`%-${RUN}`) as Array<{ run_id: string }>).map((r) => r.run_id);
    assert.deepEqual(kept, [id("campaign-mid"), id("ordinary-new")]);
  } finally {
    db.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase, type HistoryDatabase } from "./database";
import { loadSettings } from "../../settings/settings";
import { DELETE_MAX_AGE_DAYS, pruneHistory, retentionPolicyFrom, type RetentionPolicy } from "./retention";
import { getHistory, getHistoryDatabase } from "./index";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const iso = (ageDays: number): string => new Date(NOW - ageDays * DAY).toISOString();
const POLICY: RetentionPolicy = { runMaxAgeDays: DELETE_MAX_AGE_DAYS, campaignDays: 180, spanDays: 30 };

function open(t: { after: (fn: () => void) => void }): HistoryDatabase {
  const dir = mkdtempSync(join(tmpdir(), "history-retention-"));
  const history = openHistoryDatabase(join(dir, "history.db"));
  t.after(() => {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return history;
}

function seedRuns(history: HistoryDatabase): void {
  history.write((db) => {
    const run = db.prepare("INSERT INTO runs (id, app, sha, at, campaign_id) VALUES (?, 'retention', 'abcdef1', ?, ?)");
    const turn = db.prepare("INSERT INTO agent_turns (run_id, session_id, role, ts, prompt_text, output_text) VALUES (?, 's', 'qa-author', ?, 'p', 'o')");
    for (const [id, age, campaign] of [["ordinary-old", 60, null], ["ordinary-new", 5, null], ["campaign-mid", 60, "camp"], ["campaign-old", 200, "camp"]] as const) {
      run.run(id, iso(age), campaign);
      turn.run(id, iso(age));
    }
  });
}

const ids = (history: HistoryDatabase, table: string, column = "id"): string[] =>
  history.read((db) => (db.prepare(`SELECT ${column} AS v FROM ${table} ORDER BY ${column}`).all() as Array<{ v: string }>).map((r) => r.v));

test("opening the process database and reading records deletes nothing, however old the rows are", () => {
  const history = getHistoryDatabase();
  history.write((db) => db.prepare("INSERT INTO runs (id, app, sha, at) VALUES ('read-does-not-prune', 'read-app', 'abcdef1', ?)").run(iso(40)));

  assert.equal(getHistory().runs.listRecords("read-app", 10).length, 1);
  assert.ok(getHistory().runs.getRecord("read-does-not-prune"));
});

test("a run past the ordinary window is pruned unless it belongs to a campaign still inside the campaign window", (t) => {
  const history = open(t);
  seedRuns(history);

  const report = pruneHistory(history, POLICY, NOW);

  assert.deepEqual(ids(history, "runs"), ["campaign-mid", "ordinary-new"]);
  assert.deepEqual(report.find((r) => r.table === "runs"), { table: "runs", deleted: 2 });
});

test("agent turns follow the same windows", (t) => {
  const history = open(t);
  seedRuns(history);

  const report = pruneHistory(history, POLICY, NOW);

  assert.deepEqual(ids(history, "agent_turns", "run_id"), ["campaign-mid", "ordinary-new"]);
  assert.deepEqual(report.find((r) => r.table === "agent_turns"), { table: "agent_turns", deleted: 2 });
});

test("an ISO timestamp earlier on the cutoff's own day is pruned and a later one is kept", (t) => {
  const history = open(t);
  const cutoffDay = new Date(NOW - DELETE_MAX_AGE_DAYS * DAY);
  const at = (hour: number): string => new Date(Date.UTC(cutoffDay.getUTCFullYear(), cutoffDay.getUTCMonth(), cutoffDay.getUTCDate(), hour)).toISOString();
  history.write((db) => {
    const turn = db.prepare("INSERT INTO agent_turns (run_id, session_id, role, ts, prompt_text, output_text) VALUES (NULL, ?, 'qa-author', ?, 'p', 'o')");
    turn.run("older-same-day", at(0));
    turn.run("newer-same-day", at(23));
  });

  pruneHistory(history, POLICY, NOW);

  assert.deepEqual(ids(history, "agent_turns", "session_id"), ["newer-same-day"]);
});

test("events past the run window are pruned by their epoch-ms timestamp", (t) => {
  const history = open(t);
  history.write((db) => {
    const event = db.prepare("INSERT INTO run_events (run_id, seq, ts, body) VALUES (?, 0, ?, '{}')");
    event.run("old-events", NOW - 31 * DAY);
    event.run("new-events", NOW - 1 * DAY);
  });

  const report = pruneHistory(history, POLICY, NOW);

  assert.deepEqual(ids(history, "run_events", "run_id"), ["new-events"]);
  assert.deepEqual(report.find((r) => r.table === "run_events"), { table: "run_events", deleted: 1 });
});

test("the report names every table the job touches", (t) => {
  const history = open(t);
  assert.deepEqual(pruneHistory(history, POLICY, NOW).map((r) => r.table), ["runs", "run_events", "agent_turns", "run_spans", "run_spec_snapshots", "run_plans"]);
});

test("the retention windows come from the loaded settings", () => {
  assert.deepEqual(retentionPolicyFrom(loadSettings({}).retention), POLICY);
  const configured = retentionPolicyFrom(loadSettings({ QA_TELEMETRY_RETENTION_DAYS: "7", QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS: "90" }).retention);
  assert.equal(configured.spanDays, 7);
  assert.equal(configured.campaignDays, 90);
  assert.equal(configured.runMaxAgeDays, DELETE_MAX_AGE_DAYS);
});

test("a malformed retention window stops the settings load instead of keeping a default", () => {
  assert.throws(() => loadSettings({ QA_TELEMETRY_RETENTION_DAYS: "not-a-number" }), /QA_TELEMETRY_RETENTION_DAYS/);
});

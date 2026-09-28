/*
 * Persistent run history (SQLite via better-sqlite3). Survives process restarts so
 * the TUI/continue/chat can address past runs. Persisted to disk at HISTORY_DB_PATH
 * (a docker-compose volume in production — see the `qa-data` volume).
 * Initialization is LAZY: the database is opened (and the schema created) on first
 * use, not at import time. This keeps a bare `import` side-effect-free — importing a
 * module that re-exports from here (e.g. the CLI) does not touch the filesystem until
 * a record is actually read or written.
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { qayabaDataDir } from "../paths";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { RunRecord, RunMode, TestTarget, QaCase, RunVerdict, SpecRecord, RunOutcome, AgentActivity, PLANNER_OBJECTIVE } from "../types";
import { applyOutcome as foldApplyOutcome } from "@contexts/cross-run-learning/domain/rule-fold";
import { type LearningRule, type RuleUpsert, type Confidence, type RuleStatus } from "../qa/learning/learning-rule";
import type { ErrorClass } from "../qa/learning/taxonomy";
import type { Curriculum } from "../qa/learning/curriculum";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/infrastructure/curriculum-port.adapter";
import { updateScorecard, type Scorecard, type ScorecardEntry } from "../qa/learning/oracle-types";
import { logJson } from "../integrations/logger";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports";
import type { AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";

const redactionPort = new RedactionPortAdapter();


export interface AgentTurnRecord {
  runId: string | null;        /* maps to RunRecord.id; null for turns with no parent run */
  sessionId: string;           /* OpenCode session id */
  role: string;                /* agent name (qa-generator, qa-reviewer, qa-explorer, …) */
  round: number;               /* 0-based generation round within the session */
  isRepair: boolean;           /* true for in-session contract-repair re-prompts */
  ts: string;                  /* ISO-8601 timestamp when the turn completed */
  objective: string | null;    /* human-readable objective scope (null when not supplied) */
  promptText: string;          /* full prompt sent to the agent */
  outputText: string;          /* agent reply, sanitized before persist */
  promptBytes: number;         /* byte length of promptText */
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  /*
   * Per-turn efficiency measurements (design D11). Each is null when the runtime or the row
   * cannot supply it — never a fabricated zero/false. Omitted on write means null.
   */
  totalCalls?: number | null;
  stepsUsed?: number | null;
  maxSteps?: number | null;
  callsBeforeFirstWrite?: number | null;
  writeCount?: number | null;
  redundantReadCount?: number | null;
  duplicateCallCount?: number | null;
  promptProvidedReadCount?: number | null;
  exhausted?: boolean | null;
  callBuckets?: Record<string, number> | null;
}

/*
 * The 10 nullable per-turn efficiency columns (design D11): the proposal's 8
 * plus prompt_provided_read_count and call_buckets (a JSON-encoded
 * Record<CallBucket, number> TEXT blob, like run_outcomes.gate_signals).
 * `exhausted` is a nullable 0/1: NULL means "unknown", never false.
 */
export const AGENT_TURN_EFFICIENCY_COLUMNS: ReadonlyArray<{ name: string; type: "INTEGER" | "TEXT" }> = [
  { name: "total_calls", type: "INTEGER" },
  { name: "steps_used", type: "INTEGER" },
  { name: "max_steps", type: "INTEGER" },
  { name: "calls_before_first_write", type: "INTEGER" },
  { name: "write_count", type: "INTEGER" },
  { name: "redundant_read_count", type: "INTEGER" },
  { name: "duplicate_call_count", type: "INTEGER" },
  { name: "prompt_provided_read_count", type: "INTEGER" },
  { name: "exhausted", type: "INTEGER" },
  { name: "call_buckets", type: "TEXT" },
];

const DELETE_MAX_AGE_DAYS = 30;

let db!: Database.Database;
let insertRun!: Database.Statement;
let getRunStmt!: Database.Statement;
let listRunsStmt!: Database.Statement;
let currentRunStmt!: Database.Statement;
let interruptedStmt!: Database.Statement;
let deleteCaseByName!: Database.Statement;
let insertCase!: Database.Statement;
let getCasesStmt!: Database.Statement;
let countCasesStmt!: Database.Statement;
let getSpecsStmt!: Database.Statement;
let appendLogStmt!: Database.Statement;
let insertActivityStmt!: Database.Statement;
let getActivityStmt!: Database.Statement;
let capActivityStmt!: Database.Statement;
let insertOutcome!: Database.Statement;
let listOutcomesStmt!: Database.Statement;
let getOutcomeStmt!: Database.Statement;
let upsertRuleStmt!: Database.Statement;
let listRulesStmt!: Database.Statement;
let listRetrievableRulesStmt!: Database.Statement;
let getRuleStmt!: Database.Statement;
let getAppRuleStmt!: Database.Statement;
let listAllRulesStmt!: Database.Statement;
let incrementRuleUsageStmt!: Database.Statement;
let loadCurriculumStmt!: Database.Statement;
let saveCurriculumStmt!: Database.Statement;
let loadScorecardStmt!: Database.Statement;
let saveScorecardStmt!: Database.Statement;
let loadContextMapStmt!: Database.Statement;
let saveContextMapStmt!: Database.Statement;
let insertAgentTurnStmt!: Database.Statement;
let getAgentTurnsStmt!: Database.Statement;
let initialized = false;

function ensureDb(): void {
  if (initialized) return;

  const dbPath =
    process.env.HISTORY_DB_PATH ?? join(qayabaDataDir(), "qayaba.db");
  /* Only the directory the database lives in: a HISTORY_DB_PATH elsewhere leaves the root's data dir alone. */
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  /*
   * Wait up to 5s for a held lock instead of throwing SQLITE_BUSY immediately. WAL allows
   * concurrent readers, but the 24h online backup and any external reader (CLI, inspection)
   * can still briefly contend with a writer; without this a contended write throws.
   */
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      sha TEXT NOT NULL,
      ref TEXT,
      target TEXT NOT NULL DEFAULT 'e2e',
      mode TEXT NOT NULL DEFAULT 'diff',
      status TEXT NOT NULL DEFAULT 'enqueued',
      step TEXT,
      step_detail TEXT,
      verdict TEXT,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      note TEXT,
      retrying INTEGER DEFAULT 0,
      parent_run_id TEXT,
      trigger_repo TEXT,
      at TEXT NOT NULL,
      step_started_at TEXT,
      logs TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      objective TEXT,
      flow TEXT
    );

    CREATE TABLE IF NOT EXISTS run_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_cases_run_id ON cases(run_id);
    CREATE INDEX IF NOT EXISTS idx_specs_run_id ON specs(run_id);
    CREATE INDEX IF NOT EXISTS idx_activity_run_id ON run_activity(run_id);

    CREATE TABLE IF NOT EXISTS run_outcomes (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      sha TEXT NOT NULL,
      mode TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'e2e',
      verdict TEXT NOT NULL,
      error_class TEXT,
      gate_signals TEXT NOT NULL DEFAULT '{}',
      rules_retrieved TEXT NOT NULL DEFAULT '[]',
      reflection TEXT,
      at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_app ON run_outcomes(app);
    CREATE INDEX IF NOT EXISTS idx_outcomes_error_class ON run_outcomes(error_class);

    -- Durable backing for the live RunEvent (SSE) stream. The in-memory store keeps a
    -- bounded replay buffer; persisting here lets replay survive a restart (e.g. the maintainer
    -- hot-swap's process.exit) and eviction of an old run from the 200-run ring.
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);

    CREATE TABLE IF NOT EXISTS learning_rules (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      action_text TEXT NOT NULL,
      error_class TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'low',
      usage_count INTEGER NOT NULL DEFAULT 0,
      outcome_count INTEGER NOT NULL DEFAULT 0,
      oracle_outcome_count INTEGER NOT NULL DEFAULT 0,
      success_rate REAL,
      last_verified TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      archetype TEXT,
      at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rules_app ON learning_rules(app);
    CREATE INDEX IF NOT EXISTS idx_rules_status ON learning_rules(status);

    CREATE TABLE IF NOT EXISTS curriculum (
      app TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scorecard (
      app TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- A one-shot "rebuild the architecture map next run" flag, set by the process-audit context-heal.
    -- DB-backed because the mirror's e2e/.qa/context.json is wiped/restored by git checkout -f +
    -- git clean -fd on every run, so a file-level invalidation never survives to the next run. This
    -- flag does, and is CONSUMED (cleared) by the next generating run for the app.
    CREATE TABLE IF NOT EXISTS context_stale (
      app TEXT PRIMARY KEY,
      at TEXT NOT NULL
    );

    -- The FE<->BE architecture map (e2e/.qa/context.json) produced by a successful mode:context
    -- run, per app (latest wins — not append-only, same as curriculum/scorecard). DB-backed for the
    -- same reason context_stale is: the mirror's e2e/.qa/context.json is wiped/restored by git
    -- checkout -f + git clean -fd every run, so a shadow app (which never opens the context.json PR)
    -- would otherwise lose the map after every run. This table is the engine's source of truth for
    -- the map regardless of shadow; the repo file (when a non-shadow PR has landed) is only a fallback.
    CREATE TABLE IF NOT EXISTS context_maps (
      app TEXT PRIMARY KEY,
      built_at_sha TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Per-turn telemetry for every agent prompt/response cycle.
    -- Mirrors the run_events 30-day retention. Token columns are nullable because Codex
    -- runs return no token info. output_text is sanitized before persist (sanitizer.ts).
    CREATE TABLE IF NOT EXISTS agent_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      is_repair INTEGER NOT NULL DEFAULT 0,
      ts TEXT NOT NULL,
      objective TEXT,
      prompt_text TEXT NOT NULL,
      output_text TEXT NOT NULL,
      prompt_bytes INTEGER NOT NULL DEFAULT 0,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      tokens_cache_write INTEGER,
      cost REAL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_turns_run_id ON agent_turns(run_id);
    CREATE INDEX IF NOT EXISTS idx_agent_turns_role ON agent_turns(role);
  `);

  /* ALTER TABLE for existing DBs — CREATE TABLE IF NOT EXISTS does not add columns. */
  if (!columnExists("runs", "step_started_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN step_started_at TEXT");
  }
  if (!columnExists("learning_rules", "outcome_count")) {
    db.exec("ALTER TABLE learning_rules ADD COLUMN outcome_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists("learning_rules", "archetype")) {
    db.exec("ALTER TABLE learning_rules ADD COLUMN archetype TEXT");
  }
  /* Existing rows get oracle_outcome_count 0; that does not demote an already-active rule. */
  if (!columnExists("learning_rules", "oracle_outcome_count")) {
    db.exec("ALTER TABLE learning_rules ADD COLUMN oracle_outcome_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists("runs", "trigger_repo")) {
    db.exec("ALTER TABLE runs ADD COLUMN trigger_repo TEXT");
  }
  /*
   * agent-efficiency-metrics (design D11): every agent_turns efficiency column
   * is added by this guarded ALTER (fresh and pre-existing DBs alike), so the
   * column list has a single source of truth. All are nullable: they stay NULL
   * for a pre-existing row and for any runtime that cannot supply them (Codex
   * leaves steps_used/max_steps/exhausted NULL, D3) — never a fabricated value.
   */
  for (const { name, type } of AGENT_TURN_EFFICIENCY_COLUMNS) {
    if (!columnExists("agent_turns", name)) {
      db.exec(`ALTER TABLE agent_turns ADD COLUMN ${name} ${type}`);
    }
  }
  /*
   * "pending" is a retired rule status an older build could have written. Every retrieval and
   * ledger read filters on status IN ('active', 'candidate'), so a stored 'pending' row would never
   * be retrieved, never earn an outcome and stay stuck forever. Rewrite it once, at open, to the
   * status it always meant. Idempotent: a no-op once no such row remains.
   */
  db.exec("UPDATE learning_rules SET status = 'candidate' WHERE status = 'pending'");

  insertRun = db.prepare(`
    INSERT INTO runs (id, app, sha, ref, target, mode, status, step, step_detail, verdict, passed, failed, note, retrying, parent_run_id, trigger_repo, at, logs)
    VALUES (@id, @app, @sha, @ref, @target, @mode, @status, @step, @stepDetail, @verdict, @passed, @failed, @note, @retrying, @parentRunId, @triggerRepo, @at, @logs)
  `);
  getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  listRunsStmt = db.prepare("SELECT * FROM runs WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
  currentRunStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued') ORDER BY (status='running') DESC, at ASC, rowid ASC LIMIT 1");
  interruptedStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued')");
  deleteCaseByName = db.prepare("DELETE FROM cases WHERE run_id = ? AND name = ?");
  insertCase = db.prepare("INSERT INTO cases (run_id, name, status, detail) VALUES (@runId, @name, @status, @detail)");
  getCasesStmt = db.prepare("SELECT * FROM cases WHERE run_id = ?");
  countCasesStmt = db.prepare("SELECT status, COUNT(*) AS cnt FROM cases WHERE run_id = ? GROUP BY status");
  getSpecsStmt = db.prepare("SELECT * FROM specs WHERE run_id = ?");
  appendLogStmt = db.prepare("UPDATE runs SET logs = logs || @log WHERE id = @id");
  insertActivityStmt = db.prepare("INSERT INTO run_activity (run_id, ts, kind, status, text) VALUES (@runId, @ts, @kind, @status, @text)");
  getActivityStmt = db.prepare("SELECT kind, status, text, ts FROM run_activity WHERE run_id = ? ORDER BY id ASC");
  capActivityStmt = db.prepare(
    "DELETE FROM run_activity WHERE run_id = @id AND id NOT IN (SELECT id FROM run_activity WHERE run_id = @id ORDER BY id DESC LIMIT @keep)",
  );

  /* run_outcomes (learning layer — append-only, never purged) */
  insertOutcome = db.prepare(`
    INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, rules_retrieved, reflection, at)
    VALUES (@id, @app, @sha, @mode, @target, @verdict, @errorClass, @gateSignals, @rulesRetrieved, @reflection, @at)
  `);
  listOutcomesStmt = db.prepare("SELECT * FROM run_outcomes WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
  getOutcomeStmt = db.prepare("SELECT * FROM run_outcomes WHERE id = ?");


  upsertRuleStmt = db.prepare(`
    INSERT INTO learning_rules (id, app, trigger_text, action_text, error_class, archetype, confidence, usage_count, outcome_count, oracle_outcome_count, success_rate, last_verified, source, status, at)
    VALUES (@id, @app, @trigger, @action, @errorClass, @archetype, @confidence, @usageCount, @outcomeCount, @oracleOutcomeCount, @successRate, @lastVerified, @source, @status, @at)
    ON CONFLICT(id) DO UPDATE SET
      confidence = excluded.confidence,
      usage_count = excluded.usage_count,
      outcome_count = excluded.outcome_count,
      oracle_outcome_count = excluded.oracle_outcome_count,
      success_rate = excluded.success_rate,
      last_verified = excluded.last_verified,
      status = excluded.status
      -- archetype, trigger, action, error_class are intentionally NOT updated: they are set-once at
      -- insert (a rule's identity/shape never changes). Distilled IDs are random so this branch only
      -- fires on an explicit stable-ID re-upsert (tests), where preserving the original is correct.
  `);
  listRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') ORDER BY (status = 'active') DESC, COALESCE(success_rate, 0) DESC, at DESC LIMIT ?");
  /*
   * Governance-path fetch (backs listLearningRulesForGovernance, below): every retrievable row, no
   * ORDER BY and no LIMIT — ranking is RuleGovernanceService's job alone (see that service's own
   * header). Any SQL-side cap would have to pre-rank to decide what to keep, and no SQL order can
   * match governance's ranking (success rate plus the per-run relevance bias, plus the newest-
   * candidate exploration slots), so a cap always hides rules governance would pick.
   */
  listRetrievableRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate')");
  getRuleStmt = db.prepare("SELECT * FROM learning_rules WHERE id = ?");
  getAppRuleStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND id = ?");
  listAllRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? ORDER BY at DESC LIMIT ?");
  incrementRuleUsageStmt = db.prepare("UPDATE learning_rules SET usage_count = usage_count + 1 WHERE id = ?");
  loadCurriculumStmt = db.prepare("SELECT data, updated_at FROM curriculum WHERE app = ?");
  saveCurriculumStmt = db.prepare("INSERT INTO curriculum (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
  loadScorecardStmt = db.prepare("SELECT data FROM scorecard WHERE app = ?");
  saveScorecardStmt = db.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
  loadContextMapStmt = db.prepare("SELECT built_at_sha, data, updated_at FROM context_maps WHERE app = ?");
  saveContextMapStmt = db.prepare(
    "INSERT INTO context_maps (app, built_at_sha, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(app) DO UPDATE SET built_at_sha = excluded.built_at_sha, data = excluded.data, updated_at = excluded.updated_at",
  );

  /* agent_turns: insert a turn record; retrieve all turns for a run ordered by id. */
  insertAgentTurnStmt = db.prepare(`
    INSERT INTO agent_turns
      (run_id, session_id, role, round, is_repair, ts, objective,
       prompt_text, output_text, prompt_bytes,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost,
       total_calls, steps_used, max_steps, calls_before_first_write, write_count,
       redundant_read_count, duplicate_call_count, prompt_provided_read_count, exhausted, call_buckets)
    VALUES
      (@runId, @sessionId, @role, @round, @isRepair, @ts, @objective,
       @promptText, @outputText, @promptBytes,
       @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite, @cost,
       @totalCalls, @stepsUsed, @maxSteps, @callsBeforeFirstWrite, @writeCount,
       @redundantReadCount, @duplicateCallCount, @promptProvidedReadCount, @exhausted, @callBuckets)
  `);
  getAgentTurnsStmt = db.prepare("SELECT * FROM agent_turns WHERE run_id = ? ORDER BY id ASC");

  /* Prune old runs once on first use. */
  db.prepare(`DELETE FROM runs WHERE at < datetime('now', '-${DELETE_MAX_AGE_DAYS} days')`).run();
  /* Bound the durable event log: drop events older than the run retention window (ts is epoch ms). */
  db.prepare("DELETE FROM run_events WHERE ts < ?").run(Date.now() - DELETE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  /*
   * Prune agent_turns older than the retention window. agent_turns.ts is ISO-8601 (…T…Z) TEXT, but
   * datetime('now', …) yields the space-separated 'YYYY-MM-DD HH:MM:SS' form — a raw string compare
   * would mis-sort (the 'T' > ' ' at index 10 makes every ISO value sort GREATER, so nothing prunes).
   * Wrap ts in datetime() so BOTH sides are SQLite's canonical datetime form: a correct boundary
   * compare, consistent with run_events (which prunes correctly via its own typed epoch-ms compare).
   */
  db.prepare(`DELETE FROM agent_turns WHERE datetime(ts) < datetime('now', '-${DELETE_MAX_AGE_DAYS} days')`).run();

  initialized = true;
}

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function recalcCounts(runId: string): { passed: number; failed: number } {
  const rows = countCasesStmt.all(runId) as Array<{ status: string; cnt: number }>;
  let passed = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === "pass") passed += row.cnt;
    else if (row.status === "fail") failed += row.cnt;
  }
  return { passed, failed };
}

/*
 * SQLite returns an absent optional TEXT column as NULL, but the wire entities (QaCase / SpecRecord)
 * and their zod contracts type these fields as `field?: string` (undefined, NOT nullable). A NULL
 * objective/flow therefore fails contract validation on the API response (observed: a run whose spec
 * had no objective → "specs[].objective expected string, received null"). Normalize NULL → undefined at
 * the read boundary so an un-supplied field is simply omitted on the wire, matching the optional type.
 */
function nullsToUndefined<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = row[k] === null ? undefined : row[k];
  return out as T;
}

function rowToRecord(row: Record<string, unknown>): RunRecord {
  const runId = row.id as string;
  const cases = (getCasesStmt.all(runId) as Record<string, unknown>[]).map(nullsToUndefined) as unknown as QaCase[];
  const specRows = (getSpecsStmt.all(runId) as Record<string, unknown>[]).map(nullsToUndefined) as unknown as SpecRecord[];
  const logsText = (row.logs as string) || "";
  const activityRows = getActivityStmt.all(runId) as Array<{ kind: string; status: string | null; text: string; ts: string }>;

  return {
    id: runId,
    app: row.app as string,
    sha: row.sha as string,
    ref: (row.ref as string) || undefined,
    target: row.target as TestTarget,
    mode: row.mode as RunMode,
    status: row.status as RunRecord["status"],
    step: (row.step as string) || undefined,
    stepDetail: (row.step_detail as string) || undefined,
    verdict: (row.verdict as RunVerdict) || undefined,
    passed: row.passed as number | undefined,
    failed: row.failed as number | undefined,
    note: (row.note as string) || undefined,
    retrying: Boolean(row.retrying),
    parentRunId: (row.parent_run_id as string) || undefined,
    triggerRepo: (row.trigger_repo as string) || undefined,
    cases,
    specs: specRows.length > 0 ? specRows : undefined,
    logs: logsText ? logsText.split("\n").filter(Boolean) : [],
    activity: activityRows.length > 0
      ? activityRows.map((a) => ({
          kind: a.kind as AgentActivity["kind"],
          text: a.text,
          ...(a.status ? { status: a.status as AgentActivity["status"] } : {}),
          ts: a.ts,
        }))
      : undefined,
    stepStartedAt: (row.step_started_at as string) || undefined,
    at: row.at as string,
  };
}

export function createRecord(opts: {
  app: string; sha: string; ref?: string; target: TestTarget; mode: RunMode; parentRunId?: string; triggerRepo?: string;
}): RunRecord {
  ensureDb();
  const id = `run-${opts.sha.slice(0, 7)}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const at = new Date().toISOString();

  insertRun.run({
    id,
    app: opts.app,
    sha: opts.sha,
    ref: opts.ref ?? null,
    target: opts.target,
    mode: opts.mode,
    status: "enqueued",
    step: null,
    stepDetail: null,
    verdict: null,
    passed: 0,
    failed: 0,
    note: null,
    retrying: 0,
    parentRunId: opts.parentRunId ?? null,
    triggerRepo: opts.triggerRepo ?? null,
    at,
    logs: "",
  });

  return {
    id,
    app: opts.app,
    sha: opts.sha,
    ref: opts.ref,
    target: opts.target,
    mode: opts.mode,
    status: "enqueued",
    cases: [],
    logs: [],
    at,
    parentRunId: opts.parentRunId,
    triggerRepo: opts.triggerRepo,
  };
}

export function getRecord(id: string): RunRecord | undefined {
  ensureDb();
  const row = getRunStmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function listRecords(app: string, limit = 10): RunRecord[] {
  ensureDb();
  const rows = listRunsStmt.all(app, limit) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function currentRun(): RunRecord | undefined {
  ensureDb();
  const row = currentRunStmt.get() as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function updateRecord(id: string, patch: Partial<RunRecord>): void {
  ensureDb();
  const setClauses: string[] = [];
  const params: Array<unknown> = [];

  const add = (col: string, val: unknown) => {
    setClauses.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.status !== undefined) add("status", patch.status);
  if (patch.step !== undefined) {
    add("step", patch.step);

    const cur = (db.prepare("SELECT step FROM runs WHERE id = ?").get(id) as { step?: string } | undefined)?.step;
    if (cur !== patch.step) add("step_started_at", new Date().toISOString());
  }
  if (patch.stepDetail !== undefined) add("step_detail", patch.stepDetail);
  if (patch.verdict !== undefined) add("verdict", patch.verdict);
  if (patch.passed !== undefined) add("passed", patch.passed);
  if (patch.failed !== undefined) add("failed", patch.failed);
  if (patch.note !== undefined) add("note", patch.note);
  if (patch.retrying !== undefined) add("retrying", patch.retrying ? 1 : 0);

  if (setClauses.length > 0) {
    params.push(id);
    db.prepare(`UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  }

  if (patch.specs) {
    db.prepare("DELETE FROM specs WHERE run_id = ?").run(id);
    const insertSpec = db.prepare("INSERT INTO specs (run_id, name, objective, flow) VALUES (?, ?, ?, ?)");
    /*
     * De-dup by spec FILE name: a list built per-test (a 3-test file appearing 3×) must not report
     * "5 specs" for 2 files — the run record + value report count spec FILES, not test cases.
     */
    const seenSpec = new Set<string>();
    for (const s of patch.specs) {
      if (seenSpec.has(s.name)) continue;
      seenSpec.add(s.name);
      insertSpec.run(id, s.name, s.objective ?? null, s.flow ?? null);
    }
  }
}

export function addCase(id: string, c: QaCase): void {
  ensureDb();
  deleteCaseByName.run(id, c.name);
  insertCase.run({
    runId: id,
    name: c.name,
    status: c.status,
    detail: c.detail ?? null,
  });

  const { passed, failed } = recalcCounts(id);
  db.prepare("UPDATE runs SET passed = ?, failed = ? WHERE id = ?").run(passed, failed, id);
}

export function appendLog(id: string, msg: string): void {
  ensureDb();
  appendLogStmt.run({ id, log: msg + "\n" });
}

const ACTIVITY_CAP = 200;

/*
 * Appends one structured activity event to a run's live feed and caps the feed to
 * the last ACTIVITY_CAP rows (advisory-only; never gates a verdict). Stamps `ts`
 * here so the router stays pure/time-free and unit-testable.
 */
export function appendActivity(id: string, a: { kind: AgentActivity["kind"]; text: string; status?: AgentActivity["status"] }): void {
  ensureDb();
  insertActivityStmt.run({ runId: id, ts: new Date().toISOString(), kind: a.kind, status: a.status ?? null, text: a.text });
  capActivityStmt.run({ id, keep: ACTIVITY_CAP });
}

export function interruptedRecords(): RunRecord[] {
  ensureDb();
  const rows = interruptedStmt.all() as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function clearDatabase(): void {
  ensureDb();
  db.exec("DELETE FROM specs; DELETE FROM cases; DELETE FROM runs;");
}

/*
 * Deletes EVERYTHING history holds for an app: runs (cases/specs/activity cascade
 * via the schema's ON DELETE CASCADE), run outcomes, learning rules, curriculum and
 * scorecard. Used by DELETE /api/apps/:name?purge=1. Returns the number of run rows
 * removed (the other tables are not always populated).
 */
export function deleteAppHistory(app: string): number {
  ensureDb();
  const info = db.prepare("DELETE FROM runs WHERE app = ?").run(app);
  db.prepare("DELETE FROM run_outcomes WHERE app = ?").run(app);
  db.prepare("DELETE FROM learning_rules WHERE app = ?").run(app);
  db.prepare("DELETE FROM curriculum WHERE app = ?").run(app);
  db.prepare("DELETE FROM scorecard WHERE app = ?").run(app);
  db.prepare("DELETE FROM context_maps WHERE app = ?").run(app);
  return info.changes;
}

export const MAX_CONTINUATION_DEPTH = 5;

export function continuationDepth(record: RunRecord): number {
  let depth = 0;
  let current: RunRecord | undefined = record;
  while (current?.parentRunId) {
    depth++;
    current = getRecord(current.parentRunId);
  }
  return depth;
}

export function saveRunOutcome(outcome: RunOutcome): void {
  ensureDb();
  insertOutcome.run({
    id: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    target: outcome.target,
    verdict: outcome.verdict,
    errorClass: outcome.errorClass ?? null,
    gateSignals: JSON.stringify(outcome.gateSignals),
    rulesRetrieved: JSON.stringify(outcome.rulesRetrieved),
    reflection: outcome.reflection ? JSON.stringify(outcome.reflection) : null,
    at: outcome.at,
  });
}

function rowToOutcome(row: Record<string, unknown>): RunOutcome {
  return {
    runId: row.id as string,
    app: row.app as string,
    sha: row.sha as string,
    mode: row.mode as RunMode,
    target: row.target as TestTarget,
    verdict: row.verdict as RunVerdict,
    errorClass: (row.error_class as RunOutcome["errorClass"]) ?? null,
    gateSignals: safeJsonParse(row.gate_signals as string, { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 }),
    rulesRetrieved: safeJsonParse(row.rules_retrieved as string, []),
    reflection: row.reflection ? safeJsonParse(row.reflection as string, undefined) : undefined,
    at: row.at as string,
  };
}

export function listRunOutcomes(app: string, limit = 50): RunOutcome[] {
  ensureDb();
  const rows = listOutcomesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToOutcome);
}

/*
 * The persisted RunOutcome for a single run — the structured value signals (change-coverage,
 * oracle score, reviewer rationale, errorClass) the CLI prints in its end-of-run value report.
 * Returns undefined for a run that produced no outcome row (no runId, or saveOutcome disabled).
 */
export function getRunOutcome(runId: string): RunOutcome | undefined {
  ensureDb();
  const row = getOutcomeStmt.get(runId) as Record<string, unknown> | undefined;
  return row ? rowToOutcome(row) : undefined;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}


export function upsertLearningRule(rule: RuleUpsert & { app: string; id: string; initialStatus?: RuleStatus }): void {
  ensureDb();
  upsertRuleStmt.run({
    id: rule.id,
    app: rule.app,
    trigger: rule.trigger,
    action: rule.action,
    errorClass: rule.errorClass,
    archetype: rule.archetype ?? null,
    confidence: "low" as Confidence,
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: rule.source,
    status: (rule.initialStatus ?? "candidate") as RuleStatus,
    at: new Date().toISOString(),
  });
}

/*
 * "pending" is a retired status an older build could have written; no path inserts it anymore
 * and RuleStatus no longer carries it. Normalize at this persistence boundary — the one place a
 * raw DB value becomes a typed LearningRule — so every consumer (including the fold) only ever
 * sees the current, narrower RuleStatus union.
 */
function normalizeRuleStatus(raw: unknown): RuleStatus {
  return raw === "pending" ? "candidate" : (raw as RuleStatus);
}

function rowToRule(row: Record<string, unknown>): LearningRule {
  return {
    id: row.id as string,
    trigger: row.trigger_text as string,
    action: row.action_text as string,
    errorClass: row.error_class as ErrorClass,
    archetype: (row.archetype as string | null) ?? null,
    confidence: row.confidence as Confidence,
    usageCount: row.usage_count as number,
    outcomeCount: (row.outcome_count as number) ?? 0,
    oracleOutcomeCount: (row.oracle_outcome_count as number) ?? 0,
    successRate: row.success_rate as number | null,
    lastVerified: row.last_verified as string | null,
    source: row.source as string,
    status: normalizeRuleStatus(row.status),
    at: row.at as string,
  };
}

/*
 * The shared "give me the live ledger, not a truncated preview" cap for operator-facing ledger
 * views (TUI/API intelligence view, CLI `qayaba intel`): listLearningRules(app,
 * LEARNING_RULE_LEDGER_LIMIT) below — a single shared-limit, status-ranked read. Neither
 * generation's retrieve path (listLearningRulesForGovernance, which feeds governance the whole
 * retrievable ledger) nor the fold (getLearningRule, a direct by-id lookup) reads through this cap,
 * so ledger size can never hide a rule from ranking or drop a fold. Not used by chat.ts's learning
 * context, which is a deliberately small bounded prompt preview, not a ledger view.
 */
export const LEARNING_RULE_LEDGER_LIMIT = 200;

export function listLearningRules(app: string, limit = 20): LearningRule[] {
  ensureDb();
  const rows = listRulesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

/*
 * Direct by-id read of one app's rule, uncapped and unordered — the correct lookup for a fold that
 * already knows the exact rule id (e.g. recordOutcome folding rulesRetrieved). Unlike
 * listLearningRules(app, LEARNING_RULE_LEDGER_LIMIT), a rule ranked outside that shared window
 * still resolves here. Undefined when the row does not exist (deleted, never upserted) or belongs
 * to another app.
 */
export function getLearningRule(app: string, id: string): LearningRule | undefined {
  ensureDb();
  const row = getAppRuleStmt.get(app, id) as Record<string, unknown> | undefined;
  return row ? rowToRule(row) : undefined;
}

/*
 * Governance-only read: backs historyLearningStore(appName).selectRules, the ONLY caller
 * SqliteLearningRepository.topRules() feeds into RuleGovernanceService.topRules (the single
 * ranking truth — see that service's own header, and rule-governance.service.ts's EXPLORATION_SLOTS
 * doc). Returns EVERY active and candidate row for the app, unordered and uncapped: pre-ranking or
 * truncating here would be a less-informed copy of governance's own ranking (it cannot see the
 * per-run relevance bias), and an unordered cap silently keeps the OLDEST rows — so the newest
 * candidates and the best-proven actives of a large ledger would never be ranked at all.
 * listLearningRules() above stays the read for operator ledger views and chat's bounded preview.
 */
export function listLearningRulesForGovernance(app: string): LearningRule[] {
  ensureDb();
  const rows = listRetrievableRulesStmt.all(app) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

/*
 * ALL rules regardless of status — used ONLY by the distiller for de-duplication, so a recurring
 * failure pattern cannot spawn a duplicate candidate for a rule that was demoted (`deprecated`) or
 * `superseded`. Retrieval must NOT use this (it injects only active/candidate).
 */
export function listAllLearningRules(app: string, limit = 200): LearningRule[] {
  ensureDb();
  const rows = listAllRulesStmt.all(app, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

export function incrementRuleUsage(ruleIds: string[]): void {
  if (ruleIds.length === 0) return;
  ensureDb();
  for (const id of ruleIds) {
    incrementRuleUsageStmt.run(id);
  }
}


/*
 * Folds one run outcome onto a rule. Only a retrievable rule (active/candidate) folds: a
 * deprecated or superseded rule is never retrieved, so an outcome can reach one only when a
 * governance decision retired it after the run retrieved it — a human veto or the process audit.
 * Folding that outcome would let the outcome loop undo the decision (a clean run's prevention
 * credit alone re-promotes a deprecated rule), so a retired rule accrues nothing and keeps its
 * status until a human restores it.
 */
export function recordRuleOutcome(ruleId: string, score: number, coverageCreditConfirmed: boolean | null = null, isOracleScore = false): void {
  ensureDb();
  const row = getRuleStmt.get(ruleId) as Record<string, unknown> | undefined;
  if (!row) return;
  const current = rowToRule(row);
  if (current.status !== "active" && current.status !== "candidate") return;
  /*
   * rowToRule already normalized a retired "pending" status to "candidate" (RuleStatus no longer
   * carries it), so the shell LearningRule is structurally assignable to the fold's own
   * LearningRule with no cast on the way in. The cast on the way OUT is real, not incidental: the
   * fold's errorClass is the wider `string` (@contexts/cross-run-learning stays kernel-decoupled),
   * narrower than this shell's own ErrorClass literal union.
   */
  const updated = foldApplyOutcome(
    current,
    score,
    coverageCreditConfirmed,
    isOracleScore,
  ) as LearningRule;
  db.prepare(
    "UPDATE learning_rules SET success_rate = ?, outcome_count = ?, oracle_outcome_count = ?, confidence = ?, status = ?, last_verified = ? WHERE id = ?",
  ).run(updated.successRate, updated.outcomeCount, updated.oracleOutcomeCount, updated.confidence, updated.status, new Date().toISOString(), ruleId);
}

/*
 * Human-initiated governance override: veto a rule (force it to 'deprecated') or restore a
 * previously-vetoed one ('active'). This is the highest-authority signal in the ledger — stronger
 * than the oracle — and the ONLY write to learning_rules that originates outside the deterministic
 * distiller. It is reached by an operator via the ledger CLI, never by the agent (the read-only
 * boundary holds). A veto STICKS: 'deprecated' rules are excluded from retrieval, so a vetoed rule
 * is never injected, and recordRuleOutcome refuses to fold onto it even for a run that retrieved
 * it before the veto, so it never accrues outcomes and never auto-resurrects through the outcome
 * loop. Returns false when the rule id is unknown (no silent success).
 */
export function setRuleStatusByHuman(ruleId: string, status: "deprecated" | "active"): boolean {
  ensureDb();
  const info = db
    .prepare("UPDATE learning_rules SET status = ?, last_verified = ? WHERE id = ?")
    .run(status, new Date().toISOString(), ruleId);
  return info.changes > 0;
}

/*
 * Mark an app's architecture map as stale so the next generating run rebuilds it. Used by the
 * process-audit context-heal: a file-level invalidation of e2e/.qa/context.json does NOT survive
 * the next run's `git checkout -f`/`git clean -fd`, but this DB flag does. Idempotent (latest wins).
 */
export function markContextStale(app: string): void {
  ensureDb();
  db.prepare("INSERT OR REPLACE INTO context_stale (app, at) VALUES (?, ?)").run(app, new Date().toISOString());
}

/* Whether the app's architecture map is marked stale. Read-only: the flag stays armed. */
export function isContextStale(app: string): boolean {
  ensureDb();
  return db.prepare("SELECT app FROM context_stale WHERE app = ?").get(app) !== undefined;
}

/* Disarm the staleness flag: a rebuild was accepted by the queue, or a context run stored a fresh map. */
export function clearContextStale(app: string): void {
  ensureDb();
  db.prepare("DELETE FROM context_stale WHERE app = ?").run(app);
}

/*
 * Back-fill the structured reflection onto an already-saved run outcome. The outcome row is
 * written at verdict time, BEFORE the async best-effort reflection exists; without this the
 * `reflection` column is permanently null and the (expensive, LLM-produced) reflection is
 * computed once to distill a rule and then discarded — unqueryable forever.
 */
export function updateRunOutcomeReflection(runId: string, reflection: import("../types").StructuredReflection): void {
  ensureDb();
  db.prepare("UPDATE run_outcomes SET reflection = ? WHERE id = ?").run(JSON.stringify(reflection), runId);
}

/*
 * Completed-run counts grouped by verdict — the backing data for the Prometheus runs_total
 * counter. Lets an operator alert on a fail/invalid/infra-error rate shift, which the
 * two instantaneous gauges (queue depth, open sessions) cannot express.
 */
export function runVerdictCounts(): Record<string, number> {
  ensureDb();
  const rows = db
    .prepare("SELECT verdict, COUNT(*) AS cnt FROM runs WHERE status = 'done' AND verdict IS NOT NULL GROUP BY verdict")
    .all() as Array<{ verdict: string; cnt: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = r.cnt;
  return out;
}

/*
 * Durable RunEvent persistence. INSERT OR IGNORE keeps it idempotent if the in-memory
 * store and a re-publish ever collide on (run_id, seq).
 */
export function saveRunEvent(event: { runId: string; seq: number; ts: number; body: unknown }): void {
  ensureDb();
  db.prepare("INSERT OR IGNORE INTO run_events (run_id, seq, ts, body) VALUES (?, ?, ?, ?)").run(
    event.runId,
    event.seq,
    event.ts,
    JSON.stringify(event.body),
  );
}

export function loadRunEvents(runId: string, afterSeq = -1): Array<{ runId: string; seq: number; ts: number; body: unknown }> {
  ensureDb();
  const rows = db
    .prepare("SELECT run_id, seq, ts, body FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
    .all(runId, afterSeq) as Array<{ run_id: string; seq: number; ts: number; body: string }>;
  return rows.map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, body: safeJsonParse(r.body, {}) }));
}

/*
 * Persist one agent turn. `output_text` MUST already be sanitized by the caller
 * (sanitizer.ts `sanitizeText`) — this function stores whatever it receives.
 */
export function saveAgentTurn(turn: AgentTurnRecord): void {
  ensureDb();
  insertAgentTurnStmt.run({
    runId: turn.runId ?? null,
    sessionId: turn.sessionId,
    role: turn.role,
    round: turn.round,
    isRepair: turn.isRepair ? 1 : 0,
    ts: turn.ts,
    objective: turn.objective ?? null,
    promptText: turn.promptText,
    outputText: turn.outputText,
    promptBytes: turn.promptBytes,
    tokensInput: turn.tokensInput ?? null,
    tokensOutput: turn.tokensOutput ?? null,
    tokensReasoning: turn.tokensReasoning ?? null,
    tokensCacheRead: turn.tokensCacheRead ?? null,
    tokensCacheWrite: turn.tokensCacheWrite ?? null,
    cost: turn.cost ?? null,
    totalCalls: turn.totalCalls ?? null,
    stepsUsed: turn.stepsUsed ?? null,
    maxSteps: turn.maxSteps ?? null,
    callsBeforeFirstWrite: turn.callsBeforeFirstWrite ?? null,
    writeCount: turn.writeCount ?? null,
    redundantReadCount: turn.redundantReadCount ?? null,
    duplicateCallCount: turn.duplicateCallCount ?? null,
    promptProvidedReadCount: turn.promptProvidedReadCount ?? null,
    /* exhausted is tri-state: NULL = unknown, 0 = known not exhausted, 1 = exhausted. */
    exhausted: turn.exhausted == null ? null : turn.exhausted ? 1 : 0,
    callBuckets: turn.callBuckets ? JSON.stringify(turn.callBuckets) : null,
  });
}

/*
 * The one place a transport's AgentTurnEvent becomes an agent_turns row, shared by every runtime
 * so a new column can never drift between OpenCode and Codex. `output_text` is already sanitized
 * by the transport that emitted the event.
 */
export function saveAgentTurnEvent(t: AgentTurnEvent): void {
  saveAgentTurn({
    runId: t.runId,
    sessionId: t.sessionId,
    role: t.role,
    round: t.round,
    isRepair: t.isRepair,
    ts: t.ts,
    objective: t.objective ?? null,
    promptText: t.promptText,
    outputText: t.outputText,
    promptBytes: t.promptBytes,
    tokensInput: t.tokensInput,
    tokensOutput: t.tokensOutput,
    tokensReasoning: t.tokensReasoning,
    tokensCacheRead: t.tokensCacheRead,
    tokensCacheWrite: t.tokensCacheWrite,
    cost: t.cost,
    maxSteps: t.stepBudget?.maxSteps ?? null,
    exhausted: t.stepBudget ? t.stepBudget.exhausted : null,
    totalCalls: t.callMetrics?.totalCalls ?? null,
    stepsUsed: t.callMetrics?.stepsUsed ?? null,
    callsBeforeFirstWrite: t.callMetrics?.callsBeforeFirstWrite ?? null,
    writeCount: t.callMetrics?.writeCount ?? null,
    redundantReadCount: t.callMetrics?.redundantReadCount ?? null,
    duplicateCallCount: t.callMetrics?.duplicateCallCount ?? null,
    promptProvidedReadCount: t.callMetrics?.promptProvidedReadCount ?? null,
    callBuckets: t.callMetrics?.buckets ?? null,
  });
}

/* Retrieve all agent turn records for a run, ordered by insertion (chronological). */
export function getAgentTurns(runId: string): AgentTurnRecord[] {
  ensureDb();
  const rows = getAgentTurnsStmt.all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: (r.run_id as string | null) ?? null,
    sessionId: r.session_id as string,
    role: r.role as string,
    round: r.round as number,
    isRepair: Boolean(r.is_repair),
    ts: r.ts as string,
    objective: (r.objective as string | null) ?? null,
    promptText: r.prompt_text as string,
    outputText: r.output_text as string,
    promptBytes: r.prompt_bytes as number,
    tokensInput: (r.tokens_input as number | null) ?? null,
    tokensOutput: (r.tokens_output as number | null) ?? null,
    tokensReasoning: (r.tokens_reasoning as number | null) ?? null,
    tokensCacheRead: (r.tokens_cache_read as number | null) ?? null,
    tokensCacheWrite: (r.tokens_cache_write as number | null) ?? null,
    cost: (r.cost as number | null) ?? null,
    totalCalls: (r.total_calls as number | null) ?? null,
    stepsUsed: (r.steps_used as number | null) ?? null,
    maxSteps: (r.max_steps as number | null) ?? null,
    callsBeforeFirstWrite: (r.calls_before_first_write as number | null) ?? null,
    writeCount: (r.write_count as number | null) ?? null,
    redundantReadCount: (r.redundant_read_count as number | null) ?? null,
    duplicateCallCount: (r.duplicate_call_count as number | null) ?? null,
    promptProvidedReadCount: (r.prompt_provided_read_count as number | null) ?? null,
    exhausted: r.exhausted == null ? null : Boolean(r.exhausted),
    callBuckets: typeof r.call_buckets === "string" ? safeJsonParse<Record<string, number> | null>(r.call_buckets, null) : null,
  }));
}

/*
 * A corrupt row (exists but fails to parse) is a DISTINCT outcome from "no row yet" — returning
 * null for both let CurriculumPortAdapter.read() silently `initCurriculum` a corrupt app's
 * history, and the next successful fold() would persist that fresh curriculum right over the
 * corrupt row, permanently discarding whatever evidence it held with nothing logged anywhere.
 * CURRICULUM_CORRUPT routes the adapter's read() to throw instead, which its existing
 * try/catch (onError, no save) already fault-isolates — see curriculum-port.adapter.ts.
 */
export function loadCurriculum(app: string): Curriculum | null | typeof CURRICULUM_CORRUPT {
  ensureDb();
  const row = loadCurriculumStmt.get(app) as { data: string; updated_at: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Curriculum;
  } catch (err) {
    logJson("warn", `corrupt curriculum row for app '${app}' — refusing to silently reset it with a fresh curriculum`, {
      app,
      error: redactionPort.redactError(err),
    });
    return CURRICULUM_CORRUPT;
  }
}

export function saveCurriculum(curriculum: Curriculum): void {
  ensureDb();
  saveCurriculumStmt.run(curriculum.app, JSON.stringify(curriculum), curriculum.updatedAt);
}

export function loadScorecard(app: string): Scorecard | null {
  ensureDb();
  const row = loadScorecardStmt.get(app) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Scorecard;
  } catch {
    return null;
  }
}

/*
 * Append one oracle outcome to the app's versioned scorecard (the proof-of-improvement record:
 * avg/last valueScore over runs). Aggregation is the pure updateScorecard; this is the DB sink.
 */
export function saveScorecardEntry(entry: ScorecardEntry): void {
  ensureDb();
  const sc = updateScorecard(loadScorecard(entry.app), entry);
  saveScorecardStmt.run(sc.app, JSON.stringify(sc), sc.updatedAt);
}

export interface StoredContextMap {
  builtAtSha: string;
  data: ArchitectureContext;
  updatedAt: string;
}

/*
 * Persist the app's FE<->BE architecture map (per-app row; latest wins — not append-only, same as
 * curriculum/scorecard above). `builtAtSha` is the deterministic run sha the orchestrator captured
 * this map at, not necessarily identical to `data.builtAtSha` (the agent's own self-reported field
 * inside the JSON, left untouched) — see ContextMapCapturePortAdapter's caller.
 */
export function saveContextMap(app: string, builtAtSha: string, data: ArchitectureContext): void {
  ensureDb();
  saveContextMapStmt.run(app, builtAtSha, JSON.stringify(data), new Date().toISOString());
}

/*
 * A corrupt row (exists but fails to parse) is logged loudly and treated as "no stored map" —
 * never crashes a run. Same fault-isolation shape as loadCurriculum, except a context map is
 * advisory grounding, not a fold input: there is nothing here for a caller to distinguish from
 * "no row yet" (unlike CURRICULUM_CORRUPT, which guards a fold from clobbering real evidence), so
 * undefined is the correct, single "no usable stored map" signal for both cases.
 */
export function loadContextMap(app: string): StoredContextMap | undefined {
  ensureDb();
  const row = loadContextMapStmt.get(app) as { built_at_sha: string; data: string; updated_at: string } | undefined;
  if (!row) return undefined;
  try {
    return { builtAtSha: row.built_at_sha, data: JSON.parse(row.data) as ArchitectureContext, updatedAt: row.updated_at };
  } catch (err) {
    logJson("warn", `corrupt context-map row for app '${app}' — treating as no stored map`, {
      app,
      error: redactionPort.redactError(err),
    });
    return undefined;
  }
}

process.on("exit", () => {
  if (initialized) db.close();
});


export interface TelemetryRoleStat {
  role: string;
  medianPromptBytes: number | null;
  p95PromptBytes: number | null;
  medianCacheHitRate: number | null;  /* null when no token data available (Codex or no turns) */
  turnCount: number;
}

export interface TelemetryAnalysis {
  app: string;
  generatedAt: string;
  windowDays: number | null;  /* null = all data */
  runCount: number;
  byRole: TelemetryRoleStat[];
  reviewerConvergence: {
    avgCorrectionsRound0: number | null;  /* avg corrections on first-round rejections */
    avgCorrectionsRound1: number | null;  /* avg corrections on second-round rejections (shrinking = good) */
    approveRate: number | null;           /* fraction of runs where reviewer approved (0–1) */
  };
  groundingPresence: number | null;  /* fraction of first-round generator turns carrying a Context Pack (0–1) */
  repairFraction: number | null;     /* fraction of all turns that are in-session repairs (lower = better) */
  medianTurnsPerRun: number | null;
  medianWallClockSec: number | null;
  p95WallClockSec: number | null;
  efficiency: TelemetryEfficiency;
}

/* Aggregates over the turns' persisted efficiency measurements. Turns a runtime could not measure (null) are left out of every figure, never counted as zero. */
export interface TelemetryEfficiency {
  turnsMeasured: number;                       /* turns with call metrics */
  medianCallsBeforeFirstWrite: number | null;  /* over measured turns that made at least one call */
  exhaustedRate: number | null;                /* exhausted turns / turns whose exhaustion is known (0–1) */
  redundantReadRatio: number | null;           /* redundant reads / calls, over measured turns (0–1) */
  duplicateRatio: number | null;               /* duplicate calls / calls, over measured turns (0–1) */
}

function efficiencyOf(turnRows: Array<Record<string, unknown>>): TelemetryEfficiency {
  const measured = turnRows.filter((r) => r.total_calls != null);
  const totalCalls = measured.reduce((sum, r) => sum + (r.total_calls as number), 0);
  const sumOf = (column: string) => measured.reduce((sum, r) => sum + ((r[column] as number | null) ?? 0), 0);
  const known = turnRows.filter((r) => r.exhausted != null);
  return {
    turnsMeasured: measured.length,
    medianCallsBeforeFirstWrite: median(
      measured
        .filter((r) => (r.total_calls as number) > 0 && r.calls_before_first_write != null)
        .map((r) => r.calls_before_first_write as number),
    ),
    exhaustedRate: known.length > 0 ? known.filter((r) => r.exhausted === 1).length / known.length : null,
    redundantReadRatio: totalCalls > 0 ? sumOf("redundant_read_count") / totalCalls : null,
    duplicateRatio: totalCalls > 0 ? sumOf("duplicate_call_count") / totalCalls : null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? null;
}

export function computeTelemetryAnalysis(app: string, windowDays?: number): TelemetryAnalysis {
  ensureDb();

  /* Build the date cutoff for the window. */
  const cutoff = windowDays != null
    ? new Date(Date.now() - windowDays * 86400_000).toISOString()
    : null;

  /*
   * Retrieve agent_turns for this app by joining with run_outcomes on run_id = outcome.id.
   * When no windowDays, fetch all turns for the app.
   */
  const turnsQuery = cutoff
    ? `SELECT t.* FROM agent_turns t INNER JOIN run_outcomes r ON t.run_id = r.id WHERE r.app = ? AND t.ts >= ? ORDER BY t.id ASC`
    : `SELECT t.* FROM agent_turns t INNER JOIN run_outcomes r ON t.run_id = r.id WHERE r.app = ? ORDER BY t.id ASC`;
  const turnsArgs = cutoff ? [app, cutoff] : [app];
  const turnRows = db.prepare(turnsQuery).all(...turnsArgs) as Array<Record<string, unknown>>;

  /* Retrieve run_outcomes for reviewer convergence + approve rate. */
  const outcomesQuery = cutoff
    ? `SELECT * FROM run_outcomes WHERE app = ? AND at >= ? ORDER BY at ASC`
    : `SELECT * FROM run_outcomes WHERE app = ? ORDER BY at ASC`;
  const outcomeRows = db.prepare(outcomesQuery).all(...(cutoff ? [app, cutoff] : [app])) as Array<Record<string, unknown>>;

  const runCount = new Set(turnRows.map((r) => r.run_id as string | null).filter(Boolean)).size;

  /* Group turns by role for per-role stats. */
  const byRoleMap = new Map<string, { promptBytes: number[]; cacheRatios: number[]; turnCount: number }>();
  for (const row of turnRows) {
    const role = (row.role as string) ?? "unknown";
    if (!byRoleMap.has(role)) byRoleMap.set(role, { promptBytes: [], cacheRatios: [], turnCount: 0 });
    const entry = byRoleMap.get(role)!;
    entry.turnCount++;
    const pb = row.prompt_bytes as number | null;
    if (pb != null) entry.promptBytes.push(pb);
    const cacheRead = row.tokens_cache_read as number | null;
    const tokensInput = row.tokens_input as number | null;
    if (cacheRead != null && tokensInput != null && tokensInput > 0) {
      entry.cacheRatios.push(cacheRead / tokensInput);
    }
  }
  const byRole: TelemetryRoleStat[] = [...byRoleMap.entries()].map(([role, s]) => ({
    role,
    medianPromptBytes: median(s.promptBytes),
    p95PromptBytes: percentile(s.promptBytes, 95),
    medianCacheHitRate: median(s.cacheRatios),
    turnCount: s.turnCount,
  }));


  const generatorFirstRounds = turnRows.filter(
    (r) =>
      (r.role as string).includes("generator") &&
      (r.round as number) === 0 &&
      !r.is_repair &&
      (r.objective as string | null) !== PLANNER_OBJECTIVE,
  );
  const groundedCount = generatorFirstRounds.filter(
    (r) => typeof r.prompt_text === "string" && (r.prompt_text as string).includes("## Context Pack"),
  ).length;
  const groundingPresence = generatorFirstRounds.length > 0 ? groundedCount / generatorFirstRounds.length : null;

  /* Repair fraction: in-session repair turns / total turns. */
  const repairCount = turnRows.filter((r) => r.is_repair).length;
  const repairFraction = turnRows.length > 0 ? repairCount / turnRows.length : null;

  /* Turns per run: group by run_id, count turns. */
  const turnsByRun = new Map<string, number>();
  for (const row of turnRows) {
    const rid = (row.run_id as string | null) ?? "__unknown__";
    turnsByRun.set(rid, (turnsByRun.get(rid) ?? 0) + 1);
  }
  const medianTurnsPerRun = median([...turnsByRun.values()]);

  /* Wall-clock per run: first/last ts per run_id → span in seconds. */
  const wallClocksByRun = new Map<string, { first: number; last: number }>();
  for (const row of turnRows) {
    const rid = (row.run_id as string | null) ?? "__unknown__";
    const ts = new Date(row.ts as string).getTime();
    if (!Number.isFinite(ts)) continue;
    const entry = wallClocksByRun.get(rid);
    if (!entry) { wallClocksByRun.set(rid, { first: ts, last: ts }); continue; }
    if (ts < entry.first) entry.first = ts;
    if (ts > entry.last) entry.last = ts;
  }
  const wallClockSpans = [...wallClocksByRun.values()].map((e) => (e.last - e.first) / 1000);
  const medianWallClockSec = median(wallClockSpans);
  const p95WallClockSec = percentile(wallClockSpans, 95);

  /*
   * Reviewer convergence: from run_outcomes, inspect gateSignals.reviewerCorrections per run.
   * avgCorrectionsRound0 uses the total corrections list (all rounds recorded in the outcome);
   * we use the raw list length as a proxy for total blocking corrections across both rounds.
   * A shrinking average round-over-round is the convergence signal (manual analysis).
   */
  let totalCorrectionsRound0 = 0; let countRound0 = 0;
  let totalApproved = 0;
  for (const row of outcomeRows) {
    const gs = (() => { try { return JSON.parse(row.gate_signals as string) as { reviewerCorrections?: string[] }; } catch { return {}; } })();
    const corrections = gs.reviewerCorrections ?? [];
    if (corrections.length > 0) { totalCorrectionsRound0 += corrections.length; countRound0++; }
    const verdict = row.verdict as string;
    if (verdict === "pass" || verdict === "skipped") totalApproved++;
  }
  const approveRate = outcomeRows.length > 0 ? totalApproved / outcomeRows.length : null;

  return {
    app,
    generatedAt: new Date().toISOString(),
    windowDays: windowDays ?? null,
    runCount,
    byRole,
    reviewerConvergence: {
      avgCorrectionsRound0: countRound0 > 0 ? totalCorrectionsRound0 / countRound0 : null,
      avgCorrectionsRound1: null,  /* requires per-round correction attribution (Phase-0 round field); deferred */
      approveRate,
    },
    groundingPresence,
    repairFraction,
    medianTurnsPerRun,
    medianWallClockSec,
    p95WallClockSec,
    efficiency: efficiencyOf(turnRows),
  };
}

/*
 * ── SQLite backup (cron-like) ───────────────────────────────────────────────
 * Writes a consistent snapshot of the DB to a backup directory with a timestamp,
 * using better-sqlite3's native online backup API — WAL-safe, unlike a raw file
 * copy which can miss the -wal tail and produce a torn backup. Keeps the last
 * N backups. Called from the health poller in index.ts every 24h.
 */

export async function backupDatabase(): Promise<{ backedUp: boolean; path?: string; error?: string }> {
  if (!initialized) return { backedUp: false, error: "db not initialized" };
  const backupDir = join(qayabaDataDir(), "backups");
  try {
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `qayaba-${timestamp}.db`);
    await db.backup(backupPath);
    /* Prune old backups: keep only the last 7 */
    const files = readdirSync(backupDir)
      .filter((f: string) => f.startsWith("qayaba-") && f.endsWith(".db"))
      .sort();
    while (files.length > 7) {
      const old = files.shift();
      if (old) unlinkSync(join(backupDir, old));
    }
    return { backedUp: true, path: backupPath };
  } catch (err) {
    return { backedUp: false, error: err instanceof Error ? err.message : String(err) };
  }
}

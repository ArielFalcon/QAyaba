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
import { parseRetentionDays, parseCampaignRetentionDays, DEFAULT_SPAN_RETENTION_DAYS, DEFAULT_CAMPAIGN_RETENTION_DAYS } from "../telemetry/config";
import type { CampaignIdentity } from "@kernel/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import type { AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";
import type { TurnEnd } from "@kernel/turn-end";
import type { ToolSequenceEntry } from "@contexts/generation/domain/tool-sequence";
import type { TurnUsage } from "@contexts/generation/domain/turn-efficiency-summary";

const redactionPort = new RedactionPortAdapter();


export interface AgentTurnRecord {
  runId: string | null;        /* maps to RunRecord.id; null for turns with no parent run */
  sessionId: string;           /* OpenCode session id */
  role: string;                /* agent name (qa-generator, qa-reviewer, …) */
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
   * Per-turn efficiency measurements. Each is null when the runtime or the row
   * cannot supply it — never a fabricated zero/false. Omitted on write means null.
   */
  totalCalls?: number | null;
  stepsUsed?: number | null;
  maxSteps?: number | null;
  callsBeforeFirstWrite?: number | null;
  writeCount?: number | null;
  redundantReadCount?: number | null;
  /* Re-reads of a file already read in the session, whatever window, with no write to it in between. */
  sameFileReadCount?: number | null;
  duplicateCallCount?: number | null;
  promptProvidedReadCount?: number | null;
  /* Content reads of a file the prompt listed by path as rendered; apart from the content-based promptProvidedReadCount. */
  pathProvidedReadCount?: number | null;
  exhausted?: boolean | null;
  callBuckets?: Record<string, number> | null;
  /* How the turn ended; null when the row predates the column or the runtime does not say. A turn that ended by timeout or abort has empty output_text and only the calls measured up to its end. */
  ended?: TurnEnd | null;
  /* Wall time of the turn, from the prompt being sent to its end; null when the row predates the column or the runtime did not measure it. */
  durationMs?: number | null;
  /* Milliseconds from the turn's start to its first call / first write; null when none was made, the start was not observed, or the row predates the column. */
  timeToFirstCallMs?: number | null;
  timeToFirstWriteMs?: number | null;
  /* Calls the runtime refused under a permission rule; null (never 0) when the turn was not measured. */
  deniedCallCount?: number | null;
  /* The turn's calls in order, each with a redacted, capped target; null when the turn was not measured. */
  toolSequence?: ToolSequenceEntry[] | null;
  /* What the turn spent over every step it finished. The tokens_* columns hold the usage of the last assistant message alone (what the blocking prompt answers with), so a many-step turn reads there as one step. Null when the steps were not all observed, none finished, or the row predates the column. */
  usageTotal?: TurnUsage | null;
  /* What the turn's trace mirrors. Written with the row and read back through `getAgentTurnTraces`; `getAgentTurns` (the public turn view) does not carry them. */
  /* The model the prompt asked for (null: the agent's configured one), the one that answered, its provider, the attempt that ended the turn (1 primary, 2 fallback) and whether the fallback answered. Null where the runtime cannot say or the row predates the column. */
  modelRequested?: string | null;
  modelAnswered?: string | null;
  provider?: string | null;
  attempt?: number | null;
  fallbackUsed?: boolean | null;
  /* The class of the last failure an attempt of the turn met. */
  errorType?: string | null;
  /* Byte sizes and sha256 of the prompt's sections, by section id, and the sha256 of the bytes sent. */
  sectionSizes?: Record<string, number> | null;
  sectionHashes?: Record<string, string> | null;
  promptHash?: string | null;
  /* The time limit that bound the prompt, and the limit that ended the turn. */
  limitApplied?: string | null;
  limitFired?: string | null;
}

/*
 * The nullable per-turn efficiency columns: call counts, step budget,
 * redundancy and prompt-provided read counts, and call_buckets (a JSON-encoded
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
  { name: "path_provided_read_count", type: "INTEGER" },
  { name: "ended", type: "TEXT" },
  { name: "duration_ms", type: "INTEGER" },
  { name: "time_to_first_call_ms", type: "INTEGER" },
  { name: "time_to_first_write_ms", type: "INTEGER" },
  { name: "denied_call_count", type: "INTEGER" },
  /* A JSON-encoded ToolSequenceEntry[], like call_buckets. */
  { name: "tool_sequence", type: "TEXT" },
  /* A JSON-encoded TurnUsage. */
  { name: "usage_total", type: "TEXT" },
  /* What the turn's trace mirrors (these columns are the record; the spans copy them): the model asked for and the one that answered, the attempt, the error class, the prompt's sizes and hashes and the limits. */
  { name: "model_requested", type: "TEXT" },
  { name: "model_answered", type: "TEXT" },
  { name: "provider", type: "TEXT" },
  { name: "attempt", type: "INTEGER" },
  { name: "fallback_used", type: "INTEGER" },
  { name: "error_type", type: "TEXT" },
  /* JSON objects keyed by section id: byte sizes, and sha256 of each section as sent. */
  { name: "section_sizes", type: "TEXT" },
  { name: "section_hashes", type: "TEXT" },
  { name: "prompt_hash", type: "TEXT" },
  { name: "limit_applied", type: "TEXT" },
  { name: "limit_fired", type: "TEXT" },
  { name: "same_file_read_count", type: "INTEGER" },
];

const DELETE_MAX_AGE_DAYS = 30;

let db!: Database.Database;
let insertRun!: Database.Statement;
let getRunStmt!: Database.Statement;
let listRunsStmt!: Database.Statement;
let childrenStmt!: Database.Statement;
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
      logs TEXT DEFAULT '',
      furthest_phase TEXT,
      phase_timings TEXT,
      trace_id TEXT,
      decision TEXT,
      limit_fired TEXT,
      limit_role TEXT,
      review_required INTEGER,
      coverage_status TEXT,
      coverage_mode TEXT,
      coverage_min_ratio REAL,
      cancelled INTEGER
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      file TEXT
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

    -- The span ledger (docs/observability-design.md §3.3): every span of every run, metadata only. A row is
    -- written when the span starts (end_ns NULL) and updated when it ends, so a hung or crashed run leaves its
    -- open spans behind as evidence. Times are epoch nanoseconds, bound as BigInt (they exceed 2^53).
    CREATE TABLE IF NOT EXISTS run_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      run_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_ns INTEGER NOT NULL,
      end_ns INTEGER,
      status TEXT NOT NULL DEFAULT 'unset',
      status_message TEXT,
      attrs TEXT NOT NULL DEFAULT '{}',
      events TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_spans_run_id ON run_spans(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_spans_trace_id ON run_spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_run_spans_start_ns ON run_spans(start_ns);

    -- Evaluation scores (docs/observability-design.md section 11): one row per (run, score name, grader version), replaced on a regrade.
    -- Never pruned: they are tiny, and a campaign compares them long after the run's spans are gone. No foreign key to runs, for the same reason.
    CREATE TABLE IF NOT EXISTS run_scores (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grader_version TEXT NOT NULL,
      data_type TEXT NOT NULL,
      polarity TEXT NOT NULL,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      comment TEXT,
      observation_id TEXT,
      graded_at TEXT NOT NULL,
      PRIMARY KEY (run_id, name, grader_version)
    );
    CREATE INDEX IF NOT EXISTS idx_run_scores_name ON run_scores(name);

    -- Whether a run's evaluation is pending, complete or failed. A run with no row was never graded: pending.
    CREATE TABLE IF NOT EXISTS run_evaluations (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Regrade jobs (POST /evaluations/regrade): the request's runs, progress and the runs that failed.
    CREATE TABLE IF NOT EXISTS regrade_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      run_ids TEXT NOT NULL,
      graders TEXT,
      runs INTEGER NOT NULL,
      graded INTEGER NOT NULL DEFAULT 0,
      failed TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    -- The text of the specs a run held when it validated them (docs/observability-design.md §11.1), redacted and capped, so
    -- a run can be graded after its working copy is gone. One row per (run, path, bytes): a spec rewritten during the run is
    -- kept in each version. Same retention as run_spans.
    CREATE TABLE IF NOT EXISTS run_spec_snapshots (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      text TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (run_id, path, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_run_spec_snapshots_captured_at ON run_spec_snapshots(captured_at);

    -- What the lead planned for a run (the admitted plan, the change pages each flow visits, how each flow ended), sanitized, so a run
    -- can be graded against its change after the fact. One row per run: the last record wins. Same retention as run_spec_snapshots.
    CREATE TABLE IF NOT EXISTS run_plans (
      run_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_plans_recorded_at ON run_plans(recorded_at);

    -- LLM-judge bookkeeping (docs/observability-design.md section 11.3). One row per judge attempt: what was asked, how it ended and the
    -- tokens it spent (the day's budget is the sum of a day's rows). Never pruned, like run_scores: they are tiny.
    CREATE TABLE IF NOT EXISTS judge_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      judge TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      model TEXT,
      outcome TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_judge_attempts_run ON judge_attempts(run_id, judge, prompt_version);
    CREATE INDEX IF NOT EXISTS idx_judge_attempts_at ON judge_attempts(at);

    -- Calibration reports of a judge against human labels: one row per computation, the newest of a (judge, prompt version) is in force.
    CREATE TABLE IF NOT EXISTS judge_calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      judge TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      model TEXT NOT NULL,
      train_n INTEGER NOT NULL,
      dev_n INTEGER NOT NULL,
      test_n INTEGER NOT NULL,
      tpr REAL,
      tnr REAL,
      agreement REAL,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_judge_calibrations_judge ON judge_calibrations(judge, prompt_version);

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
      at TEXT NOT NULL,
      quarantined_at TEXT
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

    -- When an off-path context-map rebuild was last requested, so a SHA/age-stale map does not
    -- enqueue one on every run. The context_stale flag is cleared when the queue accepts a rebuild;
    -- this timestamp survives that and is the 6h dedupe bound.
    CREATE TABLE IF NOT EXISTS context_heal_requests (
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
  /* A rule an operator set aside (learning:quarantine): NULL while in force. Existing rows stay in force. */
  if (!columnExists("learning_rules", "quarantined_at")) {
    db.exec("ALTER TABLE learning_rules ADD COLUMN quarantined_at TEXT");
  }
  if (!columnExists("runs", "trigger_repo")) {
    db.exec("ALTER TABLE runs ADD COLUMN trigger_repo TEXT");
  }
  /* Where the run got in the pipeline and the JSON of its time per phase: NULL for a run that recorded none (an older run, a cancelled one). */
  if (!columnExists("runs", "furthest_phase")) {
    db.exec("ALTER TABLE runs ADD COLUMN furthest_phase TEXT");
  }
  /* The first build of the snapshot table had no flag; every row it kept is a delivered spec or an unmarked suite spec, and stays visible. */
  if (!columnExists("run_spec_snapshots", "delivered")) {
    db.exec("ALTER TABLE run_spec_snapshots ADD COLUMN delivered INTEGER NOT NULL DEFAULT 1");
  }
  if (!columnExists("runs", "phase_timings")) {
    db.exec("ALTER TABLE runs ADD COLUMN phase_timings TEXT");
  }
  /* The spec file a case ran from, as the parsed report named it (NULL for a case recorded before the column, or one the report gave no file). */
  if (!columnExists("cases", "file")) {
    db.exec("ALTER TABLE cases ADD COLUMN file TEXT");
  }
  /* What the run's trace and decision said about how it ended (NULL for a run that recorded none): the trace id, the publication decision, the limit that stopped it and the role it stopped. */
  for (const name of ["trace_id", "decision", "limit_fired", "limit_role", "coverage_status", "coverage_mode"]) {
    if (!columnExists("runs", name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
  }
  /* A Langfuse score finds its run by trace id (getRunIdByTraceId). */
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_trace_id ON runs(trace_id)");
  /* Facts the engine decided at run time and grading must not recompute: whether a reviewer ran, the coverage decision and its policy, and whether an operator cancelled the run. */
  for (const [name, type] of [["review_required", "INTEGER"], ["coverage_min_ratio", "REAL"], ["cancelled", "INTEGER"]] as const) {
    if (!columnExists("runs", name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
  /*
   * The campaign a run is a replicate of, how much content its trace may carry, and what it actually ran with (section 14). Stored as the
   * request named them and as the run resolved them; nothing reads the labels to decide what a run does. NULL for an ordinary run.
   */
  for (const [name, type] of [["campaign_id", "TEXT"], ["campaign_variant", "TEXT"], ["campaign_replicate", "INTEGER"], ["capture_mode", "TEXT"], ["effective_config", "TEXT"]] as const) {
    if (!columnExists("runs", name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_campaign_id ON runs(campaign_id)");
  /* The parent-linked child runs (a context heal, a /continue) of a run: childrenOf(parentRunId) reads this. */
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs(parent_run_id)");
  /* The model an LLM judge answered with, beside the prompt version in grader_version (NULL for every other score). */
  if (!columnExists("run_scores", "judge_model")) db.exec("ALTER TABLE run_scores ADD COLUMN judge_model TEXT");
  /*
   * Every agent_turns efficiency column
   * is added by this guarded ALTER (fresh and pre-existing DBs alike), so the
   * column list has a single source of truth. All are nullable: they stay NULL
   * for a pre-existing row and for any runtime that cannot supply them (Codex
   * leaves steps_used/max_steps/exhausted NULL) — never a fabricated value.
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
    INSERT INTO runs (id, app, sha, ref, target, mode, status, step, step_detail, verdict, passed, failed, note, retrying, parent_run_id, trigger_repo, at, logs, campaign_id, campaign_variant, campaign_replicate, capture_mode)
    VALUES (@id, @app, @sha, @ref, @target, @mode, @status, @step, @stepDetail, @verdict, @passed, @failed, @note, @retrying, @parentRunId, @triggerRepo, @at, @logs, @campaignId, @campaignVariant, @campaignReplicate, @captureMode)
  `);
  getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  listRunsStmt = db.prepare("SELECT * FROM runs WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
  childrenStmt = db.prepare("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY at DESC, rowid DESC");
  currentRunStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued') ORDER BY (status='running') DESC, at ASC, rowid ASC LIMIT 1");
  interruptedStmt = db.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued')");
  deleteCaseByName = db.prepare("DELETE FROM cases WHERE run_id = ? AND name = ?");
  insertCase = db.prepare("INSERT INTO cases (run_id, name, status, detail, file) VALUES (@runId, @name, @status, @detail, @file)");
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
  listRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') AND quarantined_at IS NULL ORDER BY (status = 'active') DESC, COALESCE(success_rate, 0) DESC, at DESC LIMIT ?");
  /*
   * Governance-path fetch (backs listLearningRulesForGovernance, below): every retrievable row, no
   * ORDER BY and no LIMIT — ranking is RuleGovernanceService's job alone (see that service's own
   * header). Any SQL-side cap would have to pre-rank to decide what to keep, and no SQL order can
   * match governance's ranking (success rate plus the per-run relevance bias, plus the newest-
   * candidate exploration slots), so a cap always hides rules governance would pick.
   */
  listRetrievableRulesStmt = db.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') AND quarantined_at IS NULL");
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
       redundant_read_count, duplicate_call_count, prompt_provided_read_count, exhausted, call_buckets,
       path_provided_read_count, ended,
       duration_ms, time_to_first_call_ms, time_to_first_write_ms, denied_call_count, tool_sequence, usage_total,
       model_requested, model_answered, provider, attempt, fallback_used, error_type,
       section_sizes, section_hashes, prompt_hash, limit_applied, limit_fired, same_file_read_count)
    VALUES
      (@runId, @sessionId, @role, @round, @isRepair, @ts, @objective,
       @promptText, @outputText, @promptBytes,
       @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite, @cost,
       @totalCalls, @stepsUsed, @maxSteps, @callsBeforeFirstWrite, @writeCount,
       @redundantReadCount, @duplicateCallCount, @promptProvidedReadCount, @exhausted, @callBuckets,
       @pathProvidedReadCount, @ended,
       @durationMs, @timeToFirstCallMs, @timeToFirstWriteMs, @deniedCallCount, @toolSequence, @usageTotal,
       @modelRequested, @modelAnswered, @provider, @attempt, @fallbackUsed, @errorType,
       @sectionSizes, @sectionHashes, @promptHash, @limitApplied, @limitFired, @sameFileReadCount)
  `);
  getAgentTurnsStmt = db.prepare("SELECT * FROM agent_turns WHERE run_id = ? ORDER BY id ASC");

  /* Prune old runs once on first use. */
  /*
   * Campaign-tagged runs are the baselines later graders and judges re-score (R4): they keep the run row, its agent turns and its spans
   * for the campaign window (QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS, default 180) instead of the ordinary one.
   */
  const campaignDays = campaignRetentionDays();
  db.prepare(`DELETE FROM runs WHERE at < datetime('now', '-${DELETE_MAX_AGE_DAYS} days') AND (campaign_id IS NULL OR datetime(at) < datetime('now', '-' || ? || ' days'))`).run(campaignDays);
  /* Bound the durable event log: drop events older than the run retention window (ts is epoch ms). */
  db.prepare("DELETE FROM run_events WHERE ts < ?").run(Date.now() - DELETE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  /*
   * Prune agent_turns older than the retention window. agent_turns.ts is ISO-8601 (…T…Z) TEXT, but
   * datetime('now', …) yields the space-separated 'YYYY-MM-DD HH:MM:SS' form — a raw string compare
   * would mis-sort (the 'T' > ' ' at index 10 makes every ISO value sort GREATER, so nothing prunes).
   * Wrap ts in datetime() so BOTH sides are SQLite's canonical datetime form: a correct boundary
   * compare, consistent with run_events (which prunes correctly via its own typed epoch-ms compare).
   */
  db.prepare(
    `DELETE FROM agent_turns WHERE datetime(ts) < datetime('now', '-${DELETE_MAX_AGE_DAYS} days')
       AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE campaign_id IS NOT NULL AND datetime(at) >= datetime('now', '-' || ? || ' days')))`,
  ).run(campaignDays);
  /* The span ledger keeps its own window (QA_TELEMETRY_RETENTION_DAYS, default 30). A malformed value is reported loudly by the telemetry bootstrap; here it must not stop the history from opening. */
  try {
    pruneRunSpans(spanRetentionDays(), Date.now(), RUN_SPAN_PRUNE_CHUNK, campaignDays);
    pruneSpecSnapshots(spanRetentionDays(), Date.now(), RUN_SPAN_PRUNE_CHUNK, campaignDays);
    pruneRunPlans(spanRetentionDays(), Date.now(), RUN_SPAN_PRUNE_CHUNK, campaignDays);
  } catch (error) {
    console.error(`[telemetry] span ledger prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }

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
  /* The campaign replicate this run is, and the content capture its trace was granted (already capped by the server). */
  campaign?: CampaignIdentity; captureMode?: CaptureMode;
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
    campaignId: opts.campaign?.id ?? null,
    campaignVariant: opts.campaign ? JSON.stringify(opts.campaign.variant) : null,
    campaignReplicate: opts.campaign?.replicate ?? null,
    captureMode: opts.captureMode ?? null,
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

/* What a run recorded about its phases. Kept off RunRecord, which is the API's shape. */
export interface RunPhases {
  furthestPhase: string | null;
  phaseTimings: Record<string, number> | null;
}

/* Stores where a run got and how long each phase took. Called once, when the run is finalized. */
export function recordRunPhases(id: string, phases: { furthestPhase: string; phaseTimings: Record<string, number> }): void {
  ensureDb();
  db.prepare("UPDATE runs SET furthest_phase = ?, phase_timings = ? WHERE id = ?").run(phases.furthestPhase, JSON.stringify(phases.phaseTimings), id);
}

export function getRunPhases(id: string): RunPhases | undefined {
  ensureDb();
  const row = db.prepare("SELECT furthest_phase, phase_timings FROM runs WHERE id = ?").get(id) as { furthest_phase: string | null; phase_timings: string | null } | undefined;
  if (!row) return undefined;
  return {
    furthestPhase: row.furthest_phase,
    phaseTimings: row.phase_timings === null ? null : safeJsonParse<Record<string, number> | null>(row.phase_timings, null),
  };
}

/* The run whose trace has this id; the join from a Langfuse score back to the run store. Undefined for an unknown trace. */
export function getRunIdByTraceId(traceId: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT id FROM runs WHERE trace_id = ? LIMIT 1").get(traceId) as { id: string } | undefined;
  return row?.id;
}

/* What a run recorded about how it ended, beyond its verdict. Undefined: no such run. */
export function getRunFacts(id: string): Required<RunFactsPatch> | undefined {
  ensureDb();
  const row = db.prepare(`SELECT ${FACT_COLUMNS.map(([, c]) => c).join(", ")} FROM runs WHERE id = ?`).get(id) as Record<string, string | number | null> | undefined;
  if (!row) return undefined;
  const flag = (v: string | number | null): boolean | null => (v === null ? null : v === 1);
  return {
    traceId: row.trace_id as string | null,
    decision: row.decision as string | null,
    limitFired: row.limit_fired as string | null,
    limitRole: row.limit_role as string | null,
    reviewRequired: flag(row.review_required!),
    coverageStatus: row.coverage_status as string | null,
    coverageMode: row.coverage_mode as string | null,
    coverageMinRatio: row.coverage_min_ratio as number | null,
    cancelled: flag(row.cancelled!),
  };
}

/* The campaign a run belongs to, or undefined for an ordinary run (or no such run). */
export function getRunCampaign(id: string): CampaignIdentity | undefined {
  ensureDb();
  const row = db.prepare("SELECT campaign_id, campaign_variant, campaign_replicate FROM runs WHERE id = ?").get(id) as { campaign_id: string | null; campaign_variant: string | null; campaign_replicate: number | null } | undefined;
  if (!row || row.campaign_id === null) return undefined;
  return { id: row.campaign_id, variant: safeJsonParse<Record<string, string>>(row.campaign_variant ?? "{}", {}), replicate: row.campaign_replicate ?? 1 };
}

/* The capture mode the campaign's runs were granted (they all share one), or undefined when it has no run yet. */
export function getCampaignCaptureMode(campaignId: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT capture_mode FROM runs WHERE campaign_id = ? AND capture_mode IS NOT NULL ORDER BY at ASC, rowid ASC LIMIT 1").get(campaignId) as { capture_mode: string } | undefined;
  return row?.capture_mode;
}

export interface CampaignRunRecord {
  id: string;
  variant: Record<string, string>;
  replicate: number;
  status: string;
  verdict: string | null;
  evaluationStatus: string | null;
}

/* Every run of a campaign, oldest first, with its grading status (null: never graded). */
export function listCampaignRuns(campaignId: string): CampaignRunRecord[] {
  ensureDb();
  const rows = db
    .prepare(
      `SELECT r.id, r.campaign_variant, r.campaign_replicate, r.status, r.verdict, e.status AS evaluation_status
       FROM runs r LEFT JOIN run_evaluations e ON e.run_id = r.id
       WHERE r.campaign_id = ? ORDER BY r.at ASC, r.rowid ASC`,
    )
    .all(campaignId) as Array<{ id: string; campaign_variant: string | null; campaign_replicate: number | null; status: string; verdict: string | null; evaluation_status: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    variant: safeJsonParse<Record<string, string>>(r.campaign_variant ?? "{}", {}),
    replicate: r.campaign_replicate ?? 1,
    status: r.status,
    verdict: r.verdict,
    evaluationStatus: r.evaluation_status,
  }));
}

/* The finished runs of a campaign (a regrade covers only runs that are over). One more than `limit` is returned at most, so the caller can tell it was exceeded. */
export function listFinishedCampaignRunIds(campaignId: string, limit: number): string[] {
  ensureDb();
  return (db.prepare("SELECT id FROM runs WHERE campaign_id = ? AND status = 'done' ORDER BY at ASC, rowid ASC LIMIT ?").all(campaignId, limit + 1) as Array<{ id: string }>).map((r) => r.id);
}

/* What the run recorded about the configuration it ran with at run time (JSON text; undefined: none recorded, or no such run), and the capture mode it applied. */
export function recordEffectiveConfig(id: string, json: string): void {
  ensureDb();
  db.prepare("UPDATE runs SET effective_config = ? WHERE id = ?").run(json, id);
}

export function getStoredEffectiveConfig(id: string): { json: string | null; captureMode: string | null } | undefined {
  ensureDb();
  const row = db.prepare("SELECT effective_config, capture_mode FROM runs WHERE id = ?").get(id) as { effective_config: string | null; capture_mode: string | null } | undefined;
  return row ? { json: row.effective_config, captureMode: row.capture_mode } : undefined;
}

export interface RunFunnelRow {
  furthestPhase: string | null;
  verdict: string | null;
  errorClass: string | null;
  count: number;
}

/*
 * How many finished runs ended where: grouped by the phase they got furthest into, their verdict and their error class
 * (from the run's outcome row, null when it has none). A run that recorded no phase groups under null. Earliest phase
 * first. Read-only.
 */
export function getRunFunnel(opts: { app?: string; since?: string } = {}): RunFunnelRow[] {
  ensureDb();
  const where = ["r.status = 'done'"];
  const params: string[] = [];
  if (opts.app !== undefined) { where.push("r.app = ?"); params.push(opts.app); }
  if (opts.since !== undefined) { where.push("datetime(r.at) >= datetime(?)"); params.push(opts.since); }
  const rows = db.prepare(
    `SELECT r.furthest_phase AS furthestPhase, r.verdict AS verdict, o.error_class AS errorClass, COUNT(*) AS count
     FROM runs r LEFT JOIN run_outcomes o ON o.id = r.id
     WHERE ${where.join(" AND ")}
     GROUP BY r.furthest_phase, r.verdict, o.error_class`,
  ).all(...params) as RunFunnelRow[];
  const rank = (phase: string | null): number => {
    const i = phase === null ? -1 : (RUN_PHASES as readonly string[]).indexOf(phase);
    return i === -1 ? RUN_PHASES.length : i;
  };
  const text = (v: string | null): string => v ?? "";
  return rows.sort((a, b) => rank(a.furthestPhase) - rank(b.furthestPhase) || text(a.verdict).localeCompare(text(b.verdict)) || text(a.errorClass).localeCompare(text(b.errorClass)));
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

/* The runs that name `parentRunId` as their parent (a context heal, a /continue), newest first. Empty for a leaf run. */
export function childrenOf(parentRunId: string): RunRecord[] {
  ensureDb();
  const rows = childrenStmt.all(parentRunId) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function currentRun(): RunRecord | undefined {
  ensureDb();
  const row = currentRunStmt.get() as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : undefined;
}

/* A run's phase record as updateRecord takes it: written in the same statement as the status it accompanies. */
export interface RunPhasesPatch {
  furthestPhase: string;
  /* Already known to serialize; see serializablePhases. */
  phaseTimings: Record<string, number>;
}

/* The phases as they can be stored, or undefined (said on the console) when they cannot: a phase record never costs a run its final status. */
export function serializablePhases(phases: RunPhasesPatch | undefined): RunPhasesPatch | undefined {
  if (!phases) return undefined;
  try {
    JSON.stringify(phases.phaseTimings);
    return phases;
  } catch (err) {
    console.error(`[qa] the phase record of a run could not be stored and is dropped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/*
 * What a run's trace and engine said about how it ended, stored with its final status. A key left out is not touched; null stores
 * "the run recorded none". Grading reads these columns and never recomputes them from the app's current configuration.
 */
export interface RunFactsPatch {
  traceId?: string | null;
  decision?: string | null;
  limitFired?: string | null;
  limitRole?: string | null;
  /* Whether the engine ran a reviewer for the run. */
  reviewRequired?: boolean | null;
  /* The engine's change-coverage decision (pass|fail|unknown), the policy mode and threshold in force. */
  coverageStatus?: string | null;
  coverageMode?: string | null;
  coverageMinRatio?: number | null;
  /* An operator cancelled the run. */
  cancelled?: boolean | null;
}

const FACT_COLUMNS: ReadonlyArray<[keyof RunFactsPatch, string]> = [
  ["traceId", "trace_id"], ["decision", "decision"], ["limitFired", "limit_fired"], ["limitRole", "limit_role"], ["reviewRequired", "review_required"],
  ["coverageStatus", "coverage_status"], ["coverageMode", "coverage_mode"], ["coverageMinRatio", "coverage_min_ratio"], ["cancelled", "cancelled"],
];

/* The patch updateRecord takes: like RunRecord's optional fields, except stepDetail may be an explicit null so a step change can clear the last detail. */
export type RunRecordPatch = Omit<Partial<RunRecord>, "stepDetail"> & {
  stepDetail?: string | null;
  phases?: RunPhasesPatch;
  facts?: RunFactsPatch;
};

export function updateRecord(id: string, patch: RunRecordPatch): void {
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
  if (patch.phases !== undefined) {
    add("furthest_phase", patch.phases.furthestPhase);
    add("phase_timings", JSON.stringify(patch.phases.phaseTimings));
  }
  if (patch.facts !== undefined) {
    for (const [key, column] of FACT_COLUMNS) {
      const v = patch.facts[key];
      if (v === undefined) continue;
      add(column, typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }

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
    file: c.file ?? null,
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

/*
 * A run that ended on an unhandled error keeps the class the shell reports. The engine may already have persisted an outcome
 * carrying the evidence the sandbox saw, with a placeholder class: that row is reclassified, never replaced, and a run that has
 * no outcome row gets the minimal one. The run's record, its outcome, the trace root, the run metric and the infra_error grader
 * then name one class, and the outcome says the verdict the record does.
 */
export function saveCrashedRunOutcome(record: RunRecord, errorClass: ErrorClass): void {
  ensureDb();
  const reclassified = db.prepare("UPDATE run_outcomes SET verdict = 'infra-error', error_class = ? WHERE id = ?").run(errorClass, record.id).changes;
  if (reclassified > 0) return;
  saveRunOutcome({
    runId: record.id,
    app: record.app,
    sha: record.sha,
    mode: record.mode,
    target: record.target,
    verdict: "infra-error",
    errorClass,
    gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [],
    at: new Date().toISOString(),
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
    quarantinedAt: (row.quarantined_at as string | null | undefined) ?? null,
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
  /* A rule an operator set aside accrues nothing, even for a run that retrieved it before the quarantine. */
  if (current.quarantinedAt) return;
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
 * Operator quarantine (npm run learning:quarantine): sets the named rules of ONE app aside without deleting them. A
 * quarantined rule is excluded from every retrieval and live-ledger read above and refused by recordRuleOutcome, so it
 * is never injected into a prompt and never credited. Only rules not yet quarantined are marked, so the first mark is
 * kept and a second run of the command changes nothing. Returns how many rules this call newly marked.
 */
export function quarantineLearningRules(app: string, ruleIds: readonly string[], at: string): number {
  ensureDb();
  const mark = db.prepare("UPDATE learning_rules SET quarantined_at = ? WHERE app = ? AND id = ? AND quarantined_at IS NULL");
  const markAll = db.transaction((ids: readonly string[]) => {
    let marked = 0;
    for (const id of ids) marked += mark.run(at, app, id).changes;
    return marked;
  });
  return markAll(ruleIds);
}

/* Lifts a quarantine: the rule is in force again. False when the rule is unknown or was not quarantined. */
export function releaseLearningRuleQuarantine(ruleId: string): boolean {
  ensureDb();
  return db.prepare("UPDATE learning_rules SET quarantined_at = NULL WHERE id = ? AND quarantined_at IS NOT NULL").run(ruleId).changes > 0;
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

/* When an off-path context-map rebuild was last requested for the app, ISO-8601; undefined when never. */
export function lastContextHealRequestAt(app: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT at FROM context_heal_requests WHERE app = ?").get(app) as { at: string } | undefined;
  return row?.at;
}

/* Record that an off-path rebuild was requested now. Idempotent: the latest request wins. */
export function recordContextHealRequest(app: string): void {
  ensureDb();
  db.prepare("INSERT OR REPLACE INTO context_heal_requests (app, at) VALUES (?, ?)").run(app, new Date().toISOString());
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

/* One row of the span ledger. `startNs`/`endNs` are epoch nanoseconds. */
export interface RunSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  runId: string | null;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint | null;
  status: string;
  statusMessage: string | null;
  /* JSON text. */
  attrs: string;
  events: string;
  links: string;
}

function campaignRetentionDays(): number {
  try {
    return parseCampaignRetentionDays(process.env.QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS);
  } catch (error) {
    console.error(`[telemetry] ${error instanceof Error ? error.message : String(error)}; keeping ${DEFAULT_CAMPAIGN_RETENTION_DAYS} days`);
    return DEFAULT_CAMPAIGN_RETENTION_DAYS;
  }
}

function spanRetentionDays(): number {
  try {
    return parseRetentionDays(process.env.QA_TELEMETRY_RETENTION_DAYS);
  } catch (error) {
    console.error(`[telemetry] ${error instanceof Error ? error.message : String(error)}; keeping ${DEFAULT_SPAN_RETENTION_DAYS} days`);
    return DEFAULT_SPAN_RETENTION_DAYS;
  }
}

/*
 * Upserts a batch of ledger rows in ONE transaction. A row carries every column, so an update of a span whose
 * start row was lost (a failed earlier batch) still lands complete.
 */
export function commitRunSpans(rows: readonly RunSpanRow[]): void {
  ensureDb();
  const upsert = db.prepare(`
    INSERT INTO run_spans (trace_id, span_id, parent_span_id, run_id, name, kind, start_ns, end_ns, status, status_message, attrs, events, links)
    VALUES (@traceId, @spanId, @parentSpanId, @runId, @name, @kind, @startNs, @endNs, @status, @statusMessage, @attrs, @events, @links)
    ON CONFLICT(trace_id, span_id) DO UPDATE SET
      parent_span_id = excluded.parent_span_id, run_id = excluded.run_id, name = excluded.name, kind = excluded.kind,
      start_ns = excluded.start_ns, end_ns = excluded.end_ns, status = excluded.status, status_message = excluded.status_message,
      attrs = excluded.attrs, events = excluded.events, links = excluded.links`);
  db.transaction((batch: readonly RunSpanRow[]) => {
    for (const row of batch) upsert.run(row);
  })(rows);
}

export function listRunSpans(runId: string): RunSpanRow[] {
  ensureDb();
  const rows = db
    .prepare("SELECT * FROM run_spans WHERE run_id = ? ORDER BY start_ns, span_id")
    .safeIntegers()
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    traceId: r.trace_id as string,
    spanId: r.span_id as string,
    parentSpanId: (r.parent_span_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    name: r.name as string,
    kind: r.kind as string,
    startNs: r.start_ns as bigint,
    endNs: (r.end_ns as bigint | null) ?? null,
    status: r.status as string,
    statusMessage: (r.status_message as string | null) ?? null,
    attrs: r.attrs as string,
    events: r.events as string,
    links: r.links as string,
  }));
}

/* A stored score as the evaluation store reads and writes it; `value` is the typed value, serialized as JSON in the table. */
export interface ScoreRow {
  runId: string;
  name: string;
  graderVersion: string;
  dataType: string;
  polarity: string;
  source: string;
  value: number | boolean | string;
  comment: string | null;
  observationId: string | null;
  /* LLM-judge scores only. */
  judgeModel?: string | null;
}

/*
 * Stores scores in one transaction. First it deletes what the regrade supersedes (a name the graders no longer emit must not
 * outlive it): every row of the run at `graderVersion`, or only the given base names and their `.<suffix>` expansions. Then it
 * inserts. The key is (run, name, grader version).
 */
export function replaceRunScores(rows: readonly ScoreRow[], gradedAt: string, scope?: { runId: string; graderVersion: string; baseNames?: readonly string[] }): void {
  ensureDb();
  const upsert = db.prepare(`
    INSERT INTO run_scores (run_id, name, grader_version, data_type, polarity, source, value, comment, observation_id, graded_at, judge_model)
    VALUES (@runId, @name, @graderVersion, @dataType, @polarity, @source, @value, @comment, @observationId, @gradedAt, @judgeModel)
    ON CONFLICT(run_id, name, grader_version) DO UPDATE SET
      data_type = excluded.data_type, polarity = excluded.polarity, source = excluded.source, value = excluded.value,
      comment = excluded.comment, observation_id = excluded.observation_id, graded_at = excluded.graded_at, judge_model = excluded.judge_model`);
  const deleteAll = db.prepare("DELETE FROM run_scores WHERE run_id = ? AND grader_version = ?");
  /* substr, not LIKE: the underscore in a score name is a LIKE wildcard. */
  const deleteNamed = db.prepare("DELETE FROM run_scores WHERE run_id = ? AND grader_version = ? AND (name = ? OR substr(name, 1, ?) = ?)");
  db.transaction((batch: readonly ScoreRow[]) => {
    if (scope) {
      if (scope.baseNames) {
        for (const base of scope.baseNames) deleteNamed.run(scope.runId, scope.graderVersion, base, base.length + 1, `${base}.`);
      } else {
        deleteAll.run(scope.runId, scope.graderVersion);
      }
    }
    for (const r of batch) upsert.run({ ...r, judgeModel: r.judgeModel ?? null, value: JSON.stringify(r.value), gradedAt });
  })(rows);
}

/* A stored value must be of the type its row declares; a row that is not is skipped and said, never shipped as an empty or wrong value. */
function scoreValueOf(raw: string, dataType: string): number | boolean | string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (dataType === "NUMERIC") return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (dataType === "BOOLEAN") return typeof v === "boolean" ? v : undefined;
  if (dataType === "CATEGORICAL") return typeof v === "string" ? v : undefined;
  return undefined;
}

export function listRunScoreRows(runId: string): ScoreRow[] {
  ensureDb();
  const rows = db.prepare("SELECT * FROM run_scores WHERE run_id = ? ORDER BY name, grader_version").all(runId) as Array<Record<string, unknown>>;
  const out: ScoreRow[] = [];
  for (const r of rows) {
    const value = scoreValueOf(r.value as string, r.data_type as string);
    if (value === undefined) {
      console.error(`[evaluation] skipping a corrupt score row: run ${runId}, ${String(r.name)}@${String(r.grader_version)} (${String(r.data_type)})`);
      continue;
    }
    out.push({
      runId: r.run_id as string,
      name: r.name as string,
      graderVersion: r.grader_version as string,
      dataType: r.data_type as string,
      polarity: r.polarity as string,
      source: r.source as string,
      value,
      comment: (r.comment as string | null) ?? null,
      observationId: (r.observation_id as string | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
    });
  }
  return out;
}

export interface JudgeAttemptRow {
  runId: string;
  judge: string;
  promptVersion: string;
  model: string | null;
  outcome: string;
  tokens: number;
  detail: string | null;
  at: string;
}

export function insertJudgeAttempt(row: JudgeAttemptRow): void {
  ensureDb();
  db.prepare(
    "INSERT INTO judge_attempts (run_id, judge, prompt_version, model, outcome, tokens, detail, at) VALUES (@runId, @judge, @promptVersion, @model, @outcome, @tokens, @detail, @at)",
  ).run(row);
}

/* The newest outcome recorded for the run, judge and prompt version; undefined when never attempted. */
export function lastJudgeOutcome(runId: string, judge: string, promptVersion: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT outcome FROM judge_attempts WHERE run_id = ? AND judge = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1").get(runId, judge, promptVersion) as { outcome: string } | undefined;
  return row?.outcome;
}

/* The model that answered the judge's newest scored attempt of the prompt version; undefined when it has none. */
export function latestJudgeModel(judge: string, promptVersion: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT model FROM judge_attempts WHERE judge = ? AND prompt_version = ? AND outcome = 'scored' AND model IS NOT NULL ORDER BY id DESC LIMIT 1").get(judge, promptVersion) as { model: string } | undefined;
  return row?.model;
}

/* Tokens the judge attempts of a UTC day (YYYY-MM-DD) used. */
export function judgeTokensUsedOn(day: string): number {
  ensureDb();
  const row = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM judge_attempts WHERE substr(at, 1, 10) = ?").get(day) as { used: number };
  return row.used;
}

/* How many attempts ended each way over the window starting at `sinceIso`: the count of unparseable replies is what a judge's prompt author reads. */
export function judgeOutcomeCounts(judge: string, sinceIso: string): Record<string, number> {
  ensureDb();
  const rows = db.prepare("SELECT outcome, COUNT(*) AS n FROM judge_attempts WHERE judge = ? AND at >= ? GROUP BY outcome").all(judge, sinceIso) as Array<{ outcome: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

export interface JudgeCalibrationRow {
  judge: string;
  promptVersion: string;
  model: string;
  trainN: number;
  devN: number;
  testN: number;
  tpr: number | null;
  tnr: number | null;
  agreement: number | null;
  status: string;
  /* The full report as JSON. */
  report: string;
  computedAt: string;
}

export function insertJudgeCalibration(row: JudgeCalibrationRow): void {
  ensureDb();
  db.prepare(
    `INSERT INTO judge_calibrations (judge, prompt_version, model, train_n, dev_n, test_n, tpr, tnr, agreement, status, report, computed_at)
     VALUES (@judge, @promptVersion, @model, @trainN, @devN, @testN, @tpr, @tnr, @agreement, @status, @report, @computedAt)`,
  ).run(row);
}

/* The newest calibration of the judge for exactly this prompt version. */
export function latestJudgeCalibration(judge: string, promptVersion: string): JudgeCalibrationRow | undefined {
  ensureDb();
  const r = db.prepare("SELECT * FROM judge_calibrations WHERE judge = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1").get(judge, promptVersion) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    judge: r.judge as string,
    promptVersion: r.prompt_version as string,
    model: r.model as string,
    trainN: r.train_n as number,
    devN: r.dev_n as number,
    testN: r.test_n as number,
    tpr: (r.tpr as number | null) ?? null,
    tnr: (r.tnr as number | null) ?? null,
    agreement: (r.agreement as number | null) ?? null,
    status: r.status as string,
    report: r.report as string,
    computedAt: r.computed_at as string,
  };
}

/*
 * The scores of the judge's newest (grader version, model) group paired with the human labels of the same runs. "Newest" is the group
 * with the latest graded_at: a judge whose prompt or model changed is calibrated for what it is now, never for what it was.
 */
export function listJudgeLabelPairs(judge: string): { graderVersion: string; model: string; pairs: Array<{ runId: string; human: number | boolean | string; judge: number | boolean | string }> } | undefined {
  ensureDb();
  const newest = db
    .prepare("SELECT grader_version, judge_model FROM run_scores WHERE name = ? AND source = 'llm_judge' ORDER BY graded_at DESC, rowid DESC LIMIT 1")
    .get(judge) as { grader_version: string; judge_model: string | null } | undefined;
  if (!newest) return undefined;
  const judged = db
    .prepare("SELECT run_id, value, data_type FROM run_scores WHERE name = ? AND source = 'llm_judge' AND grader_version = ? AND judge_model IS ?")
    .all(judge, newest.grader_version, newest.judge_model) as Array<{ run_id: string; value: string; data_type: string }>;
  const labels = new Map(
    (db.prepare("SELECT run_id, value, data_type FROM run_scores WHERE name = ? AND source = 'human'").all(judge) as Array<{ run_id: string; value: string; data_type: string }>).map((r) => [r.run_id, r]),
  );
  const pairs: Array<{ runId: string; human: number | boolean | string; judge: number | boolean | string }> = [];
  for (const j of judged) {
    const human = labels.get(j.run_id);
    if (!human) continue;
    const humanValue = scoreValueOf(human.value, human.data_type);
    const judgeValue = scoreValueOf(j.value, j.data_type);
    if (humanValue !== undefined && judgeValue !== undefined) pairs.push({ runId: j.run_id, human: humanValue, judge: judgeValue });
  }
  return { graderVersion: newest.grader_version, model: newest.judge_model ?? "unknown", pairs };
}

export function setRunEvaluationStatus(runId: string, status: string, at: string): void {
  ensureDb();
  db.prepare(
    "INSERT INTO run_evaluations (run_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
  ).run(runId, status, at);
}

/* Null: the run was never graded. */
export function getRunEvaluationStatus(runId: string): string | null {
  ensureDb();
  const row = db.prepare("SELECT status FROM run_evaluations WHERE run_id = ?").get(runId) as { status: string } | undefined;
  return row?.status ?? null;
}

export function runExists(runId: string): boolean {
  ensureDb();
  return db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) !== undefined;
}

/* Ids of the runs that finished (status done) at or after `sinceIso`, oldest first. */
export function listFinishedRunIdsSince(sinceIso: string): string[] {
  ensureDb();
  const rows = db.prepare("SELECT id FROM runs WHERE status = 'done' AND datetime(at) >= datetime(?) ORDER BY at, rowid").all(sinceIso) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export interface RegradeJobRow {
  jobId: string;
  status: string;
  runIds: string[];
  graders: string[] | null;
  runs: number;
  graded: number;
  failed: Array<{ runId: string; error: string }>;
  startedAt: string;
  finishedAt: string | null;
}

export function saveRegradeJob(job: RegradeJobRow): void {
  ensureDb();
  db.prepare(`
    INSERT INTO regrade_jobs (job_id, status, run_ids, graders, runs, graded, failed, started_at, finished_at)
    VALUES (@jobId, @status, @runIds, @graders, @runs, @graded, @failed, @startedAt, @finishedAt)
    ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, graded = excluded.graded, failed = excluded.failed, finished_at = excluded.finished_at`)
    .run({ ...job, runIds: JSON.stringify(job.runIds), graders: job.graders ? JSON.stringify(job.graders) : null, failed: JSON.stringify(job.failed) });
}

export function getRegradeJob(jobId: string): RegradeJobRow | undefined {
  ensureDb();
  const r = db.prepare("SELECT * FROM regrade_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    jobId: r.job_id as string,
    status: r.status as string,
    runIds: safeJsonParse<string[]>(r.run_ids as string, []),
    graders: typeof r.graders === "string" ? safeJsonParse<string[] | null>(r.graders, null) : null,
    runs: r.runs as number,
    graded: r.graded as number,
    failed: safeJsonParse<Array<{ runId: string; error: string }>>(r.failed as string, []),
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

/* A job a previous process left pending or running will never finish: it ends failed, with the reason. Returns how many. */
export function failInterruptedRegradeJobs(at: string): number {
  ensureDb();
  return db
    .prepare("UPDATE regrade_jobs SET status = 'failed', finished_at = ?, failed = json_insert(failed, '$[#]', json_object('runId', '', 'error', 'process restarted while the job was open')) WHERE status IN ('pending', 'running')")
    .run(at).changes;
}

export function countRunSpans(): number {
  ensureDb();
  return (db.prepare("SELECT COUNT(*) AS n FROM run_spans").get() as { n: number }).n;
}

/* Rows one prune pass may delete, so a large backlog never holds the write lock for long. */
export const RUN_SPAN_PRUNE_CHUNK = 5000;

/* Drops up to `limit` ledger spans that started more than `days` before `nowMs`, and returns how many. A non-finite cutoff prunes nothing. */
export function pruneRunSpans(days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db
    .prepare(`DELETE FROM run_spans WHERE rowid IN (SELECT rowid FROM run_spans WHERE start_ns < ? ${keep.sql} LIMIT ?)`)
    .run(BigInt(Math.floor(cutoffMs)) * 1_000_000n, ...keep.params, limit).changes;
}

/* The rows of a campaign run younger than the campaign window are exempt from the ordinary window (R4). */
function campaignKeepClause(column: string, nowMs: number, campaignDays: number | undefined): { sql: string; params: string[] } {
  if (campaignDays === undefined || !Number.isFinite(nowMs - campaignDays * 86_400_000)) return { sql: "", params: [] };
  return {
    sql: `AND (${column} IS NULL OR ${column} NOT IN (SELECT id FROM runs WHERE campaign_id IS NOT NULL AND at >= ?))`,
    params: [new Date(nowMs - campaignDays * 86_400_000).toISOString()],
  };
}

export interface SpecSnapshotRow {
  runId: string;
  path: string;
  sha256: string;
  text: string;
  bytes: number;
  /* Epoch ms. */
  capturedAt: number;
  /* 1 when the run delivered the spec. */
  delivered: number;
}

/* Keeps the snapshots of a run's specs in ONE transaction. A row already kept (same run, path and bytes) is left as it is. */
export function commitSpecSnapshots(rows: readonly SpecSnapshotRow[]): void {
  ensureDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO run_spec_snapshots (run_id, path, sha256, text, bytes, captured_at, delivered)
    VALUES (@runId, @path, @sha256, @text, @bytes, @capturedAt, @delivered)`);
  db.transaction((batch: readonly SpecSnapshotRow[]) => {
    for (const row of batch) insert.run(row);
  })(rows);
}

export function listSpecSnapshots(runId: string): SpecSnapshotRow[] {
  ensureDb();
  const rows = db.prepare("SELECT * FROM run_spec_snapshots WHERE run_id = ? ORDER BY captured_at, path").all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: r.run_id as string,
    path: r.path as string,
    sha256: r.sha256 as string,
    text: r.text as string,
    bytes: r.bytes as number,
    capturedAt: r.captured_at as number,
    delivered: r.delivered as number,
  }));
}

/* Drops up to `limit` snapshots kept more than `days` before `nowMs`, and returns how many: the window of the span ledger. */
export function pruneSpecSnapshots(days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db
    .prepare(`DELETE FROM run_spec_snapshots WHERE rowid IN (SELECT rowid FROM run_spec_snapshots WHERE captured_at < ? ${keep.sql} LIMIT ?)`)
    .run(Math.floor(cutoffMs), ...keep.params, limit).changes;
}

/* Keeps a run's plan, replacing the one kept before: the plan recorded when its flows end carries their outcomes. `plan` is JSON. */
export function commitRunPlan(runId: string, plan: string, recordedAt: number): void {
  ensureDb();
  db.prepare("INSERT OR REPLACE INTO run_plans (run_id, plan, recorded_at) VALUES (?, ?, ?)").run(runId, plan, Math.floor(recordedAt));
}

/* The plan a run kept, as the JSON it was kept as, or undefined. */
export function getRunPlan(runId: string): string | undefined {
  ensureDb();
  const row = db.prepare("SELECT plan FROM run_plans WHERE run_id = ?").get(runId) as { plan: string } | undefined;
  return row?.plan;
}

/* Drops up to `limit` plans kept more than `days` before `nowMs`, and returns how many: the window of the spec snapshots. */
export function pruneRunPlans(days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db
    .prepare(`DELETE FROM run_plans WHERE rowid IN (SELECT rowid FROM run_plans WHERE recorded_at < ? ${keep.sql} LIMIT ?)`)
    .run(Math.floor(cutoffMs), ...keep.params, limit).changes;
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
    sameFileReadCount: turn.sameFileReadCount ?? null,
    duplicateCallCount: turn.duplicateCallCount ?? null,
    promptProvidedReadCount: turn.promptProvidedReadCount ?? null,
    pathProvidedReadCount: turn.pathProvidedReadCount ?? null,
    /* exhausted is tri-state: NULL = unknown, 0 = known not exhausted, 1 = exhausted. */
    exhausted: turn.exhausted == null ? null : turn.exhausted ? 1 : 0,
    callBuckets: turn.callBuckets ? JSON.stringify(turn.callBuckets) : null,
    ended: turn.ended ?? null,
    durationMs: turn.durationMs ?? null,
    timeToFirstCallMs: turn.timeToFirstCallMs ?? null,
    timeToFirstWriteMs: turn.timeToFirstWriteMs ?? null,
    deniedCallCount: turn.deniedCallCount ?? null,
    toolSequence: turn.toolSequence ? JSON.stringify(turn.toolSequence) : null,
    usageTotal: turn.usageTotal ? JSON.stringify(turn.usageTotal) : null,
    modelRequested: turn.modelRequested ?? null,
    modelAnswered: turn.modelAnswered ?? null,
    provider: turn.provider ?? null,
    attempt: turn.attempt ?? null,
    /* fallback_used is tri-state like exhausted: NULL = unknown. */
    fallbackUsed: turn.fallbackUsed == null ? null : turn.fallbackUsed ? 1 : 0,
    errorType: turn.errorType ?? null,
    sectionSizes: turn.sectionSizes ? JSON.stringify(turn.sectionSizes) : null,
    sectionHashes: turn.sectionHashes ? JSON.stringify(turn.sectionHashes) : null,
    promptHash: turn.promptHash ?? null,
    limitApplied: turn.limitApplied ?? null,
    limitFired: turn.limitFired ?? null,
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
    sameFileReadCount: t.callMetrics?.sameFileReadCount ?? null,
    duplicateCallCount: t.callMetrics?.duplicateCallCount ?? null,
    promptProvidedReadCount: t.callMetrics?.promptProvidedReadCount ?? null,
    pathProvidedReadCount: t.callMetrics?.pathProvidedReadCount ?? null,
    callBuckets: t.callMetrics?.buckets ?? null,
    ended: t.ended ?? null,
    durationMs: t.durationMs ?? null,
    timeToFirstCallMs: t.callMetrics?.timeToFirstCallMs ?? null,
    timeToFirstWriteMs: t.callMetrics?.timeToFirstWriteMs ?? null,
    deniedCallCount: t.callMetrics?.deniedCallCount ?? null,
    toolSequence: t.callMetrics?.toolSequence ?? null,
    usageTotal: t.callMetrics?.usage ?? null,
    modelRequested: t.modelRequested ?? null,
    modelAnswered: t.modelAnswered ?? null,
    provider: t.provider ?? null,
    attempt: t.attempt ?? null,
    fallbackUsed: t.fallbackUsed ?? null,
    errorType: t.errorType ?? null,
    sectionSizes: t.sectionSizes,
    sectionHashes: t.sectionHashes ?? null,
    promptHash: t.promptHash ?? null,
    limitApplied: t.limitApplied ?? null,
    limitFired: t.limitFired ?? null,
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
    sameFileReadCount: (r.same_file_read_count as number | null) ?? null,
    duplicateCallCount: (r.duplicate_call_count as number | null) ?? null,
    promptProvidedReadCount: (r.prompt_provided_read_count as number | null) ?? null,
    pathProvidedReadCount: (r.path_provided_read_count as number | null) ?? null,
    exhausted: r.exhausted == null ? null : Boolean(r.exhausted),
    callBuckets: typeof r.call_buckets === "string" ? safeJsonParse<Record<string, number> | null>(r.call_buckets, null) : null,
    ended: (r.ended as TurnEnd | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    timeToFirstCallMs: (r.time_to_first_call_ms as number | null) ?? null,
    timeToFirstWriteMs: (r.time_to_first_write_ms as number | null) ?? null,
    deniedCallCount: (r.denied_call_count as number | null) ?? null,
    toolSequence: typeof r.tool_sequence === "string" ? toolSequenceOrNull(safeJsonParse<unknown>(r.tool_sequence, null)) : null,
    usageTotal: typeof r.usage_total === "string" ? safeJsonParse<TurnUsage | null>(r.usage_total, null) : null,
  }));
}

/* What a turn's trace mirrors, in the order of `getAgentTurns` for the same run (the rows are the same, by id). Separate from the public turn view, which does not carry it. Every field is null for a turn that carried none of it. */
export interface AgentTurnTraceRecord {
  sessionId: string;
  round: number;
  modelRequested: string | null;
  modelAnswered: string | null;
  provider: string | null;
  attempt: number | null;
  fallbackUsed: boolean | null;
  errorType: string | null;
  sectionSizes: Record<string, number> | null;
  sectionHashes: Record<string, string> | null;
  promptHash: string | null;
  limitApplied: string | null;
  limitFired: string | null;
}

/* What each turn of a run says about the role that ran it: the model asked for and the one that answered, its provider and the step limit the prompt stated. In turn order. */
export interface AgentRoleFacts {
  role: string;
  provider: string | null;
  modelRequested: string | null;
  modelAnswered: string | null;
  maxSteps: number | null;
}

export function getAgentRoleFacts(runId: string): AgentRoleFacts[] {
  ensureDb();
  const rows = db.prepare("SELECT role, provider, model_requested, model_answered, max_steps FROM agent_turns WHERE run_id = ? ORDER BY id ASC").all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    role: r.role as string,
    provider: (r.provider as string | null) ?? null,
    modelRequested: (r.model_requested as string | null) ?? null,
    modelAnswered: (r.model_answered as string | null) ?? null,
    maxSteps: (r.max_steps as number | null) ?? null,
  }));
}

export function getAgentTurnTraces(runId: string): AgentTurnTraceRecord[] {
  ensureDb();
  const rows = getAgentTurnsStmt.all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sessionId: r.session_id as string,
    round: r.round as number,
    modelRequested: (r.model_requested as string | null) ?? null,
    modelAnswered: (r.model_answered as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    attempt: (r.attempt as number | null) ?? null,
    fallbackUsed: r.fallback_used == null ? null : Boolean(r.fallback_used),
    errorType: (r.error_type as string | null) ?? null,
    sectionSizes: typeof r.section_sizes === "string" ? safeJsonParse<Record<string, number> | null>(r.section_sizes, null) : null,
    sectionHashes: typeof r.section_hashes === "string" ? safeJsonParse<Record<string, string> | null>(r.section_hashes, null) : null,
    promptHash: (r.prompt_hash as string | null) ?? null,
    limitApplied: (r.limit_applied as string | null) ?? null,
    limitFired: (r.limit_fired as string | null) ?? null,
  }));
}

/* A stored sequence is only trusted as a list of entries; anything else reads as unknown. */
function toolSequenceOrNull(value: unknown): ToolSequenceEntry[] | null {
  return Array.isArray(value) ? (value as ToolSequenceEntry[]) : null;
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

/* The agent name that runs of an earlier version recorded their pre-generation turns under; no run records it any more. */
const RETIRED_EXPLORER_ROLE = "qa-explorer";

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

  /* The run-level figures below (turn counts, wall-clock, repair fraction) cover the generation and review turns; turns that runs of an earlier version recorded under the retired explorer role appear only in byRole and the efficiency view. */
  const runTurnRows = turnRows.filter((r) => r.role !== RETIRED_EXPLORER_ROLE);

  const runCount = new Set(runTurnRows.map((r) => r.run_id as string | null).filter(Boolean)).size;

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
  const repairCount = runTurnRows.filter((r) => r.is_repair).length;
  const repairFraction = runTurnRows.length > 0 ? repairCount / runTurnRows.length : null;

  /* Turns per run: group by run_id, count turns. */
  const turnsByRun = new Map<string, number>();
  for (const row of runTurnRows) {
    const rid = (row.run_id as string | null) ?? "__unknown__";
    turnsByRun.set(rid, (turnsByRun.get(rid) ?? 0) + 1);
  }
  const medianTurnsPerRun = median([...turnsByRun.values()]);

  /* Wall-clock per run: first/last ts per run_id → span in seconds. */
  const wallClocksByRun = new Map<string, { first: number; last: number }>();
  for (const row of runTurnRows) {
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

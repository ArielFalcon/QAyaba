import type Database from "better-sqlite3";
import type { Migration } from "./index";

/*
 * Schema 1: the history store's tables and indexes, written once. Every column a table carries is
 * declared in its CREATE TABLE; later schema changes are further files in this folder.
 */
export const SCHEMA_1_SQL = `
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
    cancelled INTEGER,
    campaign_id TEXT,
    campaign_variant TEXT,
    campaign_replicate INTEGER,
    capture_mode TEXT,
    effective_config TEXT,
    change_set TEXT
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
    judge_model TEXT,
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
  -- Mirrors the run_events 30-day retention. Token columns are nullable because a
  -- run may return no token info. output_text is sanitized before persist (sanitizer.ts).
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
    cost REAL,
    total_calls INTEGER,
    steps_used INTEGER,
    max_steps INTEGER,
    calls_before_first_write INTEGER,
    write_count INTEGER,
    redundant_read_count INTEGER,
    duplicate_call_count INTEGER,
    prompt_provided_read_count INTEGER,
    exhausted INTEGER,
    call_buckets TEXT,
    path_provided_read_count INTEGER,
    ended TEXT,
    duration_ms INTEGER,
    time_to_first_call_ms INTEGER,
    time_to_first_write_ms INTEGER,
    denied_call_count INTEGER,
    tool_sequence TEXT,
    usage_total TEXT,
    model_requested TEXT,
    model_answered TEXT,
    provider TEXT,
    attempt INTEGER,
    fallback_used INTEGER,
    error_type TEXT,
    section_sizes TEXT,
    section_hashes TEXT,
    prompt_hash TEXT,
    limit_applied TEXT,
    limit_fired TEXT,
    same_file_read_count INTEGER,
    graph_provided_read_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_turns_run_id ON agent_turns(run_id);
  CREATE INDEX IF NOT EXISTS idx_agent_turns_role ON agent_turns(role);

  CREATE INDEX IF NOT EXISTS idx_runs_trace_id ON runs(trace_id);
  CREATE INDEX IF NOT EXISTS idx_runs_campaign_id ON runs(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs(parent_run_id);
`;

export const migration0001: Migration = {
  version: 1,
  name: "0001-initial",
  up(db: Database.Database): void {
    db.exec(SCHEMA_1_SQL);
  },
};

/*
 * Persistent run history (SQLite via better-sqlite3). Survives process restarts so
 * the TUI/continue/chat can address past runs. Persisted to disk at HISTORY_DB_PATH
 * (a docker-compose volume in production — see the `qa-data` volume).
 * Initialization is LAZY: the database is opened (and migrated to the latest schema) on first
 * use, not at import time. This keeps a bare `import` side-effect-free — importing a
 * module that re-exports from here (e.g. the CLI) does not touch the filesystem until
 * a record is actually read or written.
 */

import Database from "better-sqlite3";
import { getHistoryDatabase } from "./persistence/index";
import { scoreValueOf } from "./persistence/score-value";
import { randomBytes } from "node:crypto";
import { RunRecord, RunMode, TestTarget, QaCase, RunVerdict, SpecRecord, RunOutcome, AgentActivity, type RunChangeEntry } from "../types";
import { applyOutcome as foldApplyOutcome } from "@contexts/cross-run-learning/application/index";
import { type LearningRule, type RuleUpsert, type Confidence, type RuleStatus } from "../qa/learning/learning-rule";
import type { ErrorClass } from "@kernel/error-class";
import type { Curriculum } from "../qa/learning/curriculum";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import { updateScorecard, type Scorecard, type ScorecardEntry } from "../qa/learning/oracle-types";
import { logJson } from "../integrations/logger";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import type { ArchitectureContext } from "@contexts/generation/application/index.ts";
import type { CampaignIdentity } from "../contract/campaign";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import { RUN_PHASES } from "@kernel/run-step";
import type { AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";
import type { TurnEnd } from "@kernel/turn-end";
import type { ToolSequenceEntry } from "@contexts/generation/application/index";
import type { TurnUsage } from "@contexts/generation/application/index";

const redactionPort = new RedactionPortAdapter();


export interface AgentTurnRecord {
  runId: string | null;        /* maps to RunRecord.id; null for turns with no parent run */
  sessionId: string;           /* OpenCode session id */
  role: string;                /* agent name (qa-author, qa-reviewer, …) */
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
  /* Content reads whose lines a code-graph answer earlier in the session had already shown; apart from the prompt's two counts. */
  graphProvidedReadCount?: number | null;
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
let insertAgentTurnStmt!: Database.Statement;
let getAgentTurnsStmt!: Database.Statement;
let initialized = false;

function ensureDb(): void {
  if (initialized) return;
  db = getHistoryDatabase().raw;

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
       section_sizes, section_hashes, prompt_hash, limit_applied, limit_fired, same_file_read_count, graph_provided_read_count)
    VALUES
      (@runId, @sessionId, @role, @round, @isRepair, @ts, @objective,
       @promptText, @outputText, @promptBytes,
       @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite, @cost,
       @totalCalls, @stepsUsed, @maxSteps, @callsBeforeFirstWrite, @writeCount,
       @redundantReadCount, @duplicateCallCount, @promptProvidedReadCount, @exhausted, @callBuckets,
       @pathProvidedReadCount, @ended,
       @durationMs, @timeToFirstCallMs, @timeToFirstWriteMs, @deniedCallCount, @toolSequence, @usageTotal,
       @modelRequested, @modelAnswered, @provider, @attempt, @fallbackUsed, @errorType,
       @sectionSizes, @sectionHashes, @promptHash, @limitApplied, @limitFired, @sameFileReadCount, @graphProvidedReadCount)
  `);
  getAgentTurnsStmt = db.prepare("SELECT * FROM agent_turns WHERE run_id = ? ORDER BY id ASC");

  initialized = true;
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
    ...(row.change_set ? { changeSet: JSON.parse(row.change_set as string) as RunChangeEntry[] } : {}),
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
  if (patch.changeSet !== undefined) add("change_set", JSON.stringify(patch.changeSet));
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

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

export function loadRunEvents(runId: string, afterSeq = -1): Array<{ runId: string; seq: number; ts: number; body: unknown }> {
  ensureDb();
  const rows = db
    .prepare("SELECT run_id, seq, ts, body FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
    .all(runId, afterSeq) as Array<{ run_id: string; seq: number; ts: number; body: string }>;
  return rows.map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, body: safeJsonParse(r.body, {}) }));
}

/*
 * Persist one agent turn. `output_text` MUST already be sanitized by the caller
 * (the redaction port, or `sanitizeText` of the pattern redaction adapter) — this function stores whatever it receives.
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
    graphProvidedReadCount: turn.graphProvidedReadCount ?? null,
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
 * so a new column can never drift between runtimes. `output_text` is already sanitized
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
    graphProvidedReadCount: t.callMetrics?.graphProvidedReadCount ?? null,
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
    graphProvidedReadCount: (r.graph_provided_read_count as number | null) ?? null,
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
export interface TelemetryRoleStat {
  role: string;
  medianPromptBytes: number | null;
  p95PromptBytes: number | null;
  medianCacheHitRate: number | null;  /* null when no token data available (no turns) */
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
      (r.role as string).includes("author") &&
      (r.round as number) === 0 &&
      !r.is_repair,
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

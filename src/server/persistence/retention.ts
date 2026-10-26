import { parseRetentionDays, parseCampaignRetentionDays, DEFAULT_SPAN_RETENTION_DAYS, DEFAULT_CAMPAIGN_RETENTION_DAYS } from "../../telemetry/config";
import { logJson } from "../../integrations/logger";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";
import type { HistoryDatabase } from "./database";

const redactionPort = new RedactionPortAdapter();
const DAY_MS = 24 * 60 * 60 * 1000;

/* Runs, their events and their agent turns are kept this long. */
export const DELETE_MAX_AGE_DAYS = 30;

/* Rows one prune pass may delete from the span ledger tables, so a large backlog never holds the write lock for long. */
export const RUN_SPAN_PRUNE_CHUNK = 5000;

export interface RetentionPolicy {
  /* How long a run, its events and its agent turns are kept. */
  runMaxAgeDays: number;
  /* Campaign-tagged runs are the baselines later graders and judges re-score: their records are kept this long instead. */
  campaignDays: number;
  /* The window of the span ledger, the spec snapshots and the run plans. */
  spanDays: number;
}

export interface PruneReport {
  table: string;
  deleted: number;
}

/*
 * The retention windows from the environment slice that names them. A malformed value is reported loudly and the default
 * stays in force: the telemetry bootstrap fails the process on it, and the history store must still open.
 */
export function retentionPolicyFrom(env: { QA_TELEMETRY_RETENTION_DAYS?: string; QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS?: string }): RetentionPolicy {
  return {
    runMaxAgeDays: DELETE_MAX_AGE_DAYS,
    campaignDays: windowOrDefault(() => parseCampaignRetentionDays(env.QA_TELEMETRY_CAMPAIGN_RETENTION_DAYS), DEFAULT_CAMPAIGN_RETENTION_DAYS),
    spanDays: windowOrDefault(() => parseRetentionDays(env.QA_TELEMETRY_RETENTION_DAYS), DEFAULT_SPAN_RETENTION_DAYS),
  };
}

function windowOrDefault(parse: () => number, fallback: number): number {
  try {
    return parse();
  } catch (error) {
    logJson("error", `[telemetry] ${redactionPort.redactError(error)}; keeping ${fallback} days`);
    return fallback;
  }
}

/* The rows of a campaign run younger than the campaign window are exempt from the ordinary window. */
function campaignKeepClause(column: string, nowMs: number, campaignDays: number | undefined): { sql: string; params: string[] } {
  if (campaignDays === undefined || !Number.isFinite(nowMs - campaignDays * DAY_MS)) return { sql: "", params: [] };
  return {
    sql: `AND (${column} IS NULL OR ${column} NOT IN (SELECT id FROM runs WHERE campaign_id IS NOT NULL AND at >= ?))`,
    params: [new Date(nowMs - campaignDays * DAY_MS).toISOString()],
  };
}

/* Drops up to `limit` ledger spans that started more than `days` before `nowMs`, and returns how many. A non-finite cutoff prunes nothing. */
export function pruneRunSpans(db: HistoryDatabase, days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * DAY_MS;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db.write((raw) =>
    raw
      .prepare(`DELETE FROM run_spans WHERE rowid IN (SELECT rowid FROM run_spans WHERE start_ns < ? ${keep.sql} LIMIT ?)`)
      .run(BigInt(Math.floor(cutoffMs)) * 1_000_000n, ...keep.params, limit).changes,
  );
}

/* Drops up to `limit` snapshots kept more than `days` before `nowMs`, and returns how many: the window of the span ledger. */
export function pruneSpecSnapshots(db: HistoryDatabase, days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * DAY_MS;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db.write((raw) =>
    raw
      .prepare(`DELETE FROM run_spec_snapshots WHERE rowid IN (SELECT rowid FROM run_spec_snapshots WHERE captured_at < ? ${keep.sql} LIMIT ?)`)
      .run(Math.floor(cutoffMs), ...keep.params, limit).changes,
  );
}

/* Drops up to `limit` plans kept more than `days` before `nowMs`, and returns how many: the window of the spec snapshots. */
export function pruneRunPlans(db: HistoryDatabase, days: number, nowMs: number, limit: number = RUN_SPAN_PRUNE_CHUNK, campaignDays?: number): number {
  const cutoffMs = nowMs - days * DAY_MS;
  if (!Number.isFinite(cutoffMs)) return 0;
  const keep = campaignKeepClause("run_id", nowMs, campaignDays);
  return db.write((raw) =>
    raw
      .prepare(`DELETE FROM run_plans WHERE rowid IN (SELECT rowid FROM run_plans WHERE recorded_at < ? ${keep.sql} LIMIT ?)`)
      .run(Math.floor(cutoffMs), ...keep.params, limit).changes,
  );
}

/*
 * Deletes what the policy no longer keeps, one transaction per table, and reports how many rows each table lost. Retention is a job the
 * caller runs: opening the database never prunes.
 */
export function pruneHistory(db: HistoryDatabase, policy: RetentionPolicy, nowMs: number): PruneReport[] {
  const nowSeconds = Math.floor(nowMs / 1000);
  const runs = db.write(
    (raw) =>
      raw
        .prepare(
          `DELETE FROM runs WHERE at < datetime(@now, 'unixepoch', '-' || @runDays || ' days') AND (campaign_id IS NULL OR datetime(at) < datetime(@now, 'unixepoch', '-' || @campaignDays || ' days'))`,
        )
        .run({ now: nowSeconds, runDays: policy.runMaxAgeDays, campaignDays: policy.campaignDays }).changes,
  );
  /* Durable event log: ts is epoch ms. */
  const events = db.write((raw) => raw.prepare("DELETE FROM run_events WHERE ts < ?").run(nowMs - policy.runMaxAgeDays * DAY_MS).changes);
  /*
   * agent_turns.ts is ISO-8601 (...T...Z) TEXT, but datetime('now', ...) yields the space-separated 'YYYY-MM-DD HH:MM:SS' form: a raw string
   * compare would mis-sort ('T' > ' ' at index 10, so nothing would prune). datetime(ts) puts both sides in SQLite's canonical form.
   */
  const turns = db.write(
    (raw) =>
      raw
        .prepare(
          `DELETE FROM agent_turns WHERE datetime(ts) < datetime(@now, 'unixepoch', '-' || @runDays || ' days')
             AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE campaign_id IS NOT NULL AND datetime(at) >= datetime(@now, 'unixepoch', '-' || @campaignDays || ' days')))`,
        )
        .run({ now: nowSeconds, runDays: policy.runMaxAgeDays, campaignDays: policy.campaignDays }).changes,
  );
  return [
    { table: "runs", deleted: runs },
    { table: "run_events", deleted: events },
    { table: "agent_turns", deleted: turns },
    { table: "run_spans", deleted: pruneRunSpans(db, policy.spanDays, nowMs, RUN_SPAN_PRUNE_CHUNK, policy.campaignDays) },
    { table: "run_spec_snapshots", deleted: pruneSpecSnapshots(db, policy.spanDays, nowMs, RUN_SPAN_PRUNE_CHUNK, policy.campaignDays) },
    { table: "run_plans", deleted: pruneRunPlans(db, policy.spanDays, nowMs, RUN_SPAN_PRUNE_CHUNK, policy.campaignDays) },
  ];
}

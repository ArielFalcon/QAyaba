import { randomBytes } from "node:crypto";
import { RUN_PHASES } from "@kernel/run-step";
import type { CaptureMode } from "@kernel/telemetry/capture-mode";
import type { CampaignIdentity } from "../../../contract/campaign";
import { logJson } from "../../../integrations/logger";
import { RedactionPortAdapter } from "../../../orchestrator/sanitizer";
import type { AgentActivity, QaCase, RunChangeEntry, RunMode, RunRecord, RunVerdict, SpecRecord, TestTarget } from "../../../types";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";

const redactionPort = new RedactionPortAdapter();

/* What a run recorded about its phases. Kept off RunRecord, which is the API's shape. */
export interface RunPhases {
  furthestPhase: string | null;
  phaseTimings: Record<string, number> | null;
}

export interface CampaignRunRecord {
  id: string;
  variant: Record<string, string>;
  replicate: number;
  status: string;
  verdict: string | null;
  evaluationStatus: string | null;
}

export interface RunFunnelRow {
  furthestPhase: string | null;
  verdict: string | null;
  errorClass: string | null;
  count: number;
}

/* A run's phase record as updateRecord takes it: written in the same statement as the status it accompanies. */
export interface RunPhasesPatch {
  furthestPhase: string;
  /* Already known to serialize; see serializablePhases. */
  phaseTimings: Record<string, number>;
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

export const MAX_CONTINUATION_DEPTH = 5;

const ACTIVITY_CAP = 200;

/* The phases as they can be stored, or undefined (said in the log) when they cannot: a phase record never costs a run its final status. */
export function serializablePhases(phases: RunPhasesPatch | undefined): RunPhasesPatch | undefined {
  if (!phases) return undefined;
  try {
    JSON.stringify(phases.phaseTimings);
    return phases;
  } catch (err) {
    logJson("error", `[qa] the phase record of a run could not be stored and is dropped: ${redactionPort.redactError(err)}`);
    return undefined;
  }
}

/*
 * SQLite returns an absent optional TEXT column as NULL, but the wire entities (QaCase / SpecRecord) and their zod contracts type these
 * fields as `field?: string` (undefined, NOT nullable). A NULL objective/flow therefore fails contract validation on the API response.
 * Normalize NULL -> undefined at the read boundary so an un-supplied field is simply omitted on the wire.
 */
function nullsToUndefined<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = row[k] === null ? undefined : row[k];
  return out as T;
}

/* Runs and everything that hangs off one: cases, specs, the activity feed, the durable event log, plans and spec snapshots. */
export class RunRepository {
  private readonly insertRun;
  private readonly getRunRow;
  private readonly listRunRows;
  private readonly childRows;
  private readonly currentRunRow;
  private readonly interruptedRows;
  private readonly deleteCaseByName;
  private readonly insertCase;
  private readonly casesOfRun;
  private readonly countCases;
  private readonly specsOfRun;
  private readonly appendLogText;
  private readonly insertActivity;
  private readonly activityOfRun;
  private readonly capActivity;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.insertRun = raw.prepare(`
      INSERT INTO runs (id, app, sha, ref, target, mode, status, step, step_detail, verdict, passed, failed, note, retrying, parent_run_id, trigger_repo, at, logs, campaign_id, campaign_variant, campaign_replicate, capture_mode)
      VALUES (@id, @app, @sha, @ref, @target, @mode, @status, @step, @stepDetail, @verdict, @passed, @failed, @note, @retrying, @parentRunId, @triggerRepo, @at, @logs, @campaignId, @campaignVariant, @campaignReplicate, @captureMode)
    `);
    this.getRunRow = raw.prepare("SELECT * FROM runs WHERE id = ?");
    this.listRunRows = raw.prepare("SELECT * FROM runs WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
    this.childRows = raw.prepare("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY at DESC, rowid DESC");
    this.currentRunRow = raw.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued') ORDER BY (status='running') DESC, at ASC, rowid ASC LIMIT 1");
    this.interruptedRows = raw.prepare("SELECT * FROM runs WHERE status IN ('running', 'enqueued')");
    this.deleteCaseByName = raw.prepare("DELETE FROM cases WHERE run_id = ? AND name = ?");
    this.insertCase = raw.prepare("INSERT INTO cases (run_id, name, status, detail, file) VALUES (@runId, @name, @status, @detail, @file)");
    this.casesOfRun = raw.prepare("SELECT * FROM cases WHERE run_id = ?");
    this.countCases = raw.prepare("SELECT status, COUNT(*) AS cnt FROM cases WHERE run_id = ? GROUP BY status");
    this.specsOfRun = raw.prepare("SELECT * FROM specs WHERE run_id = ?");
    this.appendLogText = raw.prepare("UPDATE runs SET logs = logs || @log WHERE id = @id");
    this.insertActivity = raw.prepare("INSERT INTO run_activity (run_id, ts, kind, status, text) VALUES (@runId, @ts, @kind, @status, @text)");
    this.activityOfRun = raw.prepare("SELECT kind, status, text, ts FROM run_activity WHERE run_id = ? ORDER BY id ASC");
    this.capActivity = raw.prepare(
      "DELETE FROM run_activity WHERE run_id = @id AND id NOT IN (SELECT id FROM run_activity WHERE run_id = @id ORDER BY id DESC LIMIT @keep)",
    );
  }

  private recalcCounts(runId: string): { passed: number; failed: number } {
    const rows = this.countCases.all(runId) as Array<{ status: string; cnt: number }>;
    let passed = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === "pass") passed += row.cnt;
      else if (row.status === "fail") failed += row.cnt;
    }
    return { passed, failed };
  }

  private rowToRecord(row: Record<string, unknown>): RunRecord {
    const runId = row.id as string;
    const cases = (this.casesOfRun.all(runId) as Record<string, unknown>[]).map(nullsToUndefined) as unknown as QaCase[];
    const specRows = (this.specsOfRun.all(runId) as Record<string, unknown>[]).map(nullsToUndefined) as unknown as SpecRecord[];
    const logsText = (row.logs as string) || "";
    const activityRows = this.activityOfRun.all(runId) as Array<{ kind: string; status: string | null; text: string; ts: string }>;

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
      ...(row.change_set ? { changeSet: parseJsonColumn<RunChangeEntry[]>(row.change_set as string, [], { table: "runs", column: "change_set", id: runId }) } : {}),
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

  createRecord(opts: {
    app: string; sha: string; ref?: string; target: TestTarget; mode: RunMode; parentRunId?: string; triggerRepo?: string;
    /* The campaign replicate this run is, and the content capture its trace was granted (already capped by the server). */
    campaign?: CampaignIdentity; captureMode?: CaptureMode;
  }): RunRecord {
    const id = `run-${opts.sha.slice(0, 7)}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const at = new Date().toISOString();

    this.db.write(() =>
      this.insertRun.run({
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
      }),
    );

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

  /* Stores where a run got and how long each phase took. Called once, when the run is finalized. */
  recordRunPhases(id: string, phases: { furthestPhase: string; phaseTimings: Record<string, number> }): void {
    this.db.write(() => this.db.statement("UPDATE runs SET furthest_phase = ?, phase_timings = ? WHERE id = ?").run(phases.furthestPhase, JSON.stringify(phases.phaseTimings), id));
  }

  getRunPhases(id: string): RunPhases | undefined {
    const row = this.db.statement("SELECT furthest_phase, phase_timings FROM runs WHERE id = ?").get(id) as { furthest_phase: string | null; phase_timings: string | null } | undefined;
    if (!row) return undefined;
    return {
      furthestPhase: row.furthest_phase,
      phaseTimings: row.phase_timings === null ? null : parseJsonColumn<Record<string, number> | null>(row.phase_timings, null, { table: "runs", column: "phase_timings", id }),
    };
  }

  /* The run whose trace has this id; the join from a Langfuse score back to the run store. Undefined for an unknown trace. */
  getRunIdByTraceId(traceId: string): string | undefined {
    return (this.db.statement("SELECT id FROM runs WHERE trace_id = ? LIMIT 1").get(traceId) as { id: string } | undefined)?.id;
  }

  /* What a run recorded about how it ended, beyond its verdict. Undefined: no such run. */
  getRunFacts(id: string): Required<RunFactsPatch> | undefined {
    const row = this.db.statement(`SELECT ${FACT_COLUMNS.map(([, c]) => c).join(", ")} FROM runs WHERE id = ?`).get(id) as Record<string, string | number | null> | undefined;
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
  getRunCampaign(id: string): CampaignIdentity | undefined {
    const row = this.db.statement("SELECT campaign_id, campaign_variant, campaign_replicate FROM runs WHERE id = ?").get(id) as { campaign_id: string | null; campaign_variant: string | null; campaign_replicate: number | null } | undefined;
    if (!row || row.campaign_id === null) return undefined;
    return { id: row.campaign_id, variant: parseJsonColumn<Record<string, string>>(row.campaign_variant ?? "{}", {}, { table: "runs", column: "campaign_variant", id }), replicate: row.campaign_replicate ?? 1 };
  }

  /* The capture mode the campaign's runs were granted (they all share one), or undefined when it has no run yet. */
  getCampaignCaptureMode(campaignId: string): string | undefined {
    return (this.db.statement("SELECT capture_mode FROM runs WHERE campaign_id = ? AND capture_mode IS NOT NULL ORDER BY at ASC, rowid ASC LIMIT 1").get(campaignId) as { capture_mode: string } | undefined)?.capture_mode;
  }

  /* Every run of a campaign, oldest first, with its grading status (null: never graded). */
  listCampaignRuns(campaignId: string): CampaignRunRecord[] {
    const rows = this.db
      .statement(
        `SELECT r.id, r.campaign_variant, r.campaign_replicate, r.status, r.verdict, e.status AS evaluation_status
         FROM runs r LEFT JOIN run_evaluations e ON e.run_id = r.id
         WHERE r.campaign_id = ? ORDER BY r.at ASC, r.rowid ASC`,
      )
      .all(campaignId) as Array<{ id: string; campaign_variant: string | null; campaign_replicate: number | null; status: string; verdict: string | null; evaluation_status: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      variant: parseJsonColumn<Record<string, string>>(r.campaign_variant ?? "{}", {}, { table: "runs", column: "campaign_variant", id: r.id }),
      replicate: r.campaign_replicate ?? 1,
      status: r.status,
      verdict: r.verdict,
      evaluationStatus: r.evaluation_status,
    }));
  }

  /* The finished runs of a campaign (a regrade covers only runs that are over). One more than `limit` is returned at most, so the caller can tell it was exceeded. */
  listFinishedCampaignRunIds(campaignId: string, limit: number): string[] {
    return (this.db.statement("SELECT id FROM runs WHERE campaign_id = ? AND status = 'done' ORDER BY at ASC, rowid ASC LIMIT ?").all(campaignId, limit + 1) as Array<{ id: string }>).map((r) => r.id);
  }

  /* What the run recorded about the configuration it ran with at run time (JSON text). */
  recordEffectiveConfig(id: string, json: string): void {
    this.db.write(() => this.db.statement("UPDATE runs SET effective_config = ? WHERE id = ?").run(json, id));
  }

  /* The configuration a run recorded (undefined: no such run; json null: none recorded) and the capture mode it applied. */
  getStoredEffectiveConfig(id: string): { json: string | null; captureMode: string | null } | undefined {
    const row = this.db.statement("SELECT effective_config, capture_mode FROM runs WHERE id = ?").get(id) as { effective_config: string | null; capture_mode: string | null } | undefined;
    return row ? { json: row.effective_config, captureMode: row.capture_mode } : undefined;
  }

  /*
   * How many finished runs ended where: grouped by the phase they got furthest into, their verdict and their error class (from the
   * run's outcome row, null when it has none). A run that recorded no phase groups under null. Earliest phase first. Read-only.
   */
  getRunFunnel(opts: { app?: string; since?: string } = {}): RunFunnelRow[] {
    const where = ["r.status = 'done'"];
    const params: string[] = [];
    if (opts.app !== undefined) { where.push("r.app = ?"); params.push(opts.app); }
    if (opts.since !== undefined) { where.push("datetime(r.at) >= datetime(?)"); params.push(opts.since); }
    const rows = this.db.statement(
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

  getRecord(id: string): RunRecord | undefined {
    const row = this.getRunRow.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  listRecords(app: string, limit = 10): RunRecord[] {
    return (this.listRunRows.all(app, limit) as Record<string, unknown>[]).map((row) => this.rowToRecord(row));
  }

  /* The runs that name `parentRunId` as their parent (a context heal, a /continue), newest first. Empty for a leaf run. */
  childrenOf(parentRunId: string): RunRecord[] {
    return (this.childRows.all(parentRunId) as Record<string, unknown>[]).map((row) => this.rowToRecord(row));
  }

  currentRun(): RunRecord | undefined {
    const row = this.currentRunRow.get() as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  updateRecord(id: string, patch: RunRecordPatch): void {
    this.db.write(() => {
      const setClauses: string[] = [];
      const params: Array<unknown> = [];

      const add = (col: string, val: unknown) => {
        setClauses.push(`${col} = ?`);
        params.push(val);
      };

      if (patch.status !== undefined) add("status", patch.status);
      if (patch.step !== undefined) {
        add("step", patch.step);

        const cur = (this.db.statement("SELECT step FROM runs WHERE id = ?").get(id) as { step?: string } | undefined)?.step;
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
        this.db.statement(`UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
      }

      if (patch.specs) {
        this.db.statement("DELETE FROM specs WHERE run_id = ?").run(id);
        const insertSpec = this.db.statement("INSERT INTO specs (run_id, name, objective, flow) VALUES (?, ?, ?, ?)");
        /*
         * De-dup by spec FILE name: a list built per-test (a 3-test file appearing 3x) must not report "5 specs" for 2 files:
         * the run record and the value report count spec FILES, not test cases.
         */
        const seenSpec = new Set<string>();
        for (const s of patch.specs) {
          if (seenSpec.has(s.name)) continue;
          seenSpec.add(s.name);
          insertSpec.run(id, s.name, s.objective ?? null, s.flow ?? null);
        }
      }
    });
  }

  addCase(id: string, c: QaCase): void {
    this.db.write(() => {
      this.deleteCaseByName.run(id, c.name);
      this.insertCase.run({ runId: id, name: c.name, status: c.status, detail: c.detail ?? null, file: c.file ?? null });
      const { passed, failed } = this.recalcCounts(id);
      this.db.statement("UPDATE runs SET passed = ?, failed = ? WHERE id = ?").run(passed, failed, id);
    });
  }

  appendLog(id: string, msg: string): void {
    this.db.write(() => this.appendLogText.run({ id, log: msg + "\n" }));
  }

  /* Appends one structured activity event to a run's live feed and caps the feed to the last ACTIVITY_CAP rows (advisory only; never gates a verdict). */
  appendActivity(id: string, a: { kind: AgentActivity["kind"]; text: string; status?: AgentActivity["status"] }): void {
    this.db.write(() => {
      this.insertActivity.run({ runId: id, ts: new Date().toISOString(), kind: a.kind, status: a.status ?? null, text: a.text });
      this.capActivity.run({ id, keep: ACTIVITY_CAP });
    });
  }

  interruptedRecords(): RunRecord[] {
    return (this.interruptedRows.all() as Record<string, unknown>[]).map((row) => this.rowToRecord(row));
  }

  clearDatabase(): void {
    this.db.write((raw) => raw.exec("DELETE FROM specs; DELETE FROM cases; DELETE FROM runs;"));
  }

  /* Removes an app's runs (cases, specs and activity cascade through the schema) and returns how many run rows were removed. */
  deleteApp(app: string): number {
    return this.db.write(() => this.db.statement("DELETE FROM runs WHERE app = ?").run(app).changes);
  }

  continuationDepth(record: RunRecord): number {
    let depth = 0;
    let current: RunRecord | undefined = record;
    while (current?.parentRunId) {
      depth++;
      current = this.getRecord(current.parentRunId);
    }
    return depth;
  }

  /*
   * Completed-run counts grouped by verdict: the backing data for the Prometheus runs_total counter. Lets an operator alert on a
   * fail/invalid/infra-error rate shift, which the two instantaneous gauges (queue depth, open sessions) cannot express.
   */
  runVerdictCounts(): Record<string, number> {
    const rows = this.db.statement("SELECT verdict, COUNT(*) AS cnt FROM runs WHERE status = 'done' AND verdict IS NOT NULL GROUP BY verdict").all() as Array<{ verdict: string; cnt: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.verdict] = r.cnt;
    return out;
  }

  /* Durable RunEvent persistence. INSERT OR IGNORE keeps it idempotent if the in-memory store and a re-publish ever collide on (run_id, seq). */
  saveRunEvent(event: { runId: string; seq: number; ts: number; body: unknown }): void {
    this.db.write(() => this.db.statement("INSERT OR IGNORE INTO run_events (run_id, seq, ts, body) VALUES (?, ?, ?, ?)").run(event.runId, event.seq, event.ts, JSON.stringify(event.body)));
  }

  loadRunEvents(runId: string, afterSeq = -1): Array<{ runId: string; seq: number; ts: number; body: unknown }> {
    const rows = this.db.statement("SELECT run_id, seq, ts, body FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, afterSeq) as Array<{ run_id: string; seq: number; ts: number; body: string }>;
    return rows.map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, body: parseJsonColumn(r.body, {}, { table: "run_events", column: "body", id: `${r.run_id}#${r.seq}` }) }));
  }

  runExists(runId: string): boolean {
    return this.db.statement("SELECT 1 FROM runs WHERE id = ?").get(runId) !== undefined;
  }

  /* Ids of the runs that finished (status done) at or after `sinceIso`, oldest first. */
  listFinishedRunIdsSince(sinceIso: string): string[] {
    const rows = this.db.statement("SELECT id FROM runs WHERE status = 'done' AND datetime(at) >= datetime(?) ORDER BY at, rowid").all(sinceIso) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /* Keeps the snapshots of a run's specs in ONE transaction. A row already kept (same run, path and bytes) is left as it is. */
  commitSpecSnapshots(rows: readonly SpecSnapshotRow[]): void {
    const insert = this.db.statement(`
      INSERT OR IGNORE INTO run_spec_snapshots (run_id, path, sha256, text, bytes, captured_at, delivered)
      VALUES (@runId, @path, @sha256, @text, @bytes, @capturedAt, @delivered)`);
    this.db.write(() => {
      for (const row of rows) insert.run(row);
    });
  }

  listSpecSnapshots(runId: string): SpecSnapshotRow[] {
    const rows = this.db.statement("SELECT * FROM run_spec_snapshots WHERE run_id = ? ORDER BY captured_at, path").all(runId) as Array<Record<string, unknown>>;
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
  commitRunPlan(runId: string, plan: string, recordedAt: number): void {
    this.db.write(() => this.db.statement("INSERT OR REPLACE INTO run_plans (run_id, plan, recorded_at) VALUES (?, ?, ?)").run(runId, plan, Math.floor(recordedAt)));
  }

  /* The plan a run kept, as the JSON it was kept as, or undefined. */
  getRunPlan(runId: string): string | undefined {
    return (this.db.statement("SELECT plan FROM run_plans WHERE run_id = ?").get(runId) as { plan: string } | undefined)?.plan;
  }
}

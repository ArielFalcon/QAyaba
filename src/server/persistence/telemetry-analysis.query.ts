import type { HistoryDatabase } from "./database";

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

export function computeTelemetryAnalysis(history: HistoryDatabase, app: string, windowDays?: number): TelemetryAnalysis {
  const db = history.raw;

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

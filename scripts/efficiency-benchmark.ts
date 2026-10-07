/*
 * Reproducible agent-efficiency benchmark. A case names a real
 * commit of a real watched app — USER DATA (CLAUDE.md: "App-specificity
 * lives only in config/"), never engine code — so cases load from
 * config/benchmarks/efficiency-cases.json (gitignored), mirroring
 * coordination-benchmark.ts's own convention.
 * config/benchmarks/efficiency-cases.example.json ships tracked.
 *
 * Commands (run inside the orchestrator container, where the service and its history live):
 *   run <label>                          submit every case, one at a time, through the service's queue
 *   register <label> <case> <runId>      attach an already-finished run to a case of the label
 *   snapshot <label>                     freeze the label's runs into config/benchmarks/efficiency-results/<label>.snapshot.json
 *   report <A> <B>                       compare two labels' snapshots
 *
 * Telemetry only: nothing here gates a run, changes a verdict or alters an exit status. A figure a
 * run did not record is unknown (null, shown n/a), never a zero, and unknown figures stay out of
 * every aggregate. The operator procedure is docs/efficiency-benchmark.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { RunEventBody } from "@kernel/contract/events.ts";
import { QueueStatusSchema } from "@kernel/contract/commands.ts";
import { classifyRunEfficiency, type CoarseRunEfficiency } from "@contexts/generation/domain/coarse-run-efficiency.ts";
import { DIFF_TIER_NAMES, type DiffTier } from "@contexts/generation/domain/diff-stat.ts";
import { CALL_BUCKETS } from "@contexts/generation/domain/tool-call-taxonomy.ts";
import { delegateRun } from "../src/server/run-delegate.ts";
import { PLANNER_OBJECTIVE, type RunOutcome, type RunRecord } from "../src/types.ts";
import type { AgentTurnRecord } from "../src/server/history.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultEfficiencyBenchmarkCasesPath(): string {
  return join(ROOT, "config", "benchmarks", "efficiency-cases.json");
}

/** Per-label registries and snapshots live here (gitignored): they hold run ids and numbers only. */
export function defaultEfficiencyResultsDir(): string {
  return join(ROOT, "config", "benchmarks", "efficiency-results");
}

/** Shaped like the CLI's own run arguments. */
export interface EfficiencyBenchmarkCase {
  readonly name: string;
  readonly app: string;
  readonly sha: string;
  readonly baseSha?: string;
  readonly mode?: RunMode;
  readonly target?: TestTarget;
  readonly guidance?: string;
  /** The size class the operator declares for the case's diff (see `DIFF_TIERS`). The benchmark never checks it against the real diff and never sends it to the service: it only groups the report. */
  readonly tier?: DiffTier;
}

/* The same commit-id rule the service applies to a run's sha and baseSha. */
const HEX_COMMIT_ID = /^[0-9a-f]{7,40}$/i;

const RUN_MODES: ReadonlySet<string> = new Set<RunMode>(["diff", "complete", "exhaustive", "manual", "context"]);
const TEST_TARGETS: ReadonlySet<string> = new Set<TestTarget>(["e2e", "code"]);
const SIZE_CLASSES: ReadonlySet<string> = new Set<string>(DIFF_TIER_NAMES);

function isDiffTier(value: unknown): value is DiffTier {
  return typeof value === "string" && SIZE_CLASSES.has(value);
}

function isEfficiencyBenchmarkCase(raw: unknown): raw is EfficiencyBenchmarkCase {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Partial<EfficiencyBenchmarkCase>;
  if (typeof c.name !== "string" || c.name.length === 0) return false;
  if (typeof c.app !== "string" || c.app.length === 0) return false;
  if (typeof c.sha !== "string" || c.sha.length === 0) return false;
  if (c.baseSha !== undefined && typeof c.baseSha !== "string") return false;
  if (c.mode !== undefined && !RUN_MODES.has(c.mode)) return false;
  if (c.target !== undefined && !TEST_TARGETS.has(c.target)) return false;
  if (c.guidance !== undefined && typeof c.guidance !== "string") return false;
  if (c.tier !== undefined && typeof c.tier !== "string") return false;
  return true;
}

/**
 * Loads and form-validates the benchmark case set from a JSON file (defaults
 * to the gitignored config/benchmarks/efficiency-cases.json). Throws loudly
 * — a malformed or missing case file is a setup error the caller should see,
 * never a silent empty benchmark (spec: "Malformed case file fails loudly").
 */
export function loadEfficiencyBenchmarkCases(
  path: string = defaultEfficiencyBenchmarkCasesPath(),
): readonly EfficiencyBenchmarkCase[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `efficiency benchmark cases not found at ${path} — copy config/benchmarks/efficiency-cases.example.json to config/benchmarks/efficiency-cases.json and fill in real cases (app/sha/name) to run the benchmark: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isEfficiencyBenchmarkCase)) {
    throw new Error(
      `${path} must be a JSON array of EfficiencyBenchmarkCase objects (name/app/sha required; baseSha/mode/target/guidance/tier optional)`,
    );
  }
  const seen = new Set<string>();
  for (const c of parsed) {
    if (seen.has(c.name)) throw new Error(`${path} has a duplicate case name '${c.name}' — results are keyed by case name`);
    seen.add(c.name);
    if (!HEX_COMMIT_ID.test(c.sha)) throw new Error(`${path}: case '${c.name}' has an invalid sha ${JSON.stringify(c.sha)} — it must be 7–40 hex characters`);
    /* An empty baseSha is no range, as the service reads it. */
    if (c.baseSha !== undefined && c.baseSha !== "" && !HEX_COMMIT_ID.test(c.baseSha)) {
      throw new Error(`${path}: case '${c.name}' has an invalid baseSha ${JSON.stringify(c.baseSha)} — it must be 7–40 hex characters`);
    }
    /* A mistyped tier must stop the benchmark: read as undeclared it would silently drop the case from every tier-grouped comparison. */
    if (c.tier !== undefined && !isDiffTier(c.tier)) {
      throw new Error(`${path}: case '${c.name}' has an invalid tier ${JSON.stringify(c.tier)} — it must be one of ${DIFF_TIER_NAMES.join(", ")}`);
    }
  }
  return parsed;
}

/** The tier each case of a cases file declares; nothing is declared when the file does not exist (runs registered by hand name cases it never had). A file that exists but is malformed throws, as it does for `run`. */
function declaredTiersOf(casesPath: string): ReadonlyMap<string, DiffTier> {
  if (!existsSync(casesPath)) return new Map();
  const declared = new Map<string, DiffTier>();
  for (const c of loadEfficiencyBenchmarkCases(casesPath)) if (c.tier !== undefined) declared.set(c.name, c.tier);
  return declared;
}

/* ── labels and their run registry ─────────────────────────────────────────────────── */

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A label names files, so it must not be able to escape the results directory. */
export function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`invalid label '${label}' — use letters, digits, '.', '_' or '-' (starting with a letter or digit)`);
  }
}

const registryFile = (resultsDir: string, label: string): string => join(resultsDir, `${label}.runs.json`);

/** Publishes the content by renaming a finished temporary file over the target, so a crash never leaves a half-written file where a good one was. */
function writeFileAtomically(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/** case name → run id, for a label. Empty when nothing was registered yet; a corrupt file throws. */
export function readRegistry(resultsDir: string, label: string): Record<string, string> {
  assertLabel(label);
  const path = registryFile(resultsDir, label);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === "string")) {
    throw new Error(`${path} is not a case-name → run-id map`);
  }
  return parsed as Record<string, string>;
}

/** Attaches a run to a case of the label (a later registration for the same case replaces the earlier one). */
export function registerRun(resultsDir: string, label: string, caseName: string, runId: string): void {
  const registry = readRegistry(resultsDir, label);
  registry[caseName] = runId;
  mkdirSync(resultsDir, { recursive: true });
  writeFileAtomically(registryFile(resultsDir, label), `${JSON.stringify(registry, null, 2)}\n`);
}

/* ── run ───────────────────────────────────────────────────────────────────────────── */

export interface BenchmarkService {
  fetch: typeof fetch;
  baseUrl: string;
  token?: string;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface RunBenchmarkOptions {
  casesPath?: string;
  resultsDir?: string;
  service: BenchmarkService;
  log?: (line: string) => void;
}

export interface RunBenchmarkResult {
  completed: Array<{ caseName: string; runId: string; verdict: string | null }>;
  /** Set when the benchmark stopped early; no later case was submitted. */
  stopped?: { caseName: string; runId: string; reason: "timeout" };
}

/* A benchmark must be the only work against DEV: the service's queue is the one sequential queue, so a
   busy one means someone else's run would share the interval a case is measured over. The queue's
   `pending` counts the running job too, so an idle queue is exactly one with nothing running and nothing pending. */
async function assertQueueIdle(service: BenchmarkService): Promise<void> {
  const headers: Record<string, string> = service.token ? { Authorization: `Bearer ${service.token}` } : {};
  const res = await service.fetch(`${service.baseUrl}/api/v1/queue`, { headers });
  if (!res.ok) throw new Error(`could not read the service's queue (HTTP ${res.status})`);
  const queue = QueueStatusSchema.parse(await res.json());
  if (!queue.running && queue.pending === 0) return;
  const running = queue.running ? `run ${queue.running.id} (${queue.running.app}) is running` : "no run is running";
  throw new Error(`the queue is busy (${running}, ${queue.pending} pending) — a benchmark must be the only work against DEV; wait for it to drain`);
}

/**
 * Submits every case through the service's sequential queue, one at a time, each waiting for a
 * terminal status before the next starts, and remembers each run id under the label. A case that
 * outlives the timeout stops the benchmark (its run id is kept; nothing later is submitted).
 */
export async function runBenchmark(label: string, opts: RunBenchmarkOptions): Promise<RunBenchmarkResult> {
  assertLabel(label);
  const cases = loadEfficiencyBenchmarkCases(opts.casesPath);
  const resultsDir = opts.resultsDir ?? defaultEfficiencyResultsDir();
  const log = opts.log ?? (() => {});

  const completed: RunBenchmarkResult["completed"] = [];
  for (const c of cases) {
    await assertQueueIdle(opts.service);
    log(`[bench] ${label}: running case '${c.name}' (${c.app} @ ${c.sha}${c.baseSha ? ` from ${c.baseSha}` : ""})`);
    const result = await delegateRun(
      {
        app: c.app,
        sha: c.sha,
        ...(c.baseSha ? { baseSha: c.baseSha } : {}),
        ...(c.target ? { target: c.target } : {}),
        mode: c.mode ?? "diff",
        ...(c.guidance ? { guidance: c.guidance } : {}),
      },
      {
        fetch: opts.service.fetch,
        baseUrl: opts.service.baseUrl,
        ...(opts.service.token ? { token: opts.service.token } : {}),
        ...(opts.service.pollMs !== undefined ? { pollMs: opts.service.pollMs } : {}),
        ...(opts.service.timeoutMs !== undefined ? { timeoutMs: opts.service.timeoutMs } : {}),
        ...(opts.service.now ? { now: opts.service.now } : {}),
        onEnqueued: (id) => registerRun(resultsDir, label, c.name, id),
      },
    );
    if (result.timedOut) {
      log(`[bench] ${label}: case '${c.name}' (run ${result.id}) did not finish in time — stopping`);
      return { completed, stopped: { caseName: c.name, runId: result.id, reason: "timeout" } };
    }
    log(`[bench] ${label}: case '${c.name}' finished (run ${result.id}, verdict ${result.verdict ?? "?"})`);
    completed.push({ caseName: c.name, runId: result.id, verdict: result.verdict });
  }
  return { completed };
}

/* ── snapshot ──────────────────────────────────────────────────────────────────────── */

export interface CaseGuardrails {
  verdict: string | null;
  specsProduced: number | null;
  /** The static gate (gateSignals.static). */
  staticPass: boolean | null;
  /** Passed > 0 and failed = 0; null when nothing was executed. */
  executePass: boolean | null;
  /** Null means unknown (never measured, or not measurable for the run). */
  coverageRatio: number | null;
  reviewerApproved: boolean | null;
  /** The error class the run ended with; null when it had none. A run that ended before the class was recorded reads as unknown in the report. */
  errorClass: string | null;
  /* The gate signals the run recorded (`RunOutcome.gateSignals`). Each is null when that signal never ran for the run: an absent count is unknown, never a zero. A recorded zero stays zero. */
  preExecAmbiguityCatches: number | null;
  deterministicSelectorBlocks: number | null;
  catalogGateFailClosed: number | null;
}

/** One generator turn, in numbers only. A figure the turn did not record is null, never a fabricated zero. The two prompt-provided read counts are kept apart: one is decided by content the prompt contained, the other by a path the prompt listed. `stepsUsed` is null unless the turn's steps were observed completely, and `maxSteps` is null when the turn had no limit. */
export interface TurnMeasurement {
  round: number;
  promptBytes: number | null;
  totalCalls: number | null;
  callsBeforeFirstWrite: number | null;
  redundantReadCount: number | null;
  promptProvidedReadCount: number | null;
  pathProvidedReadCount: number | null;
  codeRead: number | null;
  memory: number | null;
  stepsUsed: number | null;
  maxSteps: number | null;
}

/** The distinct agent sessions of a run that recorded at least one turn. */
export interface SessionCounts {
  /** Every role's sessions. */
  total: number;
  /** The generator's own (main and repair turns; not the planner's objective turn). */
  generator: number;
}

export interface CaseMeasurement {
  coarse: CoarseRunEfficiency;
  /** The generator's turns one by one. Absent for a run with no generator turn and for a snapshot taken before turns were measured. */
  turns?: TurnMeasurement[];
  /** Absent when the run recorded no turn at all (none was made, or they were pruned) and for a snapshot taken before sessions were counted: unknown, never zero. */
  sessions?: SessionCounts;
  /** Whether a generator turn hit the step limit; null for Codex (no step budget), for a run with no generator turn, and while any generator turn's exhaustion is unknown. */
  exhausted: boolean | null;
  guardrails: CaseGuardrails;
}

/** `data` is null when the run's records are gone (retention) or were never there, or when the run had not finished (`notFinished`). */
export interface SnapshotEntry {
  runId: string;
  data: CaseMeasurement | null;
  /** The run was still going when the snapshot was taken, so nothing was measured: snapshot again once it has finished. */
  notFinished?: true;
  /** The tier the case declared when the snapshot was taken; absent when it declared none. Kept even when `data` is null: it describes the case, not the run. */
  tier?: DiffTier;
}

/** Numbers and ids only — never prompt, output or event text. */
export interface EfficiencySnapshot {
  label: string;
  takenAt: string;
  cases: Record<string, SnapshotEntry>;
}

/** Where a run's recorded data is read from — history.ts in the orchestrator container, a fake in tests. */
export interface RunDataSource {
  events(runId: string): RunEventBody[];
  outcome(runId: string): RunOutcome | undefined;
  record(runId: string): RunRecord | undefined;
  turns(runId: string): AgentTurnRecord[];
}

function specsProduced(events: RunEventBody[], record: RunRecord | undefined): number | null {
  if (record?.specs) return record.specs.length;
  const written = new Set<string>();
  for (const event of events) if (event.type === "spec.written") written.add(event.file);
  return events.length > 0 ? written.size : null;
}

function executePass(record: RunRecord | undefined): boolean | null {
  if (!record) return null;
  const passed = record.passed ?? 0;
  const failed = record.failed ?? 0;
  if (passed + failed === 0) return null;
  return passed > 0 && failed === 0;
}

/* The generator's own turns, main and repair: not the planner's objective turn and not another role's. */
function generatorTurnsOf(turns: AgentTurnRecord[]): AgentTurnRecord[] {
  return turns.filter((t) => t.role.includes("generator") && t.objective !== PLANNER_OBJECTIVE);
}

function turnMeasurement(t: AgentTurnRecord): TurnMeasurement {
  return {
    round: t.round,
    promptBytes: t.promptBytes,
    totalCalls: t.totalCalls ?? null,
    callsBeforeFirstWrite: t.callsBeforeFirstWrite ?? null,
    redundantReadCount: t.redundantReadCount ?? null,
    promptProvidedReadCount: t.promptProvidedReadCount ?? null,
    pathProvidedReadCount: t.pathProvidedReadCount ?? null,
    codeRead: t.callBuckets?.[CALL_BUCKETS.CODE_READ] ?? null,
    memory: t.callBuckets?.[CALL_BUCKETS.MEMORY] ?? null,
    stepsUsed: t.stepsUsed ?? null,
    maxSteps: t.maxSteps ?? null,
  };
}

const distinctSessions = (turns: AgentTurnRecord[]): number => new Set(turns.map((t) => t.sessionId)).size;

/* A run with no recorded turn has unknown sessions: either it made none or its turns were pruned, and the two cannot be told apart. */
function sessionCounts(turns: AgentTurnRecord[], generatorTurns: AgentTurnRecord[]): SessionCounts | undefined {
  if (turns.length === 0) return undefined;
  return { total: distinctSessions(turns), generator: distinctSessions(generatorTurns) };
}

/*
 * Whether the generator hit its step limit: the exhaustion the transport persisted for every one of its
 * turns (main and repair; the planner's objective turn is not the generator's). One exhausted turn makes
 * the run exhausted; the run is known not to be only when every turn is known not to be, and any unknown
 * turn leaves it unknown.
 */
function generatorExhausted(outcome: RunOutcome | undefined, turns: AgentTurnRecord[]): boolean | null {
  if (outcome?.gateSignals.usage?.primaryProvider === "codex") return null;
  const generatorTurns = generatorTurnsOf(turns);
  if (generatorTurns.length === 0) return null;
  if (generatorTurns.some((t) => t.exhausted === true)) return true;
  return generatorTurns.every((t) => t.exhausted === false) ? false : null;
}

/* A run's outcome is written when it ends, and its record is marked done then: without either, its events are
   still growing and any window measured from them is not the run's. */
function runFinished(outcome: RunOutcome | undefined, record: RunRecord | undefined): boolean {
  return outcome !== undefined || record?.status === "done";
}

/**
 * The run's coarse efficiency and guardrails, or null when its events are gone or the run has not finished.
 * A run's outcome row outlives its events, its record and its turns, so an old run can still have guardrails;
 * without the events its calls cannot be measured, and an empty window would read as a run that made no calls.
 */
export function measureRun(runId: string, source: RunDataSource): CaseMeasurement | null {
  const outcome = source.outcome(runId);
  const record = source.record(runId);
  if (!runFinished(outcome, record)) return null;
  const events = source.events(runId);
  if (events.length === 0) return null;
  const turns = source.turns(runId);
  const generatorTurns = generatorTurnsOf(turns);
  const sessions = sessionCounts(turns, generatorTurns);
  return {
    coarse: classifyRunEfficiency(events),
    ...(generatorTurns.length > 0 ? { turns: generatorTurns.map(turnMeasurement) } : {}),
    ...(sessions ? { sessions } : {}),
    exhausted: generatorExhausted(outcome, turns),
    guardrails: {
      verdict: outcome?.verdict ?? record?.verdict ?? null,
      specsProduced: specsProduced(events, record),
      staticPass: outcome?.gateSignals.static ?? null,
      executePass: executePass(record),
      coverageRatio: outcome?.gateSignals.coverageRatio ?? null,
      reviewerApproved: outcome?.gateSignals.reviewerApproved ?? null,
      errorClass: outcome?.errorClass ?? null,
      preExecAmbiguityCatches: outcome?.gateSignals.preExecAmbiguityCatches ?? null,
      deterministicSelectorBlocks: outcome?.gateSignals.deterministicSelectorBlocks ?? null,
      catalogGateFailClosed: outcome?.gateSignals.catalogGateFailClosed ?? null,
    },
  };
}

const snapshotFile = (resultsDir: string, label: string): string => join(resultsDir, `${label}.snapshot.json`);

/** Measures every run registered under the label; a run whose data is gone yields a null entry. A case that declared a tier keeps it on its entry, whatever became of its run's data. */
export function takeSnapshot(
  label: string,
  resultsDir: string,
  sourceFor: (runId: string) => RunDataSource,
  now: () => string = () => new Date().toISOString(),
  declaredTiers: ReadonlyMap<string, DiffTier> = new Map(),
): EfficiencySnapshot {
  const cases: Record<string, SnapshotEntry> = {};
  for (const [caseName, runId] of Object.entries(readRegistry(resultsDir, label))) {
    const source = sourceFor(runId);
    const record = source.record(runId);
    const notFinished = record !== undefined && !runFinished(source.outcome(runId), record);
    const tier = declaredTiers.get(caseName);
    cases[caseName] = {
      runId,
      data: measureRun(runId, source),
      ...(notFinished ? { notFinished: true as const } : {}),
      ...(tier !== undefined ? { tier } : {}),
    };
  }
  return { label, takenAt: now(), cases };
}

export function readSnapshot(resultsDir: string, label: string): EfficiencySnapshot | null {
  assertLabel(label);
  const path = snapshotFile(resultsDir, label);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EfficiencySnapshot;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.label !== "string" || typeof parsed.cases !== "object") {
    throw new Error(`${path} is not an efficiency snapshot`);
  }
  return parsed;
}

const measuredCalls = (data: CaseMeasurement | null | undefined): number =>
  data ? data.coarse.firstPass.totalCalls + data.coarse.grounding.totalCalls + data.coarse.wholeRunExcludingGrounding.totalCalls : 0;

/**
 * Writes the snapshot, but never one that holds less than the file it replaces: once the runs'
 * records age out, re-snapshotting would silently erase the only surviving measurements. A finished
 * run's calls never change, so a case counts as lost when it has no data any more or, for the SAME
 * run, when its measured calls dropped at all (events pruned one by one leave a partial window). A
 * case re-registered to a different run is a new measurement: fewer calls there is the improvement
 * the benchmark exists to show, not a loss.
 */
export function writeSnapshot(resultsDir: string, snapshot: EfficiencySnapshot): void {
  const existing = readSnapshot(resultsDir, snapshot.label);
  if (existing) {
    const lost = Object.entries(existing.cases)
      .filter(([name, entry]) => {
        if (entry.data === null) return false;
        const replacement = snapshot.cases[name];
        if (replacement?.data == null) return true;
        return replacement.runId === entry.runId && measuredCalls(replacement.data) < measuredCalls(entry.data);
      })
      .map(([name]) => name);
    if (lost.length > 0) {
      throw new Error(
        `refusing to overwrite snapshot '${snapshot.label}': it would lose the measurements of case(s) ${lost.join(", ")} (their runs' records may have been pruned). Keep the existing snapshot or use a new label.`,
      );
    }
  }
  mkdirSync(resultsDir, { recursive: true });
  writeFileAtomically(snapshotFile(resultsDir, snapshot.label), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/* ── report ────────────────────────────────────────────────────────────────────────── */

/** One side of a case in a comparison. A measured side carries the case's declared `tier`, left off when it declared none or one no size class names. */
export type CaseView = { status: "missing"; notFinished?: true } | { status: "measured"; data: CaseMeasurement; tier?: DiffTier };

export interface ReportRow {
  caseName: string;
  a: CaseView;
  b: CaseView;
  /** Names of the guardrails whose recorded value differs between the two labels (empty unless both measured). */
  guardrailChanges: string[];
}

/** How much of the step limit a label's generator turns used. A turn whose ratio is unknown is counted in `unknown` and takes no part in the mean. */
export interface StepUse {
  /** Mean of stepsUsed / maxSteps over the turns whose ratio is known; null when none is. */
  meanRatio: number | null;
  known: number;
  unknown: number;
}

export interface Comparison {
  labelA: string;
  labelB: string;
  rows: ReportRow[];
  stepUse: { a: StepUse; b: StepUse };
}

function viewOf(snapshot: EfficiencySnapshot, caseName: string): CaseView {
  const entry = snapshot.cases[caseName];
  if (entry?.data) return { status: "measured", data: entry.data, ...(isDiffTier(entry.tier) ? { tier: entry.tier } : {}) };
  return entry?.notFinished ? { status: "missing", notFinished: true } : { status: "missing" };
}

/* A turn's steps used over the limit it was held to; null when either is unknown. A limit that is not a positive whole number is no limit (a runtime enforces none), so it never yields an infinite or negative ratio. A snapshot taken before steps were recorded has neither figure. */
function stepUseRatio(stepsUsed: number | null | undefined, maxSteps: number | null | undefined): number | null {
  if (stepsUsed == null) return null;
  const limit = maxSteps ?? 0;
  return Number.isInteger(limit) && limit > 0 ? stepsUsed / limit : null;
}

function stepUseOf(snapshot: EfficiencySnapshot): StepUse {
  const ratios = Object.values(snapshot.cases).flatMap((entry) => (entry.data?.turns ?? []).map((t) => stepUseRatio(t.stepsUsed, t.maxSteps)));
  const known = ratios.filter((ratio): ratio is number => ratio !== null);
  const meanRatio = known.length === 0 ? null : known.reduce((sum, ratio) => sum + ratio, 0) / known.length;
  return { meanRatio, known: known.length, unknown: ratios.length - known.length };
}

const GUARDRAIL_NAMES: ReadonlyArray<keyof CaseGuardrails> = [
  "verdict", "specsProduced", "staticPass", "executePass", "coverageRatio", "reviewerApproved", "errorClass",
  "preExecAmbiguityCatches", "deterministicSelectorBlocks", "catalogGateFailClosed",
];

/* A guardrail an older snapshot never recorded is unknown (undefined), and unknown on either side is not evidence of a change. */
const changed = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && a !== b;

/** One row per case named by either snapshot: a case with no data on a side is `missing` there, never left out. */
export function compareSnapshots(a: EfficiencySnapshot, b: EfficiencySnapshot): Comparison {
  const names = [...new Set([...Object.keys(a.cases), ...Object.keys(b.cases)])];
  const rows = names.map((caseName): ReportRow => {
    const left = viewOf(a, caseName);
    const right = viewOf(b, caseName);
    const guardrailChanges =
      left.status === "measured" && right.status === "measured"
        ? GUARDRAIL_NAMES.filter((g) => changed(left.data.guardrails[g], right.data.guardrails[g])).map(String)
        : [];
    return { caseName, a: left, b: right, guardrailChanges };
  });
  return { labelA: a.label, labelB: b.label, rows, stepUse: { a: stepUseOf(a), b: stepUseOf(b) } };
}

/* A figure an older snapshot never recorded is undefined: unknown, like a recorded null. */
const val = (v: number | string | null | undefined): string => (v === null || v === undefined ? "n/a" : String(v));
const yesNo = (v: boolean | null, yes: string, no: string): string => (v === null ? "n/a" : v ? yes : no);
const ratioText = (ratio: number | null): string => (ratio === null ? "n/a" : ratio.toFixed(2));

function windowLine(w: CoarseRunEfficiency["firstPass"]): string {
  return `calls ${w.totalCalls} · before 1st write ${w.callsBeforeFirstWrite} · writes ${w.writeCount} · commands ${w.commandCount} · subagents ${w.subagentCount}`;
}

function turnLine(t: TurnMeasurement): string {
  return `turn round ${t.round}: prompt ${val(t.promptBytes)} B · calls ${val(t.totalCalls)} · before 1st write ${val(t.callsBeforeFirstWrite)} · redundant reads ${val(t.redundantReadCount)} · reads provided by content ${val(t.promptProvidedReadCount)} · by path ${val(t.pathProvidedReadCount)} · code reads ${val(t.codeRead)} · memory ${val(t.memory)} · steps used ${val(t.stepsUsed)} · max steps ${val(t.maxSteps)} · step use ${ratioText(stepUseRatio(t.stepsUsed, t.maxSteps))}`;
}

const UNDECLARED_TIER = "undeclared";

function caseLine(data: CaseMeasurement, tier: DiffTier | undefined): string {
  const sessions = data.sessions ? `sessions total ${data.sessions.total} · generator ${data.sessions.generator}` : "sessions n/a";
  return `tier ${tier ?? UNDECLARED_TIER} · ${sessions}`;
}

function measuredLines(data: CaseMeasurement, tier: DiffTier | undefined): string[] {
  const g = data.guardrails;
  return [
    caseLine(data, tier),
    ...(data.turns ?? []).map(turnLine),
    `first pass: ${windowLine(data.coarse.firstPass)}`,
    `whole run excl. grounding: ${windowLine(data.coarse.wholeRunExcludingGrounding)}`,
    `grounding: ${data.coarse.grounding.totalCalls === 0 ? "n/a (explorer unobserved)" : `calls ${data.coarse.grounding.totalCalls}`}`,
    `generator: step limit ${yesNo(data.exhausted, "hit", "not hit")}`,
    `guardrails: verdict ${val(g.verdict)} · specs ${val(g.specsProduced)} · static ${yesNo(g.staticPass, "pass", "fail")} · execute ${yesNo(g.executePass, "pass", "fail")} · coverage ${g.coverageRatio === null ? "unknown" : g.coverageRatio} · reviewer ${yesNo(g.reviewerApproved, "approved", "rejected")} · error class ${g.errorClass === undefined ? "unknown" : (g.errorClass ?? "none")} · pre-exec ambiguity catches ${val(g.preExecAmbiguityCatches)} · deterministic selector blocks ${val(g.deterministicSelectorBlocks)} · catalog gate fail-closed ${val(g.catalogGateFailClosed)}`,
  ];
}

function stepUseLine(label: string, stepUse: StepUse): string {
  return `  ${label}: mean ${ratioText(stepUse.meanRatio)} · known ${stepUse.known} · unknown ${stepUse.unknown}`;
}

/** A plain-text side-by-side report, one block per case. */
export function renderReport(comparison: Comparison): string {
  const lines: string[] = [`efficiency report: ${comparison.labelA} → ${comparison.labelB}`, ""];
  for (const row of comparison.rows) {
    lines.push(`case: ${row.caseName}`);
    for (const [label, view] of [[comparison.labelA, row.a], [comparison.labelB, row.b]] as const) {
      if (view.status === "missing") {
        lines.push(`  ${label}: MISSING — ${view.notFinished ? "the run had not finished when the snapshot was taken" : "no recorded data for this case"}`);
        continue;
      }
      lines.push(`  ${label}:`);
      for (const line of measuredLines(view.data, view.tier)) lines.push(`    ${line}`);
    }
    if (row.guardrailChanges.length > 0) lines.push(`  guardrails changed: ${row.guardrailChanges.join(", ")}`);
    lines.push("");
  }
  lines.push("step use of the generator's turns (steps used / max steps; a turn whose ratio is unknown is left out of the mean and counted):");
  lines.push(stepUseLine(comparison.labelA, comparison.stepUse.a), stepUseLine(comparison.labelB, comparison.stepUse.b), "");
  return lines.join("\n");
}

/* ── command line ──────────────────────────────────────────────────────────────────── */

const USAGE = [
  "usage: npm run efficiency-benchmark -- <command>",
  "  run <label> [--timeout-minutes N] submit every case in config/benchmarks/efficiency-cases.json, one at a time, through the service's queue; N is how long to wait for each case (default 30)",
  "  register <label> <case> <runId>    attach an already-finished run to a case of the label",
  "  snapshot <label>                   freeze the label's runs, and the tier each case declares, into config/benchmarks/efficiency-results/<label>.snapshot.json",
  "  report <labelA> <labelB>           compare two labels' snapshots",
  "run inside the orchestrator container: it needs the service's control API and its run history.",
].join("\n");

export interface MainOptions {
  resultsDir?: string;
  casesPath?: string;
  out?: (line: string) => void;
  /** The service `run` submits to; defaults to the local orchestrator. */
  service?: BenchmarkService;
  /** Where `snapshot` reads run data from; defaults to the orchestrator's run history. */
  sourceFor?: (runId: string) => RunDataSource;
  now?: () => string;
  env?: Record<string, string | undefined>;
}

function discoverApiToken(env: Record<string, string | undefined>): string | undefined {
  if (env.QA_API_TOKEN) return env.QA_API_TOKEN;
  try {
    return readFileSync(join(ROOT, "config", ".api_token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function defaultService(env: Record<string, string | undefined>): Promise<BenchmarkService> {
  const { resolvePort } = await import("../src/server/port.ts");
  const token = discoverApiToken(env);
  return { fetch, baseUrl: `http://localhost:${resolvePort(env)}`, ...(token ? { token } : {}) };
}

/* The orchestrator's own history store, imported lazily so the commands that never read it do not open it. */
async function historySource(): Promise<(runId: string) => RunDataSource> {
  const history = await import("../src/server/history.ts");
  const source: RunDataSource = {
    events: (runId) => history.loadRunEvents(runId).map((e) => e.body as RunEventBody),
    outcome: (runId) => history.getRunOutcome(runId),
    record: (runId) => history.getRecord(runId),
    turns: (runId) => history.getAgentTurns(runId),
  };
  return () => source;
}

type RunArguments = { ok: true; label: string; timeoutMs?: number } | { ok: false; problem: string };

/** `run <label>` with an optional `--timeout-minutes N` (a positive number). */
function parseRunArguments(args: string[]): RunArguments {
  const positional: string[] = [];
  let timeoutMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--timeout-minutes") {
      positional.push(args[i]!);
      continue;
    }
    const minutes = Number(args[++i]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, problem: "error: --timeout-minutes needs a positive number of minutes" };
    }
    timeoutMs = minutes * 60_000;
  }
  if (positional.length !== 1) return { ok: false, problem: "error: run takes exactly one label" };
  return { ok: true, label: positional[0]!, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** Returns the process exit code: 0 ok, 1 the command failed, 2 bad usage. */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const env = opts.env ?? process.env;
  const resultsDir = opts.resultsDir ?? defaultEfficiencyResultsDir();
  const [command, ...args] = argv;

  try {
    if (command === "run") {
      const parsed = parseRunArguments(args);
      if (!parsed.ok) {
        out(parsed.problem);
        for (const line of USAGE.split("\n")) out(line);
        return 2;
      }
      const baseService = opts.service ?? (await defaultService(env));
      const result = await runBenchmark(parsed.label, {
        ...(opts.casesPath ? { casesPath: opts.casesPath } : {}),
        resultsDir,
        service: parsed.timeoutMs !== undefined ? { ...baseService, timeoutMs: parsed.timeoutMs } : baseService,
        log: out,
      });
      for (const c of result.completed) out(`${c.caseName}: run ${c.runId} → ${c.verdict ?? "no verdict"}`);
      if (result.stopped) {
        out(`stopped at '${result.stopped.caseName}' (run ${result.stopped.runId}): it did not finish in time; later cases were not submitted`);
        return 1;
      }
      out(`${result.completed.length} case(s) finished; now run: snapshot ${parsed.label}`);
      return 0;
    }

    if (command === "register" && args.length === 3) {
      registerRun(resultsDir, args[0]!, args[1]!, args[2]!);
      out(`registered run ${args[2]} as case '${args[1]}' of label '${args[0]}'`);
      return 0;
    }

    if (command === "snapshot" && args.length === 1) {
      const label = args[0]!;
      if (Object.keys(readRegistry(resultsDir, label)).length === 0) {
        out(`no runs registered under label '${label}' — use \`run ${label}\` or \`register ${label} <case> <runId>\` first`);
        return 1;
      }
      const declaredTiers = declaredTiersOf(opts.casesPath ?? defaultEfficiencyBenchmarkCasesPath());
      const snapshot = takeSnapshot(label, resultsDir, opts.sourceFor ?? (await historySource()), opts.now, declaredTiers);
      writeSnapshot(resultsDir, snapshot);
      const entries = Object.values(snapshot.cases);
      const measured = entries.filter((e) => e.data !== null).length;
      const notFinished = entries.filter((e) => e.notFinished).length;
      out(`snapshot '${label}' written: ${measured} case(s) measured, ${entries.length - measured - notFinished} with no recorded data (missing)${notFinished > 0 ? `, ${notFinished} not finished (snapshot again once they have)` : ""}`);
      return 0;
    }

    if (command === "report" && args.length === 2) {
      const [a, b] = [readSnapshot(resultsDir, args[0]!), readSnapshot(resultsDir, args[1]!)];
      if (!a || !b) {
        out(`no snapshot for label '${!a ? args[0] : args[1]}' — run \`snapshot ${!a ? args[0] : args[1]}\` first`);
        return 1;
      }
      for (const line of renderReport(compareSnapshots(a, b)).split("\n")) out(line);
      return 0;
    }
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  for (const line of USAGE.split("\n")) out(line);
  return 2;
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

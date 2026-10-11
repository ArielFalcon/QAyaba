/*
 * The one metrics shape both arms of the pipeline-vs-plain-agent experiment emit, and the pure
 * functions that build it. `probe-report.ts` fills it from a pipeline run's recorded history;
 * `baseline-agent.ts` fills it from the plain agent's session. Keeping the shape, the aggregation
 * and the rendering here is what makes the two arms comparable by construction.
 *
 * A figure that was not measured is null and reads `n/a`; it is never a zero, and it stays out of
 * every sum. Nothing here reads a file, the clock or the network.
 */
import type { RunEventBody } from "@kernel/contract/events.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { DecideCoverageService, type CoverageStatus } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { isContentReadTool } from "@contexts/generation/domain/call-sequence.ts";
import { EXPLORER_AGENT_NAME } from "@contexts/generation/domain/explorer-agent.ts";
import type { ToolSequenceEntry } from "@contexts/generation/domain/tool-sequence.ts";
import type { TurnCallMetrics } from "@contexts/generation/domain/turn-efficiency-summary.ts";
import type { AgentTurnRecord } from "../src/server/history.ts";
import type { RunOutcome, RunRecord } from "../src/types.ts";

/* ── phases ────────────────────────────────────────────────────────────────────────── */

/** The phases of a run, in the order they happen. `grounding` is the pre-generation sub-step of the engine's `generate` step. */
export const PHASES = ["gate", "classify", "setup", "grounding", "generation", "validate", "health", "execute", "coverage", "retry", "decide"] as const;
export type PhaseName = (typeof PHASES)[number];
export type PhaseDurations = Record<PhaseName, number | null>;

/** A recorded run event with the time it was recorded at, epoch milliseconds. */
export interface TimedRunEvent {
  ts: number;
  body: RunEventBody;
}

const PHASE_NAMES: ReadonlySet<string> = new Set(PHASES);

function phaseOf(step: string, detail: string | undefined): PhaseName | undefined {
  if (step === "generate") return detail === PRE_GENERATION_GROUNDING_STEP_DETAIL ? "grounding" : "generation";
  return PHASE_NAMES.has(step) ? (step as PhaseName) : undefined;
}

const emptyPhases = (): PhaseDurations => Object.fromEntries(PHASES.map((p) => [p, null])) as PhaseDurations;

/**
 * How long each phase took, from the `step.changed` events a run already records: a phase lasts until
 * the next step change (the last one until the final event). A phase the run never entered is null; one
 * entered twice (a retry loop) is the sum of its stretches. `finished` is false while the run has not
 * reached its `done` step, and then the last phase is cut at the last event seen.
 */
export function phaseDurations(events: readonly TimedRunEvent[]): { totalMs: number | null; finished: boolean; phases: PhaseDurations } {
  const phases = emptyPhases();
  if (events.length === 0) return { totalMs: null, finished: false, phases };
  const first = events[0]!.ts;
  const last = events[events.length - 1]!.ts;
  const steps = events.flatMap((e) => (e.body.type === "step.changed" ? [{ ts: e.ts, step: e.body.step, detail: e.body.detail }] : []));
  steps.forEach((s, i) => {
    const phase = phaseOf(s.step, s.detail);
    if (!phase) return;
    const until = steps[i + 1]?.ts ?? last;
    phases[phase] = (phases[phase] ?? 0) + Math.max(0, until - s.ts);
  });
  return { totalMs: Math.max(0, last - first), finished: steps.some((s) => s.step === "done"), phases };
}

/* ── tools ─────────────────────────────────────────────────────────────────────────── */

/** What a run's diff and the explorer's brief say about where the agent should have looked. Either is null when unknown. */
export interface ReadingContext {
  /** Paths of the files the change touched, relative to the working copy. */
  changedFiles: readonly string[] | null;
  /** The explorer's brief, as text. */
  briefText: string | null;
  /** The directory the agent writes its tests under: reading there is expected, not exploration. */
  suiteDir: string;
}

export const DEFAULT_SUITE_DIR = "e2e";
const SAMPLE_SIZE = 20;
const URL_LIMIT = 50;

export interface ToolSummary {
  /** Calls in the listed sequence (the sequence is capped, so this can be below the turn's call count). */
  listed: number;
  byTool: Record<string, number>;
  denied: number;
  distinctFilesRead: number;
  /** Reads outside every directory the diff touches and outside the suite directory; null when the diff is unknown. */
  filesReadOutsideDiffDirs: number | null;
  outsideDiffDirsSample: string[];
  /** Reads of a file the explorer's brief does not name; null when there was no brief. */
  filesReadOutsideBrief: number | null;
  outsideBriefSample: string[];
  /** The pages the agent opened in the browser, in order, once each. */
  browserUrls: string[];
}

const BROWSER_NAVIGATE = /(^|_)browser_navigate$/i;

const dirOf = (file: string): string => {
  const at = file.lastIndexOf("/");
  return at < 0 ? "." : file.slice(0, at);
};

/* A file is inside a directory when it is that directory or below it; the root (".") holds only the files directly in it, or everything would be inside. */
function isUnder(file: string, dir: string): boolean {
  if (dir === ".") return !file.includes("/");
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * Reduces a turn's tool sequence to where the agent looked: which files it read, how many of them lie
 * outside the directories the diff touched and outside the explorer's brief, and which pages it opened.
 * A denied call is counted as denied and is not a read. Null when the turn kept no sequence.
 */
export function summarizeTools(sequence: readonly ToolSequenceEntry[] | null, ctx: ReadingContext): ToolSummary | null {
  if (sequence === null) return null;
  const byTool: Record<string, number> = {};
  for (const entry of sequence) byTool[entry.tool] = (byTool[entry.tool] ?? 0) + 1;

  const reads = [...new Set(sequence.filter((e) => !e.denied && e.target !== null && isContentReadTool(e.tool)).map((e) => e.target as string))];
  const diffDirs = ctx.changedFiles === null ? null : [...new Set(ctx.changedFiles.map(dirOf))];
  const outsideDiff = diffDirs === null ? null : reads.filter((f) => !isUnder(f, ctx.suiteDir) && !diffDirs.some((d) => isUnder(f, d)));
  const outsideBrief = ctx.briefText === null ? null : reads.filter((f) => !isUnder(f, ctx.suiteDir) && !(ctx.briefText as string).includes(f));
  const urls = [...new Set(sequence.filter((e) => !e.denied && e.target !== null && BROWSER_NAVIGATE.test(e.tool)).map((e) => e.target as string))];

  return {
    listed: sequence.length,
    byTool,
    denied: sequence.filter((e) => e.denied).length,
    distinctFilesRead: reads.length,
    filesReadOutsideDiffDirs: outsideDiff === null ? null : outsideDiff.length,
    outsideDiffDirsSample: (outsideDiff ?? []).slice(0, SAMPLE_SIZE),
    filesReadOutsideBrief: outsideBrief === null ? null : outsideBrief.length,
    outsideBriefSample: (outsideBrief ?? []).slice(0, SAMPLE_SIZE),
    browserUrls: urls.slice(0, URL_LIMIT),
  };
}

/* ── turns ─────────────────────────────────────────────────────────────────────────── */

export interface ProbeUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  /** `all-steps`: summed over every step the turn finished. `last-message`: only the final assistant message (the engine's older columns), which understates a many-step turn. Null: nothing was recorded. */
  source: "all-steps" | "last-message" | null;
}

export interface ProbeTurn {
  role: string;
  round: number;
  isRepair: boolean;
  ended: string | null;
  durationMs: number | null;
  stepsUsed: number | null;
  maxSteps: number | null;
  calls: number | null;
  writes: number | null;
  buckets: Record<string, number> | null;
  callsBeforeFirstWrite: number | null;
  msToFirstCall: number | null;
  msToFirstWrite: number | null;
  deniedCalls: number | null;
  usage: ProbeUsage;
  promptBytes: number | null;
  redundantReads: number | null;
  /** Reads of content the prompt already carried. */
  promptProvidedReads: number | null;
  /** Reads of a file the prompt listed by path. */
  pathProvidedReads: number | null;
  tools: ToolSummary | null;
  /** The full ordered sequence, kept in the JSON only. */
  toolSequence: ToolSequenceEntry[] | null;
}

const NO_USAGE: ProbeUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cost: null, source: null };

function usageOf(t: AgentTurnRecord): ProbeUsage {
  if (t.usageTotal) {
    const u = t.usageTotal;
    return { input: u.input, output: u.output, reasoning: u.reasoning, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost, source: "all-steps" };
  }
  const recorded = [t.tokensInput, t.tokensOutput, t.tokensReasoning, t.tokensCacheRead, t.tokensCacheWrite, t.cost].some((v) => v != null);
  if (!recorded) return NO_USAGE;
  return {
    input: t.tokensInput ?? null, output: t.tokensOutput ?? null, reasoning: t.tokensReasoning ?? null,
    cacheRead: t.tokensCacheRead ?? null, cacheWrite: t.tokensCacheWrite ?? null, cost: t.cost ?? null, source: "last-message",
  };
}

/** A recorded agent turn in the shared shape. Columns an older row lacks read as null. */
export function toProbeTurn(t: AgentTurnRecord, ctx: ReadingContext): ProbeTurn {
  const toolSequence = t.toolSequence ?? null;
  return {
    role: t.role,
    round: t.round,
    isRepair: t.isRepair,
    ended: t.ended ?? null,
    durationMs: t.durationMs ?? null,
    stepsUsed: t.stepsUsed ?? null,
    maxSteps: t.maxSteps ?? null,
    calls: t.totalCalls ?? null,
    writes: t.writeCount ?? null,
    buckets: t.callBuckets ?? null,
    callsBeforeFirstWrite: t.callsBeforeFirstWrite ?? null,
    msToFirstCall: t.timeToFirstCallMs ?? null,
    msToFirstWrite: t.timeToFirstWriteMs ?? null,
    deniedCalls: t.deniedCallCount ?? null,
    usage: usageOf(t),
    promptBytes: t.promptBytes,
    redundantReads: t.redundantReadCount ?? null,
    promptProvidedReads: t.promptProvidedReadCount ?? null,
    pathProvidedReads: t.pathProvidedReadCount ?? null,
    tools: summarizeTools(toolSequence, ctx),
    toolSequence,
  };
}

export interface MeasuredTurnInput {
  role: string;
  round: number;
  isRepair: boolean;
  ended: string | null;
  durationMs: number | null;
  maxSteps: number | null;
  promptBytes: number | null;
  /** What the call tracker measured of the turn; null when nothing was observed. */
  metrics: TurnCallMetrics | null;
}

/** A turn the call tracker measured live (or replayed from a session) in the shared shape: the plain-agent arm's counterpart of `toProbeTurn`. */
export function turnFromCallMetrics(t: MeasuredTurnInput, ctx: ReadingContext): ProbeTurn {
  const m = t.metrics;
  const u = m?.usage ?? null;
  return {
    role: t.role,
    round: t.round,
    isRepair: t.isRepair,
    ended: t.ended,
    durationMs: t.durationMs,
    stepsUsed: m?.stepsUsed ?? null,
    maxSteps: t.maxSteps,
    calls: m?.totalCalls ?? null,
    writes: m?.writeCount ?? null,
    buckets: m ? { ...m.buckets } : null,
    callsBeforeFirstWrite: m?.callsBeforeFirstWrite ?? null,
    msToFirstCall: m?.timeToFirstCallMs ?? null,
    msToFirstWrite: m?.timeToFirstWriteMs ?? null,
    deniedCalls: m?.deniedCallCount ?? null,
    usage: u ? { input: u.input, output: u.output, reasoning: u.reasoning, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost, source: "all-steps" } : NO_USAGE,
    promptBytes: t.promptBytes,
    redundantReads: m?.redundantReadCount ?? null,
    promptProvidedReads: m?.promptProvidedReadCount ?? null,
    pathProvidedReads: m?.pathProvidedReadCount ?? null,
    tools: summarizeTools(m?.toolSequence ?? null, ctx),
    toolSequence: m?.toolSequence ?? null,
  };
}

/* ── the report ────────────────────────────────────────────────────────────────────── */

export type Arm = "pipeline" | "baseline";

export interface ProbeSpec {
  path: string;
  /** Lines of the spec as it stood when the report was made; null when the file was no longer there. */
  lines: number | null;
}

export interface ProbeCoverage {
  status: CoverageStatus;
  ratio: number | null;
  changedLines: number | null;
  coveredLines: number | null;
  /** The ratio a pass needs, as the app's policy (or the default) states it. */
  minRatio: number;
}

export interface ProbeTotals {
  /** Sums over the turns that know the figure; null when no turn does. */
  calls: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Wall time of all agent turns. */
  agentMs: number | null;
  /** Turns whose usage is only the last message's. */
  turnsWithPartialUsage: number;
}

export interface ProbeReport {
  schema: 1;
  arm: Arm;
  /** The run id (pipeline) or the label (baseline). */
  id: string;
  app: string | null;
  sha: string | null;
  mode: string | null;
  at: string | null;
  verdict: string | null;
  errorClass: string | null;
  note: string | null;
  /** False while the run is still going (its figures are partial). */
  finished: boolean;
  totalMs: number | null;
  phases: PhaseDurations;
  /** Time inside the phases above that the run also records separately. */
  nested: { explorerMs: number | null; domCaptureMs: number | null; reviewMs: number | null };
  turns: ProbeTurn[];
  totals: ProbeTotals;
  specs: ProbeSpec[];
  execution: { passed: number | null; failed: number | null; flaky: number | null } | null;
  coverage: ProbeCoverage | null;
  reviewer: { approved: boolean | null; reasons: string[] } | null;
  /** What only one arm can say (the plain agent's model, step cap and timeout, its final words, what it wrote outside the suite). Not compared across arms. */
  detail?: Record<string, unknown>;
}

const sumKnown = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

export function totalsOf(turns: readonly ProbeTurn[]): ProbeTotals {
  return {
    calls: sumKnown(turns.map((t) => t.calls)),
    costUsd: sumKnown(turns.map((t) => t.usage.cost)),
    inputTokens: sumKnown(turns.map((t) => t.usage.input)),
    outputTokens: sumKnown(turns.map((t) => t.usage.output)),
    cacheReadTokens: sumKnown(turns.map((t) => t.usage.cacheRead)),
    agentMs: sumKnown(turns.map((t) => t.durationMs)),
    turnsWithPartialUsage: turns.filter((t) => t.usage.source === "last-message").length,
  };
}

/** Change-coverage as the engine's own policy reads it: a ratio against the minimum, unknown when nothing was measured. */
export function coverageOf(changedLines: number | null, coveredLines: number | null, recordedRatio: number | null, minRatio: number): ProbeCoverage {
  const measured = changedLines !== null && coveredLines !== null && changedLines > 0;
  const ratio = measured ? coveredLines / changedLines : recordedRatio;
  const status: CoverageStatus = measured
    ? new DecideCoverageService().decide({ measured: true, overall: { changedLines, coveredChanged: coveredLines, ratio: ratio as number }, perFile: [], uncovered: [], branches: null }, { mode: "signal", minRatio })
    : ratio === null ? "unknown" : ratio >= minRatio ? "pass" : "fail";
  return { status, ratio, changedLines, coveredLines, minRatio };
}

export interface PipelineReportInput {
  runId: string;
  record: RunRecord | undefined;
  outcome: RunOutcome | undefined;
  events: readonly TimedRunEvent[];
  turns: readonly AgentTurnRecord[];
  /** The files the change touched; null when they could not be read. */
  changedFiles: readonly string[] | null;
  /** Lines per reported spec path; a path missing from the map has no known count. */
  specLines: ReadonlyMap<string, number | null>;
  /** The change-coverage minimum of the app's policy. */
  minRatio: number;
  suiteDir?: string;
}

function reportedSpecs(input: PipelineReportInput): ProbeSpec[] {
  const paths = new Set<string>();
  for (const s of input.record?.specs ?? []) paths.add(s.name);
  for (const e of input.events) if (e.body.type === "spec.written") paths.add(e.body.file);
  return [...paths].map((path) => ({ path, lines: input.specLines.get(path) ?? null }));
}

function lastEvent<T extends RunEventBody["type"]>(events: readonly TimedRunEvent[], type: T): Extract<RunEventBody, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.body.type === type) return events[i]!.body as Extract<RunEventBody, { type: T }>;
  return undefined;
}

const roleIs = (t: AgentTurnRecord, name: string): boolean => t.role === name || t.role.includes(name);

/** One pipeline run's report, from what its history recorded. Pure: everything it needs is handed in. */
export function buildPipelineReport(input: PipelineReportInput): ProbeReport {
  const { record, outcome, events } = input;
  const { totalMs, finished, phases } = phaseDurations(events);
  const started = lastEvent(events, "run.started");
  const explorerTurns = input.turns.filter((t) => roleIs(t, EXPLORER_AGENT_NAME));
  const briefText = explorerTurns.length > 0 ? explorerTurns[explorerTurns.length - 1]!.outputText : null;
  const ctx: ReadingContext = { changedFiles: input.changedFiles, briefText, suiteDir: input.suiteDir ?? DEFAULT_SUITE_DIR };
  const turns = input.turns.map((t) => toProbeTurn(t, ctx));

  const explorerMs = sumKnown(explorerTurns.map((t) => t.durationMs ?? null));
  const reviewMs = sumKnown(input.turns.filter((t) => roleIs(t, "reviewer")).map((t) => t.durationMs ?? null));
  const domCaptureMs = phases.grounding !== null && explorerMs !== null && phases.grounding >= explorerMs ? phases.grounding - explorerMs : null;

  const computed = lastEvent(events, "coverage.computed");
  const verdictEvent = lastEvent(events, "reviewer.verdict");
  const hasCoverage = computed !== undefined || (outcome?.gateSignals.coverageRatio ?? null) !== null;
  const reviewerApproved = verdictEvent?.approved ?? outcome?.gateSignals.reviewerApproved ?? null;

  return {
    schema: 1,
    arm: "pipeline",
    id: input.runId,
    app: record?.app ?? outcome?.app ?? null,
    sha: record?.sha ?? outcome?.sha ?? started?.sha ?? null,
    mode: record?.mode ?? outcome?.mode ?? started?.mode ?? null,
    at: record?.at ?? outcome?.at ?? null,
    verdict: outcome?.verdict ?? record?.verdict ?? null,
    errorClass: outcome?.errorClass ?? null,
    note: record?.note ?? null,
    finished: finished || outcome !== undefined,
    totalMs,
    phases,
    nested: { explorerMs, domCaptureMs, reviewMs },
    turns,
    totals: totalsOf(turns),
    specs: reportedSpecs(input),
    execution: record
      ? { passed: record.passed ?? null, failed: record.failed ?? null, flaky: events.filter((e) => e.body.type === "test.flaky").length }
      : null,
    coverage: hasCoverage
      ? coverageOf(computed?.changedLines ?? null, computed?.coveredLines ?? null, outcome?.gateSignals.coverageRatio ?? null, input.minRatio)
      : null,
    reviewer: verdictEvent
      ? { approved: verdictEvent.approved, reasons: verdictEvent.reasons }
      : reviewerApproved === null ? null : { approved: reviewerApproved, reasons: outcome?.gateSignals.reviewerCorrections ?? [] },
  };
}

/* ── rendering ─────────────────────────────────────────────────────────────────────── */

const NA = "n/a";

export const secs = (ms: number | null): string => (ms === null ? NA : `${(ms / 1000).toFixed(1)}s`);
const num = (v: number | null): string => (v === null ? NA : String(v));
const usd = (v: number | null): string => (v === null ? NA : `$${v.toFixed(4)}`);
const kilo = (v: number | null): string => (v === null ? NA : v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : String(v));
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const RUN_COLUMNS = ["arm", "id", "app", "mode", "verdict", "error", "total", ...PHASES.filter((p) => p !== "health" && p !== "retry"), "specs", "change-coverage", "reviewer", "cost", "note"] as const;

/** The header of the runs table. */
export const RUN_TABLE_HEADER = `| ${RUN_COLUMNS.join(" | ")} |\n|${RUN_COLUMNS.map(() => "---").join("|")}|`;

/** One markdown table row summarising a run. */
export function renderRunRow(r: ProbeReport): string {
  const specs = r.specs.length === 0 ? "0" : r.specs.map((s) => `${s.path} (${s.lines === null ? NA : `${s.lines} L`})`).join(", ");
  const coverage = r.coverage === null ? NA : `${r.coverage.status} ${r.coverage.ratio === null ? NA : r.coverage.ratio.toFixed(2)}`;
  const reviewer = r.reviewer === null ? NA : r.reviewer.approved === null ? NA : r.reviewer.approved ? "approved" : "rejected";
  const partial = r.totals.turnsWithPartialUsage > 0 ? "*" : "";
  const cells = [
    r.arm, r.id, r.app ?? NA, r.mode ?? NA, r.verdict ?? NA, r.errorClass ?? "none", `${secs(r.totalMs)}${r.finished ? "" : " (running)"}`,
    ...PHASES.filter((p) => p !== "health" && p !== "retry").map((p) => secs(r.phases[p])),
    specs, coverage, reviewer, `${usd(r.totals.costUsd)}${partial}`, clip(r.note ?? "", 80),
  ];
  return `| ${cells.map((c) => cell(String(c))).join(" | ")} |`;
}

const TURN_COLUMNS = ["id", "role", "ended", "wall", "steps", "calls", "before 1st write (calls / time)", "to 1st call", "denied", "tokens in/out/reason/cache", "cost", "prompt B", "redundant / prompt-provided reads", "files read (outside diff dirs / outside brief)", "browser urls"] as const;

/** The header of the per-turn table. */
export const TURN_TABLE_HEADER = `| ${TURN_COLUMNS.join(" | ")} |\n|${TURN_COLUMNS.map(() => "---").join("|")}|`;

/** One markdown row per agent turn of the report. A cost or token figure marked `*` is the last message's alone. */
export function renderTurnRows(r: ProbeReport): string[] {
  return r.turns.map((t) => {
    const partial = t.usage.source === "last-message" ? "*" : "";
    const tools = t.tools;
    const cells = [
      r.id, `${t.role}${t.isRepair ? " (repair)" : ""} #${t.round}`, t.ended ?? NA, secs(t.durationMs),
      `${num(t.stepsUsed)}/${num(t.maxSteps)}`, num(t.calls),
      `${num(t.callsBeforeFirstWrite)} / ${secs(t.msToFirstWrite)}${t.writes === 0 ? " (no write)" : ""}`, secs(t.msToFirstCall), num(t.deniedCalls),
      `${kilo(t.usage.input)}/${kilo(t.usage.output)}/${kilo(t.usage.reasoning)}/${kilo(t.usage.cacheRead)}${partial}`, `${usd(t.usage.cost)}${partial}`,
      num(t.promptBytes), `${num(t.redundantReads)} / ${num(t.promptProvidedReads)}`,
      tools === null ? NA : `${tools.distinctFilesRead} (${num(tools.filesReadOutsideDiffDirs)} / ${num(tools.filesReadOutsideBrief)})`,
      tools === null ? NA : tools.browserUrls.length === 0 ? "0" : `${tools.browserUrls.length}: ${tools.browserUrls.slice(0, 3).join(", ")}${tools.browserUrls.length > 3 ? ", …" : ""}`,
    ];
    return `| ${cells.map((c) => cell(String(c))).join(" | ")} |`;
  });
}

/** Both tables for a set of reports, ready to paste. */
export function renderMarkdown(reports: readonly ProbeReport[]): string {
  const lines = ["### Runs", "", RUN_TABLE_HEADER, ...reports.map(renderRunRow), "", "### Agent turns", "", TURN_TABLE_HEADER, ...reports.flatMap(renderTurnRows)];
  if (reports.some((r) => r.totals.turnsWithPartialUsage > 0)) {
    lines.push("", "`*` tokens and cost of a turn recorded before per-step usage existed: the last assistant message alone, which understates a many-step turn.");
  }
  return lines.join("\n");
}

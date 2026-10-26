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
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { AgentBrowserGateSignal } from "@kernel/agent-browser.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { NoopKind } from "@kernel/noop-kind.ts";
import { DecideCoverageService, type CoverageStatus } from "@contexts/objective-signal/application/index.ts";
import { isContentReadTool } from "@contexts/generation/application/index.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/application/index.ts";
import type { ToolSequenceEntry } from "@contexts/generation/application/index.ts";
import type { TurnCallMetrics } from "@contexts/generation/application/index.ts";
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

/** What a run's diff says about where the agent should have looked. Null when unknown. */
export interface ReadingContext {
  /** Paths of the files the change touched, relative to the working copy. */
  changedFiles: readonly string[] | null;
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
 * outside the directories the diff touched, and which pages it opened.
 * A denied call is counted as denied and is not a read. Null when the turn kept no sequence.
 */
export function summarizeTools(sequence: readonly ToolSequenceEntry[] | null, ctx: ReadingContext): ToolSummary | null {
  if (sequence === null) return null;
  const byTool: Record<string, number> = {};
  for (const entry of sequence) byTool[entry.tool] = (byTool[entry.tool] ?? 0) + 1;

  const reads = [...new Set(sequence.filter((e) => !e.denied && e.target !== null && isContentReadTool(e.tool)).map((e) => e.target as string))];
  const diffDirs = ctx.changedFiles === null ? null : [...new Set(ctx.changedFiles.map(dirOf))];
  const outsideDiff = diffDirs === null ? null : reads.filter((f) => !isUnder(f, ctx.suiteDir) && !diffDirs.some((d) => isUnder(f, d)));
  const urls = [...new Set(sequence.filter((e) => !e.denied && e.target !== null && BROWSER_NAVIGATE.test(e.tool)).map((e) => e.target as string))];

  return {
    listed: sequence.length,
    byTool,
    denied: sequence.filter((e) => e.denied).length,
    distinctFilesRead: reads.length,
    filesReadOutsideDiffDirs: outsideDiff === null ? null : outsideDiff.length,
    outsideDiffDirsSample: (outsideDiff ?? []).slice(0, SAMPLE_SIZE),
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
  /** Re-reads of a file already read, whatever window. */
  sameFileReads: number | null;
  /** Reads of content the prompt already carried. */
  promptProvidedReads: number | null;
  /** Reads of a file the prompt listed by path. */
  pathProvidedReads: number | null;
  /** Reads of source a code-graph answer had already shown. */
  graphProvidedReads: number | null;
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
    sameFileReads: t.sameFileReadCount ?? null,
    promptProvidedReads: t.promptProvidedReadCount ?? null,
    pathProvidedReads: t.pathProvidedReadCount ?? null,
    graphProvidedReads: t.graphProvidedReadCount ?? null,
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
    sameFileReads: m?.sameFileReadCount ?? null,
    promptProvidedReads: m?.promptProvidedReadCount ?? null,
    pathProvidedReads: m?.pathProvidedReadCount ?? null,
    graphProvidedReads: m?.graphProvidedReadCount ?? null,
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
  nested: { domCaptureMs: number | null; reviewMs: number | null };
  turns: ProbeTurn[];
  totals: ProbeTotals;
  specs: ProbeSpec[];
  execution: { passed: number | null; failed: number | null; flaky: number | null } | null;
  coverage: ProbeCoverage | null;
  reviewer: { approved: boolean | null; reasons: string[] } | null;
  /** What the cross-repo stitcher supplied and what the generator's prompt carried of it. Absent in a report made before the figures existed. */
  stitcher?: StitcherMetrics;
  /** How the generator used the run_spec tool and whether the loop ended closed (every delivered spec seen passing in its final bytes). Absent when the run did not grant the tool. */
  closedLoop?: ClosedLoopGateSignal;
  /** How the authoring agents used the authenticated browser: calls, requests the guard refused, sessions lost and renewed. Absent when the run did not grant it. */
  agentBrowser?: AgentBrowserGateSignal;
  /** How the run was coordinated by the lead/sidekick coordination: what became of the plan, the flows delivered and left unfinished, and whether the lead took over. Absent for a run that coordinated nothing (a code run, or one stored before every e2e run was coordinated). */
  coordination?: CoordinationGateSignal;
  /** The reason a declared no-op named (`not-worth`, `unobservable`, or `unspecified` when it named none). Absent for a run that declared none. */
  noop?: { kind: NoopKind };
  /** How the run's evidence scores against a hand-written ground truth (`--ground-truth`); absent when none was given. */
  groundTruth?: GroundTruthScore;
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
  /** The source of each reported spec as it stood on disk; a spec that is gone is null. Read for the routes the specs navigate to. */
  specSources?: ReadonlyMap<string, string | null>;
  /** The context ids the run recorded, by source; absent when the history was not read. */
  contextIds?: ReadonlyArray<{ source: string; ids: readonly string[] }>;
  /** The hand-written ground truth to score the run against, when the operator gave one. */
  groundTruth?: GroundTruth;
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
  const ctx: ReadingContext = { changedFiles: input.changedFiles, suiteDir: input.suiteDir ?? DEFAULT_SUITE_DIR };
  const turns = input.turns.map((t) => toProbeTurn(t, ctx));

  const reviewMs = sumKnown(input.turns.filter((t) => roleIs(t, "reviewer")).map((t) => t.durationMs ?? null));
  const domCaptureMs = phases.grounding;

  const computed = lastEvent(events, "coverage.computed");
  const verdictEvent = lastEvent(events, "reviewer.verdict");
  const hasCoverage = computed !== undefined || (outcome?.gateSignals.coverageRatio ?? null) !== null;
  const reviewerApproved = verdictEvent?.approved ?? outcome?.gateSignals.reviewerApproved ?? null;

  const generatorTurn = input.turns.find((t) => roleIs(t, "author") && !t.isRepair && t.round === 0) ?? input.turns.find((t) => roleIs(t, "author"));
  const specs = reportedSpecs(input);
  const stitcher = stitcherMetrics(outcome?.gateSignals, generatorTurn ? generatorTurn.promptText : null);

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
    nested: { domCaptureMs, reviewMs },
    turns,
    totals: totalsOf(turns),
    specs,
    execution: record
      ? { passed: record.passed ?? null, failed: record.failed ?? null, flaky: events.filter((e) => e.body.type === "test.flaky").length }
      : null,
    coverage: hasCoverage
      ? coverageOf(computed?.changedLines ?? null, computed?.coveredLines ?? null, outcome?.gateSignals.coverageRatio ?? null, input.minRatio)
      : null,
    reviewer: verdictEvent
      ? { approved: verdictEvent.approved, reasons: verdictEvent.reasons }
      : reviewerApproved === null ? null : { approved: reviewerApproved, reasons: outcome?.gateSignals.reviewerCorrections ?? [] },
    stitcher,
    ...(outcome?.gateSignals.closedLoop ? { closedLoop: outcome.gateSignals.closedLoop } : {}),
    ...(outcome?.gateSignals.agentBrowser ? { agentBrowser: outcome.gateSignals.agentBrowser } : {}),
    ...(outcome?.gateSignals.coordination ? { coordination: outcome.gateSignals.coordination } : {}),
    ...(outcome?.gateSignals.noop ? { noop: outcome.gateSignals.noop } : {}),
    ...(input.groundTruth
      ? { groundTruth: scoreGroundTruth(input.groundTruth, { filesRead: contentReadsOf(turns), specSources: specSourcesOf(specs, input.specSources), ...(input.contextIds ? { contextIds: input.contextIds } : {}) }) }
      : {}),
  };
}

/* ── the cross-repo stitcher: what it supplied, and whether the evidence reaches the affected code ──────────────── */

export interface SectionPresence {
  present: boolean;
  /** UTF-8 bytes from the section's heading to the next level-2 heading (or the end): a plain line right after the section may be counted with it. */
  bytes: number;
}

/** The advisory structural sections of a generator prompt. */
export interface PromptSections {
  serviceLinks: SectionPresence;
  structuralBlastRadius: SectionPresence;
  coChange: SectionPresence;
}

export interface StitcherMetrics {
  /** The run's recorded gate signals; null when the run did not record them (no resolver wired, or an arm without a stitcher). Never zero for "not measured". */
  serviceLinksCount: number | null;
  contractDriftCount: number | null;
  structuralSignalBytes: number | null;
  crossRepoImpactedCount: number | null;
  /** What the generator's first-pass prompt carried; null when the prompt text was not recorded. */
  generatorPrompt: PromptSections | null;
}

function sectionOf(prompt: string, title: string): SectionPresence {
  const marker = `## ${title}`;
  const newline = prompt.indexOf(`\n${marker}`);
  const at = prompt.startsWith(marker) ? 0 : newline < 0 ? -1 : newline + 1;
  if (at < 0) return { present: false, bytes: 0 };
  const next = prompt.indexOf("\n## ", at + marker.length);
  return { present: true, bytes: Buffer.byteLength(prompt.slice(at, next < 0 ? prompt.length : next), "utf8") };
}

/** Which advisory structural sections a generator prompt carries, and how large each is. */
export function promptSections(prompt: string): PromptSections {
  return {
    serviceLinks: sectionOf(prompt, PROMPT_HEADINGS.crossServiceLinks),
    structuralBlastRadius: sectionOf(prompt, PROMPT_HEADINGS.structuralBlastRadius),
    coChange: sectionOf(prompt, PROMPT_HEADINGS.coChangeFiles),
  };
}

type GateSignals = {
  serviceLinksCount?: number;
  contractDriftCount?: number;
  structuralSignalBytes?: number;
  crossRepoImpactedCount?: number;
};

/** The stitcher figures of a run: the recorded gate signals (null when absent) and the sections of the generator prompt. */
export function stitcherMetrics(signals: GateSignals | undefined, generatorPrompt: string | null): StitcherMetrics {
  return {
    serviceLinksCount: signals?.serviceLinksCount ?? null,
    contractDriftCount: signals?.contractDriftCount ?? null,
    structuralSignalBytes: signals?.structuralSignalBytes ?? null,
    crossRepoImpactedCount: signals?.crossRepoImpactedCount ?? null,
    generatorPrompt: generatorPrompt === null ? null : promptSections(generatorPrompt),
  };
}

/**
 * What a case's correct answer is, written by hand before any run: the files and routes of the application under test a
 * change affects, and the ones it must not be credited for. Files are repo-relative to the application under test.
 */
export interface GroundTruth {
  affectedFiles: string[];
  affectedRoutes: string[];
  notAffectedFiles: string[];
  /** Routes that must not count as the right target; optional because a spec may pass through them on its way. */
  notAffectedRoutes: string[];
  /** FE↔BE links, as `repo/symbol→repo/symbol` (the same form as the `svc-link:` ids); absent in an older truth file. */
  affectedLinks?: string[];
  notAffectedLinks?: string[];
  /** The data state the expected outcome depends on, written by hand (R4: 0 restaurants means a no-op). */
  devDataState?: { note?: string; resultCount?: number };
  /** The change's identifiable elements, when the case has them. */
  changedElements?: Array<{ testId?: string; role?: string; name?: string }>;
}

/** A ground truth from parsed JSON. Throws, naming the field, on a shape that cannot be scored. */
export function parseGroundTruth(raw: unknown): GroundTruth {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the ground truth must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const list = (key: string, required: boolean): string[] => {
    const value = obj[key];
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) throw new Error(`ground truth '${key}' must be an array of non-empty strings`);
    return (value as string[]).map((v) => v.trim());
  };
  const truth: GroundTruth = {
    affectedFiles: list("affectedFiles", true),
    affectedRoutes: list("affectedRoutes", true),
    notAffectedFiles: list("notAffectedFiles", true),
    notAffectedRoutes: list("notAffectedRoutes", false),
    affectedLinks: list("affectedLinks", false),
    notAffectedLinks: list("notAffectedLinks", false),
  };
  if (truth.affectedFiles.length === 0) throw new Error("ground truth 'affectedFiles' is empty: there is nothing to recall");
  const data = obj["devDataState"];
  if (data !== undefined) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("ground truth 'devDataState' must be an object");
    const note = (data as { note?: unknown }).note;
    const resultCount = (data as { resultCount?: unknown }).resultCount;
    if (note !== undefined && typeof note !== "string") throw new Error("ground truth 'devDataState.note' must be a string");
    if (resultCount !== undefined && (typeof resultCount !== "number" || !Number.isFinite(resultCount))) throw new Error("ground truth 'devDataState.resultCount' must be a number");
    truth.devDataState = { ...(note !== undefined ? { note } : {}), ...(resultCount !== undefined ? { resultCount } : {}) };
  }
  const elements = obj["changedElements"];
  if (elements !== undefined) {
    if (!Array.isArray(elements)) throw new Error("ground truth 'changedElements' must be an array");
    truth.changedElements = elements.map((e, i) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) throw new Error(`ground truth 'changedElements[${i}]' must be an object`);
      const out: { testId?: string; role?: string; name?: string } = {};
      for (const key of ["testId", "role", "name"] as const) {
        const value = (e as Record<string, unknown>)[key];
        if (value !== undefined) {
          if (typeof value !== "string" || value.trim() === "") throw new Error(`ground truth 'changedElements[${i}].${key}' must be a non-empty string`);
          out[key] = value.trim();
        }
      }
      return out;
    });
  }
  return truth;
}

/** One source of evidence scored against the ground truth. */
export interface SourceScore {
  /** What the source is, for the reader: how its items were obtained. */
  basis: string;
  /** Distinct items the source named; null when the source is free text that can only be searched for the judged items. */
  named: number | null;
  /** Affected items the source reached, and the ones it did not. */
  hits: string[];
  misses: string[];
  /** Items the ground truth says are NOT affected that the source named. */
  falsePositives: string[];
  /** Items named that the ground truth neither credits nor rejects; null when `named` is. */
  unjudged: number | null;
  /** hits / (hits + false positives): of the items the ground truth could judge, how many were right. Null when none was judged. */
  precision: number | null;
  /** Named items that are affected / items named: counts the unjudged as wrong. Null when `named` is null or zero. */
  precisionAll: number | null;
  /** hits / affected items. */
  recall: number | null;
}

export interface GroundTruthScore {
  /** The FE↔BE links the stitcher delivered; null when the run recorded no service-links source. */
  stitcherLinks: SourceScore | null;
  /** The routes the change ranking delivered; null when the run recorded no route-ranking source. */
  rankingRoutes: SourceScore | null;
  /** The routes the context map delivered; null when the run recorded no context-map source. */
  mapRoutes: SourceScore | null;
  /** The files the agent read; null when no tool sequence was kept. */
  filesRead: SourceScore | null;
  /** The routes the generated specs navigate to (`goto` literals); null when the specs' source could not be read. */
  specRoutes: (SourceScore & { dynamicGotos: number }) | null;
}

const normalizeFile = (p: string): string => p.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/(?::|#L?)\d+(?:-\d+)?$/, "");

/** A named path is a ground-truth file when it is that path or ends with it at a directory boundary (the agent may name it from the repository root or an absolute path). */
const fileMatches = (truth: string, named: string): boolean => named === truth || named.endsWith(`/${truth}`);

/** A route is a ground-truth route when every segment is equal; a `:param` segment of the truth matches any one segment. */
function routeMatches(truth: string, named: string): boolean {
  const a = truth.split("/");
  const b = named.split("/");
  return a.length === b.length && a.every((seg, i) => (seg.startsWith(":") && seg.length > 1 && b[i] !== "") || seg === b[i]);
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function scoreNamed(basis: string, affected: readonly string[], notAffected: readonly string[], named: readonly string[], matches: (truth: string, named: string) => boolean): SourceScore {
  const hits = affected.filter((a) => named.some((n) => matches(a, n)));
  const falsePositives = notAffected.filter((x) => named.some((n) => matches(x, n)));
  const judged = named.filter((n) => affected.some((a) => matches(a, n)) || notAffected.some((x) => matches(x, n))).length;
  const namedHits = named.filter((n) => affected.some((a) => matches(a, n))).length;
  return {
    basis,
    named: named.length,
    hits,
    misses: affected.filter((a) => !hits.includes(a)),
    falsePositives,
    unjudged: named.length - judged,
    precision: ratio(hits.length, hits.length + falsePositives.length),
    precisionAll: ratio(namedHits, named.length),
    recall: ratio(hits.length, affected.length),
  };
}

/** A route as a spec navigates to it: no origin, query or hash, a leading slash and no trailing one. Null for a URL that cannot be read. */
export function normalizeRoute(raw: string): string | null {
  let path = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = (path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
  return path.startsWith("/") ? path : `/${path}`;
}

const GOTO_LITERAL = /\bgoto\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

/** The routes spec sources navigate to with a `goto` of a literal, in order of first appearance; `dynamic` counts the calls whose argument is built at run time (a template with a substitution), which cannot be scored. */
export function gotoRoutes(sources: readonly string[]): { routes: string[]; dynamic: number } {
  const routes = new Set<string>();
  let dynamic = 0;
  for (const source of sources) {
    for (const match of source.matchAll(GOTO_LITERAL)) {
      const literal = match[1]!;
      if (literal.startsWith("`") && literal.includes("${")) {
        dynamic++;
        continue;
      }
      const route = normalizeRoute(literal.slice(1, -1));
      if (route !== null) routes.add(route);
    }
  }
  return { routes: [...routes], dynamic };
}

/** The distinct files the turns read with a content-read tool (a denied call is not a read); null when no turn kept a tool sequence. */
export function contentReadsOf(turns: readonly ProbeTurn[]): string[] | null {
  const sequences = turns.map((t) => t.toolSequence).filter((s): s is ToolSequenceEntry[] => s !== null);
  if (sequences.length === 0) return null;
  return [...new Set(sequences.flatMap((seq) => seq.filter((e) => !e.denied && e.target !== null && isContentReadTool(e.tool)).map((e) => normalizeFile(e.target as string))))];
}

/** The sources of the specs that could be read; null when specs were reported and none could be read. */
export function specSourcesOf(specs: readonly ProbeSpec[], sources: ReadonlyMap<string, string | null> | undefined): string[] | null {
  if (sources === undefined) return null;
  const read = specs.flatMap((s) => {
    const text = sources.get(s.path);
    return typeof text === "string" ? [text] : [];
  });
  return specs.length > 0 && read.length === 0 ? null : read;
}

export interface GroundTruthEvidence {
  filesRead: readonly string[] | null;
  specSources: readonly string[] | null;
  /** The context ids the run recorded, by source; absent when the history was not read. */
  contextIds?: ReadonlyArray<{ source: string; ids: readonly string[] }>;
}

/** Scores each source of evidence against the ground truth: what it reached (recall), and how much of what it named was right (precision). */
export function scoreGroundTruth(truth: GroundTruth, evidence: GroundTruthEvidence): GroundTruthScore {
  const fileScore = (basis: string, named: readonly string[]): SourceScore => scoreNamed(basis, truth.affectedFiles, truth.notAffectedFiles, named, fileMatches);

  const filesRead = evidence.filesRead === null ? null : fileScore("files read with a content-read tool, by every agent turn", evidence.filesRead);

  const exact = (truthItem: string, named: string): boolean => truthItem === named;
  const affectedLinks = truth.affectedLinks ?? [];
  const notAffectedLinks = truth.notAffectedLinks ?? [];

  const sourceIds = (source: string): readonly string[] | null => evidence.contextIds?.find((c) => c.source === source)?.ids ?? null;
  const stripIds = (ids: readonly string[] | null, prefix: string): string[] | null => ids === null ? null : ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  const stitcherIds = stripIds(sourceIds("service-links"), "svc-link:");
  const stitcherLinks = stitcherIds === null ? null : scoreNamed("FE↔BE links the stitcher delivered", affectedLinks, notAffectedLinks, stitcherIds, exact);
  const rankingIds = stripIds(sourceIds("route-ranking"), "route:");
  const rankingRoutes = rankingIds === null ? null : scoreNamed("routes the change ranking delivered", truth.affectedRoutes, truth.notAffectedRoutes, rankingIds, routeMatches);
  const mapIds = stripIds(sourceIds("context-map"), "route:");
  const mapRoutes = mapIds === null ? null : scoreNamed("routes the context map delivered", truth.affectedRoutes, truth.notAffectedRoutes, mapIds, routeMatches);

  let specRoutes: GroundTruthScore["specRoutes"] = null;
  if (evidence.specSources !== null) {
    const { routes, dynamic } = gotoRoutes(evidence.specSources);
    specRoutes = { ...scoreNamed("page.goto literals of the generated specs", truth.affectedRoutes, truth.notAffectedRoutes, routes, routeMatches), dynamicGotos: dynamic };
  }
  return { stitcherLinks, rankingRoutes, mapRoutes, filesRead, specRoutes };
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

const TURN_COLUMNS = ["id", "role", "ended", "wall", "steps", "calls", "before 1st write (calls / time)", "to 1st call", "denied", "tokens in/out/reason/cache", "cost", "prompt B", "redundant / same-file / prompt-provided reads", "files read (outside diff dirs)", "browser urls"] as const;

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
      num(t.promptBytes), `${num(t.redundantReads)} / ${num(t.sameFileReads)} / ${num(t.promptProvidedReads)}`,
      tools === null ? NA : `${tools.distinctFilesRead} (${num(tools.filesReadOutsideDiffDirs)})`,
      tools === null ? NA : tools.browserUrls.length === 0 ? "0" : `${tools.browserUrls.length}: ${tools.browserUrls.slice(0, 3).join(", ")}${tools.browserUrls.length > 3 ? ", …" : ""}`,
    ];
    return `| ${cells.map((c) => cell(String(c))).join(" | ")} |`;
  });
}

const STITCHER_COLUMNS = ["id", "arm", "service links", "contract drift", "structural signal B", "prompt: service-links B", "prompt: blast-radius B", "prompt: co-change B"] as const;
const GROUND_TRUTH_COLUMNS = ["id", "arm", "source", "named", "hits", "misses", "false positives", "unjudged", "precision", "precision-all", "recall"] as const;

const sectionBytes = (s: SectionPresence | undefined): string => (s === undefined ? NA : s.present ? String(s.bytes) : "absent");
const fixed = (v: number | null): string => (v === null ? NA : v.toFixed(2));

/** The stitcher-signal table and the ground-truth table, for the reports that carry them (nothing when none does). */
export function renderStitcherTables(reports: readonly ProbeReport[]): string[] {
  const withStitcher = reports.filter((r) => r.stitcher !== undefined);
  const withTruth = reports.filter((r) => r.groundTruth !== undefined);
  const lines: string[] = [];
  const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;
  if (withStitcher.length > 0) {
    lines.push("", "### Stitcher signals", "", `| ${STITCHER_COLUMNS.join(" | ")} |`, `|${STITCHER_COLUMNS.map(() => "---").join("|")}|`);
    for (const r of withStitcher) {
      const st = r.stitcher!;
      lines.push(row([r.id, r.arm, num(st.serviceLinksCount), num(st.contractDriftCount), num(st.structuralSignalBytes), sectionBytes(st.generatorPrompt?.serviceLinks), sectionBytes(st.generatorPrompt?.structuralBlastRadius), sectionBytes(st.generatorPrompt?.coChange)]));
    }
  }
  if (withTruth.length > 0) {
    lines.push("", "### Ground truth", "", `| ${GROUND_TRUTH_COLUMNS.join(" | ")} |`, `|${GROUND_TRUTH_COLUMNS.map(() => "---").join("|")}|`);
    for (const r of withTruth) {
      const gt = r.groundTruth!;
      const sources: Array<[string, SourceScore | null]> = [
        ["stitcher links", gt.stitcherLinks],
        ["ranking routes", gt.rankingRoutes],
        ["map routes", gt.mapRoutes],
        ["files read", gt.filesRead],
        ["spec routes", gt.specRoutes],
      ];
      for (const [name, score] of sources) {
        if (score === null) lines.push(row([r.id, r.arm, name, NA, NA, NA, NA, NA, NA, NA, NA]));
        else lines.push(row([r.id, r.arm, name, num(score.named), String(score.hits.length), String(score.misses.length), String(score.falsePositives.length), num(score.unjudged), fixed(score.precision), fixed(score.precisionAll), fixed(score.recall)]));
      }
    }
    lines.push("", "precision = hits / (hits + false positives), over what the ground truth can judge; precision-all = affected items named / items named. A source `n/a` was not available for that run (no tool sequence, no readable spec).");
  }
  return lines;
}

/** Both tables for a set of reports, ready to paste. */
/** What the authenticated browser did in the runs that were granted it: nothing is listed for a run that was not. */
export function renderBrowserLines(reports: readonly ProbeReport[]): string[] {
  const used = reports.filter((r) => r.agentBrowser !== undefined);
  if (used.length === 0) return [];
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    "",
    "### Authenticated browser",
    "",
    ...used.map((r) => {
      const b = r.agentBrowser!;
      return `- ${r.id}: ${plural(b.calls, "call", "calls")}, ${b.blocks} blocked, ${plural(b.invalidations, "session lost", "sessions lost")} (${b.renewals} renewed)`;
    }),
  ];
}

/** How the runs were coordinated: what became of each plan and its flows. A run that recorded no coordination lists nothing. */
export function renderCoordinationLines(reports: readonly ProbeReport[]): string[] {
  const used = reports.filter((r) => r.coordination !== undefined);
  if (used.length === 0) return [];
  return [
    "",
    "### Coordination",
    "",
    ...used.map((r) => {
      const c = r.coordination!;
      const how = c.plan === undefined ? "no plan" : `plan ${c.plan}`;
      const flows = c.flows > 0 ? `, ${c.delivered}/${c.flows} flows delivered${c.incomplete > 0 ? `, ${c.incomplete} unfinished` : ""}` : "";
      return `- ${r.id}: ${how}${flows}${c.refusal ? ` (no author: ${c.refusal})` : ""}${c.authoring ? `, authored with ${c.authoring}` : ""}`;
    }),
  ];
}

/** The kind each declared no-op named: a run that declared none lists nothing. */
export function renderNoopLines(reports: readonly ProbeReport[]): string[] {
  const used = reports.filter((r) => r.noop !== undefined);
  if (used.length === 0) return [];
  return ["", "### No-op", "", ...used.map((r) => `- ${r.id}: ${r.noop!.kind}`)];
}

export function renderMarkdown(reports: readonly ProbeReport[]): string {
  const lines = ["### Runs", "", RUN_TABLE_HEADER, ...reports.map(renderRunRow), "", "### Agent turns", "", TURN_TABLE_HEADER, ...reports.flatMap(renderTurnRows)];
  lines.push(...renderStitcherTables(reports));
  lines.push(...renderBrowserLines(reports));
  lines.push(...renderCoordinationLines(reports));
  lines.push(...renderNoopLines(reports));
  if (reports.some((r) => r.totals.turnsWithPartialUsage > 0)) {
    lines.push("", "`*` tokens and cost of a turn recorded before per-step usage existed: the last assistant message alone, which understates a many-step turn.");
  }
  return lines.join("\n");
}

/* The shared metrics shape of the pipeline-vs-plain-agent experiment: what is derived from a run's
   recorded events and turns, and how an unknown figure is kept apart from a zero. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL, RUN_PHASES, RUN_STAGES } from "@kernel/run-step.ts";
import type { ToolSequenceEntry } from "@contexts/generation/application/index.ts";
import type { AgentTurnRecord } from "../platform/persistence/repositories/telemetry.repository.ts";
import type { RunOutcome, RunRecord } from "../platform/persistence/types.ts";
import {
  DEFAULT_SUITE_DIR, PHASES, buildPipelineReport, contentReadsOf, coverageOf, gotoRoutes, normalizeRoute, parseGroundTruth, phaseDurations, phaseDurationsFromSpans, promptSections, renderMarkdown, renderRunRow, runTimeAccount, RUN_TABLE_HEADER,
  renderNoopLines, scoreGroundTruth, specSourcesOf, stitcherMetrics, summarizeTools, toProbeTurn, turnFromCallMetrics, type GroundTruth, type ReadingContext, type TimedRunEvent,
} from "./probe-metrics.ts";

const step = (ts: number, name: string, detail?: string): TimedRunEvent => ({ ts, body: { type: "step.changed", step: name as "gate", ...(detail ? { detail } : {}) } });
const started = (ts: number): TimedRunEvent => ({ ts, body: { type: "run.started", app: "demo", sha: "abc1234", mode: "diff", target: "e2e" } });
const verdictEvent = (ts: number): TimedRunEvent => ({ ts, body: { type: "run.verdict", verdict: "pass", engineStatus: "success" } });

/* ── phases ── */

test("each phase lasts until the next step change, grounding is the generate step's pre-generation sub-step, and a phase never entered is unknown", () => {
  const events = [
    started(1_000), step(1_010, "gate"), step(3_010, "classify"), step(4_010, "setup"), step(14_010, "generate", PRE_GENERATION_GROUNDING_STEP_DETAIL),
    step(64_010, "generate"), step(364_010, "validate"), step(366_010, "execute"), step(396_010, "decide"), step(397_010, "done"), verdictEvent(397_011),
  ];
  const { totalMs, finished, phases } = phaseDurations(events);
  assert.equal(finished, true);
  assert.equal(totalMs, 396_011);
  assert.equal(phases.gate, 2_000);
  assert.equal(phases.setup, 10_000);
  assert.equal(phases.grounding, 50_000);
  assert.equal(phases.generation, 300_000);
  assert.equal(phases.execute, 30_000);
  assert.equal(phases.decide, 1_000);
  assert.equal(phases.coverage, null, "a phase the run never entered is unknown, not zero");
  assert.equal(phases.retry, null);
});

test("a phase entered twice is the sum of its stretches, and a run that has not reached done is marked unfinished and cut at its last event", () => {
  const events = [started(0), step(0, "generate"), step(1_000, "validate"), step(1_500, "retry", "static-fix round 1/2"), step(4_500, "generate"), step(5_000, "validate"), { ts: 6_000, body: { type: "log.line" as const, level: "info" as const, text: "x" } }];
  const { phases, finished, totalMs } = phaseDurations(events);
  assert.equal(finished, false);
  assert.equal(phases.generation, 1_000 + 500);
  assert.equal(phases.retry, 3_000);
  assert.equal(phases.validate, 500 + 1_000, "the last stretch runs to the last event seen");
  assert.equal(totalMs, 6_000);
});

test("a run with no events has no durations at all", () => {
  const { totalMs, finished, phases } = phaseDurations([]);
  assert.equal(totalMs, null);
  assert.equal(finished, false);
  assert.ok(PHASES.every((p) => phases[p] === null));
});

/* The phase spans of the run's own ledger: the phase cursor's exact start and end, in epoch nanoseconds. */
const ms = (n: number): bigint => BigInt(n) * 1_000_000n;
const phaseSpan = (phase: string, startMs: number, endMs: number | null) => ({ name: `qayaba.phase.${phase}`, startNs: ms(startMs), endNs: endMs === null ? null : ms(endMs) });

test("a phase lasts as long as its span says, whatever the coarse step events of the run showed", () => {
  /* A baseline validate that took 106 s in the span and 3 s between two step events. */
  const spans = [phaseSpan("gate", 0, 2_000), phaseSpan("ground", 2_000, 62_000), phaseSpan("generate", 62_000, 362_000), phaseSpan("validate", 362_000, 468_000), phaseSpan("execute", 468_000, 498_000), phaseSpan("decide", 498_000, 499_000)];
  const from = phaseDurationsFromSpans(spans)!;
  assert.equal(from.phases.gate, 2_000);
  assert.equal(from.phases.grounding, 60_000, "ground is the probe's grounding");
  assert.equal(from.phases.generation, 300_000);
  assert.equal(from.phases.validate, 106_000);
  assert.equal(from.phases.coverage, null, "a phase with no span is unknown, not zero");
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord(), outcome: undefined,
    events: [started(0), step(0, "gate"), step(2_000, "generate"), step(362_000, "validate"), step(365_000, "execute"), step(395_000, "done")],
    turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: spans,
  });
  assert.equal(report.phases.validate, 106_000, "the span, not the 3 s between two step events");
  assert.equal(report.phaseSource, "spans");
});

test("a phase entered twice is the sum of its spans, the fix loop is the probe's retry, and every engine phase is kept by its own name", () => {
  const spans = [phaseSpan("generate", 0, 1_000), phaseSpan("fix_loop", 1_000, 4_000), phaseSpan("generate", 4_000, 4_500), phaseSpan("review", 4_500, 9_000), phaseSpan("publish", 9_000, 9_100), phaseSpan("workspace", 0, 50)];
  const from = phaseDurationsFromSpans(spans)!;
  assert.equal(from.phases.generation, 1_500);
  assert.equal(from.phases.retry, 3_000);
  assert.deepEqual(from.enginePhases, { generate: 1_500, fix_loop: 3_000, review: 4_500, publish: 100, workspace: 50 });
});

test("a phase still open when the report was made is cut at the latest moment the ledger saw", () => {
  const from = phaseDurationsFromSpans([phaseSpan("gate", 0, 2_000), phaseSpan("generate", 2_000, null), { name: "qayaba.exec", startNs: ms(2_500), endNs: ms(7_000) }])!;
  assert.equal(from.phases.gate, 2_000);
  assert.equal(from.phases.generation, 5_000);
});

test("a run whose ledger holds no phase span has none, and the report falls back to the step events and says so", () => {
  assert.equal(phaseDurationsFromSpans([{ name: "qayaba.exec", startNs: ms(0), endNs: ms(10) }]), undefined);
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(), turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: [] });
  assert.equal(report.phaseSource, "events");
  assert.equal(report.phases.grounding, 60_000);
});

/* ── the whole run's time ── */

const runSpan = (startMs: number, endMs: number | null) => ({ name: "qayaba.run", startNs: ms(startMs), endNs: endMs === null ? null : ms(endMs) });
const stageSpan = (stage: string, startMs: number, endMs: number | null) => ({ name: `qayaba.stage.${stage}`, startNs: ms(startMs), endNs: endMs === null ? null : ms(endMs) });

/* The run that showed the gap: 2.5 s on the root, 1.6 s in phases, and the first 0.9 s explained by nothing. */
const skippedRun = [runSpan(0, 2_517), phaseSpan("gate", 918, 924), phaseSpan("workspace", 924, 2_478), phaseSpan("classify", 2_478, 2_513)];

test("a run's time is the root span's, less what its phases hold, less what its stages hold: the rest is named unattributed", () => {
  const account = runTimeAccount(skippedRun)!;
  assert.equal(account.runMs, 2_517);
  assert.equal(account.phasesMs, 1_595);
  assert.equal(account.outsidePhasesMs, 922);
  assert.deepEqual(account.stages, {});
  assert.equal(account.unattributedMs, 922);

  const explained = runTimeAccount([...skippedRun, stageSpan("config", 0, 120), stageSpan("engine_build", 120, 600), stageSpan("sandbox_open", 600, 900)])!;
  assert.deepEqual(explained.stages, { config: 120, engine_build: 480, sandbox_open: 300 });
  assert.equal(explained.stagesMs, 900);
  assert.equal(explained.outsidePhasesMs, 922, "the figure outside the phases does not depend on the stages");
  assert.equal(explained.unattributedMs, 22);
});

test("a stage entered twice is the sum of its spans, and a run span still open is cut at the latest moment the ledger saw", () => {
  const account = runTimeAccount([runSpan(0, null), phaseSpan("gate", 100, 700), stageSpan("teardown", 700, 800), stageSpan("teardown", 800, 850)])!;
  assert.equal(account.stages.teardown, 150);
  assert.equal(account.runMs, 850);
  assert.equal(account.unattributedMs, 100);
});

test("a ledger without the run span has no account: the total stays the step events' and nothing is claimed unattributed", () => {
  assert.equal(runTimeAccount([phaseSpan("gate", 0, 2_000)]), undefined);
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(), turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: [phaseSpan("gate", 0, 2_000)] });
  assert.equal(report.totalSource, "events");
  assert.equal(report.timeAccount, undefined);
  assert.equal(report.stages, undefined);
});

test("a report whose ledger holds the run span takes its total from that span, keeps every field it had, and adds the account", () => {
  const events = [started(0), step(10, "gate"), step(1_710, "done")];
  const spans = [...skippedRun, stageSpan("sandbox_open", 0, 900)];
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events, turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: spans });
  assert.equal(report.totalMs, 2_517, "the root span, not the 1.7 s between the first and the last event");
  assert.equal(report.totalSource, "run-span");
  assert.equal(report.phaseSource, "spans");
  assert.equal(report.phases.gate, 6);
  assert.equal(report.enginePhases?.workspace, 1_554, "the engine's own phase names are kept as they were");
  assert.deepEqual(report.stages, { sandbox_open: 900 });
  assert.equal(report.timeAccount?.unattributedMs, 22);
});

test("a run that ended before its first phase still accounts for its time by its stages", () => {
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: [started(0)], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: [runSpan(0, 800), stageSpan("config", 0, 300)] });
  assert.equal(report.totalMs, 800);
  assert.equal(report.phaseSource, "events", "there is no phase span to read the phases from");
  assert.equal(report.timeAccount?.phasesMs, 0);
  assert.equal(report.timeAccount?.unattributedMs, 500);
});

const accounted = (extra: ReturnType<typeof runSpan>[] = []) =>
  buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(), turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: [...skippedRun, stageSpan("config", 0, 120), ...extra] });

const columnsOf = (markdown: string): string[] => markdown.split("\n").find((l) => l.startsWith("| arm"))!.split("|").map((c) => c.trim()).filter(Boolean);

test("the runs table has a column for every engine phase the run recorded, in the engine's order, and one for the time no span explains", () => {
  const every = RUN_PHASES.map((phase, i) => phaseSpan(phase, i * 10, i * 10 + 5));
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(), turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7, phaseSpans: [runSpan(0, 1_000), ...every, stageSpan("config", 400, 500)] });
  const header = columnsOf(renderMarkdown([report]));
  for (const phase of RUN_PHASES) {
    const shown = header.includes(phase) || header.includes({ ground: "grounding", generate: "generation", fix_loop: "retry" }[phase as string] ?? phase);
    assert.ok(shown, `${phase} has a column`);
  }
  for (const phase of ["workspace", "review", "publish", "learn", "health", "fix_loop"]) assert.ok(header.includes(phase), `${phase}, which the table had no slot for, is a column`);
  assert.ok(header.includes("stage:config"));
  assert.ok(header.includes("unattributed"));
  const order = RUN_PHASES.filter((p) => ["workspace", "health", "fix_loop", "review", "publish", "learn"].includes(p));
  assert.deepEqual(header.filter((c) => order.includes(c as never)), order);
});

test("the unattributed time of the incident run reads off its row", () => {
  const markdown = renderMarkdown([accounted()]);
  const header = columnsOf(markdown);
  const row = markdown.split("\n").find((l) => l.includes(RUN_ID) && l.startsWith("| pipeline"))!.split("|").map((c) => c.trim());
  const cells = row.slice(1, row.length - 1);
  assert.equal(cells[header.indexOf("total")], "2.5s");
  assert.equal(cells[header.indexOf("workspace")], "1.6s");
  assert.equal(cells[header.indexOf("stage:config")], "0.1s");
  assert.equal(cells[header.indexOf("unattributed")], "0.8s");
});

test("a table of reports that recorded no engine phase, stage or run span is the table it always was", () => {
  const base = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(), turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  const lines = renderMarkdown([base]).split("\n");
  assert.equal(lines[2], RUN_TABLE_HEADER.split("\n")[0]);
  assert.equal(lines[4], renderRunRow(base));
  assert.deepEqual(columnsOf(renderMarkdown([base])), ["arm", "id", "app", "mode", "verdict", "error", "total", ...PHASES.filter((p) => p !== "health" && p !== "retry"), "specs", "change-coverage", "reviewer", "cost", "note"]);
  assert.ok(RUN_STAGES.length > 0);
});

test("the agent totals sum every recorded turn, a failed one included, and name the turns whose time was not recorded", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord(), outcome: undefined, events: baseEvents(),
    turns: [
      turnRecord({ role: "qa-author", durationMs: 299_000, cost: 0.5 }),
      turnRecord({ role: "qa-author", round: 1, ended: "aborted", durationMs: 965_000, cost: 0.25 }),
      turnRecord({ role: "qa-author", round: 2, ended: "aborted", durationMs: undefined }),
    ],
    changedFiles: null, specLines: new Map(), minRatio: 0.7,
  });
  assert.equal(report.totals.agentMs, 299_000 + 965_000);
  assert.equal(report.totals.costUsd, 0.75);
  assert.equal(report.totals.turns, 3);
  assert.equal(report.totals.turnsWithoutDuration, 1);
  assert.match(renderMarkdown([report]), /1 of 3 turn\(s\) recorded no duration/);
});

/* ── tools ── */

const ctx = (over: Partial<ReadingContext> = {}): ReadingContext => ({ changedFiles: ["src/orders/checkout.ts", "src/orders/cart.ts"], suiteDir: DEFAULT_SUITE_DIR, ...over });
const read = (target: string): ToolSequenceEntry => ({ tool: "read", target });

test("files read are counted once, split by whether they lie in a diff directory, and the suite directory is not exploration", () => {
  const seq: ToolSequenceEntry[] = [
    read("src/orders/checkout.ts"), read("src/orders/checkout.ts"), read("src/orders/cart.ts"), read("src/payments/charge.ts"),
    read("src/shared/util.ts"), read("e2e/fixtures.ts"), { tool: "grep", target: "createOrder" }, { tool: "read", target: "src/secret.ts", denied: true },
  ];
  const s = summarizeTools(seq, ctx());
  assert.ok(s);
  assert.equal(s.distinctFilesRead, 5, "a denied read is not a read, a repeat is one file");
  assert.equal(s.filesReadOutsideDiffDirs, 2, "payments and shared are outside src/orders; e2e/ is the suite");
  assert.deepEqual(s.outsideDiffDirsSample.sort(), ["src/payments/charge.ts", "src/shared/util.ts"]);
  assert.equal(s.denied, 1);
  assert.equal(s.byTool.read, 7);
});

test("what cannot be judged stays unknown: no diff or no sequence at all", () => {
  const seq = [read("src/a.ts")];
  const noDiff = summarizeTools(seq, ctx({ changedFiles: null }));
  assert.equal(noDiff?.filesReadOutsideDiffDirs, null);
  assert.equal(summarizeTools(null, ctx()), null);
});

test("a change at the repository root makes only root-level files inside its directory", () => {
  const s = summarizeTools([read("README.md"), read("src/deep/file.ts")], ctx({ changedFiles: ["package.json"] }));
  assert.equal(s?.filesReadOutsideDiffDirs, 1);
  assert.deepEqual(s?.outsideDiffDirsSample, ["src/deep/file.ts"]);
});

test("a file outside the working copy is outside the diff's directories", () => {
  const s = summarizeTools([read("/etc/hosts")], ctx());
  assert.equal(s?.filesReadOutsideDiffDirs, 1);
});

test("the pages the agent opened are listed once each, in order, and a denied navigation is not a page", () => {
  const seq: ToolSequenceEntry[] = [
    { tool: "playwright_browser_navigate", target: "https://dev.example.test/a" },
    { tool: "playwright_browser_snapshot", target: null },
    { tool: "playwright_browser_navigate", target: "https://dev.example.test/b" },
    { tool: "playwright_browser_navigate", target: "https://dev.example.test/a" },
    { tool: "playwright_browser_navigate", target: "https://evil.test/", denied: true },
  ];
  assert.deepEqual(summarizeTools(seq, ctx())?.browserUrls, ["https://dev.example.test/a", "https://dev.example.test/b"]);
});

/* ── turns ── */

function turnRecord(over: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    runId: "run-1", sessionId: "s1", role: "qa-author", round: 0, isRepair: false, ts: "2026-10-11T10:00:00.000Z", objective: null,
    promptText: "p", outputText: "o", promptBytes: 1234, tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null,
    ...over,
  };
}

test("a turn's usage prefers the sum over its steps, falls back to the last message marked as partial, and is unknown when nothing was recorded", () => {
  const all = toProbeTurn(turnRecord({ tokensInput: 5, usageTotal: { input: 900, output: 80, reasoning: 7, cacheRead: 4_000, cacheWrite: 1, cost: 0.02, steps: 9 } }), ctx());
  assert.equal(all.usage.source, "all-steps");
  assert.equal(all.usage.input, 900);
  assert.equal(all.usage.cost, 0.02);

  const last = toProbeTurn(turnRecord({ tokensInput: 5, tokensOutput: 6, cost: 0.001 }), ctx());
  assert.equal(last.usage.source, "last-message");
  assert.equal(last.usage.input, 5);
  assert.equal(last.usage.reasoning, null);

  const none = toProbeTurn(turnRecord(), ctx());
  assert.equal(none.usage.source, null);
  assert.equal(none.usage.cost, null);
});

test("a turn recorded before the new columns existed reads every new figure as unknown, never zero", () => {
  const t = toProbeTurn(turnRecord(), ctx());
  assert.equal(t.durationMs, null);
  assert.equal(t.msToFirstWrite, null);
  assert.equal(t.deniedCalls, null);
  assert.equal(t.tools, null);
  assert.equal(t.calls, null);
});

test("a turn measured live carries the same figures as a recorded one, and one nothing observed reads unknown", () => {
  const measured = turnFromCallMetrics(
    {
      role: "qa-baseline", round: 0, isRepair: false, ended: "completed", durationMs: 90_000, maxSteps: 50, promptBytes: 4_000,
      metrics: {
        totalCalls: 12, stepsUsed: 9, observationComplete: true, callsBeforeFirstWrite: 8, writeCount: 1, commandCount: 2, redundantReadCount: 1, sameFileReadCount: 1, duplicateCallCount: 0,
        promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0, buckets: { code_read: 8, code_graph: 0, browser: 2, write: 1, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 0 },
        timeToFirstCallMs: 2_000, timeToFirstWriteMs: 40_000, deniedCallCount: 3, toolSequence: [read("src/orders/checkout.ts"), read("src/other/x.ts")],
        usage: { input: 900, output: 80, reasoning: 0, cacheRead: 4_000, cacheWrite: 0, cost: 0.02, steps: 9 },
      },
    },
    ctx(),
  );
  assert.equal(measured.calls, 12);
  assert.equal(measured.msToFirstWrite, 40_000);
  assert.equal(measured.deniedCalls, 3);
  assert.equal(measured.usage.source, "all-steps");
  assert.equal(measured.tools?.filesReadOutsideDiffDirs, 1);

  const unobserved = turnFromCallMetrics({ role: "qa-baseline", round: 0, isRepair: false, ended: "timeout", durationMs: 600_000, maxSteps: 50, promptBytes: null, metrics: null }, ctx());
  assert.equal(unobserved.calls, null);
  assert.equal(unobserved.usage.cost, null);
  assert.equal(unobserved.tools, null);
});

/* ── coverage ── */

test("coverage is judged against the policy's minimum at its boundary, and unmeasured or empty coverage is unknown", () => {
  const MIN = 0.7;
  assert.equal(coverageOf(10, 7, null, MIN).status, "pass");
  assert.equal(coverageOf(10, 6, null, MIN).status, "fail");
  assert.equal(coverageOf(0, 0, null, MIN).status, "unknown");
  assert.equal(coverageOf(null, null, null, MIN).status, "unknown");
  assert.equal(coverageOf(null, null, 0.9, MIN).status, "pass", "a recorded ratio with no line counts still judges");
  assert.equal(coverageOf(10, 7, null, MIN).ratio, 0.7);
});

/* ── the pipeline report ── */

const RUN_ID = "run-abc1234-xyz";

function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return { id: RUN_ID, app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "done", cases: [], logs: [], at: "2026-10-11T10:00:00.000Z", verdict: "pass", passed: 2, failed: 0, note: "all good", ...over };
}

function outcome(over: Partial<RunOutcome["gateSignals"]> = {}, errorClass: RunOutcome["errorClass"] = null): RunOutcome {
  return {
    runId: RUN_ID, app: "demo", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass", errorClass,
    gateSignals: { static: true, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0, ...over },
    at: "2026-10-11T10:00:00.000Z",
  };
}

const baseEvents = (): TimedRunEvent[] => [
  started(0), step(0, "gate"), step(1_000, "setup"), step(2_000, "generate", PRE_GENERATION_GROUNDING_STEP_DETAIL), step(62_000, "generate"), step(362_000, "execute"), step(392_000, "decide"), step(393_000, "done"),
  { ts: 392_500, body: { type: "spec.written", file: "flows/checkout.spec.ts" } },
  { ts: 392_600, body: { type: "coverage.computed", changedLines: 20, coveredLines: 15 } },
  { ts: 392_700, body: { type: "reviewer.verdict", approved: false, reasons: ["asserts nothing about the total"] } },
  { ts: 392_800, body: { type: "test.flaky", name: "t", attempts: 2 } },
];

test("a pipeline run's report carries its verdict, phases, specs, coverage, reviewer and execution, and reads the grounding as the page capture", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord({ specs: [{ name: "flows/checkout.spec.ts" }] }), outcome: outcome({ reviewerApproved: true }, "E-TIME-BUDGET"),
    events: baseEvents(),
    turns: [
      turnRecord({ role: "qa-author", durationMs: 299_000, timeToFirstWriteMs: 150_000, totalCalls: 29, deniedCallCount: 2, toolSequence: [read("src/orders/checkout.ts"), read("src/shared/x.ts")] }),
      turnRecord({ role: "qa-reviewer", durationMs: 8_000 }),
    ],
    changedFiles: ["src/orders/checkout.ts"], specLines: new Map([["flows/checkout.spec.ts", 84]]), minRatio: 0.7,
  });
  assert.equal(report.arm, "pipeline");
  assert.equal(report.verdict, "pass");
  assert.equal(report.errorClass, "E-TIME-BUDGET");
  assert.equal(report.note, "all good");
  assert.equal(report.finished, true);
  assert.equal(report.phases.grounding, 60_000);
  assert.equal(report.nested.domCaptureMs, 60_000);
  assert.equal(report.nested.reviewMs, 8_000);
  assert.deepEqual(report.specs, [{ path: "flows/checkout.spec.ts", lines: 84 }]);
  assert.equal(report.coverage?.status, "pass", "15 of 20 changed lines meets 0.7");
  assert.equal(report.reviewer?.approved, false, "the verdict event is what the reviewer said; the outcome's flag is only the fallback");
  assert.deepEqual(report.reviewer?.reasons, ["asserts nothing about the total"]);
  assert.equal(report.execution?.passed, 2);
  assert.equal(report.execution?.flaky, 1);
  const generator = report.turns.find((t) => t.role === "qa-author");
  assert.equal(generator?.tools?.filesReadOutsideDiffDirs, 1);
  assert.equal(report.totals.calls, 29, "turns that did not count their calls are left out of the sum");
});

test("a spec whose file is gone is reported with an unknown line count, and a run with neither coverage nor a reviewer says so", () => {
  const events = baseEvents().filter((e) => e.body.type !== "coverage.computed" && e.body.type !== "reviewer.verdict");
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord(), outcome: outcome(), events, turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7,
  });
  assert.deepEqual(report.specs, [{ path: "flows/checkout.spec.ts", lines: null }]);
  assert.equal(report.coverage, null);
  assert.equal(report.reviewer, null);
  assert.equal(report.totals.calls, null);
  assert.equal(report.totals.costUsd, null);
});

test("a run whose records are gone still reports what its outcome kept, with unknown phases", () => {
  const report = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ coverageRatio: 0.4 }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal(report.verdict, "pass");
  assert.equal(report.totalMs, null);
  assert.equal(report.coverage?.status, "fail");
  assert.equal(report.execution, null);
});

test("a pipeline report carries how the generator used run_spec and whether the loop ended closed, and nothing when the run did not grant it", () => {
  const withLoop = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ closedLoop: { calls: 3, devWrites: 2, closed: true } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.deepEqual(withLoop.closedLoop, { calls: 3, devWrites: 2, closed: true });
  const without = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal("closedLoop" in without, false);
});

test("a pipeline report carries the kind of a declared no-op, listed in the markdown, and nothing for a run that is not one", () => {
  const declared = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ noop: { kind: "unobservable" } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.deepEqual(declared.noop, { kind: "unobservable" });
  assert.match(renderNoopLines([declared]).join("\n"), new RegExp(`${RUN_ID}: unobservable`));
  assert.ok(renderMarkdown([declared]).includes("### No-op"));
  const without = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal("noop" in without, false);
  assert.deepEqual(renderNoopLines([without]), []);
});

test("a pipeline report carries how the authoring agents used the browser, and nothing when the run did not grant it", () => {
  const used = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ agentBrowser: { calls: 9, blocks: 2, invalidations: 1, renewals: 1 } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.deepEqual(used.agentBrowser, { calls: 9, blocks: 2, invalidations: 1, renewals: 1 });
  const without = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal("agentBrowser" in without, false);
});

test("the markdown row shows the browser's calls, blocks and lost sessions when the run used it, and a run without it shows none", () => {
  const used = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ agentBrowser: { calls: 9, blocks: 2, invalidations: 1, renewals: 1 } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  const markdown = renderMarkdown([used]);
  assert.match(markdown, /Authenticated browser/);
  assert.match(markdown, /9 calls, 2 blocked, 1 session lost \(1 renewed\)/);
  const without = renderMarkdown([buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 })]);
  assert.doesNotMatch(without, /Authenticated browser/);
});

test("a pipeline report carries how the run was coordinated, and nothing when it was not", () => {
  const signal = { plan: "fanout", flows: 3, delivered: 2, incomplete: 1, authoring: "authenticated-browser" };
  const used = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ coordination: signal }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.deepEqual(used.coordination, signal);
  const without = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal("coordination" in without, false);
});

test("the markdown names how a coordinated run's plan and flows came out, and a run that recorded no coordination lists none", () => {
  const delivered = buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ coordination: { plan: "fanout", flows: 3, delivered: 2, incomplete: 1, authoring: "run-spec-only" } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  const markdown = renderMarkdown([delivered]);
  assert.match(markdown, /Coordination/);
  assert.match(markdown, /plan fanout, 2\/3 flows delivered, 1 unfinished/);
  assert.match(markdown, /authored with run-spec-only/);
  const refusedRun = renderMarkdown([buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome({ coordination: { flows: 0, delivered: 0, incomplete: 0, refusal: "plan-rejected:malformed" } }), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 })]);
  assert.match(refusedRun, /no plan.*no author: plan-rejected:malformed/);
  assert.doesNotMatch(renderMarkdown([buildPipelineReport({ runId: RUN_ID, record: undefined, outcome: outcome(), events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 })]), /Coordination/);
});

/* ── rendering ── */

test("the markdown row names the run and shows every unknown figure as n/a, never 0, and flags partial usage", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord({ status: "running" }), outcome: undefined, events: baseEvents().slice(0, 3), changedFiles: null, specLines: new Map(), minRatio: 0.7,
    turns: [turnRecord({ role: "qa-author", tokensInput: 4_000, tokensOutput: 60, cost: 0.003 })],
  });
  const row = renderRunRow(report);
  assert.ok(row.includes(RUN_ID));
  assert.ok(row.includes("n/a"));
  assert.ok(row.includes("(running)"), "an unfinished run says it is partial");
  assert.ok(row.includes("$0.0030*"), "partial usage is flagged");
  const markdown = renderMarkdown([report]);
  assert.ok(markdown.includes("### Agent turns"));
  assert.ok(markdown.includes("last assistant message alone"));
});

/* ── the stitcher's signals ── */

test("a generator prompt's advisory sections are found by their heading and measured in bytes up to the next level-2 heading", () => {
  const links = ["## Cross-service links (deterministic — from the stitcher, advisory)", "- web/api.ts#create -> orders-service", "", "### Contract drift (WARNINGS)", "- WARNING: web/x.ts calls POST /nope"].join("\n");
  const prompt = ["## Working rules", "rules", links, "## Structural blast radius (deterministic — from the code graph, advisory)", "- `A.b` (src/a.ts)", "## Task", "do it"].join("\n");
  const sections = promptSections(prompt);
  assert.deepEqual(sections.serviceLinks, { present: true, bytes: Buffer.byteLength(links, "utf8") }, "a ### sub-heading belongs to its section; the bytes are UTF-8, not characters");
  assert.equal(sections.structuralBlastRadius.present, true);
  assert.equal(sections.structuralBlastRadius.bytes, Buffer.byteLength("## Structural blast radius (deterministic — from the code graph, advisory)\n- `A.b` (src/a.ts)", "utf8"));
  assert.deepEqual(sections.coChange, { present: false, bytes: 0 });
});

test("a section that opens the prompt is found, and a heading quoted mid-line is not a section", () => {
  assert.equal(promptSections("## Files that historically change together (git history, advisory)\n- a.ts").coChange.present, true);
  assert.equal(promptSections("see the ## Cross-service links above").serviceLinks.present, false);
});

test("the stitcher's figures are the run's recorded signals, unknown when it recorded none, and a recorded zero stays a zero", () => {
  const none = stitcherMetrics(undefined, null);
  assert.deepEqual(none, { serviceLinksCount: null, contractDriftCount: null, structuralSignalBytes: null, crossRepoImpactedCount: null, generatorPrompt: null });
  const zero = stitcherMetrics({ serviceLinksCount: 0, contractDriftCount: 0 }, "no sections here");
  assert.equal(zero.serviceLinksCount, 0);
  assert.equal(zero.contractDriftCount, 0);
  assert.equal(zero.structuralSignalBytes, null);
  assert.equal(zero.generatorPrompt?.serviceLinks.present, false);
});

/* ── the ground truth ── */

const TRUTH: GroundTruth = {
  affectedFiles: ["src/app/features/cart/api/cart.api.ts", "src/app/features/cart/stores/cart.store.ts", "src/app/features/cart/pages/cart-form/cart-form.page.ts"],
  affectedRoutes: ["/cart/new"],
  notAffectedFiles: ["src/app/features/home/picker.component.ts"],
  notAffectedRoutes: ["/cart/:id/view"],
};

test("a ground truth needs its three lists, a non-empty set of affected files and strings only; other keys and an absent notAffectedRoutes are fine", () => {
  const ok = parseGroundTruth({ affectedFiles: ["a.ts"], affectedRoutes: [], notAffectedFiles: [], note: "free text" });
  assert.deepEqual(ok.notAffectedRoutes, []);
  for (const bad of [null, [], { affectedFiles: ["a.ts"], affectedRoutes: [] }, { affectedFiles: [], affectedRoutes: [], notAffectedFiles: [] }, { affectedFiles: ["a.ts", 3], affectedRoutes: [], notAffectedFiles: [] }, { affectedFiles: ["a.ts"], affectedRoutes: "/x", notAffectedFiles: [] }]) {
    assert.throws(() => parseGroundTruth(bad), /ground truth/, JSON.stringify(bad));
  }
});

test("routes are read from the literals a spec navigates to, without origin, query or trailing slash, and a route built at run time is counted apart", () => {
  const spec = [
    "await page.goto('/cart/new');",
    'await page.goto("https://dev.example.test/cart/new/?x=1#top");',
    "await page.goto(`/cart/list`);",
    "await page.goto(`/cart/${id}/edit`);",
    "await page.goto(baseUrl + '/x');",
    "await page.goto('cart/other');",
  ].join("\n");
  assert.deepEqual(gotoRoutes([spec]), { routes: ["/cart/new", "/cart/list", "/cart/other"], dynamic: 1 });
  assert.equal(normalizeRoute("https://dev.example.test"), "/");
  assert.equal(normalizeRoute("/"), "/");
});

test("files read match the truth from the repository root, an absolute path or with a line suffix, a file with only the same name does not, and a denied read is no read", () => {
  const turns = [
    toProbeTurn(turnRecord({ toolSequence: [read("/app/.mirrors/org__web/src/app/features/cart/api/cart.api.ts"), read("src/app/features/cart/stores/cart.store.ts:41"), read("src/other/cart.api.ts"), { tool: "read", target: "src/app/features/cart/pages/cart-form/cart-form.page.ts", denied: true }, { tool: "grep", target: "cart" }] }), ctx()),
    toProbeTurn(turnRecord({ role: "qa-reviewer", toolSequence: [read("src/app/features/home/picker.component.ts")] }), ctx()),
  ];
  const filesRead = contentReadsOf(turns);
  assert.ok(filesRead);
  const score = scoreGroundTruth(TRUTH, { filesRead, specSources: null }).filesRead;
  assert.deepEqual(score?.hits, ["src/app/features/cart/api/cart.api.ts", "src/app/features/cart/stores/cart.store.ts"]);
  assert.deepEqual(score?.misses, ["src/app/features/cart/pages/cart-form/cart-form.page.ts"]);
  assert.deepEqual(score?.falsePositives, ["src/app/features/home/picker.component.ts"]);
  assert.equal(score?.named, 4);
  assert.equal(score?.unjudged, 1);
});

test("a source that was not observed is unknown, not a zero score: no tool sequence, no readable spec", () => {
  const unseen = scoreGroundTruth(TRUTH, { filesRead: contentReadsOf([toProbeTurn(turnRecord(), ctx())]), specSources: null });
  assert.deepEqual(unseen, { stitcherLinks: null, rankingRoutes: null, mapRoutes: null, filesRead: null, specRoutes: null });
  const noSpecs = scoreGroundTruth(TRUTH, { filesRead: null, specSources: [] }).specRoutes;
  assert.equal(noSpecs?.recall, 0, "no spec navigated anywhere: every affected route was missed");
  assert.equal(noSpecs?.precision, null);
  assert.equal(noSpecs?.precisionAll, null);
  assert.equal(specSourcesOf([{ path: "a.spec.ts", lines: 3 }], new Map([["a.spec.ts", null]])), null);
  assert.deepEqual(specSourcesOf([], new Map()), []);
});

test("spec routes match the affected route with its parameters, and a route the truth rejects is a false positive", () => {
  const specs = ["await page.goto('/cart/new');\nawait page.goto('/cart/7/view');\nawait page.goto('/login');"];
  const score = scoreGroundTruth(TRUTH, { filesRead: null, specSources: specs }).specRoutes;
  assert.deepEqual(score?.hits, ["/cart/new"]);
  assert.deepEqual(score?.falsePositives, ["/cart/:id/view"]);
  assert.equal(score?.unjudged, 1);
  assert.equal(score?.precision, 0.5);
  assert.ok(Math.abs((score?.precisionAll ?? 0) - 1 / 3) < 1e-9);
  assert.equal(score?.recall, 1);
});

test("a pipeline report carries the stitcher's signals, the sections of the generator's first-pass prompt and the ground-truth score of its evidence", () => {
  const prompt = "## Working rules\nr\n## Cross-service links (deterministic — from the stitcher, advisory)\n- a -> b\n## Task\nt";
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord({ specs: [{ name: "flows/cart.spec.ts" }] }), outcome: outcome({ serviceLinksCount: 4, contractDriftCount: 0, structuralSignalBytes: 900 }),
    events: baseEvents(), changedFiles: ["svc/Handler.java"], specLines: new Map(), minRatio: 0.7, groundTruth: TRUTH,
    specSources: new Map([["flows/cart.spec.ts", "await page.goto('/cart/new');"]]),
    turns: [
      turnRecord({ role: "qa-author", promptText: prompt, toolSequence: [read("src/app/features/cart/api/cart.api.ts"), read("src/app/features/cart/pages/cart-form/cart-form.page.ts")] }),
      turnRecord({ role: "qa-author", round: 1, isRepair: true, promptText: "## Task\nfix" }),
    ],
  });
  assert.equal(report.stitcher?.serviceLinksCount, 4);
  assert.equal(report.stitcher?.contractDriftCount, 0);
  assert.equal(report.stitcher?.structuralSignalBytes, 900);
  assert.equal(report.stitcher?.generatorPrompt?.serviceLinks.present, true, "the first generator pass, not the repair");
  assert.equal(report.groundTruth?.filesRead?.recall, 2 / 3, "every read of the generator counts as the agent reading");
  assert.equal(report.groundTruth?.specRoutes?.recall, 1);
});

test("a pipeline report without a ground truth carries none, and one with no recorded stitcher signals reads them unknown", () => {
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: outcome(), events: baseEvents(), turns: [turnRecord({ role: "qa-author" })], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal(report.groundTruth, undefined);
  assert.equal(report.stitcher?.serviceLinksCount, null);
  assert.equal(report.stitcher?.generatorPrompt?.serviceLinks.present, false);
});

test("the markdown shows the stitcher table and the ground-truth table, an unavailable source as n/a", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord(), outcome: outcome({ serviceLinksCount: 4 }), events: baseEvents(), changedFiles: null, specLines: new Map(), minRatio: 0.7, groundTruth: TRUTH,
    turns: [turnRecord({ role: "qa-author", promptText: "## Cross-service links (x)\nl" })],
  });
  const markdown = renderMarkdown([report]);
  assert.ok(markdown.includes("### Stitcher signals"));
  assert.ok(markdown.includes("### Ground truth"));
  assert.ok(markdown.includes("| stitcher links | n/a |"), "a source that was not observed reads n/a");
  assert.equal(renderMarkdown([buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 })]).includes("### Ground truth"), false);
});

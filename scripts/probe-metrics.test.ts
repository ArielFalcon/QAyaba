/* The shared metrics shape of the pipeline-vs-plain-agent experiment: what is derived from a run's
   recorded events and turns, and how an unknown figure is kept apart from a zero. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { EXPLORER_AGENT_NAME } from "@contexts/generation/domain/explorer-agent.ts";
import type { ToolSequenceEntry } from "@contexts/generation/domain/tool-sequence.ts";
import type { AgentTurnRecord } from "../src/server/history.ts";
import type { RunOutcome, RunRecord } from "../src/types.ts";
import {
  DEFAULT_SUITE_DIR, PHASES, buildPipelineReport, contentReadsOf, coverageOf, gotoRoutes, normalizeRoute, parseGroundTruth, phaseDurations, promptSections, renderMarkdown, renderRunRow,
  scoreGroundTruth, specSourcesOf, stitcherMetrics, summarizeTools, toProbeTurn, turnFromCallMetrics, type GroundTruth, type ReadingContext, type TimedRunEvent,
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

/* ── tools ── */

const ctx = (over: Partial<ReadingContext> = {}): ReadingContext => ({ changedFiles: ["src/orders/checkout.ts", "src/orders/cart.ts"], briefText: "Blast radius: src/orders/checkout.ts and src/payments/charge.ts", suiteDir: DEFAULT_SUITE_DIR, ...over });
const read = (target: string): ToolSequenceEntry => ({ tool: "read", target });

test("files read are counted once, split by whether they lie in a diff directory and whether the brief names them, and the suite directory is not exploration", () => {
  const seq: ToolSequenceEntry[] = [
    read("src/orders/checkout.ts"), read("src/orders/checkout.ts"), read("src/orders/cart.ts"), read("src/payments/charge.ts"),
    read("src/shared/util.ts"), read("e2e/fixtures.ts"), { tool: "grep", target: "createOrder" }, { tool: "read", target: "src/secret.ts", denied: true },
  ];
  const s = summarizeTools(seq, ctx());
  assert.ok(s);
  assert.equal(s.distinctFilesRead, 5, "a denied read is not a read, a repeat is one file");
  assert.equal(s.filesReadOutsideDiffDirs, 2, "payments and shared are outside src/orders; e2e/ is the suite");
  assert.deepEqual(s.outsideDiffDirsSample.sort(), ["src/payments/charge.ts", "src/shared/util.ts"]);
  assert.equal(s.filesReadOutsideBrief, 2, "cart.ts and util.ts are not in the brief; checkout and charge are, and the suite is not counted");
  assert.equal(s.denied, 1);
  assert.equal(s.byTool.read, 7);
});

test("what cannot be judged stays unknown: no diff, no brief, or no sequence at all", () => {
  const seq = [read("src/a.ts")];
  const noDiff = summarizeTools(seq, ctx({ changedFiles: null }));
  assert.equal(noDiff?.filesReadOutsideDiffDirs, null);
  assert.equal(noDiff?.filesReadOutsideBrief, 1);
  assert.equal(summarizeTools(seq, ctx({ briefText: null }))?.filesReadOutsideBrief, null);
  assert.equal(summarizeTools(null, ctx()), null);
});

test("a change at the repository root makes only root-level files inside its directory", () => {
  const s = summarizeTools([read("README.md"), read("src/deep/file.ts")], ctx({ changedFiles: ["package.json"], briefText: null }));
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
    runId: "run-1", sessionId: "s1", role: "qa-generator", round: 0, isRepair: false, ts: "2026-10-11T10:00:00.000Z", objective: null,
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
        totalCalls: 12, stepsUsed: 9, observationComplete: true, callsBeforeFirstWrite: 8, writeCount: 1, commandCount: 2, redundantReadCount: 1, duplicateCallCount: 0,
        promptProvidedReadCount: 0, pathProvidedReadCount: 0, buckets: { code_read: 8, browser: 2, write: 1, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 0 },
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
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, ...over },
    rulesRetrieved: [], at: "2026-10-11T10:00:00.000Z",
  };
}

const baseEvents = (): TimedRunEvent[] => [
  started(0), step(0, "gate"), step(1_000, "setup"), step(2_000, "generate", PRE_GENERATION_GROUNDING_STEP_DETAIL), step(62_000, "generate"), step(362_000, "execute"), step(392_000, "decide"), step(393_000, "done"),
  { ts: 392_500, body: { type: "spec.written", file: "flows/checkout.spec.ts" } },
  { ts: 392_600, body: { type: "coverage.computed", changedLines: 20, coveredLines: 15 } },
  { ts: 392_700, body: { type: "reviewer.verdict", approved: false, reasons: ["asserts nothing about the total"] } },
  { ts: 392_800, body: { type: "test.flaky", name: "t", attempts: 2 } },
];

test("a pipeline run's report carries its verdict, phases, specs, coverage, reviewer and execution, and splits grounding into the explorer and the page capture", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord({ specs: [{ name: "flows/checkout.spec.ts" }] }), outcome: outcome({ reviewerApproved: true }, "E-TIME-BUDGET"),
    events: baseEvents(),
    turns: [
      turnRecord({ role: EXPLORER_AGENT_NAME, durationMs: 45_000, outputText: "Blast radius: src/orders/checkout.ts" }),
      turnRecord({ role: "qa-generator", durationMs: 299_000, timeToFirstWriteMs: 150_000, totalCalls: 29, deniedCallCount: 2, toolSequence: [read("src/orders/checkout.ts"), read("src/shared/x.ts")] }),
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
  assert.equal(report.nested.explorerMs, 45_000);
  assert.equal(report.nested.domCaptureMs, 15_000);
  assert.equal(report.nested.reviewMs, 8_000);
  assert.deepEqual(report.specs, [{ path: "flows/checkout.spec.ts", lines: 84 }]);
  assert.equal(report.coverage?.status, "pass", "15 of 20 changed lines meets 0.7");
  assert.equal(report.reviewer?.approved, false, "the verdict event is what the reviewer said; the outcome's flag is only the fallback");
  assert.deepEqual(report.reviewer?.reasons, ["asserts nothing about the total"]);
  assert.equal(report.execution?.passed, 2);
  assert.equal(report.execution?.flaky, 1);
  const generator = report.turns.find((t) => t.role === "qa-generator");
  assert.equal(generator?.tools?.filesReadOutsideDiffDirs, 1);
  assert.equal(generator?.tools?.filesReadOutsideBrief, 1, "the brief is the explorer's output of the same run");
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

/* ── rendering ── */

test("the markdown row names the run and shows every unknown figure as n/a, never 0, and flags partial usage", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord({ status: "running" }), outcome: undefined, events: baseEvents().slice(0, 3), changedFiles: null, specLines: new Map(), minRatio: 0.7,
    turns: [turnRecord({ role: "qa-generator", tokensInput: 4_000, tokensOutput: 60, cost: 0.003 })],
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

test("the brief's blast radius is scored by the files it lists: hits, misses, a named file the truth rejects, and the files it names that the truth cannot judge", () => {
  const brief = JSON.stringify({ blastRadius: [
    { symbol: "CartApi.create", file: "src/app/features/cart/api/cart.api.ts", role: "posts the cart" },
    { symbol: "Picker", file: "src/app/features/home/picker.component.ts", role: "reads carts" },
    { symbol: "Other", file: "src/app/features/other/other.ts", role: "x" },
  ] });
  const score = scoreGroundTruth(TRUTH, { briefText: brief, filesRead: null, specSources: null }).briefBlastRadius;
  assert.ok(score);
  assert.deepEqual(score.hits, ["src/app/features/cart/api/cart.api.ts"]);
  assert.deepEqual(score.misses, ["src/app/features/cart/stores/cart.store.ts", "src/app/features/cart/pages/cart-form/cart-form.page.ts"]);
  assert.deepEqual(score.falsePositives, ["src/app/features/home/picker.component.ts"]);
  assert.equal(score.named, 3);
  assert.equal(score.unjudged, 1);
  assert.equal(score.precision, 0.5, "of the two files the truth can judge, one was right");
  assert.ok(Math.abs((score.precisionAll ?? 0) - 1 / 3) < 1e-9, "counting the unjudged file as wrong");
  assert.ok(Math.abs((score.recall ?? 0) - 1 / 3) < 1e-9);
});

test("a brief that is not the expected JSON is searched for the judged files only, and says it cannot count what it named", () => {
  const score = scoreGroundTruth(TRUTH, { briefText: "Look at src/app/features/cart/stores/cart.store.ts and src/app/features/home/picker.component.ts.", filesRead: null, specSources: null }).briefBlastRadius;
  assert.deepEqual(score?.hits, ["src/app/features/cart/stores/cart.store.ts"]);
  assert.deepEqual(score?.falsePositives, ["src/app/features/home/picker.component.ts"]);
  assert.equal(score?.named, null);
  assert.equal(score?.unjudged, null);
  assert.equal(score?.precisionAll, null);
});

test("files read match the truth from the repository root, an absolute path or with a line suffix, a file with only the same name does not, and a denied read is no read", () => {
  const turns = [
    toProbeTurn(turnRecord({ toolSequence: [read("/app/.mirrors/org__web/src/app/features/cart/api/cart.api.ts"), read("src/app/features/cart/stores/cart.store.ts:41"), read("src/other/cart.api.ts"), { tool: "read", target: "src/app/features/cart/pages/cart-form/cart-form.page.ts", denied: true }, { tool: "grep", target: "cart" }] }), ctx()),
    toProbeTurn(turnRecord({ role: "qa-reviewer", toolSequence: [read("src/app/features/home/picker.component.ts")] }), ctx()),
  ];
  const filesRead = contentReadsOf(turns);
  assert.ok(filesRead);
  const score = scoreGroundTruth(TRUTH, { briefText: null, filesRead, specSources: null }).filesRead;
  assert.deepEqual(score?.hits, ["src/app/features/cart/api/cart.api.ts", "src/app/features/cart/stores/cart.store.ts"]);
  assert.deepEqual(score?.misses, ["src/app/features/cart/pages/cart-form/cart-form.page.ts"]);
  assert.deepEqual(score?.falsePositives, ["src/app/features/home/picker.component.ts"]);
  assert.equal(score?.named, 4);
  assert.equal(score?.unjudged, 1);
});

test("a source that was not observed is unknown, not a zero score: no brief, no tool sequence, no readable spec", () => {
  const unseen = scoreGroundTruth(TRUTH, { briefText: null, filesRead: contentReadsOf([toProbeTurn(turnRecord(), ctx())]), specSources: null });
  assert.deepEqual(unseen, { briefBlastRadius: null, filesRead: null, specRoutes: null });
  const noSpecs = scoreGroundTruth(TRUTH, { briefText: null, filesRead: null, specSources: [] }).specRoutes;
  assert.equal(noSpecs?.recall, 0, "no spec navigated anywhere: every affected route was missed");
  assert.equal(noSpecs?.precision, null);
  assert.equal(noSpecs?.precisionAll, null);
  assert.equal(specSourcesOf([{ path: "a.spec.ts", lines: 3 }], new Map([["a.spec.ts", null]])), null);
  assert.deepEqual(specSourcesOf([], new Map()), []);
});

test("spec routes match the affected route with its parameters, and a route the truth rejects is a false positive", () => {
  const specs = ["await page.goto('/cart/new');\nawait page.goto('/cart/7/view');\nawait page.goto('/login');"];
  const score = scoreGroundTruth(TRUTH, { briefText: null, filesRead: null, specSources: specs }).specRoutes;
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
      turnRecord({ role: EXPLORER_AGENT_NAME, outputText: JSON.stringify({ blastRadius: [{ symbol: "S", file: "src/app/features/cart/stores/cart.store.ts", role: "r" }] }), toolSequence: [read("src/app/features/cart/api/cart.api.ts")] }),
      turnRecord({ role: "qa-generator", promptText: prompt, toolSequence: [read("src/app/features/cart/pages/cart-form/cart-form.page.ts")] }),
      turnRecord({ role: "qa-generator", round: 1, isRepair: true, promptText: "## Task\nfix" }),
    ],
  });
  assert.equal(report.stitcher?.serviceLinksCount, 4);
  assert.equal(report.stitcher?.contractDriftCount, 0);
  assert.equal(report.stitcher?.structuralSignalBytes, 900);
  assert.equal(report.stitcher?.generatorPrompt?.serviceLinks.present, true, "the first generator pass, not the repair");
  assert.equal(report.groundTruth?.briefBlastRadius?.recall, 1 / 3);
  assert.equal(report.groundTruth?.filesRead?.recall, 2 / 3, "the explorer's read and the generator's both count as the agent reading");
  assert.equal(report.groundTruth?.specRoutes?.recall, 1);
});

test("a pipeline report without a ground truth carries none, and one with no recorded stitcher signals reads them unknown", () => {
  const report = buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: outcome(), events: baseEvents(), turns: [turnRecord({ role: "qa-generator" })], changedFiles: null, specLines: new Map(), minRatio: 0.7 });
  assert.equal(report.groundTruth, undefined);
  assert.equal(report.stitcher?.serviceLinksCount, null);
  assert.equal(report.stitcher?.generatorPrompt?.serviceLinks.present, false);
});

test("the markdown shows the stitcher table and the ground-truth table, an unavailable source as n/a", () => {
  const report = buildPipelineReport({
    runId: RUN_ID, record: runRecord(), outcome: outcome({ serviceLinksCount: 4 }), events: baseEvents(), changedFiles: null, specLines: new Map(), minRatio: 0.7, groundTruth: TRUTH,
    turns: [turnRecord({ role: "qa-generator", promptText: "## Cross-service links (x)\nl" })],
  });
  const markdown = renderMarkdown([report]);
  assert.ok(markdown.includes("### Stitcher signals"));
  assert.ok(markdown.includes("### Ground truth"));
  assert.ok(markdown.includes("| brief blast radius | n/a |"), "a source that was not observed reads n/a");
  assert.equal(renderMarkdown([buildPipelineReport({ runId: RUN_ID, record: runRecord(), outcome: undefined, events: [], turns: [], changedFiles: null, specLines: new Map(), minRatio: 0.7 })]).includes("### Ground truth"), false);
});

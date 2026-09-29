/* Freezing a label's runs into a snapshot (the only thing `report` reads), because the runs' own
   events and turns are pruned after 30 days. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureRun,
  readRegistry,
  readSnapshot,
  registerRun,
  takeSnapshot,
  writeSnapshot,
  type RunDataSource,
} from "./efficiency-benchmark.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import type { RunEventBody } from "@kernel/contract/events.ts";
import type { RunOutcome, RunRecord } from "../src/types.ts";
import type { AgentTurnRecord } from "../src/server/history.ts";

const activity = (callId: string, kind: "analyzing" | "writing" | "command" | "subagent"): RunEventBody => ({
  type: "agent.activity", kind, target: "t", status: "completed", callId,
});
const step = (detail?: string): RunEventBody => ({ type: "step.changed", step: "generate", ...(detail ? { detail } : {}) });

const events: RunEventBody[] = [
  step(PRE_GENERATION_GROUNDING_STEP_DETAIL),
  activity("e1", "analyzing"),
  step(),
  activity("g1", "analyzing"),
  activity("g2", "analyzing"),
  activity("g3", "writing"),
  activity("g4", "command"),
  { type: "spec.written", file: "a.spec.ts" },
];

function outcome(overrides: Partial<RunOutcome["gateSignals"]> = {}, verdict: RunOutcome["verdict"] = "pass"): RunOutcome {
  return {
    runId: "run-1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e", verdict, errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.8, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0, ...overrides },
    rulesRetrieved: [], at: "2026-09-28T10:00:00.000Z",
  };
}

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1", app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "done", verdict: "pass",
  passed: 3, failed: 0, cases: [], logs: [], at: "2026-09-28T10:00:00.000Z", ...overrides,
});

const generatorTurn = (outputText: string, overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord => ({
  runId: "run-1", sessionId: "s", role: "qa-generator", round: 0, isRepair: false, ts: "2026-09-28T10:00:00.000Z", objective: null,
  promptText: "p", outputText, promptBytes: 1, tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null,
  ...overrides,
});

function source(over: Partial<{ events: RunEventBody[]; outcome: RunOutcome; record: RunRecord; turns: AgentTurnRecord[] }> = {}): RunDataSource {
  const data = { events, outcome: outcome(), record: record(), turns: [generatorTurn("all done")], ...over };
  return { events: () => data.events, outcome: () => data.outcome, record: () => data.record, turns: () => data.turns };
}

test("a run is measured coarsely from its events, excluding the grounding sub-step from the first pass", () => {
  const measured = measureRun("run-1", source())!;
  assert.equal(measured.coarse.firstPass.totalCalls, 4);
  assert.equal(measured.coarse.firstPass.callsBeforeFirstWrite, 2);
  assert.equal(measured.coarse.firstPass.writeCount, 1);
  assert.equal(measured.coarse.firstPass.commandCount, 1);
  assert.equal(measured.coarse.grounding.totalCalls, 1);
});

test("the guardrails are read from the run's recorded outcome and result", () => {
  const { guardrails } = measureRun("run-1", source())!;
  assert.deepEqual(guardrails, {
    verdict: "pass", specsProduced: 1, staticPass: true, executePass: true, coverageRatio: 0.8, reviewerApproved: true,
  });
});

test("a run that executed nothing has a null execute result, and a failing execution is false", () => {
  const notExecuted = measureRun("run-1", source({ record: record({ passed: 0, failed: 0 }) }))!;
  assert.equal(notExecuted.guardrails.executePass, null);
  const failing = measureRun("run-1", source({ record: record({ passed: 2, failed: 1 }) }))!;
  assert.equal(failing.guardrails.executePass, false);
});

test("an unmeasured coverage or an absent reviewer verdict stays null, never a fabricated value", () => {
  const { guardrails } = measureRun("run-1", source({ outcome: outcome({ coverageRatio: null, reviewerApproved: undefined }) }))!;
  assert.equal(guardrails.coverageRatio, null);
  assert.equal(guardrails.reviewerApproved, null);
});

test("exhaustion is detected in the generator's output, and is false for a generator that finished", () => {
  const exhausted = measureRun("run-1", source({
    turns: [generatorTurn("CRITICAL - MAXIMUM STEPS REACHED. The maximum number of steps allowed for this task has been reached.")],
  }))!;
  assert.equal(exhausted.exhausted, true);
  assert.equal(measureRun("run-1", source())!.exhausted, false);
});

test("exhaustion is null for a Codex primary (no step budget) and when the run has no generator turn", () => {
  const codex = measureRun("run-1", source({
    outcome: outcome({ usage: { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, complete: false, primaryProvider: "codex" } }),
    turns: [generatorTurn("The maximum number of steps allowed for this task has been reached.")],
  }))!;
  assert.equal(codex.exhausted, null);
  assert.equal(measureRun("run-1", source({ turns: [] }))!.exhausted, null);
});

test("a run whose data has been pruned measures to null", () => {
  const gone: RunDataSource = { events: () => [], outcome: () => undefined, record: () => undefined, turns: () => [] };
  assert.equal(measureRun("run-gone", gone), null);
});

/* The run's outcome row is never pruned, while its events, run record and turns age out after 30 days:
   what remains of an old run is an outcome and nothing to measure calls from. */
const outcomeOnlySource = (): RunDataSource => ({
  events: () => [],
  outcome: () => outcome(),
  record: () => undefined,
  turns: () => [],
});

test("a run whose events are gone but whose outcome row remains is not measured as a run that made no calls", () => {
  assert.equal(measureRun("run-old", outcomeOnlySource()), null);
});

function resultsDir(t: import("node:test").TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "efficiency-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "results");
}

test("a snapshot covers every case registered under the label, with a null entry for a run whose data is gone", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "kept", "run-1");
  registerRun(dir, "baseline", "pruned", "run-2");
  const sources: Record<string, RunDataSource> = {
    "run-1": source(),
    "run-2": { events: () => [], outcome: () => undefined, record: () => undefined, turns: () => [] },
  };

  const snapshot = takeSnapshot("baseline", dir, (runId) => sources[runId]!, () => "2026-09-28T12:00:00.000Z");

  assert.equal(snapshot.label, "baseline");
  assert.equal(snapshot.takenAt, "2026-09-28T12:00:00.000Z");
  assert.equal(snapshot.cases.kept!.runId, "run-1");
  assert.notEqual(snapshot.cases.kept!.data, null);
  assert.deepEqual(snapshot.cases.pruned, { runId: "run-2", data: null });
});

test("a snapshot keeps numbers and ids only: no prompt, output or event text is written", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "case-a", "run-1");
  const secretOutput = "the agent said something private";
  const snapshot = takeSnapshot("after", dir, () => source({ turns: [generatorTurn(secretOutput)] }), () => "2026-09-28T12:00:00.000Z");
  writeSnapshot(dir, snapshot);

  assert.doesNotMatch(readFileSync(join(dir, "after.snapshot.json"), "utf8"), /something private/);
  assert.equal(readSnapshot(dir, "after")!.cases["case-a"]!.runId, "run-1");
});

test("re-taking a snapshot with the same or more data replaces it", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "case-a", "run-1");
  const first = takeSnapshot("after", dir, () => source(), () => "2026-09-28T12:00:00.000Z");
  writeSnapshot(dir, first);
  registerRun(dir, "after", "case-b", "run-2");
  const second = takeSnapshot("after", dir, () => source(), () => "2026-09-29T12:00:00.000Z");

  assert.doesNotThrow(() => writeSnapshot(dir, second));
  assert.deepEqual(Object.keys(readSnapshot(dir, "after")!.cases).sort(), ["case-a", "case-b"]);
});

test("a snapshot that would lose a case's data is refused and the existing one is kept", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "case-a", "run-1");
  writeSnapshot(dir, takeSnapshot("baseline", dir, () => source(), () => "2026-09-28T12:00:00.000Z"));

  const pruned: RunDataSource = { events: () => [], outcome: () => undefined, record: () => undefined, turns: () => [] };
  const shrunk = takeSnapshot("baseline", dir, () => pruned, () => "2026-11-01T12:00:00.000Z");

  assert.throws(() => writeSnapshot(dir, shrunk), /refusing to overwrite snapshot 'baseline'.*case-a/);
  assert.equal(readSnapshot(dir, "baseline")!.takenAt, "2026-09-28T12:00:00.000Z");
});

test("a snapshot that drops a case the existing one measured is refused", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "case-a", "run-1");
  registerRun(dir, "baseline", "case-b", "run-2");
  writeSnapshot(dir, takeSnapshot("baseline", dir, () => source(), () => "2026-09-28T12:00:00.000Z"));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.runs.json"), JSON.stringify({ "case-a": "run-1" }));
  const smaller = takeSnapshot("baseline", dir, () => source(), () => "2026-09-29T12:00:00.000Z");

  assert.throws(() => writeSnapshot(dir, smaller), /case-b/);
});

test("a label that could escape the results directory is rejected", (t) => {
  const dir = resultsDir(t);
  assert.throws(() => registerRun(dir, "../evil", "case", "run-1"), /invalid label/);
  assert.throws(() => readSnapshot(dir, "a/b"), /invalid label/);
});

test("reading a label with no snapshot yields null", (t) => {
  assert.equal(readSnapshot(resultsDir(t), "nothing-here"), null);
});

/* Replacing a file must be atomic: a reader that already has the old file open still sees the old, complete
   content, and a crash mid-write can never leave a truncated file where the good one was. */
test("writing a snapshot replaces the file atomically and leaves no temporary file behind", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "case-a", "run-1");
  const first = takeSnapshot("after", dir, () => source(), () => "2026-09-28T12:00:00.000Z");
  writeSnapshot(dir, first);
  const reader = openSync(join(dir, "after.snapshot.json"), "r");
  t.after(() => closeSync(reader));

  writeSnapshot(dir, takeSnapshot("after", dir, () => source(), () => "2026-09-29T12:00:00.000Z"));

  const seenByReader = JSON.parse(readFileSync(reader, "utf8")) as { takenAt: string };
  assert.equal(seenByReader.takenAt, "2026-09-28T12:00:00.000Z", "the open file still holds the old snapshot in full");
  assert.equal(readSnapshot(dir, "after")!.takenAt, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("registering a run replaces the label's registry atomically", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "case-a", "run-1");
  const reader = openSync(join(dir, "after.runs.json"), "r");
  t.after(() => closeSync(reader));

  registerRun(dir, "after", "case-b", "run-2");

  assert.deepEqual(JSON.parse(readFileSync(reader, "utf8")), { "case-a": "run-1" }, "the open file still holds the old registry in full");
  assert.deepEqual(readRegistry(dir, "after"), { "case-a": "run-1", "case-b": "run-2" });
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("re-snapshotting after the runs' events aged out keeps the measured snapshot instead of replacing it with empty windows", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "case-a", "run-1");
  writeSnapshot(dir, takeSnapshot("baseline", dir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  const measuredCalls = readSnapshot(dir, "baseline")!.cases["case-a"]!.data!.coarse.firstPass.totalCalls;
  assert.ok(measuredCalls > 0);

  const aged = takeSnapshot("baseline", dir, () => outcomeOnlySource(), () => "2026-11-01T12:00:00.000Z");

  assert.throws(() => writeSnapshot(dir, aged), /refusing to overwrite snapshot 'baseline'.*case-a/);
  assert.equal(readSnapshot(dir, "baseline")!.cases["case-a"]!.data!.coarse.firstPass.totalCalls, measuredCalls);
});

test("a snapshot whose measured window is empty never replaces one that measured calls, whatever its source", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "case-a", "run-1");
  writeSnapshot(dir, takeSnapshot("baseline", dir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  const emptyWindow = takeSnapshot("baseline", dir, () => source(), () => "2026-11-01T12:00:00.000Z");
  const emptied = emptyWindow.cases["case-a"]!.data!.coarse;
  for (const window of [emptied.firstPass, emptied.grounding, emptied.wholeRunExcludingGrounding]) {
    Object.assign(window, { totalCalls: 0, callsBeforeFirstWrite: 0, writeCount: 0, commandCount: 0, subagentCount: 0, repeatedCallCount: 0 });
  }

  assert.throws(() => writeSnapshot(dir, emptyWindow), /refusing to overwrite snapshot 'baseline'.*case-a/);
});

test("a snapshot that measures fewer calls for a case than the existing one is refused, not only one that measures none", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "baseline", "case-a", "run-1");
  writeSnapshot(dir, takeSnapshot("baseline", dir, () => source(), () => "2026-09-28T12:00:00.000Z"));
  /* Some of the run's events have since been pruned: what is left is a partial window. */
  const partial = takeSnapshot("baseline", dir, () => source({ events: events.slice(0, 5) }), () => "2026-11-01T12:00:00.000Z");
  assert.ok(partial.cases["case-a"]!.data !== null, "the partial window still measures something");

  assert.throws(() => writeSnapshot(dir, partial), /refusing to overwrite snapshot 'baseline'.*case-a/);
  assert.equal(readSnapshot(dir, "baseline")!.takenAt, "2026-09-28T12:00:00.000Z");
});

/* A run that is still going has neither an outcome nor a finished record; whatever its events hold now is a
   window that later events would change. */
const inFlightSource = (status: RunRecord["status"] = "running"): RunDataSource => ({
  events: () => events.slice(0, 4),
  outcome: () => undefined,
  record: () => record({ status }),
  turns: () => [],
});

test("a run that has not finished is not measured", () => {
  assert.equal(measureRun("run-1", inFlightSource("running")), null);
  assert.equal(measureRun("run-1", inFlightSource("enqueued")), null);
});

test("a run with an outcome is finished even when its record is gone, and a done record is finished without an outcome", () => {
  assert.notEqual(measureRun("run-1", source({ record: undefined as unknown as RunRecord })), null);
  assert.notEqual(measureRun("run-1", { events: () => events, outcome: () => undefined, record: () => record({ status: "done" }), turns: () => [] }), null);
});

test("a snapshot reports a run that has not finished as not finished, apart from a run whose data is gone", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "going", "run-1");
  registerRun(dir, "after", "pruned", "run-2");
  const gone: RunDataSource = { events: () => [], outcome: () => undefined, record: () => undefined, turns: () => [] };
  const sources: Record<string, RunDataSource> = { "run-1": inFlightSource(), "run-2": gone };

  const snapshot = takeSnapshot("after", dir, (runId) => sources[runId]!, () => "2026-09-28T12:00:00.000Z");

  assert.deepEqual(snapshot.cases.going, { runId: "run-1", data: null, notFinished: true });
  assert.deepEqual(snapshot.cases.pruned, { runId: "run-2", data: null });
});

test("a snapshot taken while a run was going can be replaced once the run has finished", (t) => {
  const dir = resultsDir(t);
  registerRun(dir, "after", "case-a", "run-1");
  writeSnapshot(dir, takeSnapshot("after", dir, () => inFlightSource(), () => "2026-09-28T12:00:00.000Z"));

  const finished = takeSnapshot("after", dir, () => source(), () => "2026-09-28T13:00:00.000Z");

  assert.doesNotThrow(() => writeSnapshot(dir, finished));
  assert.notEqual(readSnapshot(dir, "after")!.cases["case-a"]!.data, null);
});

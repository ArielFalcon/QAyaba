import { test } from "node:test";
import assert from "node:assert/strict";
import { ScoreMetricsSink, composeScoreSinks } from "./score-metrics-sink";
import { traceHarness } from "./trace-harness";
import { GRADER_CATALOG, type Score } from "@contexts/evaluation/application/index";
import type { RecordMeasurement } from "@kernel/telemetry/telemetry.port";

const RUN = "run-0f1e2d3c";

const score = (name: string, value: Score["value"], dataType: Score["dataType"], source: Score["source"] = "deterministic"): Score => ({
  name,
  value,
  dataType,
  polarity: "none",
  source,
  graderVersion: "1",
});

function sinkOf(h: ReturnType<typeof traceHarness>, over: { app?: string; verdict?: string } = {}) {
  return new ScoreMetricsSink({
    telemetry: h.telemetry,
    appOf: () => ("app" in over ? over.app : "name-webapp"),
    verdictOf: () => ("verdict" in over ? over.verdict : "pass"),
  });
}

test("numeric and boolean scores become gauge measurements with catalog and run labels only", () => {
  const h = traceHarness();
  const sink = sinkOf(h);
  sink.emit(RUN, [
    score("spec_validity_rate", 0.5, "NUMERIC"),
    score("spec_pass_rate", 1, "NUMERIC"),
    score("step_intent_mix.auth", 0.25, "NUMERIC"),
    score("empty_output_guard", true, "BOOLEAN"),
    score("approval_consistent", false, "BOOLEAN"),
  ]);

  const gauges = h.measurements.filter((m) => m.name === "qayaba.eval.score");
  assert.equal(gauges.length, 5);
  assert.equal(h.measurements.filter((m) => m.name === "qayaba.eval.class").length, 0);
  const byName = new Map(gauges.map((m) => [m.attrs["qayaba.eval.name"], m]));
  assert.equal(byName.get("spec_validity_rate")?.value, 0.5);
  assert.equal(byName.get("empty_output_guard")?.value, 1, "a true boolean is 1");
  assert.equal(byName.get("approval_consistent")?.value, 0, "a false boolean is 0");
  const family = byName.get("step_intent_mix.auth")!;
  assert.equal(family.attrs["qayaba.eval.data_type"], "NUMERIC");
  assert.equal(byName.get("spec_pass_rate")?.attrs["qayaba.eval.source"], "deterministic");
  assert.equal(byName.get("spec_pass_rate")?.attrs["qayaba.app"], "name-webapp");
  assert.equal(byName.get("spec_pass_rate")?.attrs["qayaba.verdict"], "pass");
  for (const m of gauges) assert.ok(!JSON.stringify(m.attrs).includes(RUN), "the run id never becomes a label");
});

test("every categorical score whose catalog entry declares its categories is counted, with no list of its own", () => {
  const h = traceHarness();
  const declared = GRADER_CATALOG.filter((s) => s.dataType === "CATEGORICAL" && s.categories && s.categories.length > 0);
  sinkOf(h).emit(RUN, declared.map((s) => score(s.name, s.categories![0]!, "CATEGORICAL")));
  const classes = h.measurements.filter((m) => m.name === "qayaba.eval.class");
  assert.deepEqual(classes.map((m) => [m.attrs["qayaba.eval.name"], m.attrs["qayaba.eval.value"]]), declared.map((s) => [s.name, s.categories![0]]));
});

test("only closed-set categorical scores are counted, and budget_exhaustion's free string is never emitted", () => {
  const h = traceHarness();
  sinkOf(h).emit(RUN, [
    score("furthest_phase", "execute", "CATEGORICAL"),
    score("change_coverage", "unknown", "CATEGORICAL"),
    score("infra_error", "E-STEP-BUDGET", "CATEGORICAL"),
    score("budget_exhaustion", "step-cap@generate/qa-author/write_spec", "CATEGORICAL"),
    score("some_open_judgment", "delightful", "CATEGORICAL", "llm_judge"),
    score("infra_error", "NOT-A-CLASS", "CATEGORICAL"),
  ]);

  const classes = h.measurements.filter((m) => m.name === "qayaba.eval.class");
  assert.deepEqual(
    classes.map((m) => [m.attrs["qayaba.eval.name"], m.attrs["qayaba.eval.value"]]),
    [
      ["furthest_phase", "execute"],
      ["change_coverage", "unknown"],
      ["infra_error", "E-STEP-BUDGET"],
      ["infra_error", "other"],
    ],
  );
  for (const m of classes) assert.equal(m.value, 1);
  assert.equal(h.measurements.filter((m) => m.name === "qayaba.eval.score").length, 0, "a categorical score has no numeric value");
  assert.ok(!JSON.stringify(h.measurements).includes("step-cap@generate"), "the dynamic budget string is not a label");
});

test("a run with no record or outcome omits the app and verdict labels instead of inventing them", () => {
  const h = traceHarness();
  const sink = new ScoreMetricsSink({ telemetry: h.telemetry, appOf: () => undefined, verdictOf: () => undefined });
  sink.emit(RUN, [score("spec_validity_rate", 0.75, "NUMERIC")]);
  const [m] = h.measurements;
  assert.equal(m?.value, 0.75);
  assert.deepEqual(Object.keys(m!.attrs).sort(), ["qayaba.eval.data_type", "qayaba.eval.name", "qayaba.eval.source"]);
});

test("the sink never throws into grading and one failing sink does not stop another", async () => {
  const logs: string[] = [];
  const throwing = {
    gauge: (() => () => {
      throw new Error("meter gone");
    }) as (name: string) => RecordMeasurement,
    counter: (() => () => undefined) as (name: string) => RecordMeasurement,
  };
  const sink = new ScoreMetricsSink({ telemetry: throwing, appOf: () => "app", verdictOf: () => "pass", log: (m) => logs.push(m) });
  assert.doesNotThrow(() => sink.emit(RUN, [score("spec_validity_rate", 1, "NUMERIC")]));
  assert.match(logs.join("\n"), /meter gone/);

  const calls: string[] = [];
  const composite = composeScoreSinks(
    [
      { emit: () => { throw new Error("down"); } },
      { emit: (runId) => void calls.push(runId) },
    ],
    (m) => logs.push(m),
  );
  await assert.doesNotReject(async () => {
    await composite.emit(RUN, [score("spec_validity_rate", 1, "NUMERIC")], "t");
  });
  assert.deepEqual(calls, [RUN]);
  assert.match(logs.join("\n"), /down/);
});

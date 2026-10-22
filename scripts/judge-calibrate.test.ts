import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArguments, type CalibrateDeps } from "./judge-calibrate.ts";
import { CalibrateJudgeUseCase } from "../qa-engine/src/contexts/evaluation/application/calibrate-judge.use-case.ts";
import { splitOfRun } from "../qa-engine/src/contexts/evaluation/domain/judge-calibration.ts";
import type { CalibrationReport } from "../qa-engine/src/contexts/evaluation/domain/judge-calibration.ts";

function testRuns(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (splitOfRun(`cal-${i}`) === "test") out.push(`cal-${i}`);
  return out;
}

function setup(pairs: Array<{ runId: string; human: boolean; judge: boolean }> | undefined) {
  const out: string[] = [];
  const saved: CalibrationReport[] = [];
  const deps: CalibrateDeps = {
    useCase: new CalibrateJudgeUseCase({
      pairs: { pairsFor: () => (pairs ? { graderVersion: "judge-spec_relevance@2", promptVersion: "2", model: "prov/judge", pairs } : undefined) },
      store: { save: (r) => void saved.push(r), latest: () => undefined },
      now: () => "2026-10-18T10:00:00.000Z",
    }),
    out: (line) => out.push(line),
  };
  return { deps, out, saved };
}

test("a command line needs a judge from the known set and an optional positive --min-n", () => {
  assert.deepEqual(parseArguments(["--judge", "spec_relevance"]), { ok: true, judge: "spec_relevance" });
  assert.deepEqual(parseArguments(["--judge", "failure_root_cause", "--min-n", "5"]), { ok: true, judge: "failure_root_cause", minN: 5 });
  assert.match((parseArguments([]) as { problem: string }).problem, /--judge is required/);
  assert.match((parseArguments(["--judge", "vibes"]) as { problem: string }).problem, /unknown judge/);
  assert.match((parseArguments(["--judge", "spec_relevance", "--min-n", "0"]) as { problem: string }).problem, /--min-n/);
  assert.match((parseArguments(["--judge", "spec_relevance", "--min-n", "2.5"]) as { problem: string }).problem, /--min-n/);
  assert.match((parseArguments(["--judge", "spec_relevance", "--bogus"]) as { problem: string }).problem, /unknown argument/);
  assert.match((parseArguments(["--judge"]) as { problem: string }).problem, /needs a value/);
});

test("the report names the judge, prompt version, model, splits, rates and status, and is persisted", async () => {
  const ids = testRuns(40);
  const { deps, out, saved } = setup(ids.map((runId, i) => ({ runId, human: i < 20, judge: i < 20 })));
  const code = await main(["--judge", "spec_relevance"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /spec_relevance/);
  assert.match(text, /prompt version 2/);
  assert.match(text, /prov\/judge/);
  assert.match(text, /TPR 1\.000/);
  assert.match(text, /TNR 1\.000/);
  assert.match(text, /status: calibrated/);
  assert.equal(saved.length, 1);
});

test("an experimental judge is still a successful report, and says why", async () => {
  const { deps, out } = setup([]);
  assert.equal(await main(["--judge", "spec_relevance"], deps), 0);
  assert.match(out.join("\n"), /status: experimental/);
  assert.match(out.join("\n"), /no test labels/);
});

test("--min-n lowers the per-class minimum", async () => {
  const ids = testRuns(24);
  const pairs = ids.map((runId, i) => ({ runId, human: i < 12, judge: i < 12 }));
  const strict = setup(pairs);
  await main(["--judge", "spec_relevance"], strict.deps);
  assert.match(strict.out.join("\n"), /status: experimental/);
  const lenient = setup(pairs);
  await main(["--judge", "spec_relevance", "--min-n", "10"], lenient.deps);
  assert.match(lenient.out.join("\n"), /status: calibrated/);
});

test("a judge with no scores yet exits 1 with what to do, and persists nothing", async () => {
  const { deps, out, saved } = setup(undefined);
  assert.equal(await main(["--judge", "spec_relevance"], deps), 1);
  assert.match(out.join("\n"), /no scores yet/);
  assert.equal(saved.length, 0);
});

test("a bad command line prints the problem and the usage and exits 2", async () => {
  const { deps, out } = setup(undefined);
  assert.equal(await main(["--judge", "vibes"], deps), 2);
  assert.match(out.join("\n"), /usage: npm run judge-calibrate/);
});

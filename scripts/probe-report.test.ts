/* The pipeline arm of the probe: a run id in, the shared metrics report out, written beside its markdown. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnRecord } from "../src/server/history.ts";
import type { RunRecord } from "../src/types.ts";
import type { ProbeReport, TimedRunEvent } from "./probe-metrics.ts";
import { DEFAULT_COVERAGE_MIN_RATIO, collectReport, main, type ReportDeps } from "./probe-report.ts";

const record = (id: string): RunRecord => ({ id, app: "demo", sha: "abc1234", target: "e2e", mode: "diff", status: "done", cases: [], logs: [], at: "2026-10-11T10:00:00.000Z", verdict: "pass", passed: 1, failed: 0 });

const events: TimedRunEvent[] = [
  { ts: 0, body: { type: "run.started", app: "demo", sha: "abc1234", mode: "diff", target: "e2e" } },
  { ts: 10, body: { type: "step.changed", step: "gate" } },
  { ts: 2_010, body: { type: "step.changed", step: "done" } },
];

function fakeDeps(known: readonly string[], over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    events: (id) => (known.includes(id) ? events : []),
    outcome: () => undefined,
    record: (id) => (known.includes(id) ? record(id) : undefined),
    turns: (): AgentTurnRecord[] => [],
    changedFiles: async () => ["src/a.ts"],
    specLines: () => new Map(),
    specSources: () => new Map(),
    minRatio: () => DEFAULT_COVERAGE_MIN_RATIO,
    ...over,
  };
}

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "probe-report-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a run unknown to the history fails loudly instead of reporting an empty run", async () => {
  await assert.rejects(() => collectReport("run-gone", fakeDeps([])), /not in the history/);
});

test("a known run is reported with its phases from the recorded events", async () => {
  const report = await collectReport("run-1", fakeDeps(["run-1"]));
  assert.equal(report.id, "run-1");
  assert.equal(report.verdict, "pass");
  assert.equal(report.phases.gate, 2_000);
});

test("main prints the markdown for every run, writes each run's full report, and exits 0", async () => {
  const { dir, done } = scratch();
  try {
    const lines: string[] = [];
    const code = await main(["run-1", "run-2"], { deps: fakeDeps(["run-1", "run-2"]), out: (l) => lines.push(l), outDir: dir });
    assert.equal(code, 0);
    const text = lines.join("\n");
    assert.ok(text.includes("run-1") && text.includes("run-2"));
    const written = JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8")) as ProbeReport;
    assert.equal(written.id, "run-1");
    assert.equal(written.arm, "pipeline");
  } finally {
    done();
  }
});

test("--json prints the reports as JSON instead of markdown", async () => {
  const { dir, done } = scratch();
  try {
    const lines: string[] = [];
    await main(["run-1", "--json"], { deps: fakeDeps(["run-1"]), out: (l) => lines.push(l), outDir: dir });
    const parsed = JSON.parse(lines.join("\n")) as ProbeReport[];
    assert.equal(parsed[0]?.id, "run-1");
  } finally {
    done();
  }
});

test("a run that cannot be reported does not stop the others, and the exit code says so", async () => {
  const { dir, done } = scratch();
  try {
    const lines: string[] = [];
    const code = await main(["run-gone", "run-1"], { deps: fakeDeps(["run-1"]), out: (l) => lines.push(l), outDir: dir });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("run-gone")));
    assert.ok(existsSync(join(dir, "run-1.json")));
    assert.equal(existsSync(join(dir, "run-gone.json")), false);
  } finally {
    done();
  }
});

test("a run id that could name a file outside the results directory is refused before anything is read or written", async () => {
  const { dir, done } = scratch();
  try {
    const lines: string[] = [];
    const code = await main(["../escape"], { deps: fakeDeps(["../escape"]), out: (l) => lines.push(l), outDir: dir });
    assert.equal(code, 1);
    assert.ok(lines.join("\n").includes("invalid run id"));
  } finally {
    done();
  }
});

test("no run id, or an unknown option, is a usage error", async () => {
  const lines: string[] = [];
  assert.equal(await main([], { deps: fakeDeps([]), out: (l) => lines.push(l) }), 2);
  assert.equal(await main(["run-1", "--nope"], { deps: fakeDeps(["run-1"]), out: (l) => lines.push(l) }), 2);
  assert.ok(lines.some((l) => l.startsWith("usage:")));
});

test("--ground-truth scores the run against the file: the report carries the score and the markdown the table", async () => {
  const { dir, done } = scratch();
  try {
    const truth = join(dir, "truth.json");
    writeFileSync(truth, JSON.stringify({ affectedFiles: ["src/a.ts"], affectedRoutes: ["/a"], notAffectedFiles: [] }), "utf8");
    const lines: string[] = [];
    const code = await main(["run-1", "--ground-truth", truth], {
      deps: fakeDeps(["run-1"], { specSources: () => new Map([["flows/a.spec.ts", "await page.goto('/a');"]]), record: (id) => ({ ...record(id), specs: [{ name: "flows/a.spec.ts" }] }) }),
      out: (l) => lines.push(l), outDir: dir,
    });
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8")) as ProbeReport;
    assert.equal(written.groundTruth?.specRoutes?.recall, 1);
    assert.ok(lines.join("\n").includes("### Ground truth"));
  } finally {
    done();
  }
});

test("a ground-truth file that cannot be read or scored stops the report before any run is read, naming the file", async () => {
  const { dir, done } = scratch();
  try {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ affectedFiles: [] }), "utf8");
    for (const path of [bad, join(dir, "missing.json")]) {
      const lines: string[] = [];
      assert.equal(await main(["run-1", "--ground-truth", path], { deps: fakeDeps(["run-1"]), out: (l) => lines.push(l), outDir: dir }), 1);
      assert.ok(lines.join("\n").includes(path));
    }
    assert.equal(existsSync(join(dir, "run-1.json")), false);
  } finally {
    done();
  }
});

test("--ground-truth without a file is a usage error", async () => {
  assert.equal(await main(["run-1", "--ground-truth"], { deps: fakeDeps(["run-1"]), out: () => undefined }), 2);
});

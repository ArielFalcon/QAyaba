import { test } from "node:test";
import assert from "node:assert/strict";
import { GradeRunUseCase } from "@contexts/evaluation/application/grade-run.use-case.ts";
import type { EvidencePort } from "@contexts/evaluation/application/ports/index.ts";
import type { Score } from "@contexts/evaluation/domain/score.ts";
import { evidence } from "./evidence-fixtures.ts";
import { MemoryScoreStore } from "./fakes.ts";

const quiet = () => undefined;

function build(port: EvidencePort, over: { sink?: { emit: (...a: unknown[]) => unknown } } = {}) {
  const store = new MemoryScoreStore();
  const grade = new GradeRunUseCase({ evidence: port, store, now: () => "2026-10-17T11:00:00.000Z", log: quiet, ...(over.sink ? { sink: over.sink as never } : {}) });
  return { store, grade };
}

test("grading a finished run stores its scores and marks the evaluation complete", async () => {
  const { store, grade } = build({ load: async () => evidence() });
  const result = await grade.execute("run-1");
  assert.equal(result.status, "complete");
  assert.equal(store.status("run-1"), "complete");
  assert.ok(store.list("run-1", { allVersions: false }).some((s) => s.name === "spec_pass_rate"));
});

test("grading the same run twice leaves one score per name and version", async () => {
  const { store, grade } = build({ load: async () => evidence() });
  await grade.execute("run-1");
  const first = store.list("run-1", { allVersions: true }).length;
  await grade.execute("run-1");
  assert.equal(store.list("run-1", { allVersions: true }).length, first);
});

test("a regrade replaces the stored score when the evidence changed", async () => {
  let e = evidence({ specs: { generated: 2, valid: 2, passed: 1 } });
  const { store, grade } = build({ load: async () => e });
  await grade.execute("run-1");
  e = evidence({ specs: { generated: 2, valid: 2, passed: 2 } });
  await grade.execute("run-1");
  const rate = store.list("run-1", { allVersions: true }).find((s) => s.name === "spec_pass_rate");
  assert.equal(rate?.value, 1);
});

test("a run that has not finished is not graded and stays pending", async () => {
  const { store, grade } = build({ load: async () => evidence({ finished: false, verdict: null }) });
  assert.deepEqual(await grade.execute("run-1"), { status: "skipped", reason: "not-finished" });
  assert.equal(store.status("run-1"), "pending");
  assert.equal(store.rows.size, 0);
});

test("an unknown run is skipped", async () => {
  const { grade } = build({ load: async () => undefined });
  assert.deepEqual(await grade.execute("nope"), { status: "skipped", reason: "unknown-run" });
});

test("evidence that cannot be read fails the evaluation instead of throwing", async () => {
  const { store, grade } = build({ load: async () => { throw new Error("db locked"); } });
  const result = await grade.execute("run-1");
  assert.equal(result.status, "failed");
  assert.equal(store.status("run-1"), "failed");
});

test("a grader that throws on malformed evidence fails the evaluation instead of throwing", async () => {
  const broken = { ...evidence(), specs: undefined } as unknown as ReturnType<typeof evidence>;
  const { store, grade } = build({ load: async () => broken });
  assert.equal((await grade.execute("run-1")).status, "failed");
  assert.equal(store.status("run-1"), "failed");
});

test("a sink that fails changes nothing about the stored grade", async () => {
  const seen: Score[][] = [];
  const { store, grade } = build({ load: async () => evidence() }, { sink: { emit: (_r: unknown, scores: unknown) => { seen.push(scores as Score[]); throw new Error("langfuse down"); } } });
  assert.equal((await grade.execute("run-1")).status, "complete");
  assert.equal(store.status("run-1"), "complete");
  assert.ok(seen.length === 1 && seen[0]!.length > 0);
});

test("naming graders grades only those", async () => {
  const { store, grade } = build({ load: async () => evidence() });
  await grade.execute("run-1", { graders: ["furthest_phase"] });
  assert.deepEqual(store.list("run-1", { allVersions: true }).map((s) => s.name), ["furthest_phase"]);
});

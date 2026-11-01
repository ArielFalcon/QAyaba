/* What the branch-cases regeneration records of the decisions it was sent: the identity of an arm is its decision's, so a taken arm is counted by identity and not by count. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchCasesRecord, declinedDecisionsOf } from "@contexts/run-orchestration/application/run-flow/branch-cases-record.ts";
import { gapUnits } from "@contexts/run-orchestration/application/run-flow/phases/coverage.steps.ts";

const arm = (file: string, line: number, label: string, column = 2) => ({ file, line, column, kind: "if", arm: label });
const before = [arm("src/a.ts", 3, "else"), arm("src/a.ts", 3, "then", 20), arm("src/b.ts", 9, "else"), arm("src/b.ts", 9, "else", 40)];
const units = gapUnits([], before, []);

test("a regeneration that takes two arms reports two arms taken, counted by the identity of each arm and not by how many remain", () => {
  const after = [arm("src/a.ts", 3, "then", 20), arm("src/b.ts", 9, "else", 40), arm("src/c.ts", 1, "else")];

  const record = branchCasesRecord({ before, after, units, placements: undefined });

  assert.equal(record.armsTaken, 2, "the third arm is a new one: it was not taken, and does not cancel a taken one");
  assert.equal(record.findings, units.length);
});

test("a rejected regeneration takes no arm: its after is its before, and no arm is reported taken", () => {
  const record = branchCasesRecord({ before, after: before, units, placements: undefined });

  assert.equal(record.armsTaken, 0);
  assert.ok(record.decisions!.every((d) => d.taken === 0));
});

test("an accepted regeneration that could not be recounted says nothing of the arms taken", () => {
  const record = branchCasesRecord({ before, after: undefined, units, placements: undefined });

  assert.equal("armsTaken" in record, false);
  assert.ok(record.decisions!.every((d) => !("taken" in d)));
});

test("each decision sent is recorded with its identity, its untaken arms, the flow it went to, the fact that sent it and how many of its arms were taken", () => {
  const placements = units.map((u, i) => (i === 1 ? {} : { flowId: u.finding.file === "src/a.ts" ? "alpha" : "beta", by: u.finding.file === "src/a.ts" ? "evaluator" as const : "candidate" as const }));
  const after = [arm("src/a.ts", 3, "then", 20), arm("src/b.ts", 9, "else")];

  const record = branchCasesRecord({ before, after, units, placements });

  const byIdentity = Object.fromEntries(record.decisions!.map((d) => [`${d.file}:${d.line}:${d.column}`, d]));
  assert.deepEqual(byIdentity["src/a.ts:3:2"], { file: "src/a.ts", line: 3, column: 2, kind: "if", arms: 1, taken: 1, flow: "alpha", by: "evaluator" });
  assert.equal(byIdentity["src/a.ts:3:20"]!.taken, 0);
  assert.equal(byIdentity["src/b.ts:9:2"]!.taken, 0);
  assert.equal(byIdentity["src/b.ts:9:40"]!.taken, 1);
  assert.equal(record.decisions!.filter((d) => d.flow === undefined).length, 1, "the decision no flow took has no flow and no fact");
});

test("the largest share of the findings one flow received is recorded, and survivors the pass routed are counted apart from those it did not", () => {
  const placements = [{ flowId: "alpha", by: "evaluator" as const }, { flowId: "alpha", by: "evaluator" as const }, { flowId: "alpha", by: "candidate" as const }, { flowId: "beta", by: "lead" as const }, { flowId: "beta", by: "spec" as const }, {}];

  const record = branchCasesRecord({ before, after: before, units, placements });

  assert.equal(units.length, 4);
  assert.equal(record.maxFlowShare, 3 / 4, "three of the four decisions went to alpha");
  assert.deepEqual(record.survivors, { routed: 1, unrouted: 1 });
});

test("a run with no pass records no share and no survivors, and a regeneration with nothing sent records no findings' flows", () => {
  const record = branchCasesRecord({ before, after: before, units, placements: undefined });

  assert.equal("maxFlowShare" in record, false);
  assert.equal("survivors" in record, false);
});

test("a decision the lead declined is recorded with its basis, apart from one no flow took, and counts for no flow's share", () => {
  const placements = [{ declined: { basis: "needs-unavailable-state" as const } }, { declined: { basis: "no-observable-change" as const, contradicted: "its changed code is executable code" } }, { flowId: "alpha", by: "evaluator" as const }, {}];

  const record = branchCasesRecord({ before, after: before, units, placements });

  assert.deepEqual(record.decisions!.map((d) => d.declined), [{ basis: "needs-unavailable-state" }, { basis: "no-observable-change", contradicted: true }, undefined, undefined]);
  assert.equal(record.decisions![3]!.flow, undefined, "an undeclined decision no flow took is not declined");
  assert.equal(record.maxFlowShare, 1 / 4);
  assert.deepEqual(record.armsTaken, 0, "a declined arm stays untaken in the recount");
});

test("the declined decisions of a turn are listed by their identity with the basis, and a turn that declined nothing lists none", () => {
  const placements = [{}, { declined: { basis: "already-covered" as const } }, {}, { declined: { basis: "no-observable-change" as const, contradicted: "fact" } }];

  assert.deepEqual(declinedDecisionsOf(units, placements), [
    { file: "src/b.ts", line: 9, column: 2, kind: "if", basis: "already-covered" },
    { file: "src/b.ts", line: 9, column: 40, kind: "if", basis: "no-observable-change", contradicted: true },
  ]);
  assert.deepEqual(declinedDecisionsOf(units, undefined), []);
  assert.deepEqual(declinedDecisionsOf(units, units.map(() => ({}))), []);
});

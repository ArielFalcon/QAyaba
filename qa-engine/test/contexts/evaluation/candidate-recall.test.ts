/* candidate_recall: of the use cases a person labelled reachable on dev for the change, the share the harness's candidates named. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import type { ReferenceEvidence } from "@contexts/evaluation/domain/run-evaluation-evidence.ts";
import { evidence } from "./evidence-fixtures.ts";

const plan = { kind: "fanout", changeRoutes: [], candidates: [], flows: [{ id: "a", visits: [], candidates: [], passed: true }] };
const reference = (over: Partial<ReferenceEvidence> = {}): ReferenceEvidence => ({
  useCases: [{ id: "uc-a", named: true }, { id: "uc-b", named: true }, { id: "uc-c", named: false }],
  unlabelledCandidates: 0,
  ...over,
});
const grade = (over = {}) => gradeEvidence(evidence({ plan, ...over }), ["candidate_recall"]);

test("the share of the dev use cases a candidate names is graded, and the ids no candidate names are the comment", () => {
  const [s] = grade({ reference: reference() });
  assert.equal(s?.name, "candidate_recall");
  assert.equal(s?.value, 2 / 3);
  assert.match(String(s?.comment), /uc-c/);
  assert.doesNotMatch(String(s?.comment), /uc-a/);
});

test("candidates that match no reference use case are counted in the comment and never lower the recall", () => {
  const [s] = grade({ reference: reference({ useCases: [{ id: "uc-a", named: true }], unlabelledCandidates: 4 }) });
  assert.equal(s?.value, 1);
  assert.match(String(s?.comment), /4 candidate\(s\) match no reference use case/);
});

test("nothing is graded without a reference, without a dev use case, or for a run that has not finished", () => {
  assert.deepEqual(grade(), []);
  assert.deepEqual(grade({ reference: reference({ useCases: [] }) }), []);
  assert.deepEqual(grade({ reference: reference(), finished: false, verdict: null }), []);
});

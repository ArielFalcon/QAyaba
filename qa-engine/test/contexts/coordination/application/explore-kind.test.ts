import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { exploreDelegationId, readExploreResult, renderExploreBrief } from "@contexts/coordination/application/explore-kind.ts";
import { MAX_FINDINGS } from "@contexts/coordination/application/exploration.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const brief = createDelegationBrief({ redaction, delegationId: exploreDelegationId("run-1", "q1"), runId: "run-1", objective: "what does /cart show?", task: "look", scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] } });
const finding = (n: number) => ({ claim: `claim ${n}`, kind: "page", ref: "/cart", evidence: "saw it" });
const answer = (over: Record<string, unknown> = {}): string => `thinking... ${JSON.stringify({ id: "q1", status: "answered", findings: [finding(1)], ...over })}`;

test("an answer of the contract is read with its findings and a writes-nothing result", () => {
  const result = readExploreResult(redaction, answer(), brief);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.filesChanged, []);
  assert.equal(result.exploration?.findings.length, 1);
  assert.equal(result.exploration?.id, "q1");
});

test("an unanswered question is a result with concerns, not a failure", () => {
  const result = readExploreResult(redaction, answer({ status: "unanswered", findings: [] }), brief);
  assert.equal(result.status, "completed-with-concerns");
  assert.equal(result.exploration?.status, "unanswered");
});

test("at most 12 findings are kept, malformed ones are dropped and free text is scrubbed", () => {
  const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => finding(i));
  assert.equal(readExploreResult(redaction, answer({ findings: many }), brief).exploration?.findings.length, MAX_FINDINGS);
  const mixed = [finding(1), { claim: "no kind", kind: "mystery", ref: "/x", evidence: "e" }, { claim: "", kind: "page", ref: "/x", evidence: "e" }, { ...finding(2), claim: `token sk-ant-api03-${"a".repeat(40)}` }];
  const kept = readExploreResult(redaction, answer({ findings: mixed }), brief).exploration?.findings ?? [];
  assert.equal(kept.length, 2);
  assert.ok(!kept[1]!.claim.includes("sk-ant-api03-aaaa"));
});

test("an answer that is no result, or answers another question, is a failed result", () => {
  assert.equal(readExploreResult(redaction, "I looked around.", brief).status, "failed");
  assert.equal(readExploreResult(redaction, answer({ id: "q2" }), brief).status, "failed");
  assert.equal(readExploreResult(redaction, answer({ status: "maybe" }), brief).status, "failed");
});

test("the brief states the question, the result contract and the symbol ref form, and grants nothing", () => {
  const rendered = renderExploreBrief(redaction, brief);
  assert.ok(rendered.text.includes("what does /cart show?"));
  assert.ok(rendered.text.includes('"findings"'));
  assert.ok(rendered.text.includes("<repo-relative file>#<symbol>"));
  assert.equal(brief.scope.writablePaths.length, 0);
});

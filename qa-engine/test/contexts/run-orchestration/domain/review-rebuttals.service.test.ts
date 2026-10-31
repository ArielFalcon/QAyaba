/* Review rebuttals: a finding is withdrawn only on evidence the orchestrator can check, and a rebuttal names one finding by its id. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  namedRebuttals,
  verifyRebuttals,
  type AnsweredRebuttal,
  type RebuttalEvidence,
  type ReviewRebuttal,
  type RoundFinding,
} from "@contexts/run-orchestration/domain/review-rebuttals.service.ts";
import { identifyFindings } from "@contexts/run-orchestration/domain/review-finding-filter.service.ts";

const evidence = (over: Partial<RebuttalEvidence> = {}): RebuttalEvidence => ({
  greenCaseRefs: new Set(["flows/checkout.spec.ts"]),
  intactClauses: new Set(["flows/checkout.spec.ts#assertion-0"]),
  ...over,
});

const FINDING = "[wrong-objective] checkout.spec.ts: the discount is never asserted";
const OTHER = "[false-positive] checkout.spec.ts: the total is not asserted";
/* The round's findings as the run admitted them. */
const [ONE, TWO] = identifyFindings([{ text: FINDING }, { text: OTHER }]) as [RoundFinding, RoundFinding];

const rebuttal = (over: Partial<ReviewRebuttal> = {}): ReviewRebuttal => ({
  findingId: ONE.id,
  basis: "execution",
  ref: "flows/checkout.spec.ts",
  reason: "the case ran green on these bytes",
  ...over,
});

test("a rebuttal naming a spec that ran green withdraws its finding", () => {
  const out = verifyRebuttals([rebuttal()], [ONE], evidence());
  assert.deepEqual(out.withdrawn, [ONE.id]);
  assert.deepEqual(out.disputed, []);
});

test("a rebuttal naming a case that is not green in this run is a dispute, never a withdrawal", () => {
  const out = verifyRebuttals([rebuttal({ ref: "flows/other.spec.ts" })], [ONE], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed.map((entry) => ({ id: entry.findingId, text: entry.finding })), [{ id: ONE.id, text: FINDING }]);
});

test("a contract rebuttal withdraws a finding when the cited clause is intact", () => {
  const out = verifyRebuttals([rebuttal({ basis: "contract", ref: "flows/checkout.spec.ts#assertion-0" })], [ONE], evidence());
  assert.deepEqual(out.withdrawn, [ONE.id]);
});

test("a contract rebuttal citing a clause the current bytes no longer hold is a dispute", () => {
  const out = verifyRebuttals([rebuttal({ basis: "contract", ref: "flows/checkout.spec.ts#assertion-9" })], [ONE], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.equal(out.disputed.length, 1);
});

test("a rebuttal whose id names no finding of this round is unnamed: it withdraws and disputes nothing", () => {
  const stray = rebuttal({ findingId: "F9" });
  const out = verifyRebuttals([stray], [ONE], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed, []);
  assert.deepEqual(out.unnamed, [stray]);
});

test("two findings with the same text are two findings: a rebuttal withdraws only the one whose id it names", () => {
  const [a, b] = identifyFindings([{ text: FINDING }, { text: FINDING }]) as [RoundFinding, RoundFinding];
  assert.notEqual(a.id, b.id);
  const out = verifyRebuttals([rebuttal({ findingId: a.id })], [a, b], evidence());
  assert.deepEqual(out.withdrawn, [a.id]);
  assert.deepEqual(out.disputed, []);
});

test("one verified rebuttal withdraws the finding even when another rebuttal of it is unchecked", () => {
  const out = verifyRebuttals(
    [rebuttal({ ref: "flows/gone.spec.ts" }), rebuttal({ basis: "contract", ref: "flows/checkout.spec.ts#assertion-0" })],
    [ONE],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, [ONE.id]);
  assert.deepEqual(out.disputed, []);
});

test("each finding of a round is judged on its own rebuttal", () => {
  const out = verifyRebuttals([rebuttal(), rebuttal({ findingId: TWO.id, ref: "flows/missing.spec.ts" })], [ONE, TWO], evidence());
  assert.deepEqual(out.withdrawn, [ONE.id]);
  assert.deepEqual(out.disputed.map((entry) => entry.finding), [OTHER]);
  assert.equal(out.disputed[0]?.rebuttal.reason, "the case ran green on these bytes");
});

test("a reference is the same reference whatever its separators or path style", () => {
  const out = verifyRebuttals([rebuttal({ ref: "  FLOWS\\Checkout.spec.ts  " })], [ONE], evidence({ greenCaseRefs: new Set(["flows/checkout.spec.ts"]) }));
  assert.deepEqual(out.withdrawn, [ONE.id]);
});

test("the basis decides which evidence is consulted: a reference only intact clauses hold does not verify an execution claim", () => {
  const out = verifyRebuttals([rebuttal({ basis: "execution", ref: "flows/checkout.spec.ts#assertion-0" })], [ONE], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.equal(out.disputed.length, 1);
  const contract = verifyRebuttals([rebuttal({ basis: "contract", ref: "flows/checkout.spec.ts" })], [ONE], evidence());
  assert.deepEqual(contract.withdrawn, []);
  assert.equal(contract.disputed.length, 1);
});

test("the first unchecked rebuttal of a finding is the one the dispute reports", () => {
  const out = verifyRebuttals(
    [rebuttal({ ref: "flows/first.spec.ts", reason: "the first reason" }), rebuttal({ ref: "flows/second.spec.ts", reason: "the second reason" })],
    [ONE],
    evidence(),
  );
  assert.equal(out.disputed.length, 1);
  assert.equal(out.disputed[0]?.rebuttal.reason, "the first reason");
});

test("a rebuttal spells the spec with the spec directory in front and still verifies, on either basis", () => {
  const prefixed = evidence({ specRelDir: "e2e" });
  assert.deepEqual(verifyRebuttals([rebuttal({ ref: "e2e/flows/checkout.spec.ts" })], [ONE], prefixed).withdrawn, [ONE.id]);
  assert.deepEqual(verifyRebuttals([rebuttal({ basis: "contract", ref: "e2e/flows/checkout.spec.ts#assertion-0" })], [ONE], prefixed).withdrawn, [ONE.id]);
});

const answered = (over: Partial<AnsweredRebuttal> & { finding: string }): AnsweredRebuttal => ({ basis: "execution", ref: "flows/checkout.spec.ts", reason: "it ran green", ...over });

test("a rebuttal the answer named by id is taken as it is, whatever text it carries", () => {
  const out = namedRebuttals([answered({ finding: FINDING, findingId: TWO.id })], [ONE, TWO]);
  assert.deepEqual(out.rebuttals.map((r) => r.findingId), [TWO.id]);
  assert.deepEqual(out.unread, []);
});

test("a repeated text names the one finding of the round with exactly that text, whitespace and case aside", () => {
  const out = namedRebuttals([answered({ finding: `  ${FINDING.toUpperCase().replaceAll(" ", "  ")}\n` })], [ONE, TWO]);
  assert.deepEqual(out.rebuttals.map((r) => r.findingId), [ONE.id]);
  assert.deepEqual(out.unread, []);
});

test("a repeated text that is only part of a finding names none and is unread", () => {
  const abridged = answered({ finding: "checkout.spec.ts: the discount is never asserted" });
  const out = namedRebuttals([abridged], [ONE, TWO]);
  assert.deepEqual(out.rebuttals, []);
  assert.deepEqual(out.unread, [abridged]);
});

test("a repeated text two findings share names neither and is unread, so it can withdraw neither", () => {
  const twins = identifyFindings([{ text: FINDING }, { text: FINDING }]);
  const repeat = answered({ finding: FINDING });
  const out = namedRebuttals([repeat], twins);
  assert.deepEqual(out.rebuttals, []);
  assert.deepEqual(out.unread, [repeat]);
});

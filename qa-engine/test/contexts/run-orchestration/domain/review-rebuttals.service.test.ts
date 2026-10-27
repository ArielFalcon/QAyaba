/* Review rebuttals: a finding is withdrawn only on evidence the orchestrator can check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyRebuttals,
  type RebuttalEvidence,
  type ReviewRebuttal,
} from "@contexts/run-orchestration/domain/review-rebuttals.service.ts";

const evidence = (over: Partial<RebuttalEvidence> = {}): RebuttalEvidence => ({
  greenCaseRefs: new Set(["flows/checkout.spec.ts"]),
  intactClauses: new Set(["flows/checkout.spec.ts#assertion-0"]),
  ...over,
});

const rebuttal = (over: Partial<ReviewRebuttal> & { finding: string }): ReviewRebuttal => ({
  basis: "execution",
  ref: "flows/checkout.spec.ts",
  reason: "the case ran green on these bytes",
  ...over,
});

const FINDING = "[wrong-objective] checkout.spec.ts: the discount is never asserted";

test("a rebuttal naming a spec that ran green withdraws its finding", () => {
  const out = verifyRebuttals([rebuttal({ finding: FINDING })], [FINDING], evidence());
  assert.deepEqual(out.withdrawn, [FINDING]);
  assert.deepEqual(out.disputed, []);
});

test("a rebuttal naming a case that is not green in this run is a dispute, never a withdrawal", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: FINDING, ref: "flows/other.spec.ts" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed.map((entry) => entry.finding), [FINDING]);
});

test("a contract rebuttal withdraws a finding when the cited clause is intact", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: FINDING, basis: "contract", ref: "flows/checkout.spec.ts#assertion-0" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, [FINDING]);
});

test("a contract rebuttal citing a clause the current bytes no longer hold is a dispute", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: FINDING, basis: "contract", ref: "flows/checkout.spec.ts#assertion-9" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, []);
  assert.equal(out.disputed.length, 1);
});

test("a rebuttal that names no finding of this round disputes nothing", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: "[false-positive] a finding nobody raised here" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed, []);
});

test("a reworded finding is still the same finding when the repeated part is specific", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: "checkout.spec.ts: the discount is never asserted" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, [FINDING]);
});

test("a fragment too short to identify one finding does not withdraw anything", () => {
  const out = verifyRebuttals([rebuttal({ finding: "the discount" })], [FINDING], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed, []);
});

test("one verified rebuttal withdraws the finding even when another rebuttal of it is unchecked", () => {
  const out = verifyRebuttals(
    [
      rebuttal({ finding: FINDING, ref: "flows/gone.spec.ts" }),
      rebuttal({ finding: FINDING, basis: "contract", ref: "flows/checkout.spec.ts#assertion-0" }),
    ],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, [FINDING]);
  assert.deepEqual(out.disputed, []);
});

test("each finding of a round is judged on its own rebuttal", () => {
  const other = "[false-positive] checkout.spec.ts: the total is not asserted";
  const out = verifyRebuttals(
    [
      rebuttal({ finding: FINDING }),
      rebuttal({ finding: other, ref: "flows/missing.spec.ts" }),
    ],
    [FINDING, other],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, [FINDING]);
  assert.deepEqual(out.disputed.map((entry) => entry.finding), [other]);
  assert.equal(out.disputed[0]?.rebuttal.reason, "the case ran green on these bytes");
});

test("a reference is the same reference whatever its separators or path style", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: FINDING, ref: "  FLOWS\\Checkout.spec.ts  " })],
    [FINDING],
    evidence({ greenCaseRefs: new Set(["flows/checkout.spec.ts"]) }),
  );
  assert.deepEqual(out.withdrawn, [FINDING]);
});

test("a reworded finding is the same finding whichever side repeats more, and whitespace does not matter", () => {
  const long = "[wrong-objective] checkout.spec.ts: the discount is never asserted anywhere in this spec";
  const short = "[wrong-objective] checkout.spec.ts: the discount is never asserted";
  for (const [rebutted, raised] of [[long, short], [short, long]] as const) {
    const out = verifyRebuttals([rebuttal({ finding: rebutted })], [raised], evidence());
    assert.deepEqual(out.withdrawn, [raised]);
  }
  const spaced = verifyRebuttals([rebuttal({ finding: `  ${FINDING.replaceAll(" ", "  ")}\n` })], [FINDING], evidence());
  assert.deepEqual(spaced.withdrawn, [FINDING]);
});

test("the basis decides which evidence is consulted: a reference only intact clauses hold does not verify an execution claim", () => {
  const out = verifyRebuttals(
    [rebuttal({ finding: FINDING, basis: "execution", ref: "flows/checkout.spec.ts#assertion-0" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(out.withdrawn, []);
  assert.equal(out.disputed.length, 1);
  const contract = verifyRebuttals(
    [rebuttal({ finding: FINDING, basis: "contract", ref: "flows/checkout.spec.ts" })],
    [FINDING],
    evidence(),
  );
  assert.deepEqual(contract.withdrawn, []);
  assert.equal(contract.disputed.length, 1);
});

test("the first unchecked rebuttal of a finding is the one the dispute reports", () => {
  const out = verifyRebuttals(
    [
      rebuttal({ finding: FINDING, ref: "flows/first.spec.ts", reason: "the first reason" }),
      rebuttal({ finding: FINDING, ref: "flows/second.spec.ts", reason: "the second reason" }),
    ],
    [FINDING],
    evidence(),
  );
  assert.equal(out.disputed.length, 1);
  assert.equal(out.disputed[0]?.rebuttal.reason, "the first reason");
});

test("a short finding repeated exactly is the same finding, however little the containment could prove", () => {
  const short = "[other] fix it";
  const out = verifyRebuttals([rebuttal({ finding: short })], [short], evidence());
  assert.deepEqual(out.withdrawn, [short]);
});

test("whitespace is collapsed, not removed: two findings that differ by its placement are different findings", () => {
  const out = verifyRebuttals([rebuttal({ finding: "the discount is never asserted" })], ["thediscount is never asserted"], evidence());
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(out.disputed, []);
});

test("a repeated fragment of exactly the identifying length is specific enough; a character less is not", () => {
  const finding = "[false-positive] checkout.spec.ts: the discount is never asserted on the total";
  const exact = finding.slice(0, 24);
  assert.equal(exact.length, 24);
  assert.deepEqual(verifyRebuttals([rebuttal({ finding: exact })], [finding], evidence()).withdrawn, [finding]);
  assert.deepEqual(verifyRebuttals([rebuttal({ finding: exact.slice(0, 23) })], [finding], evidence()).withdrawn, []);
});

test("a rebuttal spells the spec with the spec directory in front and still verifies, on either basis", () => {
  const prefixed = evidence({ specRelDir: "e2e" });
  const execution = verifyRebuttals([rebuttal({ finding: FINDING, ref: "e2e/flows/checkout.spec.ts" })], [FINDING], prefixed);
  assert.deepEqual(execution.withdrawn, [FINDING]);
  const contract = verifyRebuttals(
    [rebuttal({ finding: FINDING, basis: "contract", ref: "e2e/flows/checkout.spec.ts#assertion-0" })],
    [FINDING],
    prefixed,
  );
  assert.deepEqual(contract.withdrawn, [FINDING]);
});

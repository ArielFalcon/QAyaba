/* The one proof rule and the mode tally every rule about skipped and expected-to-fail tests reads: a file is proven by a case that executed, was declared to pass and passed, and the modes are counted per file, never matched by a title. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProof, hasRealPass, isRealPass, modeRefusals, refuseOutright, tallyOf, verdictAfterRefusal } from "@kernel/case-proof.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const caseOf = (file: string, over: Partial<QaCase> = {}): QaCase => ({ name: `${file} › t`, status: "pass", expectedStatus: "passed", file, ...over });

test("a real pass is a case that executed, was declared to pass and passed", () => {
  assert.equal(isRealPass(caseOf("a.spec.ts")), true);
  assert.equal(isRealPass(caseOf("a.spec.ts", { expectedStatus: "failed" })), false, "a test.fail() test passes by failing");
  assert.equal(isRealPass(caseOf("a.spec.ts", { expectedStatus: "skipped", status: "fail", refused: true })), false);
  assert.equal(isRealPass(caseOf("a.spec.ts", { status: "fail" })), false);
  assert.equal(isRealPass(caseOf("a.spec.ts", { status: "flaky" })), false);
});

test("a case recorded without a declared status is read as the runner reports it", () => {
  const { expectedStatus: _declared, ...undeclared } = caseOf("a.spec.ts");
  assert.equal(isRealPass(undeclared), true);
});

test("a file is proven by one real passing case of its own, spelled however the report spelled the path", () => {
  const cases = [caseOf("flows/a.spec.ts", { expectedStatus: "failed" }), caseOf("./flows/b.spec.ts")];
  assert.equal(hasProof("flows/a.spec.ts", cases), false);
  assert.equal(hasProof("flows/b.spec.ts", cases), true);
  assert.equal(hasProof("flows/c.spec.ts", cases), false, "a file nothing was reported of has no proof");
  assert.equal(hasRealPass(cases), true);
  assert.equal(hasRealPass([cases[0]!]), false);
});

test("the tests of a file are counted by declared mode: tests that ran, those that passed, those marked to fail and the skipped ones", () => {
  const tally = tallyOf("flows/a.spec.ts", {
    cases: [
      caseOf("flows/a.spec.ts"),
      caseOf("flows/a.spec.ts", { status: "fail" }),
      caseOf("flows/a.spec.ts", { expectedStatus: "failed" }),
      caseOf("flows/a.spec.ts", { expectedStatus: "failed", status: "fail", refused: true }),
      caseOf("flows/b.spec.ts"),
    ],
    skippedTests: [{ name: "x", file: "flows/a.spec.ts" }, { name: "y", file: "flows/b.spec.ts" }],
  });
  assert.deepEqual(tally, { ran: 2, passing: 1, expectedFailures: 1, skipped: 1 });
});

test("outright refusal takes every skipped test and every test marked test.fail() of the judged files out of the report, as failing cases that say why", () => {
  const refused = refuseOutright(
    {
      cases: [caseOf("flows/a.spec.ts"), caseOf("flows/a.spec.ts", { name: "flows/a.spec.ts › known bug", expectedStatus: "failed" }), caseOf("flows/other.spec.ts", { expectedStatus: "failed" })],
      skippedTests: [{ name: "flows/a.spec.ts › later", file: "flows/a.spec.ts", annotation: "fixme" }, { name: "cleanup.spec.ts › teardown", file: "cleanup.spec.ts", annotation: "skip" }],
    },
    ["flows/a.spec.ts"],
  );
  assert.deepEqual(refused.cases.map((c) => c.file), ["flows/a.spec.ts", "flows/other.spec.ts"], "a file that is not judged keeps its tests as reported");
  assert.deepEqual(refused.skippedTests.map((t) => t.name), ["cleanup.spec.ts › teardown"]);
  assert.deepEqual(refused.refused.map((c) => [c.name, c.status, c.expectedStatus, c.file]), [
    ["flows/a.spec.ts › known bug", "fail", "failed", "flows/a.spec.ts"],
    ["flows/a.spec.ts › later", "fail", "skipped", "flows/a.spec.ts"],
  ], "a refused test is stored with the status it declared");
  assert.deepEqual(refused.refused.map((c) => c.refused), [true, true]);
  assert.match(refused.refused[0]!.detail!, /test\.fail\(\).*not a pass/);
  assert.match(refused.refused[1]!.detail!, /test\.fixme\).*not a pass/);
});

test("with no judged files every test of the report is judged: a run of one spec", () => {
  const refused = refuseOutright({ cases: [caseOf("staged/x.spec.ts", { expectedStatus: "failed" })], skippedTests: [{ name: "x", file: "staged/x.spec.ts" }] });
  assert.equal(refused.refused.length, 2);
  assert.deepEqual(refused.cases, []);
});

test("a file's refusals are its extra skipped and expected-to-fail tests against the run before, and a named test that is skipped or expected to fail", () => {
  const prior = { cases: [caseOf("a.spec.ts", { status: "fail" }), caseOf("a.spec.ts", { expectedStatus: "failed" })], skippedTests: [{ name: "old", file: "a.spec.ts" }] };
  const same = { cases: [caseOf("a.spec.ts"), caseOf("a.spec.ts", { expectedStatus: "failed" })], skippedTests: [{ name: "old", file: "a.spec.ts" }] };
  assert.deepEqual(modeRefusals(["a.spec.ts"], prior, same), [], "what was already there is not the round's doing");
  const more = { cases: [...same.cases, caseOf("a.spec.ts", { expectedStatus: "failed" })], skippedTests: [...same.skippedTests, { name: "new", file: "a.spec.ts" }] };
  assert.deepEqual(modeRefusals(["a.spec.ts"], prior, more).map((r) => r.why), ["1 more test(s) expected to fail (test.fail())", "1 more skipped test(s)"]);
  const named = modeRefusals(["a.spec.ts"], prior, same, [{ file: "a.spec.ts", name: "old" }]);
  assert.match(named[0]!.why, /named is skipped/);
});

test("a refusal record counts toward no mode: the baseline a later round is compared with does not hold the test it refused", () => {
  const refused = refuseOutright({ cases: [caseOf("a.spec.ts", { expectedStatus: "failed" })], skippedTests: [{ name: "x", file: "a.spec.ts" }] }, ["a.spec.ts"]);
  assert.deepEqual(tallyOf("a.spec.ts", { cases: refused.refused, skippedTests: refused.skippedTests }), { ran: 0, passing: 0, expectedFailures: 0, skipped: 0 });
  const kept = { cases: [caseOf("a.spec.ts", { expectedStatus: "failed" })], skippedTests: [{ name: "x", file: "a.spec.ts" }] };
  assert.equal(modeRefusals(["a.spec.ts"], { cases: refused.refused }, kept).length, 2, "a round that keeps what was refused has added one of each");
});

test("a pass that names no file proves no file, whatever else the run reported", () => {
  const unattributed: QaCase = { name: "runs", status: "pass" };
  assert.equal(hasProof("flows/a.spec.ts", [unattributed]), false, "the only pass of a run cannot stand for a file it does not name");
  assert.equal(hasProof("flows/a.spec.ts", [unattributed, caseOf("flows/b.spec.ts")]), false);
  assert.equal(hasProof("flows/a.spec.ts", [unattributed, caseOf("flows/a.spec.ts")]), true);
});

test("a refused test fails a run that passed, was flaky or executed nothing, and leaves a failure or a crash with no refusal as it was", () => {
  assert.deepEqual((["pass", "flaky", "infra-error"] as const).map((v) => verdictAfterRefusal(v, 1)), ["fail", "fail", "fail"]);
  assert.deepEqual((["pass", "flaky", "infra-error", "fail"] as const).map((v) => verdictAfterRefusal(v, 0)), ["pass", "flaky", "infra-error", "fail"]);
  assert.equal(verdictAfterRefusal("skipped", 1), "skipped");
});

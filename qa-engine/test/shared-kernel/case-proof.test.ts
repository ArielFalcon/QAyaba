/* The one proof rule and the mode tally every rule about skipped and expected-to-fail tests reads: a file is proven by a case that executed, was declared to pass and passed, and the modes are counted per file, never matched by a title. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProof, hasRealPass, isRealPass, modeRefusals, refuseOutright, tallyOf } from "@kernel/case-proof.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const caseOf = (file: string, over: Partial<QaCase> = {}): QaCase => ({ name: `${file} › t`, status: "pass", expectedStatus: "passed", file, ...over });

test("a real pass is a case that executed, was declared to pass and passed", () => {
  assert.equal(isRealPass(caseOf("a.spec.ts")), true);
  assert.equal(isRealPass(caseOf("a.spec.ts", { expectedStatus: "failed" })), false, "a test.fail() test passes by failing");
  assert.equal(isRealPass(caseOf("a.spec.ts", { expectedStatus: "not-run", status: "fail" })), false);
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
      caseOf("flows/a.spec.ts", { expectedStatus: "not-run", status: "fail" }),
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
    ["flows/a.spec.ts › known bug", "fail", "not-run", "flows/a.spec.ts"],
    ["flows/a.spec.ts › later", "fail", "not-run", "flows/a.spec.ts"],
  ]);
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

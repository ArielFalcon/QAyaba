/* The one proof rule and the mode tally every rule about skipped and expected-to-fail tests reads: a file is proven by a case that executed, was declared to pass and passed, and the modes are counted per file, never matched by a title. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProof, hasRealPass, isRealPass, tallyOf } from "@kernel/case-proof.ts";
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

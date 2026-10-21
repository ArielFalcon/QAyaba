/* SuiteRevision is the value a run admits: the bytes that executed (files), the executed verdict, the cases and the namespace. Its constructor is the executed-only invariant — only a pass/fail/flaky outcome (a suite that actually ran) has a revision. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isExecutedVerdict, suiteRevision } from "@contexts/qa-run-orchestration/domain/suite-revision.ts";

const CASES = [{ name: "a", status: "pass" as const, file: "a.spec.ts" }];
const FILES = new Map([["a.spec.ts", "sha:abc"]]);

test("suiteRevision builds a revision from an executed pass/fail/flaky outcome, preserving each field", () => {
  for (const verdict of ["pass", "fail", "flaky"]) {
    const revision = suiteRevision({ files: FILES, verdict, cases: CASES, namespace: "run-1" });
    assert.ok(revision, `${verdict} is an executed verdict and admits a revision`);
    assert.equal(revision!.verdict, verdict);
    assert.equal(revision!.files, FILES);
    assert.equal(revision!.cases, CASES);
    assert.equal(revision!.namespace, "run-1");
  }
});

test("a non-executed verdict (invalid, infra-error, skipped) never admits a revision", () => {
  for (const verdict of ["invalid", "infra-error", "skipped"]) {
    assert.equal(suiteRevision({ files: FILES, verdict, cases: CASES, namespace: "run-1" }), undefined, `${verdict} never executed the suite, so it has no revision`);
  }
});

test("isExecutedVerdict guards exactly the three executed verdicts", () => {
  assert.equal(isExecutedVerdict("pass"), true);
  assert.equal(isExecutedVerdict("fail"), true);
  assert.equal(isExecutedVerdict("flaky"), true);
  assert.equal(isExecutedVerdict("invalid"), false);
  assert.equal(isExecutedVerdict("infra-error"), false);
  assert.equal(isExecutedVerdict("skipped"), false);
});

/* What the current bytes prove to the reviewer's pre-check and to a rebuttal is the one proof rule: a file is green when a real pass ran and nothing failed, and a test marked test.fail() is no pass. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QaCase } from "@kernel/qa-case.ts";
import { greenSpecFiles } from "@contexts/run-orchestration/application/run-flow/phases/review-services.ts";

const caseOf = (file: string, over: Partial<QaCase> = {}): QaCase => ({ name: `${file} › t`, status: "pass", expectedStatus: "passed", file, ...over });

test("a spec file whose only passing test is marked test.fail() is not green", () => {
  const green = greenSpecFiles([caseOf("flows/a.spec.ts", { expectedStatus: "failed" }), caseOf("flows/b.spec.ts")]);

  assert.deepEqual([...green], ["flows/b.spec.ts"]);
});

test("a spec file with a real pass beside a failing case is not green, and one with a real pass alone is", () => {
  const green = greenSpecFiles([caseOf("flows/a.spec.ts"), caseOf("flows/a.spec.ts", { status: "fail" }), caseOf("flows/b.spec.ts"), { name: "runs", status: "pass" }]);

  assert.deepEqual([...green], ["flows/b.spec.ts"]);
});

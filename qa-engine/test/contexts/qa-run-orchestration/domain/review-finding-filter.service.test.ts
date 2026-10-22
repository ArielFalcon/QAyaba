/* Review-finding filter: only evidence the orchestrator can verify may block. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterReviewFindings,
  type CitedFinding,
  type ReviewScope,
} from "@contexts/qa-run-orchestration/domain/review-finding-filter.service.ts";

const scope: ReviewScope = {
  inScopeSpecs: new Set(["flows/checkout.spec.ts"]),
  executedSpecs: new Set(["flows/checkout.spec.ts"]),
};

const finding = (over: Partial<CitedFinding> & { text: string }): CitedFinding => ({ severity: "blocking", ...over });

test("a finding with no citation is dropped, never sent to the generator", () => {
  const out = filterReviewFindings([finding({ text: "[false-positive] this test asserts nothing" })], scope);
  assert.deepEqual(out.blocking, []);
  assert.deepEqual(out.dropped, ["[false-positive] this test asserts nothing"]);
});

test("a blocking finding about the stock auth spec, outside the diff's scope, is dropped", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[wrong-objective] auth.spec.ts: the login helper is not part of the change",
        citation: { kind: "contract", ref: "specs/auth.spec.ts#clause-2" },
      }),
    ],
    scope,
  );
  assert.deepEqual(out.blocking, []);
  assert.equal(out.dropped.length, 1);
});

test("a DOM-only finding is advisory: recorded, never blocking", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[fragile-selector] the button label is not on the captured page",
        citation: { kind: "dom", ref: "flows/checkout.spec.ts" },
      }),
    ],
    scope,
  );
  assert.deepEqual(out.blocking, []);
  assert.equal(out.advisory.length, 1);
});

test("an execution-backed finding on a spec this run executed keeps its blocking severity", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[false-positive] checkout.spec.ts: no assertion verifies the discount",
        citation: { kind: "execution", ref: "flows/checkout.spec.ts" },
      }),
    ],
    scope,
  );
  assert.equal(out.blocking.length, 1);
  assert.equal(out.advisory.length, 0);
  assert.equal(out.dropped.length, 0);
});

test("an execution citation for a spec the run never executed is dropped", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[false-positive] the helper never ran",
        citation: { kind: "execution", ref: "flows/helper.spec.ts" },
      }),
    ],
    scope,
  );
  assert.deepEqual(out.blocking, []);
  assert.equal(out.dropped.length, 1);
});

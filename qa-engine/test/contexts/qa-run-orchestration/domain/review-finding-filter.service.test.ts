/* Review-finding filter: only evidence the orchestrator can verify may block. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterReviewFindings,
  takeMissingCases,
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

test("a verified advisory finding is kept as advisory, never promoted to blocking", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[fragile-selector] checkout.spec.ts: prefer a role over a text selector",
        severity: "advisory",
        citation: { kind: "execution", ref: "flows/checkout.spec.ts" },
      }),
    ],
    scope,
  );
  assert.deepEqual(out.blocking, []);
  assert.equal(out.advisory.length, 1);
  assert.deepEqual(out.dropped, []);
});

test("a contract citation needs the spec in scope, not an execution of it: only an execution citation must have run", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[wrong-objective] checkout.spec.ts: the contract clause no longer asserts the total",
        citation: { kind: "contract", ref: "flows/checkout.spec.ts#assertion-1" },
      }),
    ],
    { inScopeSpecs: new Set(["flows/checkout.spec.ts"]), executedSpecs: new Set<string>() },
  );
  assert.equal(out.blocking.length, 1, "the clause travels with the bytes; it does not need its own execution");
});

test("an execution citation on an in-scope spec the run never executed is dropped", () => {
  const out = filterReviewFindings(
    [
      finding({
        text: "[false-positive] checkout.spec.ts: nothing verifies the total",
        citation: { kind: "execution", ref: "flows/checkout.spec.ts" },
      }),
    ],
    { inScopeSpecs: new Set(["flows/checkout.spec.ts"]), executedSpecs: new Set<string>() },
  );
  assert.deepEqual(out.blocking, []);
  assert.equal(out.dropped.length, 1, "an execution claim needs an execution of that spec");
});

test("a finding that cites an arm no test ran is a missing case, kept only when that arm is in the run's list, and never blocks whatever severity it carries", () => {
  const findings = [
    { text: "[missing-case] the empty result of the search is not tested", severity: "blocking" as const, citation: { kind: "arm" as const, ref: "src/search.ts:12" } },
    { text: "[missing-case] an arm the run never listed", severity: "advisory" as const, citation: { kind: "arm" as const, ref: "src/search.ts:99" } },
    { text: "[false-positive] a.spec.ts asserts nothing", severity: "blocking" as const, citation: { kind: "execution" as const, ref: "a.spec.ts" } },
  ];

  const { missingCases, dropped, rest } = takeMissingCases(findings, new Set(["src/search.ts:12", "src/search.ts:30"]));

  assert.deepEqual(missingCases, ["[missing-case] the empty result of the search is not tested"]);
  assert.deepEqual(dropped, ["[missing-case] an arm the run never listed"]);
  assert.deepEqual(rest, [findings[2]]);
});

test("an arm citation that reaches the evidence filter is never a verified finding", () => {
  const out = filterReviewFindings([{ text: "x", severity: "blocking", citation: { kind: "arm", ref: "src/a.ts:1" } }], { inScopeSpecs: new Set(["a.spec.ts"]), executedSpecs: new Set(["a.spec.ts"]) });
  assert.deepEqual(out, { blocking: [], advisory: [], dropped: ["x"] });
});

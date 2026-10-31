/* Test-intent contract domain tests: anchoring against the change's tokens, generic delta rules and the
   change-derived waivers. Pure functions, no ports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeTokens, normalizeToken } from "@contexts/objective-signal/domain/change-tokens.ts";
import {
  anchoring,
  diffContracts,
  type IntentClause,
  type SpecIntent,
} from "@contexts/objective-signal/domain/test-intent-contract.ts";

/* One added line carrying two literals: the change's own vocabulary. */
const DIFF = ["diff --git a/src/checkout.ts b/src/checkout.ts", "@@ -1,2 +1,3 @@", "+  submitButton: 'Pay now',", "+  heading: \"Order summary\","].join("\n");

const clause = (over: Partial<IntentClause> & { id: string }): IntentClause => ({
  kind: "assertion",
  literals: [],
  scope: [],
  positional: [],
  opaque: false,
  ...over,
});

const spec = (over: Partial<SpecIntent> & { file: string }): SpecIntent => ({
  testName: "checkout",
  clauses: [],
  ...over,
});

test("a primary pass that names no change token is unanchored, and one that does is anchored", () => {
  const tokens = changeTokens(DIFF);
  const unrelated = [clause({ id: "a1", literals: ["Balance"], expected: "Balance", strength: "exact" })];
  const related = [clause({ id: "a1", literals: ["Pay now"], expected: "Pay now", strength: "exact" })];

  assert.equal(anchoring(unrelated, tokens), "unanchored");
  assert.equal(anchoring(related, tokens), "anchored");
});

test("a change with no token at all is no-tokens and can never be unanchored", () => {
  const tokens = changeTokens("diff --git a/src/style.css b/src/style.css\n@@ -1 +1 @@\n+.a { color: red; }");
  assert.equal(tokens.all.size, 0, "a diff with no quoted literal yields no token");
  assert.equal(anchoring([clause({ id: "a1", literals: ["Balance"] })], tokens), "no-tokens");
});

test("a changed container from the grounding report anchors a scope step", () => {
  const tokens = changeTokens("diff --git a/x b/x\n@@ -1 +1 @@\n+/* no literals here */", ["Order summary"]);
  assert.equal(normalizeToken("Order  Summary"), "order summary");
  assert.equal(anchoring([clause({ id: "a1", literals: ["Order summary"] })], tokens), "anchored");
});

test("a clause whose argument is not a literal is opaque: changing it is never rejected", () => {
  const tokens = changeTokens(DIFF);
  const before = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], opaque: true })] })];
  const after = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Something else"], opaque: true })] })];

  assert.deepEqual(diffContracts(before, after, tokens), []);
  assert.equal(anchoring(before[0]!.clauses, tokens), "not-evaluable", "opacity alone never makes a pass unanchored");
});

test("replacing a scope step with a positional step is rejected", () => {
  const tokens = changeTokens(DIFF);
  const before = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], scope: ["cart"], strength: "exact" })] })];
  const after = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], scope: [], positional: ["last"], strength: "exact" })] })];

  const rules = diffContracts(before, after, tokens).map((violation) => violation.rule);
  assert.deepEqual(rules, ["scope-to-position"]);
});

test("an assertion the regeneration drops is rejected", () => {
  const tokens = changeTokens(DIFF);
  const before = [
    spec({
      file: "e2e/a.spec.ts",
      clauses: [
        clause({ id: "a1", literals: ["Pay now"], strength: "exact" }),
        clause({ id: "a2", kind: "assertion", strength: "exact", expected: "3" }),
      ],
    }),
  ];
  const after = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], strength: "exact" })] })];

  const violations = diffContracts(before, after, tokens);
  assert.deepEqual(violations.map((violation) => violation.rule), ["dropped-assertion"]);
  assert.equal(violations[0]!.clauseId, "a2");
});

test("adding a scope step is waived: a strict-mode fix is not a weakening", () => {
  const tokens = changeTokens(DIFF);
  const before = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], scope: ["cart"], strength: "exact" })] })];
  const after = [
    spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], scope: ["cart", "button"], strength: "exact" })] }),
  ];

  assert.deepEqual(diffContracts(before, after, tokens), []);
});

test("a changed expected value is waived only when the new value comes from an added diff line", () => {
  const tokens = changeTokens(DIFF);
  const baseline = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], expected: "Pay now", strength: "exact" })] })];
  const waived = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], expected: "Order summary", strength: "exact" })] })];
  const notWaived = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], expected: "Pay later", strength: "exact" })] })];

  assert.deepEqual(diffContracts(baseline, waived, tokens), []);
  assert.deepEqual(
    diffContracts(baseline, notWaived, tokens).map((violation) => violation.rule),
    ["changed-expected-value"],
  );
});

test("deleting a test and weakening its matcher are both rejected", () => {
  const tokens = changeTokens(DIFF);
  const baseline = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], strength: "exact" })] })];
  const removed: SpecIntent[] = [];
  const weakened = [spec({ file: "e2e/a.spec.ts", clauses: [clause({ id: "a1", literals: ["Pay now"], strength: "truthy" })] })];

  assert.deepEqual(diffContracts(baseline, removed, tokens).map((violation) => violation.rule), ["deleted-test"]);
  assert.deepEqual(diffContracts(baseline, weakened, tokens).map((violation) => violation.rule), ["weakened-matcher"]);
});

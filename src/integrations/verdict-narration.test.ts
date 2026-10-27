import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGeneratorVerdict, parseReviewerVerdict } from "./verdict-validate";
import { parseVerdict } from "./verdict-parse";

/* Narration holds braces that are not JSON; the closing block that follows must still be found by every verdict reader. */
const NARRATION = "I will write `async ({ page }) => {` and then the helper {name, value} to check the form.\n";

test("parseReviewerVerdict reads the closing verdict after narration with an unbalanced brace", () => {
  const v = parseReviewerVerdict(`${NARRATION}{"approved":false,"corrections":["a.spec.ts: scope the selector"]}`);
  assert.equal(v.parsed, true);
  assert.equal(v.approved, false);
  assert.equal(v.corrections.length, 1);
});

test("parseReviewerVerdict takes the last verdict when an earlier one was quoted", () => {
  const v = parseReviewerVerdict('{"approved":false,"corrections":["x"]} then, revised:\n{"approved":true,"corrections":[]}');
  assert.equal(v.approved, true);
});

test("checkGeneratorVerdict finds the closing block after narration with an unbalanced brace", () => {
  assert.equal(checkGeneratorVerdict(`${NARRATION}{"specs":["login.spec.ts"]}`).valid, true);
});

test("parseVerdict reads the author's specs after narration with an unbalanced brace", () => {
  const v = parseVerdict(`${NARRATION}{"specs":["e2e/login.spec.ts"],"note":"ok"}`);
  assert.equal(v.parsed, true);
  assert.deepEqual(v.specs, ["e2e/login.spec.ts"]);
});

test("parseVerdict reads the lead's plan after narration with an unbalanced brace", () => {
  const v = parseVerdict(`${NARRATION}{"plan":{"flows":[]}}`);
  assert.equal(v.parsed, true);
  assert.deepEqual(v.plan, { flows: [] });
});

test("parseVerdict reads the lead's explore request after narration with an unbalanced brace", () => {
  const v = parseVerdict(`${NARRATION}{"explore":[{"question":"q"}]}`);
  assert.equal(v.parsed, true);
  assert.equal(v.explore?.length, 1);
});

test("parseVerdict takes the last closing block and ignores a non-verdict object after it", () => {
  const v = parseVerdict('{"specs":["a.spec.ts"]} later {"specs":["b.spec.ts"]} and {"unrelated":1}');
  assert.deepEqual(v.specs, ["b.spec.ts"]);
});

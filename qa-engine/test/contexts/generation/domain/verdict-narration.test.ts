import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGeneratorVerdict, parseReviewerVerdict } from "@contexts/generation/domain/verdict-validate.ts";
import { parseVerdict } from "@contexts/generation/domain/verdict-parse.ts";

/* Narration holds braces that are not JSON; the closing block that follows must still be found by every verdict reader. */
const NARRATION = "I will write `async ({ page }) => {` and then the helper {name, value} to check the form.\n";

test("parseReviewerVerdict reads the closing verdict after narration with an unbalanced brace", () => {
  const v = parseReviewerVerdict(`${NARRATION}{"approved":false,"corrections":[{"text":"a.spec.ts: scope the selector","severity":"blocking"}]}`);
  assert.equal(v.parsed, true);
  assert.equal(v.approved, false);
  assert.equal(v.findings.length, 1);
});

test("parseReviewerVerdict takes the last verdict when an earlier one was quoted", () => {
  const v = parseReviewerVerdict('{"approved":false,"corrections":[{"text":"x","severity":"blocking"}]} then, revised:\n{"approved":true,"corrections":[]}');
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

test("parseVerdict takes the closing block, not an earlier one", () => {
  const v = parseVerdict('{"specs":["a.spec.ts"]} later {"specs":["b.spec.ts"]}');
  assert.deepEqual(v.specs, ["b.spec.ts"]);
});

/* The answer is what closes the output: a closing block that does not read (not JSON, cut short) or an object of another shape after it is a miss, never an earlier block of the same answer. */
const BROKEN_CLOSINGS = {
  "not JSON": (json: string) => `${json.slice(0, -1)},}`,
  "cut short": (json: string) => json.slice(0, Math.floor(json.length / 2)),
  "another object after it": (json: string) => `${json}\n{"unrelated":1}`,
};

test("no verdict reader takes an earlier block when the closing one does not read", () => {
  for (const [name, broken] of Object.entries(BROKEN_CLOSINGS)) {
    const author = parseVerdict(`{"specs":["draft.spec.ts"]}\nrevised:\n${broken('{"specs":["final.spec.ts"]}')}`);
    assert.equal(author.parsed, false, `author: ${name}`);
    assert.deepEqual(author.specs, [], `author: ${name}`);
    assert.equal(checkGeneratorVerdict(`{"specs":["draft.spec.ts"]}\nrevised:\n${broken('{"specs":["final.spec.ts"]}')}`).valid, false, `author check: ${name}`);
    assert.equal(parseVerdict(`{"plan":{"flows":[]}}\nrevised:\n${broken('{"plan":{"flows":[{"id":"cart"}]}}')}`).parsed, false, `lead plan: ${name}`);
    const reviewer = parseReviewerVerdict(`{"approved":true,"corrections":[]}\nreconsidered:\n${broken('{"approved":false,"corrections":[{"text":"x","severity":"blocking"}]}')}`);
    assert.equal(reviewer.parsed, false, `reviewer: ${name}`);
    assert.equal(reviewer.approved, false, `reviewer: ${name}`);
  }
});

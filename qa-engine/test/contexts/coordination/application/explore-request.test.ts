import { test } from "node:test";
import assert from "node:assert/strict";
import { admitExploreRequest, EXPLORE_REJECTED, MAX_EXPLORE_QUESTIONS, MAX_QUESTION_CHARS } from "@contexts/coordination/application/explore-request.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const ask = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, question: `what is on page ${i + 1}?` }));

test("more than 3 questions, an empty question or a route with a scheme is not admitted", () => {
  assert.deepEqual(admitExploreRequest(ask(MAX_EXPLORE_QUESTIONS + 1), redaction), { kind: "rejected", reason: EXPLORE_REJECTED.OVER_LIMIT });
  assert.deepEqual(admitExploreRequest([{ id: "a", question: "   " }], redaction), { kind: "rejected", reason: EXPLORE_REJECTED.MALFORMED });
  assert.deepEqual(admitExploreRequest([{ id: "a", question: "what shows?", routes: ["https://elsewhere.example/cart"] }], redaction), { kind: "rejected", reason: EXPLORE_REJECTED.MALFORMED });
  assert.deepEqual(admitExploreRequest([{ id: "a", question: "what shows?", routes: ["//elsewhere.example/cart"] }], redaction), { kind: "rejected", reason: EXPLORE_REJECTED.MALFORMED });
});

test("a request that is not a list, is empty or repeats a question id is not admitted", () => {
  assert.equal(admitExploreRequest({ question: "x" }, redaction).kind, "rejected");
  assert.deepEqual(admitExploreRequest([], redaction), { kind: "rejected", reason: EXPLORE_REJECTED.EMPTY });
  assert.deepEqual(admitExploreRequest([{ id: "same", question: "one?" }, { id: "same", question: "two?" }], redaction), { kind: "rejected", reason: EXPLORE_REJECTED.DUPLICATE });
});

test("up to 3 questions with site-relative routes are admitted, a long question is cut and a missing id is numbered", () => {
  const admitted = admitExploreRequest([{ question: "page words ".repeat(60), routes: ["/cart", "/cart", "/orders/:id"] }, { id: "Second One", question: "which symbol handles checkout?" }], redaction);
  assert.equal(admitted.kind, "admitted");
  if (admitted.kind !== "admitted") return;
  assert.equal(admitted.questions[0]!.question.length, MAX_QUESTION_CHARS);
  assert.equal(admitted.questions[0]!.id, "q1");
  assert.deepEqual(admitted.questions[0]!.routes, ["/cart", "/orders/:id"]);
  assert.equal(admitted.questions[1]!.id, "second-one");
});

test("a question is scrubbed before it is kept", () => {
  const admitted = admitExploreRequest([{ id: "a", question: `does the page show sk-ant-api03-${"a".repeat(40)} anywhere?` }], redaction);
  assert.equal(admitted.kind, "admitted");
  if (admitted.kind !== "admitted") return;
  assert.ok(!admitted.questions[0]!.question.includes("sk-ant-api03-aaaa"));
});

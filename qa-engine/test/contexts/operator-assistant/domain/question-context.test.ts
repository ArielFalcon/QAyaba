import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUESTION_CHARS, boundQuestion, helpHistoryLine, helpQuestionContext, runHistoryLine, runQuestionContext } from "@contexts/operator-assistant/domain/question-context.ts";

const redactKeys = (text: string): string => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]");

test("a credential in the question leaves before the question is cut", () => {
  const key = `sk-${"Q7x9Zk2M".repeat(6)}`;
  const question = `${"a".repeat(MAX_QUESTION_CHARS - 10)}${key} and more words after`;
  const bound = boundQuestion(question, redactKeys);
  assert.doesNotMatch(bound, /sk-Q7x9/);
  assert.ok(bound.endsWith(" [truncated]"));
});

test("a short question passes through redaction and is not cut", () => {
  assert.equal(boundQuestion("why did it fail?", redactKeys), "why did it fail?");
});

test("a conversation line names the operator for a question and the assistant for anything else", () => {
  assert.equal(runHistoryLine({ role: "q", text: "why?" }), "Operator: why?");
  assert.equal(runHistoryLine({ role: "a", text: 4 }), "Assistant: 4");
  assert.equal(helpHistoryLine({ role: "q", text: "how?" }), "q: how?");
});

test("a run question's context is the orientation, the run and the last six lines of the conversation", () => {
  const history = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  const context = runQuestionContext({ orientation: "ORIENT", run: "RUN", history });
  assert.equal(context, `ORIENT\n\n---\n\nRUN\n\nRecent conversation:\n${history.slice(2).join("\n")}`);
  assert.equal(runQuestionContext({ orientation: "ORIENT", run: "RUN", history: [] }), "ORIENT\n\n---\n\nRUN");
});

test("a product question's context is the help text and the last ten lines of the conversation", () => {
  const history = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  assert.equal(helpQuestionContext("HELP", history), `HELP\n\n## Recent conversation\n${history.slice(2).join("\n")}`);
  assert.equal(helpQuestionContext("HELP", []), "HELP");
});

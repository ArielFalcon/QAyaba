/*
 * The learning context the run assistant answers from (buildLearningContext) over the real history
 * store (test-setup.mjs gives each test file a temporary one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLearningContext } from "./chat";
import { getHistory } from "./persistence/index";

test("the assistant is told the recent outcomes an app's runs left", () => {
  const app = `chat-outcomes-${Math.random().toString(36).slice(2)}`;
  getHistory().learning.saveRunOutcome({
    runId: `${app}-1`, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict: "fail", errorClass: "E-EXEC-FAIL",
    gateSignals: { static: true, coverageRatio: null, valueScore: 0.5, reviewerCorrections: [], flaky: false, retries: 0 }, at: "2026-10-01T00:00:00.000Z",
  });

  const context = buildLearningContext(app);

  assert.ok(context, "an app with an outcome has learning state worth reporting");
  assert.match(context, /fail E-EXEC-FAIL valueScore=50% \(diff\/e2e, abcdef1\)/);
});

test("an app with no learning state at all gives the assistant no learning context", () => {
  assert.equal(buildLearningContext(`chat-empty-${Math.random().toString(36).slice(2)}`), null);
});

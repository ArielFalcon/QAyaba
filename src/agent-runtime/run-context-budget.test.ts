import { test } from "node:test";
import assert from "node:assert/strict";
import { RunContextBudget, roleOfRecordedTurn, samplesOfRecordedTurns, type RecordedTurnRow } from "./run-context-budget";
import type { AgentRuntimeConfig } from "./types";

const assignment = (model: string) => ({ provider: "opencode" as const, model });
const config: AgentRuntimeConfig = { assignments: { primary: assignment("p/main"), reviewer: assignment("p/judge"), chat: assignment("p/chat") } };

/* A recorded author turn: 10 steps, a 4,000-byte prompt (1,000 tokens), ending at 6,000 tokens of context. */
const authorTurn = (role = "qa-author"): RecordedTurnRow => ({ role, stepsUsed: 10, promptBytes: 4_000, tokensInput: 2_000, tokensCacheRead: 4_000 });

test("a run that has installed nothing knows no window and no working room", () => {
  const run = new RunContextBudget();

  assert.equal(run.windowTokens("author"), undefined);
  assert.equal(run.budget.fit({ prompt: { tokens: 1 }, role: "author" }).outcome, "unknown");
});

test("the window of a role is the one the runtime reports for the model the role is assigned", () => {
  const run = new RunContextBudget();
  run.install({ windows: { "p/main": 300_000, "p/judge": 120_000 }, config, stepLimits: {}, history: [] });

  assert.equal(run.windowTokens("author"), 300_000);
  assert.equal(run.windowTokens("lead"), 300_000);
  assert.equal(run.windowTokens("reviewer"), 120_000);
  assert.equal(run.windowTokens("reflector"), undefined, "the chat tier reported no window");
});

test("the working room comes from the recorded turns of the role, replacing the cold start", () => {
  const run = new RunContextBudget();
  run.install({ windows: { "p/main": 300_000 }, config, stepLimits: { author: 50 }, history: [authorTurn(), authorTurn("author"), authorTurn()] });

  const fit = run.budget.fit({ prompt: { tokens: 1_000 }, role: "author" });

  assert.equal(fit.roomBasis, "history");
  assert.equal(fit.workingRoomTokens, 5_000, "(6,000 - 1,000) / 10 steps = 500 a step, over 10 steps");
  assert.equal(fit.outcome, "fits");
});

test("a turn of a role the engine does not know, or one without its figures, is no sample", () => {
  assert.equal(roleOfRecordedTurn("qa-lead"), "lead");
  assert.equal(roleOfRecordedTurn("reviewer"), "reviewer");
  assert.equal(roleOfRecordedTurn("qa-unheard-of"), undefined);
  assert.equal(samplesOfRecordedTurns([{ ...authorTurn("qa-unheard-of") }, { ...authorTurn(), stepsUsed: null }]).length, 0);
});

test("installing again replaces the run's windows: a run never keeps what it read before", () => {
  const run = new RunContextBudget();
  run.install({ windows: { "p/main": 300_000 }, config, stepLimits: {}, history: [] });
  run.install({ windows: undefined, config, stepLimits: {}, history: [] });

  assert.equal(run.windowTokens("author"), undefined);
});

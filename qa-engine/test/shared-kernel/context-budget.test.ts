import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextBudget, bytesOfTokens, roomTokens, tokensOfBytes } from "@kernel/context-budget.ts";
import type { ContextWindowPort } from "@kernel/ports/context-window.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { COLD_START_STEP_GROWTH_TOKENS, estimateWorkingRoom, turnSample, type TurnSample } from "@kernel/working-room.ts";

const windows = (byRole: Partial<Record<AgentRole, number>>, byModel: Record<string, number> = {}): ContextWindowPort => ({
  windowTokens: (role, model) => (model !== undefined ? byModel[model] : byRole[role]),
});

const fixedRoom = (growth: number, steps: number) => ({ forRole: () => ({ growthTokensPerStep: growth, steps, basis: "history" as const, samples: 9 }) });

test("a prompt fits when prompt plus working room is at most the window, and is over one token past it", () => {
  const budget = new ContextBudget(windows({ author: 10_000 }), fixedRoom(100, 20)); /* room 2000 */
  assert.equal(budget.fit({ prompt: { tokens: 8_000 }, role: "author" }).outcome, "fits");
  const over = budget.fit({ prompt: { tokens: 8_001 }, role: "author" });
  assert.equal(over.outcome, "over");
  assert.equal(over.workingRoomTokens, 2_000);
  assert.equal(over.windowTokens, 10_000);
});

test("a prompt given in bytes is converted with the documented estimator", () => {
  const budget = new ContextBudget(windows({ author: 10_000 }), fixedRoom(100, 20));
  assert.equal(budget.fit({ prompt: { bytes: bytesOfTokens(8_000) }, role: "author" }).outcome, "fits");
  assert.equal(tokensOfBytes(bytesOfTokens(123)), 123);
  assert.equal(tokensOfBytes(5), 2);
});

test("an unknown window is unknown, never a number", () => {
  const budget = new ContextBudget(windows({}), fixedRoom(100, 20));
  const fit = budget.fit({ prompt: { tokens: 1 }, role: "lead" });
  assert.equal(fit.outcome, "unknown");
  assert.equal(fit.windowTokens, undefined);
});

test("an unknown working room is unknown even with a known window", () => {
  const budget = new ContextBudget(windows({ lead: 1_000_000 }), { forRole: () => undefined });
  const fit = budget.fit({ prompt: { tokens: 1 }, role: "lead" });
  assert.equal(fit.outcome, "unknown");
  assert.equal(fit.windowTokens, 1_000_000);
});

test("an explicit model asks the port for that model's window", () => {
  const budget = new ContextBudget(windows({ author: 1_000 }, { "p/escalated": 50_000 }), fixedRoom(10, 10));
  assert.equal(budget.fit({ prompt: { tokens: 10_000 }, role: "author", model: "p/escalated" }).outcome, "fits");
  assert.equal(budget.fit({ prompt: { tokens: 10_000 }, role: "author" }).outcome, "over");
});

test("two budgets over different per-run ports do not interfere", () => {
  const a = new ContextBudget(windows({ lead: 10_000 }), fixedRoom(0, 0));
  const b = new ContextBudget(windows({ lead: 100_000 }), fixedRoom(0, 0));
  assert.equal(a.fit({ prompt: { tokens: 50_000 }, role: "lead" }).outcome, "over");
  assert.equal(b.fit({ prompt: { tokens: 50_000 }, role: "lead" }).outcome, "fits");
  assert.equal(a.fit({ prompt: { tokens: 50_000 }, role: "lead" }).outcome, "over");
});

const sample = (role: AgentRole, steps: number, growthPerStep: number, promptTokens = 1_000): TurnSample => ({ role, stepsUsed: steps, promptTokens, finalContextTokens: promptTokens + growthPerStep * steps });

test("the working room is the role's measured growth per step times its usual steps", () => {
  const turns = [sample("author", 10, 500), sample("author", 10, 500), sample("author", 10, 500), sample("lead", 2, 9_999)];
  const room = estimateWorkingRoom({ turns, stepLimitFor: () => 99 }).forRole("author")!;
  assert.equal(room.basis, "history");
  assert.equal(room.samples, 3);
  assert.equal(room.growthTokensPerStep, 500);
  assert.equal(room.steps, 10);
  assert.equal(roomTokens(room), 5_000);
});

test("the usual figures are the conservative upper quartile, so one cheap turn does not shrink the room", () => {
  const turns = [sample("author", 4, 100), sample("author", 6, 200), sample("author", 8, 300), sample("author", 40, 1_000)];
  const room = estimateWorkingRoom({ turns, stepLimitFor: () => undefined }).forRole("author")!;
  assert.ok(room.steps >= 8 && room.growthTokensPerStep >= 300);
});

test("with too little history the room starts cold from the role's live step limit", () => {
  const room = estimateWorkingRoom({ turns: [sample("author", 10, 500)], stepLimitFor: (role) => (role === "author" ? 30 : undefined) }).forRole("author")!;
  assert.equal(room.basis, "cold-start");
  assert.equal(room.steps, 30);
  assert.equal(room.growthTokensPerStep, COLD_START_STEP_GROWTH_TOKENS);
});

test("with no history and no step limit the room is unknown", () => {
  assert.equal(estimateWorkingRoom({ turns: [], stepLimitFor: () => undefined }).forRole("lead"), undefined);
});

test("a recorded turn becomes a sample only when it holds the figures a growth needs", () => {
  assert.deepEqual(turnSample({ role: "author", stepsUsed: 5, promptTokens: 1_000, tokensInput: 3_000, tokensCacheRead: 1_000 }), { role: "author", stepsUsed: 5, promptTokens: 1_000, finalContextTokens: 4_000 });
  assert.equal(turnSample({ role: "author", stepsUsed: null, promptTokens: 1_000, tokensInput: 3_000, tokensCacheRead: 0 }), undefined);
  assert.equal(turnSample({ role: "author", stepsUsed: 5, promptTokens: 1_000, tokensInput: null, tokensCacheRead: null }), undefined);
});

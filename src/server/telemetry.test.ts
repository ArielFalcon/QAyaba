/* These tests verify that computeTelemetryAnalysis correctly aggregates agent_turns + run_outcomes
   for an app into the metrics exposed by GET /api/apps/:app/telemetry.
   The tests use the real SQLite history layer (same pattern as history.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTelemetryAnalysis } from "./history";
import { saveAgentTurn, saveRunOutcome } from "./history";
import type { AgentTurnRecord } from "./history";
import type { RunOutcome } from "../types";

/* Unique-per-invocation app name so tests don't bleed into each other. */
function uniqueApp(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function outcome(runId: string, app: string, overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId,
    app,
    sha: "abc1234",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: null,
      valueScore: null,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: new Date().toISOString(),
    ...overrides,
  };
}

function turn(runId: string, overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    runId,
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    role: "qa-generator",
    round: 0,
    isRepair: false,
    ts: new Date().toISOString(),
    objective: null,
    promptText: "## System\nYou are a QA agent.",
    outputText: '{"specs":["a.spec.ts"],"approved":true}',
    promptBytes: 40,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: null,
    tokensCacheRead: 20,
    tokensCacheWrite: 5,
    cost: 0.001,
    ...overrides,
  };
}

describe("computeTelemetryAnalysis — empty app returns zero-state", () => {
  it("returns zero runCount and null aggregates when no turns exist for the app", () => {
    const app = uniqueApp("tel-empty");
    const analysis = computeTelemetryAnalysis(app);
    assert.equal(analysis.app, app);
    assert.equal(analysis.runCount, 0, "no runs recorded");
    assert.equal(analysis.byRole.length, 0, "no role stats when no turns");
    assert.equal(analysis.groundingPresence, null, "null when no turns");
    assert.equal(analysis.repairFraction, null, "null when no turns");
    assert.equal(analysis.medianTurnsPerRun, null, "null when no turns");
    assert.equal(analysis.medianWallClockSec, null, "null when no turns");
    assert.equal(analysis.reviewerConvergence.approveRate, null, "null when no outcomes");
  });
});

describe("computeTelemetryAnalysis — per-role prompt size aggregates", () => {
  it("computes medianPromptBytes and turnCount per role", () => {
    const app = uniqueApp("tel-role");
    const runId = `run-tel-role-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, { role: "qa-generator", promptBytes: 200 }));
    saveAgentTurn(turn(runId, { role: "qa-generator", promptBytes: 400 }));
    saveAgentTurn(turn(runId, { role: "qa-reviewer", promptBytes: 150 }));

    const analysis = computeTelemetryAnalysis(app);
    const gen = analysis.byRole.find((r) => r.role === "qa-generator");
    const rev = analysis.byRole.find((r) => r.role === "qa-reviewer");

    assert.ok(gen, "qa-generator role must appear in byRole");
    assert.equal(gen.turnCount, 2, "two generator turns");
    assert.equal(gen.medianPromptBytes, 300, "median of 200 and 400 = 300");

    assert.ok(rev, "qa-reviewer role must appear in byRole");
    assert.equal(rev.turnCount, 1);
    assert.equal(rev.medianPromptBytes, 150);
  });
});

describe("computeTelemetryAnalysis — cache hit rate", () => {
  it("computes median cache hit rate (cacheRead/tokensInput) per role", () => {
    const app = uniqueApp("tel-cache");
    const runId = `run-tel-cache-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, { role: "qa-generator", tokensInput: 100, tokensCacheRead: 20 }));
    saveAgentTurn(turn(runId, { role: "qa-generator", tokensInput: 100, tokensCacheRead: 50 }));

    const analysis = computeTelemetryAnalysis(app);
    const gen = analysis.byRole.find((r) => r.role === "qa-generator");
    assert.ok(gen, "qa-generator must appear");
    assert.ok(gen.medianCacheHitRate !== null, "cache hit rate should be populated");
    assert.ok(Math.abs(gen.medianCacheHitRate! - 0.35) < 1e-9, `expected 0.35, got ${gen.medianCacheHitRate}`);
  });

  it("cache hit rate is null when no token data (Codex turns)", () => {
    const app = uniqueApp("tel-codex");
    const runId = `run-tel-codex-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, { role: "qa-generator", tokensInput: null, tokensCacheRead: null }));

    const analysis = computeTelemetryAnalysis(app);
    const gen = analysis.byRole.find((r) => r.role === "qa-generator");
    assert.ok(gen, "qa-generator must appear");
    assert.equal(gen.medianCacheHitRate, null, "null when no token data");
  });
});

describe("computeTelemetryAnalysis — grounding presence", () => {
  it("detects Context Pack presence in first-round generator turns", () => {
    const app = uniqueApp("tel-grnd");
    const runId = `run-tel-grnd-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, {
      role: "qa-generator", round: 0, isRepair: false,
      promptText: "## System\n...## Context Pack\n<routes>...</routes>",
    }));
    saveAgentTurn(turn(runId, {
      role: "qa-generator", round: 0, isRepair: false,
      promptText: "## System\n... no context pack here",
    }));

    const analysis = computeTelemetryAnalysis(app);
    assert.ok(analysis.groundingPresence !== null, "grounding presence should be computed");
    assert.equal(analysis.groundingPresence, 0.5, "1 of 2 first-round turns grounded = 0.5");
  });

  /* the PLANNER turn (role qa-generator, objective "(planner)") is a plan-only pass that never
     carries a Context Pack. Counting it deflated groundingPresence. It must be EXCLUDED.
   */
  it("a planner turn does NOT count against grounding presence", () => {
    const app = uniqueApp("tel-grnd-planner");
    const runId = `run-tel-grnd-planner-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    /* The PLANNER turn: round 0, qa-generator, objective "(planner)", NO pack. Must be excluded. */
    saveAgentTurn(turn(runId, {
      role: "qa-generator", round: 0, isRepair: false, objective: "(planner)",
      promptText: "## Phase 1 of 2 — PLANNING ONLY\n... no pack here",
    }));
    saveAgentTurn(turn(runId, {
      role: "qa-generator", round: 0, isRepair: false, objective: "checkout flow",
      promptText: "## System\n...## Context Pack\n<routes>...</routes>",
    }));

    const analysis = computeTelemetryAnalysis(app);
    /* Only the WRITE turn counts → 1/1 grounded = 1.0. If the planner were (wrongly) counted it
       would be 1/2 = 0.5 — so 1.0 proves the planner was excluded.
     */
    assert.equal(analysis.groundingPresence, 1, "planner turn must be excluded → 1/1 write turn grounded");
  });

  it("a run that is ONLY a planner turn yields null grounding (no real write turns to measure)", () => {
    const app = uniqueApp("tel-grnd-planneronly");
    const runId = `run-tel-grnd-planneronly-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, {
      role: "qa-generator", round: 0, isRepair: false, objective: "(planner)",
      promptText: "## Phase 1 of 2 — PLANNING ONLY",
    }));
    const analysis = computeTelemetryAnalysis(app);
    assert.equal(analysis.groundingPresence, null, "with only a planner turn there are no write turns → null, not 0");
  });
});

describe("computeTelemetryAnalysis — repair fraction", () => {
  it("repair fraction = (isRepair turns) / (all turns)", () => {
    const app = uniqueApp("tel-repair");
    const runId = `run-tel-repair-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, { isRepair: false }));
    saveAgentTurn(turn(runId, { isRepair: false }));
    saveAgentTurn(turn(runId, { isRepair: true }));  /* 1 of 3 turns = 1/3 ≈ 0.333 */

    const analysis = computeTelemetryAnalysis(app);
    assert.ok(analysis.repairFraction !== null);
    assert.ok(Math.abs(analysis.repairFraction! - 1 / 3) < 1e-9, `expected 1/3, got ${analysis.repairFraction}`);
  });
});

describe("computeTelemetryAnalysis — reviewer convergence approveRate", () => {
  it("approveRate = fraction of runs with pass/skipped verdict", () => {
    const app = uniqueApp("tel-conv");
    const run1 = `run-conv-pass-${Date.now()}`;
    const run2 = `run-conv-fail-${Date.now()}`;
    saveRunOutcome(outcome(run1, app, { verdict: "pass" }));
    saveRunOutcome(outcome(run2, app, { verdict: "fail" }));

    const analysis = computeTelemetryAnalysis(app);
    assert.ok(analysis.reviewerConvergence.approveRate !== null);
    assert.equal(analysis.reviewerConvergence.approveRate, 0.5);
  });
});

describe("computeTelemetryAnalysis — turns per run and wall-clock", () => {
  it("median turns per run matches expected count", () => {
    const app = uniqueApp("tel-turns");
    const runId = `run-tel-turns-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId));
    saveAgentTurn(turn(runId));
    saveAgentTurn(turn(runId));

    const analysis = computeTelemetryAnalysis(app);
    assert.equal(analysis.runCount, 1);
    assert.equal(analysis.medianTurnsPerRun, 3, "3 turns in the only run → median = 3");
  });

  it("wall-clock span is non-negative when turns span time", () => {
    const app = uniqueApp("tel-wall");
    const runId = `run-tel-wall-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 5000);
    saveAgentTurn(turn(runId, { ts: t0.toISOString() }));
    saveAgentTurn(turn(runId, { ts: t1.toISOString() }));

    const analysis = computeTelemetryAnalysis(app);
    assert.ok(analysis.medianWallClockSec !== null);
    assert.ok(analysis.medianWallClockSec! >= 5, `expected >= 5s, got ${analysis.medianWallClockSec}`);
  });
});

/* The explorer's turns are persisted so the per-role and efficiency views can show them, but the
   existing run-level figures keep the meaning they had before: they describe the roles that
   were recorded then (generator, reviewer, worker ...), never the explorer. */
describe("computeTelemetryAnalysis — the explorer is exposed only by role and efficiency views", () => {
  const explorerTurn = (runId: string, overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord =>
    turn(runId, { role: "qa-explorer", ...overrides });

  it("leaves the turns-per-run and repair figures as they were without the explorer's turns", () => {
    const app = uniqueApp("tel-explorer-legacy");
    const runId = `run-explorer-legacy-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId));
    saveAgentTurn(turn(runId, { isRepair: true }));
    saveAgentTurn(explorerTurn(runId));
    saveAgentTurn(explorerTurn(runId));

    const analysis = computeTelemetryAnalysis(app);

    assert.equal(analysis.medianTurnsPerRun, 2, "the run's two generator turns, not its four turns");
    assert.equal(analysis.repairFraction, 1 / 2, "one repair among the two generator turns");
  });

  it("does not stretch the wall-clock span to the explorer's turns, before or after the generator's", () => {
    const app = uniqueApp("tel-explorer-wall");
    const runId = `run-explorer-wall-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    const t0 = Date.now();
    saveAgentTurn(explorerTurn(runId, { ts: new Date(t0 - 60_000).toISOString() }));
    saveAgentTurn(turn(runId, { ts: new Date(t0).toISOString() }));
    saveAgentTurn(turn(runId, { ts: new Date(t0 + 5_000).toISOString() }));
    saveAgentTurn(explorerTurn(runId, { ts: new Date(t0 + 90_000).toISOString() }));

    const analysis = computeTelemetryAnalysis(app);

    assert.equal(analysis.medianWallClockSec, 5);
    assert.equal(analysis.p95WallClockSec, 5);
  });

  it("does not count a run that only has explorer turns", () => {
    const app = uniqueApp("tel-explorer-only");
    const withGenerator = `run-explorer-gen-${Date.now()}`;
    const explorerOnly = `run-explorer-only-${Date.now()}`;
    saveRunOutcome(outcome(withGenerator, app));
    saveRunOutcome(outcome(explorerOnly, app));
    saveAgentTurn(turn(withGenerator));
    saveAgentTurn(explorerTurn(explorerOnly));

    const analysis = computeTelemetryAnalysis(app);

    assert.equal(analysis.runCount, 1);
    assert.equal(analysis.medianTurnsPerRun, 1);
  });

  it("still reports the explorer's turns in the per-role view", () => {
    const app = uniqueApp("tel-explorer-byrole");
    const runId = `run-explorer-byrole-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId));
    saveAgentTurn(explorerTurn(runId, { promptBytes: 900 }));

    const explorer = computeTelemetryAnalysis(app).byRole.find((r) => r.role === "qa-explorer");

    assert.ok(explorer, "the explorer appears in byRole");
    assert.equal(explorer.turnCount, 1);
    assert.equal(explorer.medianPromptBytes, 900);
  });

  it("counts an exhausted explorer turn in the exhausted rate", () => {
    const app = uniqueApp("tel-explorer-exhausted");
    const runId = `run-explorer-exhausted-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, { exhausted: false }));
    saveAgentTurn(explorerTurn(runId, { exhausted: true }));

    assert.equal(computeTelemetryAnalysis(app).efficiency.exhaustedRate, 1 / 2);
  });
});

describe("computeTelemetryAnalysis — windowDays filtering", () => {
  it("windowDays=1 excludes turns older than 1 day", () => {
    const app = uniqueApp("tel-win");
    const oldRunId = `run-old-${Date.now()}`;
    const newRunId = `run-new-${Date.now()}`;

    const oldAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    saveRunOutcome(outcome(oldRunId, app, { at: oldAt }));
    saveRunOutcome(outcome(newRunId, app));

    saveAgentTurn(turn(oldRunId, { ts: oldAt }));
    saveAgentTurn(turn(newRunId));

    const analysis = computeTelemetryAnalysis(app, 1);
    assert.equal(analysis.runCount, 1, "only the new run should be within the 1-day window");
    assert.equal(analysis.medianTurnsPerRun, 1, "only 1 turn in the window");
  });
});

describe("computeTelemetryAnalysis — efficiency aggregates", () => {
  const measured = (overrides: Partial<AgentTurnRecord>): Partial<AgentTurnRecord> => ({
    totalCalls: 10,
    callsBeforeFirstWrite: 5,
    redundantReadCount: 0,
    duplicateCallCount: 0,
    exhausted: false,
    ...overrides,
  });

  it("reports null aggregates when the app has no measured turns", () => {
    const app = uniqueApp("tel-eff-empty");
    const runId = `run-eff-empty-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId));

    const { efficiency } = computeTelemetryAnalysis(app);
    assert.equal(efficiency.turnsMeasured, 0);
    assert.equal(efficiency.medianCallsBeforeFirstWrite, null);
    assert.equal(efficiency.exhaustedRate, null);
    assert.equal(efficiency.redundantReadRatio, null);
    assert.equal(efficiency.duplicateRatio, null);
  });

  it("computes the aggregates from the persisted per-turn metrics", () => {
    const app = uniqueApp("tel-eff");
    const runId = `run-eff-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, measured({ totalCalls: 10, callsBeforeFirstWrite: 8, redundantReadCount: 2, duplicateCallCount: 1, exhausted: true })));
    saveAgentTurn(turn(runId, measured({ totalCalls: 10, callsBeforeFirstWrite: 4, redundantReadCount: 0, duplicateCallCount: 1, exhausted: false })));
    saveAgentTurn(turn(runId, measured({ totalCalls: 20, callsBeforeFirstWrite: 20, redundantReadCount: 4, duplicateCallCount: 2, exhausted: false })));

    const { efficiency } = computeTelemetryAnalysis(app);
    assert.equal(efficiency.turnsMeasured, 3);
    assert.equal(efficiency.medianCallsBeforeFirstWrite, 8);
    assert.equal(efficiency.exhaustedRate, 1 / 3);
    assert.equal(efficiency.redundantReadRatio, 6 / 40);
    assert.equal(efficiency.duplicateRatio, 4 / 40);
  });

  it("leaves turns without measurements out of every aggregate and out of the exhausted rate's denominator", () => {
    const app = uniqueApp("tel-eff-null");
    const runId = `run-eff-null-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, measured({ totalCalls: 10, callsBeforeFirstWrite: 6, redundantReadCount: 1, duplicateCallCount: 0, exhausted: true })));
    saveAgentTurn(turn(runId));
    saveAgentTurn(turn(runId, { exhausted: null, totalCalls: null }));

    const { efficiency } = computeTelemetryAnalysis(app);
    assert.equal(efficiency.turnsMeasured, 1);
    assert.equal(efficiency.exhaustedRate, 1);
    assert.equal(efficiency.medianCallsBeforeFirstWrite, 6);
    assert.equal(efficiency.redundantReadRatio, 0.1);
  });

  it("ignores turns that made no calls when taking the median calls before the first write", () => {
    const app = uniqueApp("tel-eff-zero");
    const runId = `run-eff-zero-${Date.now()}`;
    saveRunOutcome(outcome(runId, app));
    saveAgentTurn(turn(runId, measured({ totalCalls: 0, callsBeforeFirstWrite: 0 })));
    saveAgentTurn(turn(runId, measured({ totalCalls: 12, callsBeforeFirstWrite: 9 })));

    const { efficiency } = computeTelemetryAnalysis(app);
    assert.equal(efficiency.medianCallsBeforeFirstWrite, 9);
  });
});

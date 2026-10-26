import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHistoryDatabase } from "./database";
import { createHistory, type History } from "./index";
import { DELETE_MAX_AGE_DAYS, pruneHistory } from "./retention";
import { RunRepository } from "./repositories/run.repository";
import { ContextRepository } from "./repositories/context.repository";
import { JudgeRepository } from "./repositories/judge.repository";
import { EvaluationRepository } from "./repositories/evaluation.repository";
import { LearningRepository } from "./repositories/learning.repository";
import { TelemetryRepository } from "./repositories/telemetry.repository";

/*
 * The persistence gate: no write statement runs outside a transaction. Every public method of every repository is either
 * listed as a read or driven below with a call that writes, so a new method is covered or this file fails.
 */

const AT = "2026-10-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-26T12:00:00.000Z");

interface Harness {
  history: History;
  writes: Array<{ sql: string; inTransaction: boolean }>;
  db: ReturnType<typeof openHistoryDatabase>;
}

function instrumented(t: { after: (fn: () => void) => void }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "history-gate-"));
  const writes: Harness["writes"] = [];
  const db = openHistoryDatabase(join(dir, "history.db"), {
    onStatement: (sql, inTransaction) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes.push({ sql, inTransaction });
    },
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { history: createHistory(db), writes, db };
}

/* Methods that only read, or that are private helpers of a method driven below. */
const READS: Record<string, readonly string[]> = {
  RunRepository: [
    "recalcCounts", "rowToRecord", "getRunPhases", "getRunIdByTraceId", "getRunFacts", "getRunCampaign", "getCampaignCaptureMode", "listCampaignRuns",
    "listFinishedCampaignRunIds", "getStoredEffectiveConfig", "getRunFunnel", "getRecord", "listRecords", "childrenOf", "currentRun", "interruptedRecords",
    "continuationDepth", "runVerdictCounts", "loadRunEvents", "runExists", "listFinishedRunIdsSince", "listSpecSnapshots", "getRunPlan",
  ],
  ContextRepository: ["isContextStale", "loadContextMap"],
  JudgeRepository: ["lastJudgeOutcome", "latestJudgeModel", "judgeTokensUsedOn", "judgeOutcomeCounts", "latestJudgeCalibration", "listJudgeLabelPairs"],
  EvaluationRepository: ["listRunScoreRows", "getRunEvaluationStatus", "getRegradeJob"],
  LearningRepository: [
    "writeOutcome", "rowToOutcome", "listRunOutcomes", "getRunOutcome", "rowToRule", "listLearningRules", "getLearningRule", "listLearningRulesForGovernance",
    "listAllLearningRules", "loadCurriculum", "loadScorecard",
  ],
  TelemetryRepository: ["listRunSpans", "getAgentTurns", "getAgentRoleFacts", "getAgentTurnTraces", "computeTelemetryAnalysis"],
};

const REPOSITORIES = {
  RunRepository,
  ContextRepository,
  JudgeRepository,
  EvaluationRepository,
  LearningRepository,
  TelemetryRepository,
} as const;

/* `deleteApp` of each repository is driven through the one entry point that calls it, `History.purgeApp`. */
const VIA_PURGE_APP = "deleteApp";

/* The writing calls, keyed `Repository.method`. Each must perform at least one write statement. */
function writingCalls(h: History): Record<string, () => unknown> {
  const run = h.runs.createRecord({ app: "app", sha: "abcdef1234", target: "e2e", mode: "diff" });
  const score = { runId: "r", name: "n", graderVersion: "g1", dataType: "NUMERIC", polarity: "higher", source: "code", value: 1, comment: null, observationId: null };
  const turn = {
    runId: null, sessionId: "s", role: "qa-author", round: 0, isRepair: false, ts: AT, objective: null, promptText: "p", outputText: "o", promptBytes: 1,
    tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null,
  };
  const outcome = {
    runId: "r", app: "app", sha: "abcdef1", mode: "diff", target: "e2e", verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 }, rulesRetrieved: [], at: AT,
  };
  return {
    "RunRepository.createRecord": () => h.runs.createRecord({ app: "app", sha: "abcdef2345", target: "e2e", mode: "diff" }),
    "RunRepository.recordRunPhases": () => h.runs.recordRunPhases(run.id, { furthestPhase: "setup", phaseTimings: {} }),
    "RunRepository.recordEffectiveConfig": () => h.runs.recordEffectiveConfig(run.id, "{}"),
    "RunRepository.updateRecord": () => h.runs.updateRecord(run.id, { status: "running", step: "generate", specs: [{ name: "a.spec.ts" }] }),
    "RunRepository.addCase": () => h.runs.addCase(run.id, { name: "case", status: "pass" }),
    "RunRepository.appendLog": () => h.runs.appendLog(run.id, "line"),
    "RunRepository.appendActivity": () => h.runs.appendActivity(run.id, { kind: "command", text: "x" }),
    "RunRepository.saveRunEvent": () => h.runs.saveRunEvent({ runId: run.id, seq: 0, ts: 1, body: {} }),
    "RunRepository.commitSpecSnapshots": () => h.runs.commitSpecSnapshots([{ runId: run.id, path: "a", sha256: "s", text: "t", bytes: 1, capturedAt: 1, delivered: 1 }]),
    "RunRepository.commitRunPlan": () => h.runs.commitRunPlan(run.id, "{}", 1),
    "RunRepository.clearDatabase": () => h.runs.clearDatabase(),
    "ContextRepository.markContextStale": () => h.contexts.markContextStale("app"),
    "ContextRepository.clearContextStale": () => h.contexts.clearContextStale("app"),
    "ContextRepository.recordContextHealRequest": () => h.contexts.recordContextHealRequest("app"),
    "ContextRepository.saveContextMap": () => h.contexts.saveContextMap("app", "abcdef1", { builtAtSha: "abcdef1", routes: [], api: [], feBe: [] }),
    "JudgeRepository.insertJudgeAttempt": () => h.judges.insertJudgeAttempt({ runId: "r", judge: "j", promptVersion: "v1", model: null, outcome: "scored", tokens: 1, detail: null, at: AT }),
    "JudgeRepository.insertJudgeCalibration": () =>
      h.judges.insertJudgeCalibration({ judge: "j", promptVersion: "v1", model: "m", trainN: 1, devN: 1, testN: 1, tpr: null, tnr: null, agreement: null, status: "ok", report: "{}", computedAt: AT }),
    "EvaluationRepository.replaceRunScores": () => h.evaluations.replaceRunScores([score], AT, { runId: "r", graderVersion: "g1" }),
    "EvaluationRepository.setRunEvaluationStatus": () => h.evaluations.setRunEvaluationStatus("r", "complete", AT),
    "EvaluationRepository.saveRegradeJob": () =>
      h.evaluations.saveRegradeJob({ jobId: "j", status: "pending", runIds: ["r"], graders: null, runs: 1, graded: 0, failed: [], startedAt: AT, finishedAt: null }),
    "EvaluationRepository.failInterruptedRegradeJobs": () => h.evaluations.failInterruptedRegradeJobs("2026-10-01T00:00:01.000Z"),
    "LearningRepository.saveRunOutcome": () => h.learning.saveRunOutcome(outcome),
    "LearningRepository.saveCrashedRunOutcome": () => h.learning.saveCrashedRunOutcome(h.runs.getRecord(run.id)!, "E-INFRA" as never),
    "LearningRepository.updateRunOutcomeReflection": () => h.learning.updateRunOutcomeReflection("r", {} as never),
    "LearningRepository.upsertLearningRule": () => h.learning.upsertLearningRule({ id: "rule-1", app: "app", trigger: "t", action: "a", errorClass: "E-INFRA", source: "test" } as never),
    "LearningRepository.incrementRuleUsage": () => h.learning.incrementRuleUsage(["rule-1"]),
    "LearningRepository.recordRuleOutcome": () => h.learning.recordRuleOutcome("rule-1", 1),
    "LearningRepository.setRuleStatusByHuman": () => h.learning.setRuleStatusByHuman("rule-1", "active"),
    "LearningRepository.quarantineLearningRules": () => h.learning.quarantineLearningRules("app", ["rule-1"], AT),
    "LearningRepository.releaseLearningRuleQuarantine": () => h.learning.releaseLearningRuleQuarantine("rule-1"),
    "LearningRepository.saveCurriculum": () => h.learning.saveCurriculum({ app: "app", updatedAt: AT } as never),
    "LearningRepository.saveScorecardEntry": () => h.learning.saveScorecardEntry({ app: "app", runId: "r", at: AT, valueScore: 1 } as never),
    "TelemetryRepository.commitRunSpans": () =>
      h.telemetry.commitRunSpans([{ traceId: "t", spanId: "s", parentSpanId: null, runId: null, name: "n", kind: "internal", startNs: 1n, endNs: null, status: "unset", statusMessage: null, attrs: "{}", events: "[]", links: "[]" }]),
    "TelemetryRepository.saveAgentTurn": () => h.telemetry.saveAgentTurn(turn),
    "TelemetryRepository.saveAgentTurnEvent": () => h.telemetry.saveAgentTurnEvent({ ...turn, event: "turn" } as never),
  };
}

test("every public repository method is either a read or driven by the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-gate-"));
  const db = openHistoryDatabase(join(dir, "history.db"));
  const driven = new Set(Object.keys(writingCalls(createHistory(db))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
  const uncovered: string[] = [];
  for (const [name, repository] of Object.entries(REPOSITORIES)) {
    const methods = Object.getOwnPropertyNames(repository.prototype).filter((m) => m !== "constructor");
    for (const method of methods) {
      if (method === VIA_PURGE_APP || READS[name]!.includes(method) || driven.has(`${name}.${method}`)) continue;
      uncovered.push(`${name}.${method}`);
    }
    for (const read of READS[name]!) assert.ok(methods.includes(read), `${name}.${read} is listed as a read but does not exist`);
  }
  assert.deepEqual(uncovered, [], "list each as a read, or drive it in writingCalls");
});

test("no repository method writes outside a transaction", (t) => {
  const { history, writes } = instrumented(t);
  const calls = writingCalls(history);
  /* A learning rule exists before the calls that update it, and the run table is cleared last. */
  const first = "LearningRepository.upsertLearningRule";
  const last = "RunRepository.clearDatabase";
  const order = [first, ...Object.keys(calls).filter((k) => k !== first && k !== last), last];
  for (const key of order) {
    const before = writes.length;
    calls[key]!();
    assert.ok(writes.length > before, `${key} performed no write, so the gate proves nothing for it`);
  }
  const outside = writes.filter((w) => !w.inTransaction).map((w) => w.sql);
  assert.deepEqual(outside, []);
});

test("purging an app and pruning history write only inside transactions", (t) => {
  const { history, writes, db } = instrumented(t);
  history.runs.createRecord({ app: "app", sha: "abcdef1234", target: "e2e", mode: "diff" });
  history.contexts.markContextStale("app");
  const before = writes.length;
  history.purgeApp("app");
  assert.ok(writes.length > before, "purgeApp performed no write");
  const beforePrune = writes.length;
  pruneHistory(db, { runMaxAgeDays: DELETE_MAX_AGE_DAYS, campaignDays: 180, spanDays: 30 }, NOW);
  assert.ok(writes.length > beforePrune, "pruneHistory performed no write");
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...productionFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

test("only the persistence module opens a database or prepares a statement", () => {
  const persistence = join(SRC, "server", "persistence");
  const offenders = productionFiles(SRC)
    .filter((file) => !file.startsWith(persistence))
    .filter((file) => /\bnew Database\(|\bdb\.prepare\(|\braw\.prepare\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

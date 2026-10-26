import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getHistory } from "../index";
import { LEARNING_RULE_LEDGER_LIMIT } from "./learning.repository";
import type { RunOutcome, StructuredReflection } from "../../../types";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import { initCurriculum } from "@contexts/cross-run-learning/application/index";
import type { RuleStatus } from "../../../qa/learning/learning-rule";


test("recordRuleOutcome accumulates a running mean and earns promotion (never overwrites)", () => {
  const app = "hist-learn-1";
  getHistory().learning.upsertLearningRule({ id: "lr-1", app, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", source: "run-x" });
  getHistory().learning.recordRuleOutcome("lr-1", 0.8, null, true);
  getHistory().learning.recordRuleOutcome("lr-1", 0.8, null, true);
  getHistory().learning.recordRuleOutcome("lr-1", 0.8, null, true);
  const r = getHistory().learning.listLearningRules(app, 10).find((x) => x.id === "lr-1");
  assert.ok(r, "rule should still exist");
  assert.equal(r!.outcomeCount, 3); /* accumulated across outcomes, not overwritten */
  assert.ok(Math.abs(r!.successRate! - 0.8) < 1e-9, `expected ~0.8, got ${r!.successRate}`);
  assert.equal(r!.oracleOutcomeCount, 3, "all three outcomes were oracle-scored");
  assert.equal(r!.status, "active"); /* promotion earned from objective outcomes */
});

test("recordRuleOutcome does NOT promote on good outcomes alone when none are oracle-scored", () => {
  const app = "hist-learn-no-oracle";
  getHistory().learning.upsertLearningRule({ id: "lr-no-oracle", app, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", source: "run-x" });
  getHistory().learning.recordRuleOutcome("lr-no-oracle", 0.8);
  getHistory().learning.recordRuleOutcome("lr-no-oracle", 0.8);
  getHistory().learning.recordRuleOutcome("lr-no-oracle", 0.8);
  const r = getHistory().learning.listLearningRules(app, 10).find((x) => x.id === "lr-no-oracle");
  assert.ok(r, "rule should still exist");
  assert.equal(r!.outcomeCount, 3);
  assert.equal(r!.oracleOutcomeCount, 0, "isOracleScore was never passed — defaults to false");
  assert.equal(r!.status, "candidate", "zero objective evidence — must not promote regardless of successRate");
});

test("listLearningRulesForGovernance: excludes deprecated/superseded rows, same retrievable set as listLearningRules", () => {
  const app = "hist-governance-status-filter";
  getHistory().learning.upsertLearningRule({ id: "gov-active", app, trigger: "t", action: "a", errorClass: "E-EXEC-FAIL", source: "run", initialStatus: "active" });
  getHistory().learning.upsertLearningRule({ id: "gov-candidate", app, trigger: "t", action: "a", errorClass: "E-EXEC-FAIL", source: "run" });
  getHistory().learning.upsertLearningRule({ id: "gov-deprecated", app, trigger: "t", action: "a", errorClass: "E-EXEC-FAIL", source: "run", initialStatus: "deprecated" });

  const ids = getHistory().learning.listLearningRulesForGovernance(app).map((r) => r.id);

  assert.ok(ids.includes("gov-active"));
  assert.ok(ids.includes("gov-candidate"));
  assert.ok(!ids.includes("gov-deprecated"), "deprecated rows must never reach governance retrieval");
});

/* ── Quarantine: a rule set aside, never deleted ───────────────────────────────────────────────── */

const QUARANTINE_AT = "2026-10-12T10:00:00.000Z";

function seedQuarantineApp(app: string): void {
  getHistory().learning.upsertLearningRule({ id: `${app}-cand`, app, trigger: "t1", action: "a", errorClass: "E-STATIC", source: "run-1" });
  getHistory().learning.upsertLearningRule({ id: `${app}-act`, app, trigger: "t2", action: "a", errorClass: "E-STATIC", source: "run-2", initialStatus: "active" });
  getHistory().learning.upsertLearningRule({ id: `${app}-other`, app, trigger: "t3", action: "a", errorClass: "E-STATIC", source: "run-3" });
}

test("quarantineLearningRules marks the named rules, keeps them in the ledger and returns how many it newly marked", () => {
  const app = "hist-quarantine-mark";
  seedQuarantineApp(app);
  assert.equal(getHistory().learning.quarantineLearningRules(app, [`${app}-cand`, `${app}-act`], QUARANTINE_AT), 2);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-cand`)?.quarantinedAt, QUARANTINE_AT);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-act`)?.quarantinedAt, QUARANTINE_AT);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-other`)?.quarantinedAt, null, "a rule not named is left in force");
  assert.equal(getHistory().learning.listAllLearningRules(app).length, 3, "nothing is deleted");
});

test("a quarantined rule is never retrieved, listed as live or folded onto, whatever its status", () => {
  const app = "hist-quarantine-excluded";
  seedQuarantineApp(app);
  getHistory().learning.quarantineLearningRules(app, [`${app}-cand`, `${app}-act`], QUARANTINE_AT);
  assert.deepEqual(getHistory().learning.listLearningRulesForGovernance(app).map((r) => r.id), [`${app}-other`]);
  assert.deepEqual(getHistory().learning.listLearningRules(app, 50).map((r) => r.id), [`${app}-other`]);
  getHistory().learning.recordRuleOutcome(`${app}-cand`, 1);
  getHistory().learning.recordRuleOutcome(`${app}-act`, 1);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-cand`)?.outcomeCount, 0, "a run that retrieved the rule before the quarantine credits it nothing");
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-act`)?.outcomeCount, 0);
});

test("quarantining again marks nothing and keeps the first mark: the command is idempotent", () => {
  const app = "hist-quarantine-idempotent";
  seedQuarantineApp(app);
  assert.equal(getHistory().learning.quarantineLearningRules(app, [`${app}-cand`], QUARANTINE_AT), 1);
  assert.equal(getHistory().learning.quarantineLearningRules(app, [`${app}-cand`], "2026-12-01T00:00:00.000Z"), 0);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-cand`)?.quarantinedAt, QUARANTINE_AT);
});

test("a quarantine reaches only the app it was given, even for an id that exists in another app", () => {
  seedQuarantineApp("hist-quarantine-a");
  seedQuarantineApp("hist-quarantine-b");
  assert.equal(getHistory().learning.quarantineLearningRules("hist-quarantine-a", ["hist-quarantine-b-cand"], QUARANTINE_AT), 0);
  assert.equal(getHistory().learning.getLearningRule("hist-quarantine-b", "hist-quarantine-b-cand")?.quarantinedAt, null);
});

test("saving a rule again (a fold's upsert) does not lift its quarantine", () => {
  const app = "hist-quarantine-upsert";
  seedQuarantineApp(app);
  getHistory().learning.quarantineLearningRules(app, [`${app}-cand`], QUARANTINE_AT);
  getHistory().learning.upsertLearningRule({ id: `${app}-cand`, app, trigger: "t1", action: "a", errorClass: "E-STATIC", source: "run-1" });
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-cand`)?.quarantinedAt, QUARANTINE_AT);
});

test("releasing a quarantined rule puts it back in force, and an unknown or unquarantined rule is reported as such", () => {
  const app = "hist-quarantine-release";
  seedQuarantineApp(app);
  getHistory().learning.quarantineLearningRules(app, [`${app}-cand`], QUARANTINE_AT);
  assert.equal(getHistory().learning.releaseLearningRuleQuarantine(`${app}-cand`), true);
  assert.equal(getHistory().learning.getLearningRule(app, `${app}-cand`)?.quarantinedAt, null);
  assert.ok(getHistory().learning.listLearningRulesForGovernance(app).some((r) => r.id === `${app}-cand`));
  assert.equal(getHistory().learning.releaseLearningRuleQuarantine(`${app}-cand`), false, "nothing to release the second time");
  assert.equal(getHistory().learning.releaseLearningRuleQuarantine("no-such-rule"), false);
});

test("scorecard persists oracle outcomes and aggregates valueScore across runs", () => {
  /* Unique app per run: the on-disk DB persists across test-suite runs and saveScorecardEntry
     APPENDS (by design), so a fixed app name would accumulate entries and break absolute counts.
   */
  const app = `hist-sc-${Date.now().toString(36)}`;
  getHistory().learning.saveScorecardEntry({ runId: "r1", app, sha: "s1", target: "code", valueScore: 0.5, mutantCount: 10, killedCount: 5, at: "t1" });
  getHistory().learning.saveScorecardEntry({ runId: "r2", app, sha: "s2", target: "code", valueScore: 0.7, mutantCount: 10, killedCount: 7, at: "t2" });
  const sc = getHistory().learning.loadScorecard(app);
  assert.ok(sc, "scorecard should exist");
  assert.equal(sc!.entries.length, 2);
  assert.equal(sc!.summary.measuredRuns, 2);
  assert.ok(Math.abs(sc!.summary.avgValueScore! - 0.6) < 1e-9, `expected ~0.6, got ${sc!.summary.avgValueScore}`);
  assert.equal(sc!.summary.lastValueScore, 0.7);
});

test("loadCurriculum: a corrupt row is logged loudly and reported as a distinct fault, never silently treated as absent/fresh", () => {
  const app = `hist-curriculum-corrupt-${Date.now().toString(36)}`;
  getHistory().learning.saveCurriculum(initCurriculum(app));
  assert.ok(getHistory().learning.loadCurriculum(app), "sanity: the valid row round-trips before corruption");

  /* Corrupt the row directly (bypassing saveCurriculum, which only ever writes valid JSON) —
     a second connection to the SAME on-disk db (WAL mode allows this). */
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const raw = new Database(dbPath);
  try {
    raw.prepare("UPDATE curriculum SET data = ? WHERE app = ?").run("{not valid json", app);
  } finally {
    raw.close();
  }

  const originalWarn = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const result = getHistory().learning.loadCurriculum(app);
    assert.equal(result, CURRICULUM_CORRUPT, "a corrupt row must be reported as a distinct fault, never treated as null/absent (which a fold() would silently overwrite with a fresh curriculum)");
    assert.equal(logged.length, 1, "the corrupt row must be logged exactly once, not swallowed silently");
    assert.match(logged[0] ?? "", /corrupt/i, "the log line must be identifiable as a corrupt-curriculum fault");
    assert.match(logged[0] ?? "", new RegExp(app), "the log line must identify which app's row is corrupt");
  } finally {
    console.warn = originalWarn;
  }
});

test("updateRunOutcomeReflection back-fills the reflection that was null at verdict time", () => {
  const app = "reflect-app";
  getHistory().purgeApp(app); /* self-isolate: the history DB is a module-global singleton */
  try {
    const outcome: RunOutcome = {
      runId: "run-reflect-1", app, sha: "abc1234", mode: "diff", target: "e2e",
      verdict: "fail", errorClass: "E-EXEC-FAIL",
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-06-13T00:00:00.000Z",
    };
    getHistory().learning.saveRunOutcome(outcome); /* persisted at verdict time WITHOUT a reflection */
    assert.equal(getHistory().learning.listRunOutcomes(app)[0]?.reflection, undefined);

    const reflection: StructuredReflection = {
      goal: "test the discount", decision: "asserted only visibility", assumption: "button present",
      errorClass: "E-EXEC-FAIL", gateSignal: "fail", evidence: "selector timed out",
      rootCause: "wrong selector", preventiveRule: { trigger: "discount flow", action: "scope the locator" },
    };
    getHistory().learning.updateRunOutcomeReflection("run-reflect-1", reflection);
    assert.deepEqual(getHistory().learning.listRunOutcomes(app)[0]?.reflection, reflection);
  } finally {
    getHistory().purgeApp(app);
  }
});

test("getRunOutcome returns the single run's outcome and round-trips the reviewer verdict", () => {
  const app = "value-report-app";
  getHistory().purgeApp(app); /* self-isolate: the history DB is a module-global singleton */
  try {
    const outcome: RunOutcome = {
      runId: "run-value-1", app, sha: "deadbeef0", mode: "diff", target: "e2e",
      verdict: "pass", errorClass: null,
      gateSignals: { static: true, coverageRatio: 0.82, valueScore: null, reviewerCorrections: [], reviewerRationale: "covers the new validation branch", reviewerApproved: true, flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-06-13T00:00:00.000Z",
    };
    getHistory().learning.saveRunOutcome(outcome);

    const got = getHistory().learning.getRunOutcome("run-value-1");
    assert.ok(got, "expected an outcome for the known runId");
    assert.equal(got!.gateSignals.coverageRatio, 0.82);
    assert.equal(got!.gateSignals.reviewerApproved, true);
    assert.equal(got!.gateSignals.reviewerRationale, "covers the new validation branch");
    assert.equal(getHistory().learning.getRunOutcome("does-not-exist"), undefined);
  } finally {
    getHistory().purgeApp(app);
  }
});

test("a crash reclassifies the outcome the engine persisted, keeping the evidence it carried, and writes one where none was", () => {
  const app = "hist-crashed-class";
  try {
    const withEvidence = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveRunOutcome({
      runId: withEvidence.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict: "infra-error", errorClass: "E-INFRA",
      gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, mutantCount: 7 },
      rulesRetrieved: [], at: "2026-10-19T00:00:00.000Z",
    });

    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(withEvidence.id)!, "internal-error");
    const reclassified = getHistory().learning.getRunOutcome(withEvidence.id)!;
    assert.equal(reclassified.errorClass, "internal-error");
    assert.equal(reclassified.verdict, "infra-error");
    assert.equal(reclassified.gateSignals.mutantCount, 7, "the evidence the engine kept is not replaced with a bare row");

    const bare = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(bare.id)!, "internal-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.verdict, "infra-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.errorClass, "internal-error");
  } finally {
    getHistory().purgeApp(app);
  }
});
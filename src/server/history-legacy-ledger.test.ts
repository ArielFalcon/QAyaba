import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getLearningRule, listLearningRules, LEARNING_RULE_LEDGER_LIMIT } from "./history";
import { historyLearningStore } from "./rewritten-engine-factory";
import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { Sha } from "@kernel/sha";

/* A ledger written by an older build can hold rules with the retired "pending" status. Once the
   current build opens that ledger, those rules must be ordinary candidates — retrievable by
   generation and listed in the operator ledger — never silently excluded by the status filters.

   The fixture is the learning_rules table as the pre-branch build (0cd32f5) created it, written to
   disk BEFORE history.ts opens the database: it opens lazily on first use, and every test file runs
   in its own process with its own HISTORY_DB_PATH (test-setup.mjs). */
const APP = "legacy-ledger-app";
const PENDING_RULE_ID = "rule-written-pending";
const ACTIVE_RULE_ID = "rule-written-active";
const DEPRECATED_RULE_ID = "rule-written-deprecated";

{
  const legacy = new Database(process.env.HISTORY_DB_PATH!);
  legacy.exec(`
    CREATE TABLE IF NOT EXISTS learning_rules (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      action_text TEXT NOT NULL,
      error_class TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'low',
      usage_count INTEGER NOT NULL DEFAULT 0,
      outcome_count INTEGER NOT NULL DEFAULT 0,
      oracle_outcome_count INTEGER NOT NULL DEFAULT 0,
      success_rate REAL,
      last_verified TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      archetype TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_app ON learning_rules(app);
    CREATE INDEX IF NOT EXISTS idx_rules_status ON learning_rules(status);
  `);
  const insert = legacy.prepare(
    "INSERT INTO learning_rules (id, app, trigger_text, action_text, error_class, source, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(PENDING_RULE_ID, APP, "the diff adds a search form", "assert the result row", "E-FRAGILE-SELECTOR", "distiller", "pending", "2026-01-01T00:00:00.000Z");
  insert.run(ACTIVE_RULE_ID, APP, "the diff adds a data table", "assert the row count", "E-FRAGILE-SELECTOR", "distiller", "active", "2026-01-01T00:00:00.000Z");
  insert.run(DEPRECATED_RULE_ID, APP, "the diff adds a modal", "wait for a fixed delay", "E-FRAGILE-SELECTOR", "distiller", "deprecated", "2026-01-01T00:00:00.000Z");
  legacy.close();
}

test("a rule an older build stored as 'pending' is retrieved for generation as a candidate", async () => {
  const top = await new SqliteLearningRepository(historyLearningStore(APP)).topRules(APP, Sha.of("abc1234"), 5);

  assert.equal(top.find((r) => r.id === PENDING_RULE_ID)?.status, "candidate");
});

test("a rule an older build stored as 'pending' is listed in the operator ledger as a candidate", () => {
  const listed = listLearningRules(APP, LEARNING_RULE_LEDGER_LIMIT);

  assert.equal(listed.find((r) => r.id === PENDING_RULE_ID)?.status, "candidate");
});

test("rules an older build stored as active or deprecated keep their status once the ledger is opened", () => {
  assert.equal(getLearningRule(ACTIVE_RULE_ID)?.status, "active");
  assert.equal(getLearningRule(DEPRECATED_RULE_ID)?.status, "deprecated");
});

test("a rule an older build stored as deprecated is neither retrieved for generation nor listed in the operator ledger", async () => {
  const top = await new SqliteLearningRepository(historyLearningStore(APP)).topRules(APP, Sha.of("abc1234"), 5);
  const listed = listLearningRules(APP, LEARNING_RULE_LEDGER_LIMIT);

  assert.ok(top.some((r) => r.id === ACTIVE_RULE_ID), "setup check: retrieval returns the ledger's live rules");
  assert.ok(!top.some((r) => r.id === DEPRECATED_RULE_ID));
  assert.ok(!listed.some((r) => r.id === DEPRECATED_RULE_ID));
});

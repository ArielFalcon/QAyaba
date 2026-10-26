/* test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts";
import { Sha } from "@kernel/sha.ts";

/* Stored rows as the learning_rules table holds them.
   Column names mirror the real `learning_rules` schema: trigger_text, action_text, error_class,
   plus the full set of fields rowToRule maps (id, archetype, usage_count, outcome_count,
   last_verified, source, at).
 */
/* A store whose fold side records nothing, for tests that read rules only. */
const NO_FOLD = { saveScorecardEntry: () => {}, findRule: () => undefined, recordRuleOutcome: () => {} };
const rows = [
  { id: "r1", trigger_text: "t1", action_text: "a1", error_class: "E-X", archetype: null, status: "candidate", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.9, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" },
  { id: "r2", trigger_text: "t2", action_text: "a2", error_class: "E-Y", archetype: null, status: "active", confidence: "high", usage_count: 2, outcome_count: 5, success_rate: 0.5, last_verified: null, source: "oracle", at: "2026-01-02T00:00:00.000Z" },
];

test("a stored row's status reaches the rule as stored", async () => {
  const stored = ["candidate", "active", "deprecated", "superseded"].map((status, n) => ({ ...rows[0]!, id: `s${n}`, trigger_text: `trigger-${status}`, status }));
  const repo = new SqliteLearningRepository({ selectRules: () => stored, upsert: () => {}, ...NO_FOLD });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  for (const status of ["candidate", "active"]) assert.equal(top.find((r) => r.trigger === `trigger-${status}`)?.status, status);
});

test("topRules ranks via RuleGovernanceService — active before the coerced candidate", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, ...NO_FOLD });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(top.map((r) => r.trigger), ["t2", "t1"]); /* active(0.5) before candidate(0.9) */
});

/* The `app` argument is threaded into the injected store's selectRules. v1 stores ignore it
   (no per-app filtering yet); this pins only that the value reaches the seam, never that filtering
   happens.
 */
test("topRules threads the app argument into the injected store.selectRules", async () => {
  const seenApps: string[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: (app) => { seenApps.push(app); return rows; },
    upsert: () => {},
    ...NO_FOLD,
  });
  await repo.topRules("portfolio", Sha.of("abcdef1"), 10);
  assert.deepEqual(seenApps, ["portfolio"]);
});

test("rowToRule maps confidence exhaustively: low/medium/high pass through, unknown falls back to medium", async () => {
  /* The exhaustive ternary must treat 'medium' as a first-class match (not a catch-all).
     A 'medium' row passes through as-is; an unknown value also maps to 'medium' (safe fallback).
   */
  const mediumRow = { id: "r4", trigger_text: "t4", action_text: "a4", error_class: "E-W", archetype: null, status: "active", confidence: "medium", usage_count: 0, outcome_count: 0, success_rate: null, last_verified: null, source: "oracle", at: "2026-01-04T00:00:00.000Z" };
  const unknownRow = { id: "r5", trigger_text: "t5", action_text: "a5", error_class: "E-V", archetype: null, status: "active", confidence: "very-high", usage_count: 0, outcome_count: 0, success_rate: null, last_verified: null, source: "oracle", at: "2026-01-05T00:00:00.000Z" };
  const repo = new SqliteLearningRepository({ selectRules: () => [mediumRow, unknownRow], upsert: () => {}, ...NO_FOLD });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  const t4 = top.find((r) => r.trigger === "t4");
  const t5 = top.find((r) => r.trigger === "t5");
  assert.equal(t4?.confidence, "medium", "'medium' row confidence must be 'medium' (first-class match)");
  assert.equal(t5?.confidence, "medium", "unknown confidence value must fall back to 'medium'");
});

test("save delegates to the injected upsert (no SQLite in the test)", async () => {
  const calls: string[] = [];
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: (r) => calls.push(r.trigger), ...NO_FOLD });
  await repo.save({ id: "r3", trigger: "new", action: "a", errorClass: "E-Z", archetype: null, status: "candidate", confidence: "medium", usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() });
  assert.deepEqual(calls, ["new"]);
});

/* applyOutcome folds through the store: the run's scorecard entry is saved once, even when no rule was retrieved. A regression breaking this (an early return, a call to upsert) would not be caught by the tests that fold nothing. */
test("applyOutcome saves the run's scorecard entry in the store exactly once", async () => {
  const saved: { runId: string }[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    ...NO_FOLD,
    saveScorecardEntry: (entry) => void saved.push(entry),
  });
  const fakeOutcome: import("@kernel/run-outcome.ts").RunOutcome = {
    runId: "run-001", app: "test-app", sha: "abcdef1", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: new Date().toISOString(),
  };
  await repo.applyOutcome(fakeOutcome);
  assert.deepEqual(saved.map((e) => e.runId), ["run-001"], "the scorecard entry must be saved exactly once");
});

/* topRules() forwards the optional relevance bias verbatim to RuleGovernanceService — pinned
   here so the port-boundary forwarding cannot silently drop it. successRates are a NEAR-tie
   (0.55 vs 0.6): RuleGovernanceService scales successRate x10 before adding the bias, so a
   relevance match only flips a close call, never a wide gap.
 */
test("topRules forwards an optional relevance bias to RuleGovernanceService", async () => {
  const relevantRow = { id: "rel", trigger_text: "rel", action_text: "a", error_class: "E-EXEC-FAIL", archetype: null, status: "active", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.55, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const irrelevantRow = { id: "irrel", trigger_text: "irrel", action_text: "a", error_class: "E-FLAKY", archetype: null, status: "active", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.6, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const repo = new SqliteLearningRepository({ selectRules: () => [relevantRow, irrelevantRow], upsert: () => {}, ...NO_FOLD });

  const withoutBias = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(withoutBias.map((r) => r.trigger), ["irrel", "rel"], "no bias -> pure successRate ordering");

  const withBias = await repo.topRules("test-app", Sha.of("abcdef1"), 10, { errorClass: "E-EXEC-FAIL" });
  assert.deepEqual(withBias.map((r) => r.trigger), ["rel", "irrel"], "errorClass bias must be forwarded and flip the ordering");
});

/* incrementUsage delegates to the injected store's own incrementUsage when present, and
   tolerates its absence (optional store method).
 */
test("incrementUsage delegates to the injected store.incrementUsage", async () => {
  const incremented: (readonly string[])[] = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    ...NO_FOLD,
    incrementUsage: (ids) => { incremented.push(ids); },
  });
  await repo.incrementUsage(["r1", "r2"]);
  assert.deepEqual(incremented, [["r1", "r2"]]);
});

test("incrementUsage tolerates a store without incrementUsage wired", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: () => {}, ...NO_FOLD });
  await assert.doesNotReject(() => repo.incrementUsage(["r1"]));
});

/* UNFILTERED by status (unlike selectRules/topRules, which are retrieval-scoped to active/
   candidate) — and fails open to [] when the store doesn't implement it (mirrors incrementUsage's
   own optional-method convention on this same port).
 */
test("listAll delegates to the injected store.selectAllRules, unfiltered by status", async () => {
  const deprecatedRow = { id: "dep", trigger_text: "t-dep", action_text: "a-dep", error_class: "E-X", archetype: null, status: "deprecated", confidence: "low", usage_count: 0, outcome_count: 5, success_rate: 0.1, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" };
  const seenArgs: Array<{ app: string; limit: number }> = [];
  const repo = new SqliteLearningRepository({
    selectRules: () => [],
    upsert: () => {},
    ...NO_FOLD,
    selectAllRules: (app, limit) => { seenArgs.push({ app, limit }); return [deprecatedRow]; },
  });

  const all = await repo.listAll("test-app", 200);

  assert.deepEqual(seenArgs, [{ app: "test-app", limit: 200 }]);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "deprecated", "listAll must NOT filter out deprecated rows (unlike topRules)");
});

test("listAll tolerates a store without selectAllRules wired (fail-open to [])", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: () => {}, ...NO_FOLD });
  const all = await repo.listAll("test-app", 200);
  assert.deepEqual(all, []);
});

/* ── Quarantine and the injection policy ────────────────────────────────────────────────────────── */

const QUARANTINED_AT = "2026-10-01T00:00:00.000Z";
const quarantinedRow = { ...rows[1]!, id: "rq", trigger_text: "tq", quarantined_at: QUARANTINED_AT };
const noStore = { upsert: () => {}, ...NO_FOLD };

test("a quarantined row is never retrieved, whatever its status", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [quarantinedRow, { ...rows[0]!, quarantined_at: QUARANTINED_AT }, { ...rows[1]!, quarantined_at: null }], ...noStore });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(top.map((r) => r.trigger), ["t2"]);
});

test("listAll carries the quarantine mark so an operator and the quarantine itself can see it", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => [], selectAllRules: () => [quarantinedRow, rows[1]!], ...noStore });
  const all = await repo.listAll("test-app", 10);
  assert.deepEqual(all.map((r) => r.quarantinedAt ?? null), [QUARANTINED_AT, null]);
});

test("with unproven rules held back, a candidate row is not retrieved and a proven one is", async () => {
  const proven = { ...rows[1]!, confidence: "high" };
  const repo = new SqliteLearningRepository({ selectRules: () => [rows[0]!, proven], ...noStore }, { reflectorUnproven: false });
  const top = await repo.topRules("test-app", Sha.of("abcdef1"), 10);
  assert.deepEqual(top.map((r) => r.trigger), ["t2"]);
});

test("unproven rules are retrieved unless the repository was told to hold them back", async () => {
  const repo = new SqliteLearningRepository({ selectRules: () => rows, ...noStore });
  assert.equal((await repo.topRules("test-app", Sha.of("abcdef1"), 10)).length, 2);
  const held = new SqliteLearningRepository({ selectRules: () => rows, ...noStore }, { reflectorUnproven: true });
  assert.equal((await held.topRules("test-app", Sha.of("abcdef1"), 10)).length, 2);
});

test("quarantine hands the store the app, the ids and the moment, and returns how many rules it marked", async () => {
  const calls: unknown[] = [];
  const repo = new SqliteLearningRepository({ ...noStore, selectRules: () => [], quarantine: (app, ids, at) => { calls.push([app, [...ids], at]); return ids.length - 1; } });
  assert.equal(await repo.quarantine("demo", ["a", "b", "c"], QUARANTINED_AT), 2);
  assert.deepEqual(calls, [["demo", ["a", "b", "c"], QUARANTINED_AT]]);
});

test("quarantine of nothing touches nothing", async () => {
  const calls: unknown[] = [];
  const repo = new SqliteLearningRepository({ ...noStore, selectRules: () => [], quarantine: () => { calls.push(1); return 0; } });
  assert.equal(await repo.quarantine("demo", [], QUARANTINED_AT), 0);
  assert.equal(calls.length, 0);
});

test("a store that cannot quarantine fails the operator's command loudly instead of reporting a rule set aside that is not", async () => {
  const repo = new SqliteLearningRepository({ ...noStore, selectRules: () => [] });
  await assert.rejects(repo.quarantine("demo", ["a"], QUARANTINED_AT), /cannot quarantine/);
});
